import { log } from '@core/utils/logger.js';
import {
  platformNativeBridge,
  type MicrophoneConsumerId
} from '../native/platform-native-bridge.js';

/**
 * Mic passthrough state machine.
 *
 * Problem: when the local speaker is fluent in the meeting language they
 * don't need translation, but with the conventional setup the meeting app's
 * input is pinned to the BabelVoice virtual device — so their voice never
 * reaches the call unless they manually switch the meeting app's input back
 * to the physical mic. This coordinator keeps the mic continuously routed
 * into the virtual device whenever a translation session is NOT running.
 *
 * Concretely, "passthrough engaged" means:
 *   - we hold a consumer of the shared native mic capture (no PCM to JS),
 *   - the virtual-output AudioUnit is prepared at 24 kHz,
 *   - the native tee writes raw mic PCM into the TTS queue.
 *
 * The native mic capture is shared: a speak session's PcmSource attaches its
 * own consumer to the same AudioQueue. So `suspend` (before a speak session
 * starts) only turns the tee off — the session's TTS must not be mixed with
 * the raw voice — and *parks* our consumer, keeping the queue running for the
 * session to join; `resume` (after the session) turns the tee back on. A
 * session start no longer stops / restarts the AudioQueue, and nothing here
 * can make a session's start fail "already running".
 *
 * When the capture dies under us (mic unplugged, system default input
 * switched to the virtual device, coreaudiod restart) native turns the tee
 * off and reports it on our consumer; we release it and retry with a
 * bounded backoff.
 *
 * The `desired` flag is set from `UserPreferences.micPassthroughWhenIdle`
 * via {@link setDesired}. When false, the coordinator never engages, so
 * existing users see no behaviour change until they opt in.
 *
 * Passthrough only runs while a meeting is open ({@link setMeetingActive}):
 * holding the mic keeps the system's recording indicator on, and nobody is
 * listening on the virtual device outside a meeting. Ending the meeting
 * releases the mic.
 */
/**
 * The tee copies mic samples into the TTS unit verbatim, so both run at this
 * rate (native refuses to engage on a mismatch). 24 kHz keeps the speaker's
 * voice up to 12 kHz for the meeting peer — 16 kHz cut it off at 8 kHz — and
 * matches the TTS rate of Qwen / Gemini / OpenAI, so switching between
 * translation and passthrough doesn't rebuild the unit for those engines.
 */
const PASSTHROUGH_SAMPLE_RATE = 24_000;

/** Upper bound on waiting for trailing TTS before re-engaging passthrough. */
const TTS_DRAIN_MAX_MS = 15_000;
const TTS_DRAIN_POLL_MS = 100;

/**
 * Recovery after a capture failure: 1s, 2s, 4s … capped at 30s, at most
 * RETRY_MAX_ATTEMPTS times (~1 min), then wait for the user. An engagement
 * that stayed up for RETRY_STABLE_MS earns a fresh budget, so a flapping
 * device can't loop forever but a mic unplugged twice a day still recovers.
 */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRY_MAX_ATTEMPTS = 6;
const RETRY_STABLE_MS = 60_000;

/** The consumer of the shared mic capture we hold. */
interface HeldMic {
  /** Unknown until the native start resolved. */
  id: MicrophoneConsumerId | null;
  /** Device it was attached with (undefined = system default). */
  deviceUid: string | undefined;
  /**
   * False once it can't carry passthrough any more: its capture failed, or a
   * bulk stop detached it behind our back. It is then released, not reused.
   */
  usable: boolean;
}

class MicPassthroughCoordinator {
  /** User preference: should passthrough run while no translation is active? */
  private desired = false;
  /** A meeting is open: the only time passthrough may hold the mic. */
  private meetingActive = false;
  /**
   * Suspended by an active translation session. Independent of `desired` so
   * the renderer can change the preference mid-session and we still resume
   * (or stay disengaged) correctly when the session ends.
   */
  private suspended = false;
  /**
   * Set by a bulk stop (meeting idle timeout, app quit): passthrough stays
   * off until the user touches the setting / mic, opens a meeting, or a
   * translation session ends, so an abandoned meeting doesn't leave the mic
   * open indefinitely.
   * Kept apart from `suspended`, which only sessions own — reusing it left
   * passthrough stuck off with no way to recover from the UI.
   */
  private halted = false;
  /** Whether the tee is engaged (mic held + TTS prepared + tee on). */
  private active = false;
  /**
   * Our consumer of the shared mic capture, from engage until released —
   * across a suspend it is parked (held, tee off). Stopping it detaches only
   * us, and consumer ids are never reused, so releasing a stale one can't
   * touch a capture someone else holds.
   */
  private mic: HeldMic | null = null;
  /**
   * Bumped by every engage, park and disengage, and by halt /
   * forgetActiveState. An engage still in flight when it moves is stale: it
   * doesn't switch the tee on. The consumer it attached is kept in `mic`,
   * where the operation that made it stale (queued right behind it) parks
   * or releases it.
   */
  private epoch = 0;
  /** Microphone CoreAudio UID; updated on prefs change. Empty = system default. */
  private microphoneDeviceUid: string | undefined;
  /** Serializes engage/park/disengage so concurrent reconciles don't interleave. */
  private inflight: Promise<void> = Promise.resolve();
  /** A capture failed and we're retrying until an engage sticks. */
  private recovering = false;
  /** Retries spent since the last stable engagement or user action. */
  private retryAttempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private engagedAt = 0;

  setMicrophoneDeviceUid(uid: string | undefined): void {
    if (this.microphoneDeviceUid === uid) return;
    this.microphoneDeviceUid = uid;
    this.halted = false;
    this.resetRetry();
    // A consumer on the old device (engaged or parked) goes; reconcile then
    // engages on the new one — or, while a session runs, waits for resume.
    // If a previous engage failed (e.g. the selected mic disappeared),
    // `desired` may still be true while nothing is held: a mic change is a
    // real chance to recover, even though setDesired(true) would be a no-op.
    if (this.active || this.mic) {
      void this.enqueue(async () => {
        await this.disengageInternal();
        await this.reconcileInternal();
      });
    } else {
      void this.enqueue(() => this.reconcileInternal());
    }
  }

  setDesired(desired: boolean): void {
    if (this.desired === desired) return;
    this.desired = desired;
    this.halted = false;
    this.resetRetry();
    void this.enqueue(() => this.reconcileInternal());
  }

  /**
   * A meeting opened or ended. Opening one is a user action like toggling the
   * setting: it lifts a halt left by the last meeting's idle timeout. Ending
   * one releases the mic, parked consumer included.
   */
  setMeetingActive(active: boolean): void {
    if (this.meetingActive === active) return;
    this.meetingActive = active;
    this.halted = false;
    this.resetRetry();
    void this.enqueue(() => this.reconcileInternal());
  }

  /**
   * Called by the translation session lifecycle before a speak session
   * starts: turns the tee off and parks our mic consumer, so the session
   * joins the running capture instead of restarting it.
   */
  async suspend(): Promise<void> {
    this.suspended = true;
    this.clearRetryTimer();
    await this.enqueue(() => this.parkInternal());
  }

  /** Called once a translation session has fully terminated. */
  async resume(): Promise<void> {
    this.suspended = false;
    this.halted = false;
    this.resetRetry();
    await this.enqueue(() => this.reconcileInternal());
  }

  /**
   * Turn passthrough off after a bulk stop until the user acts again (see
   * `halted`). Call after something else tore down audio services
   * (`stopAllNativeAudioServices`). An engage that was still in flight is
   * invalidated, and our consumer is released if we may still hold one — an
   * engage that finished after the bulk stop would otherwise keep the mic
   * open (the old B13 orphan AudioQueue).
   */
  async halt(): Promise<void> {
    this.halted = true;
    this.suspended = false;
    this.epoch++;
    this.resetRetry();
    await this.enqueue(() => this.disengageInternal());
  }

  /**
   * Hard-reset external view of native state. Call when something else
   * tore down audio services (e.g. `stopAllNativeAudioServices`) so we
   * don't believe we still own the route. Invalidates an engage in flight;
   * the consumer we held is never reused (the next engage or disengage
   * releases it — a no-op if the bulk stop already detached it).
   */
  forgetActiveState(): void {
    this.active = false;
    this.epoch++;
    if (this.mic) this.mic.usable = false;
  }

  private shouldBeActive(): boolean {
    return this.shouldHoldMic() && !this.suspended;
  }

  /** Keep a parked consumer: passthrough is only suspended by a session. */
  private shouldHoldMic(): boolean {
    return this.desired && this.meetingActive && !this.halted;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.inflight.then(task, task);
    this.inflight = next.catch(() => undefined);
    return next;
  }

  private async reconcileInternal(): Promise<void> {
    if (this.shouldBeActive()) {
      if (!this.active) await this.engageInternal();
      return;
    }
    if (this.shouldHoldMic()) {
      // Suspended: tee off, consumer parked (dropped if it can't be reused).
      if (this.active || (this.mic && !this.mic.usable)) await this.parkInternal();
    } else if (this.active || this.mic) {
      await this.disengageInternal();
    }
  }

  private async engageInternal(): Promise<void> {
    if (await this.tryEngage()) {
      this.recovering = false;
    } else if (this.recovering) {
      this.scheduleRetry();
    }
  }

  /** True once passthrough is engaged; false if it isn't (any reason). */
  private async tryEngage(): Promise<boolean> {
    const caps = platformNativeBridge.getCapabilities();
    if (!caps.microphoneCapture || !caps.nativeTtsPlayback) return false;
    if (!caps.hasVirtualOutput) {
      // No BabelVoice/BlackHole installed — silently skip. The user will see
      // the existing "install virtual device" prompt elsewhere in the UI.
      return false;
    }
    const epoch = ++this.epoch;
    const stale = (): boolean => epoch !== this.epoch || !this.shouldBeActive();
    // A speak session that just finished usually still has seconds of
    // translated TTS queued (synthesis runs ahead of playback). Engaging
    // flushes the queue, which cut the last sentence off for the meeting
    // peer — let it play out first.
    await this.waitForTtsDrain(stale);
    if (stale()) return false;
    /** We hold a consumer and only the tee is left: failures now are the capture's. */
    let attached = false;
    try {
      // A parked consumer we can't reuse: its capture died, a bulk stop
      // detached it, or the user picked another microphone since.
      if (this.mic && (!this.mic.usable || this.mic.deviceUid !== this.microphoneDeviceUid)) {
        await this.releaseMic();
      }
      await platformNativeBridge.prepareTtsOutput(PASSTHROUGH_SAMPLE_RATE);
      await platformNativeBridge.flushTtsOutput();
      if (stale()) return false;
      if (!this.mic) {
        const held: HeldMic = { id: null, deviceUid: this.microphoneDeviceUid, usable: true };
        // Track it before the native start resolves: a bulk stop that lands
        // meanwhile must find (and invalidate) it.
        this.mic = held;
        try {
          held.id = await platformNativeBridge.startMicrophoneCapture(
            // The tee runs natively; nothing in JS needs the PCM.
            null,
            held.deviceUid,
            (message) => this.onCaptureError(held, message),
            PASSTHROUGH_SAMPLE_RATE
          );
        } catch (err) {
          if (this.mic === held) this.mic = null;
          throw err;
        }
        // Stale (a session is starting, the user turned it off, a bulk stop):
        // keep the consumer — the operation queued behind us parks it for
        // the session to join, or releases it.
        if (stale()) return false;
      }
      attached = true;
      await platformNativeBridge.setMicPassthroughEnabled(true);
      if (stale()) {
        await this.teeOff();
        return false;
      }
      this.active = true;
      this.engagedAt = Date.now();
      return true;
    } catch (err) {
      log.warn('mic passthrough engage failed:', err);
      // Our capture is up but died before we finished (native then refuses
      // the tee); its onError may race this, so recover here.
      if (attached) this.recovering = true;
      // Best-effort cleanup so we don't keep a consumer we can't use.
      await this.releaseMic();
      this.active = false;
      return false;
    }
  }

  /**
   * Poll until queued TTS has rendered. Bails as soon as the engage goes
   * stale — suspend() flips the flag synchronously, so a new session
   * starting never waits behind this loop for more than one poll.
   */
  private async waitForTtsDrain(stale: () => boolean): Promise<void> {
    const deadline = Date.now() + TTS_DRAIN_MAX_MS;
    while (!stale() && Date.now() < deadline) {
      if (platformNativeBridge.getTtsPendingMs() <= 0) return;
      await new Promise((resolve) => setTimeout(resolve, TTS_DRAIN_POLL_MS));
    }
  }

  /** Tee off, consumer kept (unless it can't be reused). */
  private async parkInternal(): Promise<void> {
    this.epoch++;
    const wasActive = this.active;
    try {
      await this.teeOff();
      if (wasActive) await platformNativeBridge.flushTtsOutput();
      if (this.mic && !this.mic.usable) await this.releaseMic();
    } catch (err) {
      log.warn('mic passthrough suspend failed:', err);
    } finally {
      this.active = false;
    }
  }

  /** Tee off and our consumer released. */
  private async disengageInternal(): Promise<void> {
    this.epoch++;
    const wasActive = this.active;
    try {
      await this.releaseMic();
      if (wasActive) await platformNativeBridge.flushTtsOutput();
    } catch (err) {
      log.warn('mic passthrough disengage failed:', err);
    } finally {
      this.active = false;
    }
  }

  /** Never throws. Also clears a flag set out-of-band; cheap. */
  private async teeOff(): Promise<void> {
    await platformNativeBridge
      .setMicPassthroughEnabled(false)
      .catch((err) => log.warn('mic passthrough: clearing the tee failed:', err));
  }

  /** Tee off, and detach our consumer if we hold one. Never throws. */
  private async releaseMic(): Promise<void> {
    await this.teeOff();
    const mic = this.mic;
    if (!mic) return;
    this.mic = null;
    if (mic.id === null) return;
    await platformNativeBridge
      .stopMicrophoneCapture(mic.id)
      .catch((err) => log.warn('mic passthrough: stopping the mic failed:', err));
  }

  /**
   * The capture behind our consumer `held` died on its own. Native has
   * already switched the tee off; release the consumer and retry later.
   */
  private onCaptureError(held: HeldMic, message: string): void {
    if (this.mic !== held) return;
    held.usable = false;
    log.warn(`mic passthrough capture failed: ${message}`);
    void this.enqueue(async () => {
      if (this.mic !== held) return;
      if (this.active && Date.now() - this.engagedAt >= RETRY_STABLE_MS) {
        this.retryAttempts = 0;
      }
      await this.disengageInternal();
      this.recovering = true;
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    this.clearRetryTimer();
    if (!this.shouldBeActive()) return;
    if (this.retryAttempts >= RETRY_MAX_ATTEMPTS) {
      log.warn(
        `mic passthrough: giving up after ${RETRY_MAX_ATTEMPTS} retries; ` +
          'waiting for the user to change the microphone or the setting'
      );
      this.recovering = false;
      return;
    }
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retryAttempts, RETRY_MAX_DELAY_MS);
    this.retryAttempts++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue(() => this.reconcileInternal());
    }, delay);
    this.retryTimer.unref?.();
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** A user action / session end: the next failure starts a fresh budget. */
  private resetRetry(): void {
    this.clearRetryTimer();
    this.recovering = false;
    this.retryAttempts = 0;
  }
}

export const micPassthroughCoordinator = new MicPassthroughCoordinator();
