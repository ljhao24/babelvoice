import type {
  Direction,
  SessionStatus,
  TranslationEvent,
  TranslationStatusPayload
} from '@shared/ipc-types.js';
import type { TranslationErrorKind } from '@shared/translation-error-types.js';
import { log } from '@core/utils/logger.js';
import type {
  ClientStartParams,
  TranslationClient,
  TranslationEventBody
} from '../translation/translation-client.js';
import { errorKindOf } from '../translation/translation-error.js';
import { ensureSubtitleOverlayReady } from '../window-manager.js';
import { createPcmSource, type PcmSource } from './pcm-source.js';
import { createTtsSink, type TtsSink } from './tts-sink.js';

/**
 * How long `finishing` may wait for the server's terminal event. A half-open
 * socket (sleep/wake, Wi-Fi switch) never answers FinishSession, and listen
 * has no UI exit from `finishing`, so without a deadline the session sticks.
 */
export const FINISH_DEADLINE_MS = 10_000;

/**
 * Uplink packet duration: 80 ms, the packet size the Doubao doc recommends.
 * Capture callbacks deliver smaller chunks (40 ms mic buffers;
 * ScreenCaptureKit / Process Tap pass through the system buffer size), and
 * every WS frame costs encode + framing overhead.
 */
export const UPLINK_CHUNK_MS = 80;

/** Bytes in one uplink packet of 16-bit mono PCM at `sampleRate`. */
export const uplinkChunkBytes = (
  sampleRate: number,
  chunkMs: number = UPLINK_CHUNK_MS
): number => ((sampleRate * chunkMs) / 1000) * 2;

interface SessionCallbacks {
  /** Forward every TranslationEvent (already direction-tagged) to listeners. */
  onEvent: (event: TranslationEvent) => void;
  /** Fired on every status transition (idle → connecting → running → ...). */
  onStatus: (payload: TranslationStatusPayload) => void;
  /**
   * Fired exactly once when the session reaches a terminal status (idle or
   * failed). Used by the registry to clear the slot. Native resources are
   * already released by then, so it's safe to hand them to someone else
   * (mic passthrough).
   */
  onTerminated: () => void;
}

/** Why a session ended `failed`, as broadcast in TranslationStatusPayload. */
interface SessionError {
  kind: TranslationErrorKind;
  /** Raw technical detail (logs/diagnostics). */
  message: string;
}

interface TerminateOptions {
  /** Close the TTS AudioUnit (kept alive across normal finishes, see below). */
  closeSink: boolean;
  /** Tear down the provider socket (not needed once the server finished). */
  cancelClient: boolean;
  error?: SessionError;
  /**
   * Called from open()'s own catch. Every other caller waits for an
   * in-flight open() to unwind first, so capture it starts late is stopped
   * before the status flips (and before mic passthrough re-engages).
   */
  fromOpen?: boolean;
}

export interface OpenOptions {
  suppressOverlay?: boolean;
  listenSourceAppBundleId?: string;
  /**
   * Runs first, with the session already `connecting`, so cancel() can
   * interrupt it — e.g. handing the mic + TTS unit over from passthrough.
   */
  beforeStart?: () => Promise<void>;
}

/**
 * One translation session in one Direction. Owns a TranslationClient
 * (chosen by client-factory at construction time), drives the native
 * bridge for capture and (speak-only) TTS, and reports lifecycle and
 * events through callbacks.
 *
 * The `status` field is authoritative for this Direction (see ADR-0001).
 * The state machine is engine-blind (see ADR-0002): it talks only to
 * the TranslationClient interface and never imports a concrete provider.
 *
 * It is also where failures get their `TranslationErrorKind` for the UI: a
 * client's `session-failed` carries one, a start() rejection is classified
 * here (a TranslationError's own kind, else by the step that threw), and
 * capture / TTS sink failures are 'audio-device'.
 *
 * Every live → terminal transition goes through `terminate()`, which
 * releases native resources *before* flipping the status. onTerminated
 * re-engages mic passthrough on the same TTS AudioUnit, so flipping first
 * let a still-running teardown close the unit passthrough had just
 * prepared (silence for the meeting peer).
 *
 * Constructor accepts a `clientFactory` rather than a client instance
 * so that the client's `onEvent` can be wired to this session's
 * `handleClientEvent` without exposing it on the public API.
 */
export class DirectionSession {
  private readonly client: TranslationClient;
  private readonly sink: TtsSink;
  private source: PcmSource | null = null;
  private status: SessionStatus = 'idle';
  /**
   * Set by cancel() so open()'s catch can distinguish "user pressed stop
   * during connect" (→ cancel() owns the teardown) from a genuine start
   * failure (→ failed).
   */
  private cancelRequested = false;
  /** Set once terminate() starts; stops events/audio while it runs. */
  private terminating = false;
  /** The in-flight open(), so cancel() can wait for it to unwind. */
  private opening: Promise<void> | null = null;
  private finishTimer: NodeJS.Timeout | null = null;
  private uplink: Uint8Array[] = [];
  private uplinkBytes = 0;
  private readonly uplinkChunkBytes: number;

  constructor(
    public readonly direction: Direction,
    clientFactory: (onEvent: (body: TranslationEventBody) => void) => TranslationClient,
    private readonly callbacks: SessionCallbacks
  ) {
    this.client = clientFactory((body) => this.handleClientEvent(body));
    this.sink = createTtsSink(direction);
    this.uplinkChunkBytes = uplinkChunkBytes(
      this.client.inputSampleRate,
      this.client.uplinkChunkMs
    );
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  private setStatus(next: SessionStatus, error?: SessionError): void {
    if (this.status === next) return;
    const wasTerminal = this.isTerminal();
    this.status = next;
    this.callbacks.onStatus({
      direction: this.direction,
      status: next,
      errorMessage: error?.message,
      ...(error ? { errorKind: error.kind } : {})
    });
    if (this.isTerminal() && !wasTerminal) {
      this.callbacks.onTerminated();
    }
  }

  private isTerminal(): boolean {
    return this.status === 'idle' || this.status === 'failed';
  }

  private isAcceptingAudio(): boolean {
    return (
      !this.terminating &&
      (this.status === 'running' || this.status === 'finishing')
    );
  }

  /**
   * True while a server session is meaningfully alive — i.e. not idle/failed,
   * not being cancelled and not already tearing down. Used by event handlers
   * to decide whether to react to incoming events or drop them as stale.
   */
  private isLive(): boolean {
    return (
      !this.terminating &&
      (this.status === 'connecting' ||
        this.status === 'running' ||
        this.status === 'finishing')
    );
  }

  /**
   * Bail out of open() at the next checkpoint if cancel() raced ahead, or a
   * terminal client event (session-failed while capture was starting) already
   * tore the session down — without this, open() would flip it back to
   * `running` after it had left the registry.
   */
  private checkCancel(): void {
    if (
      this.cancelRequested ||
      this.status === 'cancelling' ||
      this.terminating ||
      this.isTerminal()
    ) {
      throw new Error('cancelled');
    }
  }

  async open(
    clientParams: ClientStartParams,
    microphoneDeviceUid?: string,
    options: OpenOptions = {}
  ): Promise<void> {
    if (this.status !== 'idle') {
      throw new Error(
        `Cannot open ${this.direction} session: status=${this.status}`
      );
    }
    this.cancelRequested = false;
    this.terminating = false;
    this.setStatus('connecting');
    const opening = this.doOpen(clientParams, microphoneDeviceUid, options);
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async doOpen(
    clientParams: ClientStartParams,
    microphoneDeviceUid: string | undefined,
    options: OpenOptions
  ): Promise<void> {
    const direction = this.direction;
    // What a plain Error from the step in progress means; a TranslationError
    // (every expected client.start() failure) carries its own kind.
    let failureKind: TranslationErrorKind = 'audio-device';
    try {
      if (options.beforeStart) {
        // Hands the mic + TTS unit over from passthrough.
        await options.beforeStart();
        this.checkCancel();
      }
      await this.sink.prepare(this.client.outputSampleRate);
      this.checkCancel();
      failureKind = 'unknown';
      if (!options.suppressOverlay) {
        await ensureSubtitleOverlayReady();
        this.checkCancel();
      }
      await this.client.start(clientParams);
      this.checkCancel();
      failureKind = 'audio-device';
      // Capture at the rate the engine takes, so PCM goes out as captured.
      this.source = createPcmSource(direction, {
        microphoneDeviceUid,
        listenSourceAppBundleId: options.listenSourceAppBundleId,
        sampleRate: this.client.inputSampleRate
      });
      await this.source.start(
        (pcm) => {
          if (!this.isAcceptingAudio()) return;
          this.queueUplink(pcm);
        },
        (message) => this.fail(`${direction} capture stopped: ${message}`)
      );
      this.checkCancel();
      this.setStatus('running');
    } catch (err) {
      if (this.cancelRequested || this.terminating) {
        // cancel() or a terminal client event owns the teardown and the
        // status flip; it waits for this unwind. Only stop capture this
        // open() may have started after its first stop ran — closing the
        // sink here would kill the TTS unit mic passthrough re-engages once
        // that teardown completes.
        await this.source?.stop().catch(() => undefined);
        throw err;
      }
      log.error(`${direction} session start failed:`, err);
      const message = err instanceof Error ? err.message : String(err);
      await this.terminate('failed', {
        closeSink: true,
        cancelClient: true,
        error: { kind: errorKindOf(err, failureKind), message },
        fromOpen: true
      });
      throw err;
    }
  }

  async finish(): Promise<void> {
    if (this.status !== 'running' || this.terminating) return;
    this.setStatus('finishing');
    await this.source?.stop().catch(() => undefined);
    this.flushUplink();
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null;
      if (this.status !== 'finishing' || this.terminating) return;
      log.warn(
        `${this.direction} session: no server finish within ${FINISH_DEADLINE_MS}ms; cancelling`
      );
      void this.terminate('idle', { closeSink: true, cancelClient: true });
    }, FINISH_DEADLINE_MS);
    await this.client.finish();
    // Status transitions to idle when the server emits session-finished
    // (or the deadline above fires).
  }

  async cancel(): Promise<void> {
    if (!this.isLive()) return;
    this.cancelRequested = true;
    this.setStatus('cancelling');
    // Abort the handshake and any capture start first so an in-flight
    // open() unwinds promptly (client.start rejects; a pending Process Tap
    // build fails on stop), then wait for it so it can't start capture
    // behind our back after the teardown below.
    await this.client.cancel().catch(() => undefined);
    await this.source?.stop().catch(() => undefined);
    await this.opening?.catch(() => undefined);
    await this.terminate('idle', { closeSink: true, cancelClient: false });
  }

  /**
   * The single live → terminal path. Releases capture, the TTS unit (when
   * asked) and the provider socket, and only then flips the status, so
   * onTerminated observers see the native resources already free.
   */
  private async terminate(
    next: 'idle' | 'failed',
    options: TerminateOptions
  ): Promise<void> {
    if (this.terminating) return;
    this.terminating = true;
    if (this.finishTimer) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    this.uplink = [];
    this.uplinkBytes = 0;
    await this.source?.stop().catch(() => undefined);
    if (!options.fromOpen && this.opening) {
      // Unblock a pending client.start() / capture start, then let open()
      // hit its checkpoint and stop whatever capture came up late.
      if (options.cancelClient) {
        await this.client.cancel().catch(() => undefined);
      }
      await this.opening.catch(() => undefined);
    }
    if (options.closeSink) {
      await this.sink.close().catch(() => undefined);
    }
    if (options.cancelClient) {
      await this.client.cancel().catch(() => undefined);
    }
    this.setStatus(next, options.error);
  }

  /**
   * Surface a mid-session capture / TTS sink failure to renderers and tear
   * everything down.
   */
  private fail(message: string): void {
    if (!this.isLive()) return;
    log.error(`${this.direction} session failed: ${message}`);
    const kind: TranslationErrorKind = 'audio-device';
    this.callbacks.onEvent({
      direction: this.direction,
      type: 'session-failed',
      kind,
      message
    });
    void this.terminate('failed', {
      closeSink: true,
      cancelClient: true,
      error: { kind, message }
    });
  }

  private queueUplink(pcm: Uint8Array): void {
    this.uplink.push(pcm);
    this.uplinkBytes += pcm.byteLength;
    if (this.uplinkBytes >= this.uplinkChunkBytes) this.flushUplink();
  }

  private flushUplink(): void {
    if (this.uplinkBytes === 0) return;
    const chunk =
      this.uplink.length === 1 ? this.uplink[0] : Buffer.concat(this.uplink);
    this.uplink = [];
    this.uplinkBytes = 0;
    void this.client.sendAudio(chunk).catch((err) => {
      log.warn(`native ${this.direction} audio chunk send failed:`, err);
    });
  }

  /**
   * Receives undirected event bodies from the TranslationClient. Adds
   * `direction` (and, on TTS audio, the client's output rate) before
   * forwarding upward, and runs lifecycle side-effects (TTS playback, status
   * transitions on terminal events).
   */
  private handleClientEvent(body: TranslationEventBody): void {
    if (!this.isLive()) return;

    if (body.type === 'tts-audio') {
      const sampleRate = this.client.outputSampleRate;
      void this.sink.play(body.data, sampleRate).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error('TTS sink playback failed:', err);
        this.fail(`TTS sink playback failed: ${message}`);
      });
      // The rate travels with the chunk: renderers must not infer it from
      // their own (display-only) prefs.engineId (ADR-0002).
      this.callbacks.onEvent({ ...body, direction: this.direction, sampleRate });
      return;
    }

    this.callbacks.onEvent({ ...body, direction: this.direction } as TranslationEvent);

    if (body.type === 'session-finished') {
      // Keep the TTS AudioUnit alive across normal PTT finishes. Disposing
      // it on every session-finished, then recreating it on the next press,
      // leaves some virtual devices in a state where later audio silently
      // fails. The unit is closed on explicit cancel, failure, or shutdown.
      void this.terminate('idle', { closeSink: false, cancelClient: false });
    } else if (body.type === 'session-failed') {
      void this.terminate('failed', {
        closeSink: true,
        cancelClient: true,
        error: { kind: body.kind, message: body.message }
      });
    }
  }
}
