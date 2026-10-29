import { IPC } from '@shared/ipc-types.js';
import type {
  Direction,
  StartTranslationParams,
  TranslationEvent,
  TranslationStatusPayload
} from '@shared/ipc-types.js';
import type { EngineId } from '@shared/engine-types.js';
import type { UserPreferences } from '@shared/config-types.js';
import { log } from '@core/utils/logger.js';
import type {
  ClientStartParams,
  TranslationClient,
  TranslationClientOptions
} from '../translation/translation-client.js';
import { errorKindOf } from '../translation/translation-error.js';
import { t } from '../i18n.js';
import type { SessionObserver } from '../meetings/meeting-monitor.js';
import { DirectionSession } from './direction-session.js';
import type { BulkStopPassthrough, MicArbiter } from './mic-arbiter.js';

/** The slice of SessionRegistry the orchestrator drives. */
export interface SessionSlots {
  readonly size: number;
  has(direction: Direction): boolean;
  get(direction: Direction): DirectionSession | undefined;
  set(direction: Direction, session: DirectionSession): void;
  delete(direction: Direction): boolean;
  values(): DirectionSession[];
  clear(): void;
}

export interface SessionOrchestratorDeps {
  registry: SessionSlots;
  /** Mints the provider client for one session (client-factory). */
  createClient: (
    engineId: EngineId,
    opts: TranslationClientOptions
  ) => TranslationClient;
  /** Engine selection, resolved per start (engine-selection). */
  getActiveEngineId: () => EngineId;
  buildClientStartParams: (
    params: StartTranslationParams,
    engineId: EngineId
  ) => ClientStartParams;
  getPreferences: () => Pick<
    UserPreferences,
    'preferredMicrophoneUid' | 'listenSourceAppBundleId'
  >;
  /** Every renderer: the control window and the subtitle overlay. */
  broadcast: (channel: string, payload: unknown) => void;
  /** The control window only. */
  sendToControlWindow: (channel: string, payload: unknown) => void;
  showSubtitleOverlay: () => void;
  micArbiter: MicArbiter;
  /** Stops every native capture and the TTS unit, session-owned or not. */
  stopAllNativeAudio: () => Promise<void>;
  /** Told about every session's lifecycle, events, telemetry and uplink (MeetingMonitor). */
  observer?: SessionObserver;
}

interface StartPlan {
  engineId: EngineId;
  clientParams: ClientStartParams;
  microphoneDeviceUid: string | undefined;
  listenSourceAppBundleId: string | undefined;
}

/** Only speak owns the mic + TTS unit; listen never touches passthrough. */
const ownsMicrophone = (direction: Direction): boolean => direction === 'speak';

/** `client`, with every uplink chunk reported to `onSent` before it goes out. */
const meterUplink = (
  client: TranslationClient,
  onSent: (bytes: number) => void
): TranslationClient => ({
  engineId: client.engineId,
  inputSampleRate: client.inputSampleRate,
  outputSampleRate: client.outputSampleRate,
  uplinkChunkMs: client.uplinkChunkMs,
  start: (params) => client.start(params),
  sendAudio: (pcm) => {
    onSent(pcm.byteLength);
    return client.sendAudio(pcm);
  },
  finish: () => client.finish(),
  cancel: () => client.cancel()
});

/**
 * Starts, stops and routes DirectionSessions on behalf of the IPC layer
 * and the app lifecycle (meeting end, idle timeout, quit). Holds no session
 * state of its own beyond the bulk-cancel count — the SessionRegistry does
 * (ADR-0002 rejected an orchestrator that duplicated it). Owns the rules
 * around a session rather than inside it: start preconditions, event /
 * status routing, and the mic hand-over with idle passthrough.
 *
 * The subtitle overlay is shown when a translation session *starts*. It is
 * never auto-hidden — and never re-shown on session end either: once the
 * user closes it (close button, toggle hotkey, `subtitle:toggle` IPC) it
 * stays closed until the next session start.
 */
export class SessionOrchestrator {
  /**
   * cancelAll calls in flight. A count, not a flag: they can overlap (a
   * meeting end racing quit), and the first to finish must not let starts
   * back in while another is still sweeping. While non-zero the
   * per-session onTerminated hooks don't each re-engage mic passthrough
   * mid-teardown (racing the native stop); the bulk path decides at the end.
   */
  private bulkCancels = 0;
  /** An overlapping cancelAll asked passthrough to stay off. */
  private bulkHaltRequested = false;

  constructor(private readonly deps: SessionOrchestratorDeps) {}

  private get bulkCancelInProgress(): boolean {
    return this.bulkCancels > 0;
  }

  hasActiveSessions(): boolean {
    return this.deps.registry.size > 0;
  }

  /** Status snapshot for a renderer that (re)loaded mid-session. */
  getStatuses(): TranslationStatusPayload[] {
    return (['speak', 'listen'] as const).map((direction) => ({
      direction,
      status: this.deps.registry.get(direction)?.getStatus() ?? 'idle'
    }));
  }

  /**
   * Resolves once the session is running. Rejects when the start is
   * refused or fails; the renderer ignores the rejection and follows the
   * status broadcast instead.
   */
  async start(params: StartTranslationParams): Promise<void> {
    const { direction } = params;
    const existing = this.deps.registry.get(direction);
    if (existing) {
      // The renderer optimistically showed `connecting`; re-sync it with
      // the session that is actually running (e.g. a control window
      // reopened mid-session) instead of leaving it stuck.
      this.deps.broadcast(IPC.TranslationStatus, {
        direction,
        status: existing.getStatus()
      });
      throw new Error(`A ${direction} session is already running`);
    }
    let plan: StartPlan;
    try {
      plan = this.planStart(params);
    } catch (err) {
      this.broadcastStartRejected(direction, err);
      throw err;
    }

    // A session that keeps the overlay out (the onboarding probes render
    // its own preview) must not land in the overlay's subtitle history
    // either — only the control window hears about it.
    const toOverlayToo = !params.suppressOverlay;
    let session: DirectionSession;
    try {
      session = this.createSession(direction, plan.engineId, toOverlayToo);
    } catch (err) {
      // Constructing the client (factory / provider constructor) failed.
      log.error(`${direction} session setup failed:`, err);
      this.broadcastStartRejected(direction, err);
      throw err;
    }
    this.deps.observer?.sessionCreated(direction, plan.engineId);
    // Registered before the first await, so a bulk cancel from here on
    // finds the session and tears it down instead of leaving it running
    // outside the registry.
    this.deps.registry.set(direction, session);
    if (toOverlayToo) {
      this.deps.showSubtitleOverlay();
    }
    // On failure onTerminated has already removed the session via
    // setStatus(failed/idle); the rejection just propagates.
    await session.open(plan.clientParams, plan.microphoneDeviceUid, {
      suppressOverlay: params.suppressOverlay,
      listenSourceAppBundleId: plan.listenSourceAppBundleId,
      // Turn the passthrough tee off before the session's TTS takes the
      // virtual output (the mic capture itself is shared and keeps
      // running) — inside open() so the session is already `connecting`
      // and a cancel can interrupt it. No-op when the user hasn't opted
      // into passthrough. Listen captures system audio and plays no TTS
      // through the virtual device, so passthrough keeps running alongside
      // it.
      beforeStart: ownsMicrophone(direction)
        ? () => this.deps.micArbiter.suspendForSession()
        : undefined
    });
  }

  /** False when no session runs in `direction`. */
  async finish(direction: Direction): Promise<boolean> {
    const session = this.deps.registry.get(direction);
    if (!session) return false;
    await session.finish();
    return true;
  }

  /** False when no session runs in `direction`. */
  async cancel(direction: Direction): Promise<boolean> {
    const session = this.deps.registry.get(direction);
    if (!session) return false;
    // onTerminated handles registry removal + passthrough resume.
    await session.cancel();
    return true;
  }

  /**
   * Stop every session and all native capture at once (meeting end, idle
   * timeout, quit). `passthrough` picks what idle passthrough does after;
   * if overlapping calls disagree, `halt` wins, so a meeting end racing
   * quit can't re-open the mic under the quit.
   */
  async cancelAll(passthrough: BulkStopPassthrough): Promise<void> {
    const sessions = this.deps.registry.values();
    this.deps.registry.clear();
    this.bulkCancels++;
    if (passthrough === 'halt') this.bulkHaltRequested = true;
    let settleWith: BulkStopPassthrough = passthrough;
    try {
      await Promise.allSettled([
        ...sessions.map((s) => s.cancel()),
        this.deps.stopAllNativeAudio()
      ]);
    } finally {
      if (this.bulkHaltRequested) settleWith = 'halt';
      this.bulkCancels--;
      if (this.bulkCancels === 0) this.bulkHaltRequested = false;
    }
    await this.deps.micArbiter.settleAfterBulkStop(settleWith);
  }

  /**
   * Every check that can refuse a start before a session exists. Runs
   * synchronously, so nothing — a bulk cancel included — can slip in
   * between these checks and registering the session.
   */
  private planStart(params: StartTranslationParams): StartPlan {
    const { direction } = params;
    // A bulk cancel (meeting end, idle timeout, quit) is stopping every
    // native capture; a session started now would lose its capture to
    // that sweep halfway through open().
    if (this.bulkCancelInProgress) {
      throw new Error(t('errors:sessionsStopping'));
    }
    if (params.sourceLanguage === params.targetLanguage) {
      throw new Error(t('errors:sameLanguagePair'));
    }
    const engineId = this.deps.getActiveEngineId();
    const clientParams = this.deps.buildClientStartParams(params, engineId);
    // Mic UID is a Direction × capture concern, not a translation knob —
    // read it from prefs at start time (not over IPC, see ADR-0002 follow-up).
    const prefs = this.deps.getPreferences();
    const microphoneDeviceUid =
      direction === 'speak' ? prefs.preferredMicrophoneUid : undefined;
    // Listen + local TTS playback requires Process Tap to a specific meeting
    // app: otherwise our own TTS would be re-captured by the full-screen
    // ScreenCaptureKit loopback and re-translated forever. Hard-fail at start
    // rather than silently producing garbage subtitles. Checks the mode the
    // renderer actually requested: a synced `listenModePlayTts` without a
    // local source app is legitimately subtitles-only (s2t). A session that
    // asked for the whole system's audio (the test panel) skips the tap, so
    // the same check holds it to s2t.
    const listenSourceAppBundleId =
      direction === 'listen' && !params.captureSystemAudio
        ? prefs.listenSourceAppBundleId
        : undefined;
    if (
      direction === 'listen' &&
      params.mode === 's2s' &&
      !listenSourceAppBundleId
    ) {
      throw new Error(t('errors:listenLoopback'));
    }
    return { engineId, clientParams, microphoneDeviceUid, listenSourceAppBundleId };
  }

  private createSession(
    direction: Direction,
    engineId: EngineId,
    toOverlayToo: boolean
  ): DirectionSession {
    const { deps } = this;
    const { observer } = deps;
    const session: DirectionSession = new DirectionSession(
      direction,
      (onEvent) => {
        const client = deps.createClient(engineId, {
          onEvent,
          onTelemetry: observer
            ? (sample) => observer.telemetry(direction, engineId, sample)
            : undefined,
          tag: direction
        });
        return observer
          ? meterUplink(client, (bytes) =>
              observer.audioSent(direction, engineId, bytes, client.inputSampleRate)
            )
          : client;
      },
      {
        onEvent: (event: TranslationEvent) => {
          observer?.event(event);
          // TTS chunks are the highest-frequency event and only the control
          // window (local monitor / onboarding probe) plays them; the
          // overlay would just structured-clone and drop every chunk.
          if (event.type === 'tts-audio' || !toOverlayToo) {
            deps.sendToControlWindow(IPC.TranslationEvent, event);
          } else {
            deps.broadcast(IPC.TranslationEvent, event);
          }
        },
        onStatus: (payload: TranslationStatusPayload) => {
          observer?.status(payload);
          if (toOverlayToo) {
            deps.broadcast(IPC.TranslationStatus, payload);
          } else {
            deps.sendToControlWindow(IPC.TranslationStatus, payload);
          }
        },
        onTerminated: () => this.onSessionTerminated(direction, session)
      }
    );
    return session;
  }

  private onSessionTerminated(
    direction: Direction,
    session: DirectionSession
  ): void {
    const { registry, micArbiter } = this.deps;
    if (registry.get(direction) === session) {
      registry.delete(direction);
    }
    // Resume mic passthrough once no session owns the mic, so the user's
    // voice flows back into the meeting's virtual input without them
    // switching devices. (DirectionSession has already released the mic +
    // TTS unit by the time this fires.)
    if (
      ownsMicrophone(direction) &&
      !this.bulkCancelInProgress &&
      !registry.has('speak')
    ) {
      void micArbiter.resumeAfterSession();
    }
  }

  /**
   * A start rejected before any DirectionSession took over: no session will
   * ever broadcast a status for this attempt, so settle the renderer's
   * optimistic `connecting` here.
   */
  private broadcastStartRejected(direction: Direction, err: unknown): void {
    // Precondition refusals are plain Errors already localized via t(), so
    // they go out as `unknown` and the renderer shows the message as is.
    this.deps.broadcast(IPC.TranslationStatus, {
      direction,
      status: 'failed',
      errorMessage: err instanceof Error ? err.message : String(err),
      errorKind: errorKindOf(err)
    } satisfies TranslationStatusPayload);
  }
}
