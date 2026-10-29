import type { Direction } from '@shared/ipc-types.js';
import {
  platformNativeBridge,
  type MicrophoneConsumerId
} from '../native/platform-native-bridge.js';

/**
 * One direction's PCM input. Hides the difference between mic capture
 * (speak: pinned to a CoreAudio device UID), system audio capture (listen
 * default: ScreenCaptureKit full screen) and per-process tap (listen when
 * the user has chosen a meeting app — required when local TTS playback is on,
 * to avoid the speaker → loopback → re-translate feedback cycle).
 *
 * `start` resolves once the underlying capture is running and the callback
 * is being driven. `onFailure` reports the capture dying on its own later
 * (device unplugged, permission revoked, target app quit, …): it fires at
 * most once per `start`, only after `start` resolved, and never once `stop`
 * was called. A failing `start` rejects instead. `stop` is idempotent — safe
 * to invoke from cancel paths even if `start` was never reached or already
 * failed — and no PCM is delivered after it.
 */
export interface PcmSource {
  start(
    onPcm: (pcm: Uint8Array) => void,
    onFailure: (message: string) => void
  ): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts one native capture. Resolves to the handle its stop needs: the
 * consumer id of the shared microphone capture, nothing for the
 * single-owner system-audio / process-tap captures.
 */
type NativeStart<T> = (
  onPcm: (pcm: Uint8Array) => void,
  onError: (message: string) => void
) => Promise<T>;

/**
 * Stops what a start produced. `handle` is undefined when stop() runs before
 * the start resolved (SCK / tap: their stop also aborts a pending start).
 */
type NativeStop<T> = (handle: T | undefined) => Promise<void>;

/**
 * Adapts one native capture (whose error callback may fire at any time, even
 * while start is still pending) to the PcmSource contract.
 */
class NativePcmSource<T = void> implements PcmSource {
  /** Bumped by every start()/stop(); callbacks of older runs are dropped. */
  private generation = 0;
  /** Handle of the capture the current run started and nobody stopped yet. */
  private handle: { value: T } | null = null;

  constructor(
    private readonly startNative: NativeStart<T>,
    private readonly stopNative: NativeStop<T>
  ) {}

  async start(
    onPcm: (pcm: Uint8Array) => void,
    onFailure: (message: string) => void
  ): Promise<void> {
    const generation = ++this.generation;
    const isCurrent = (): boolean => generation === this.generation;
    let started = false;
    let reported = false;
    let earlyFailure: string | null = null;

    const fail = (message: string): void => {
      if (reported || !isCurrent()) return;
      if (!started) {
        // Hold failures that race start() until the caller has seen it
        // resolve, so it never gets onFailure while still starting.
        earlyFailure ??= message;
        return;
      }
      reported = true;
      onFailure(message);
    };

    let handle: T;
    try {
      handle = await this.startNative((pcm) => {
        if (isCurrent()) onPcm(pcm);
      }, fail);
    } catch (err) {
      reported = true; // the rejection is the failure report
      throw err;
    }
    if (!isCurrent()) {
      // stop() (or a newer start) ran while the native start was resolving,
      // so it couldn't know this handle: release it now. Captures without a
      // handle were already aborted by that stop.
      if (handle !== undefined) await this.stopNative(handle);
      return;
    }
    this.handle = { value: handle };
    started = true;
    if (earlyFailure !== null) {
      const message = earlyFailure;
      // After the caller's `await start()` continuation has run.
      setImmediate(() => fail(message));
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    const handle = this.handle;
    this.handle = null;
    await this.stopNative(handle?.value);
  }
}

export interface PcmSourceOptions {
  microphoneDeviceUid?: string;
  /** Listen direction only — when set, use Process Tap on this app. */
  listenSourceAppBundleId?: string;
  /**
   * Rate of the delivered 16-bit mono PCM — the owning TranslationClient's
   * `inputSampleRate`. The OS resamples from the device; defaults to 16 kHz.
   */
  sampleRate?: number;
}

export const createPcmSource = (
  direction: Direction,
  options: PcmSourceOptions = {}
): PcmSource => {
  const { sampleRate } = options;
  if (direction === 'speak') {
    const deviceUid = options.microphoneDeviceUid;
    // A consumer of the shared mic capture: joining a capture mic
    // passthrough already holds open doesn't restart the AudioQueue, and
    // stopping detaches only this consumer.
    return new NativePcmSource<MicrophoneConsumerId>(
      (onPcm, onError) =>
        platformNativeBridge.startMicrophoneCapture(
          onPcm,
          deviceUid,
          onError,
          sampleRate
        ),
      async (consumerId) => {
        if (consumerId !== undefined) {
          await platformNativeBridge.stopMicrophoneCapture(consumerId);
        }
      }
    );
  }
  const bundleId = options.listenSourceAppBundleId;
  if (bundleId) {
    return new NativePcmSource(
      (onPcm, onError) =>
        platformNativeBridge.startProcessAudioCapture(
          bundleId,
          onPcm,
          onError,
          sampleRate
        ),
      () => platformNativeBridge.stopProcessAudioCapture()
    );
  }
  return new NativePcmSource(
    (onPcm, onError) =>
      platformNativeBridge.startSystemAudioCapture(onPcm, onError, sampleRate),
    () => platformNativeBridge.stopSystemAudioCapture()
  );
};
