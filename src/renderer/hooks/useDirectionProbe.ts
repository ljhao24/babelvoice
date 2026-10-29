import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SessionStatus,
  StartTranslationParams,
  TranslationEvent
} from '../../shared/ipc-types.js';
import { describeSessionError, formatSessionError } from '../lib/session-error.js';
import { useAppStore } from '../store/app-store.js';
import { useDirectionSession } from './useDirectionSession.js';

/**
 * Onboarding smoke test for one Direction: open a throwaway session with
 * fixed params, watch the event stream until the round trip is proven
 * (speak: TTS played back; listen: a final translation), then stop it.
 * Fails on a session failure, a stimulus error, or a timeout — and never
 * leaves a session or a sample clip running when the step unmounts.
 *
 * The lifecycle lives in `DirectionProbeController` (framework-free, so it
 * is unit-testable with fakes); `useDirectionProbe` binds it to React.
 */

export type ProbePhase =
  | 'idle'
  | 'connecting'
  | 'running'
  | 'finishing'
  | 'done'
  | 'failed';

export interface ProbeResult {
  done: boolean;
  error: string | null;
  /**
   * Latest source / translation text. Kept after the session ends — the
   * store clears its own copy on `session-finished`, but the result panel
   * must stay visible once the test succeeded.
   */
  partials: { src: string; tgt: string };
}

/** Something played into the session once it is open (listen: a sample clip). */
export interface ProbeStimulus {
  /** Settle time between the session opening and `play`, so the first second isn't lost. */
  delayMs: number;
  /** Starts playback and returns its stop; `fail` reports a playback error. */
  play: (fail: (message: string) => void) => () => void;
}

export interface DirectionProbeSpec {
  /** Fixed params: the probe never follows the user's language preferences. */
  params: StartTranslationParams;
  /** The event that proves the full round trip. */
  doneOn: TranslationEvent['type'];
  timeoutMs: number;
  /** `failed`: shown when the session fails without a message of its own. */
  messages: { failed: string; timeout: string };
  stimulus?: ProbeStimulus;
}

export interface DirectionProbeDeps {
  /** Read on use, so copy that follows the locale stays current. */
  spec: () => DirectionProbeSpec;
  /** Resolves false when the session did not open (see useDirectionSession). */
  startSession: () => Promise<boolean>;
  stopSession: () => Promise<void>;
  subscribe: (listener: (event: TranslationEvent) => void) => () => void;
}

const IDLE_RESULT: ProbeResult = {
  done: false,
  error: null,
  partials: { src: '', tgt: '' }
};

/** What the probe card shows: its own verdict first, then the live session status. */
export const probePhase = (result: ProbeResult, status: SessionStatus): ProbePhase => {
  if (result.done) return 'done';
  if (result.error) return 'failed';
  if (status === 'connecting') return 'connecting';
  if (status === 'running') return 'running';
  if (status === 'finishing' || status === 'cancelling') return 'finishing';
  return 'idle';
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class DirectionProbeController {
  private result: ProbeResult = IDLE_RESULT;
  private readonly listeners = new Set<() => void>();
  /** Listening to the event stream: from `start` until `stop` / `dispose`. */
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopStimulus: (() => void) | null = null;
  /**
   * True while a session this probe started may still be running and
   * nobody has asked it to stop yet — what `dispose` must clean up.
   */
  private ownsSession = false;
  /** Bumped by every start / stop / dispose; stale async continuations bail. */
  private run = 0;

  constructor(private readonly deps: DirectionProbeDeps) {}

  /** useSyncExternalStore contract. */
  readonly subscribeResult = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getResult = (): ProbeResult => this.result;

  readonly start = async (): Promise<void> => {
    const run = ++this.run;
    this.disarm();
    this.halt();
    this.update(IDLE_RESULT);
    const spec = this.deps.spec();
    this.unsubscribe = this.deps.subscribe(this.onEvent);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fail(this.deps.spec().messages.timeout, true);
    }, spec.timeoutMs);
    this.ownsSession = true;
    if (!(await this.deps.startSession())) {
      // The failure itself arrives through the session status; never play
      // a stimulus into a session that didn't open.
      if (run === this.run) this.ownsSession = false;
      return;
    }
    const { stimulus } = this.deps.spec();
    if (!stimulus) return;
    await delay(stimulus.delayMs);
    // Stopped, finished, failed or unmounted while we waited.
    if (run !== this.run || !this.ownsSession) return;
    this.stopStimulus = stimulus.play((message) => {
      if (run === this.run && this.ownsSession) this.fail(message, true);
    });
  };

  readonly stop = async (): Promise<void> => {
    this.run++;
    this.disarm();
    this.halt();
    this.ownsSession = false;
    await this.deps.stopSession();
  };

  /** The step unmounted (Skip, step change): don't leave the mic or the clip running. */
  readonly dispose = (): void => {
    this.run++;
    this.disarm();
    this.halt();
    if (this.ownsSession) {
      this.ownsSession = false;
      void this.deps.stopSession();
    }
  };

  /** The session reported `failed`; only counts while the probe is listening. */
  readonly sessionFailed = (message: string | null): void => {
    if (!this.unsubscribe) return;
    this.fail(message ?? this.deps.spec().messages.failed, false);
  };

  private readonly onEvent = (event: TranslationEvent): void => {
    const { params, doneOn } = this.deps.spec();
    if (event.direction !== params.direction) return;
    if (
      event.type === 'source-subtitle-delta' ||
      event.type === 'source-subtitle-final'
    ) {
      this.update({ partials: { ...this.result.partials, src: event.text } });
    } else if (
      event.type === 'translation-subtitle-delta' ||
      event.type === 'translation-subtitle-final'
    ) {
      this.update({ partials: { ...this.result.partials, tgt: event.text } });
    }
    if (event.type === doneOn) {
      this.clearTimer();
      this.update({ done: true });
      // Auto-stop — no need for the user to press stop.
      this.release();
    }
  };

  /**
   * Record a failure. `release`: the session is still ours and alive
   * (timeout, stimulus error) — stop it; a session that failed on its own
   * has nothing left to stop.
   */
  private fail(message: string, release: boolean): void {
    this.clearTimer();
    this.update({ error: message });
    if (release) this.release();
  }

  private release(): void {
    this.halt();
    if (!this.ownsSession) return;
    this.ownsSession = false;
    void this.deps.stopSession();
  }

  /** Stop listening for events and the timeout. */
  private disarm(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Stop the stimulus, if one is playing. */
  private halt(): void {
    this.stopStimulus?.();
    this.stopStimulus = null;
  }

  private update(patch: Partial<ProbeResult>): void {
    this.result = { ...this.result, ...patch };
    this.listeners.forEach((l) => l());
  }
}

export interface DirectionProbe {
  phase: ProbePhase;
  error: string | null;
  partials: ProbeResult['partials'];
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export const useDirectionProbe = (spec: DirectionProbeSpec): DirectionProbe => {
  const specRef = useRef(spec);
  specRef.current = spec;
  const direction = spec.params.direction;

  const buildParams = useCallback(
    (): StartTranslationParams => specRef.current.params,
    []
  );
  // transient: re-running onboarding mid-meeting must not write the probe's
  // test sentence into that meeting's transcript.
  const session = useDirectionSession(direction, buildParams, {
    transient: true
  });
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const { t } = useTranslation();
  const status = useAppStore((s) => s[direction].status);
  const lastError = useAppStore((s) => s[direction].lastError);
  const lastErrorKind = useAppStore((s) => s[direction].lastErrorKind);

  const [probe] = useState(
    () =>
      new DirectionProbeController({
        spec: () => specRef.current,
        startSession: () => sessionRef.current.start(),
        stopSession: () => sessionRef.current.stop(),
        subscribe: (listener) => window.babelVoiceBridge.onTranslationEvent(listener)
      })
  );
  const result = useSyncExternalStore(probe.subscribeResult, probe.getResult);

  useEffect(() => {
    if (status !== 'failed') return;
    probe.sessionFailed(
      lastError === null
        ? null
        : formatSessionError(t, describeSessionError(t, lastErrorKind, lastError))
    );
  }, [probe, status, lastError, lastErrorKind, t]);

  useEffect(() => probe.dispose, [probe]);

  return {
    phase: probePhase(result, status),
    error: result.error,
    partials: result.partials,
    start: probe.start,
    stop: probe.stop
  };
};
