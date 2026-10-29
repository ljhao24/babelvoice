import { create } from 'zustand';
import type {
  Direction,
  SessionStatus,
  TranslationEvent
} from '@shared/ipc-types.js';
import type { TranslationErrorKind } from '@shared/translation-error-types.js';
import type { MeetingMetricsSnapshot } from '@shared/meeting-metrics-types.js';
import type { UserPreferences } from '@shared/config-types.js';
import { DEFAULT_PREFERENCES } from '@shared/config-types.js';
import {
  EMPTY_CREDENTIAL_STATUS,
  type CredentialStatus
} from '@shared/engine-types.js';
import type { Meeting } from '@shared/meeting-types.js';
import {
  appendHistory,
  beginSession,
  createTranscript,
  pushFinal,
  resetForMeeting,
  setTransient,
  settle,
  systemClock,
  type DirectionTranscript,
  type SentencePair
} from './transcript-assembler.js';

export type { SessionStatus, SentencePair };
export { MAX_STITCH_CHARS, MAX_STITCH_MS } from './transcript-assembler.js';

export interface SessionSlice {
  active: boolean;
  status: SessionStatus;
  /** Raw technical message of the last failure (main's, never localized here). */
  lastError: string | null;
  /** Main's classification of that failure; the UI localizes by it. */
  lastErrorKind: TranslationErrorKind | null;
  /** Latest in-flight delta (resets on each new fragment / clears on collect). */
  partialSrc: string;
  partialTgt: string;
  /** Sentence-so-far: concatenated finalized fragments waiting for a boundary. */
  stitchedSrc: string;
  stitchedTgt: string;
  /** Who is saying the source line in flight, when the engine tells speakers apart. */
  speaker?: number;
}

const emptySlice: SessionSlice = {
  active: false,
  status: 'idle',
  lastError: null,
  lastErrorKind: null,
  partialSrc: '',
  partialTgt: '',
  stitchedSrc: '',
  stitchedTgt: ''
};

interface AppState {
  speak: SessionSlice;
  listen: SessionSlice;
  /**
   * Pairs from the *active* meeting, capped at `historyLimit` (older lines
   * are already persisted and visible in the meeting replay).
   */
  history: SentencePair[];

  /**
   * Per-direction assembly state behind `history` and the slices' stitched
   * text: queued finals, the sentence-so-far, session seq, probe flag (see
   * transcript-assembler.ts). Only the store's actions touch it; components
   * render the slices.
   */
  transcript: Record<Direction, DirectionTranscript>;

  /**
   * The control window keeps a long live transcript; the subtitle overlay
   * only ever shows the last few pairs and lowers this so its store doesn't
   * grow for the app's whole lifetime (it never sees meeting boundaries).
   */
  historyLimit: number;

  /**
   * Only the main control window persists transcript lines. The subtitle
   * overlay runs an independent renderer + store and would otherwise double
   * every INSERT because it also subscribes to translation events.
   */
  persistTranscript: boolean;

  currentMeeting: Meeting | null;

  /** Transient on-screen message; cleared after a few seconds by the UI. */
  toast: { id: string; text: string; at: number } | null;

  preferences: UserPreferences;
  preferencesLoaded: boolean;

  /**
   * Which engines have credentials configured — presence flags + key tails
   * only, plaintext keys never reach the renderer. `loaded` flips once the
   * first `getCredentialStatus` answer (or failure) lands.
   */
  credentialStatus: CredentialStatus;
  credentialStatusLoaded: boolean;

  /** Whether the subtitle overlay window is showing; main is authoritative. */
  subtitleOverlayVisible: boolean;

  /** The open meeting's link / usage / cost snapshot (MeetingMonitor in main). */
  meetingMetrics: MeetingMetricsSnapshot | null;

  setSessionStatus: (
    direction: Direction,
    status: SessionStatus,
    err?: string | null,
    errKind?: TranslationErrorKind | null
  ) => void;
  pushEvent: (event: TranslationEvent) => void;
  setDirectionTransient: (direction: Direction, transient: boolean) => void;
  setHistoryLimit: (limit: number) => void;
  enableMeetingPersistence: () => void;

  setCurrentMeeting: (m: Meeting | null) => void;
  pushToast: (text: string) => void;
  dismissToast: (id: string) => void;

  applyPreferences: (prefs: UserPreferences) => void;
  applyCredentialStatus: (status: CredentialStatus) => void;
  applySubtitleOverlayVisible: (visible: boolean) => void;
  applyMeetingMetrics: (snapshot: MeetingMetricsSnapshot | null) => void;
}

const clearLiveText = (slice: SessionSlice): SessionSlice => ({
  ...slice,
  partialSrc: '',
  partialTgt: '',
  stitchedSrc: '',
  stitchedTgt: '',
  speaker: undefined
});

/**
 * `meetingId` travels with the line so the flush that runs *after* main has
 * ended the meeting (end button, idle timeout) still lands in that meeting
 * instead of being dropped as "no active meeting".
 */
const appendMeetingLines = (
  lines: readonly SentencePair[],
  meetingId: string | undefined
): void => {
  if (typeof window === 'undefined' || !window.babelVoiceBridge) return;
  for (const line of lines) {
    window.babelVoiceBridge
      .appendMeetingLine({
        id: line.id,
        meetingId,
        direction: line.direction,
        src: line.src,
        tgt: line.tgt,
        at: line.at,
        sessionSeq: line.sessionSeq,
        speaker: line.speaker
      })
      .catch((err: unknown) => {
        console.error('[meeting] appendMeetingLine failed', err);
      });
  }
};

export const useAppStore = create<AppState>((set, get) => {
  /**
   * Persist lines a transcript step committed. Actions call this only
   * *after* `set` has landed the state the lines belong to — the updater
   * stays free of IPC.
   */
  const persist = (
    lines: readonly SentencePair[],
    meetingId: string | undefined
  ): void => {
    if (lines.length === 0 || !get().persistTranscript) return;
    appendMeetingLines(lines, meetingId);
  };

  /**
   * Session boundary for one direction: settle its transcript (commit the
   * sentence-so-far), clear the live text and land `slice` in one `set`.
   */
  const settleDirection = (
    direction: Direction,
    slice: SessionSlice,
    { endTransient }: { endTransient: boolean }
  ): void => {
    const st = get();
    const step = settle(st.transcript[direction]);
    const transcript = endTransient
      ? setTransient(step.transcript, false)
      : step.transcript;
    set({
      history: appendHistory(st.history, step.committed, st.historyLimit),
      transcript: { ...st.transcript, [direction]: transcript },
      [direction]: clearLiveText(slice)
    });
    persist(step.committed, st.currentMeeting?.id);
  };

  return {
    speak: { ...emptySlice },
    listen: { ...emptySlice },
    history: [],
    transcript: {
      speak: createTranscript('speak'),
      listen: createTranscript('listen')
    },
    historyLimit: 1000,
    persistTranscript: false,
    currentMeeting: null,
    toast: null,
    preferences: { ...DEFAULT_PREFERENCES },
    preferencesLoaded: false,
    credentialStatus: EMPTY_CREDENTIAL_STATUS,
    credentialStatusLoaded: false,
    subtitleOverlayVisible: false,
    meetingMetrics: null,

    applyPreferences: (prefs) =>
      set({ preferences: prefs, preferencesLoaded: true }),
    applyCredentialStatus: (status) =>
      set({ credentialStatus: status, credentialStatusLoaded: true }),
    applySubtitleOverlayVisible: (visible) =>
      set({ subtitleOverlayVisible: visible }),
    applyMeetingMetrics: (snapshot) => set({ meetingMetrics: snapshot }),

    setDirectionTransient: (direction, transient) =>
      set((st) => {
        const next = setTransient(st.transcript[direction], transient);
        return next === st.transcript[direction]
          ? st
          : { transcript: { ...st.transcript, [direction]: next } };
      }),

    setHistoryLimit: (limit) =>
      set({ historyLimit: Math.max(1, Math.floor(limit)) }),

    enableMeetingPersistence: () => set({ persistTranscript: true }),

    setSessionStatus: (direction, status, err, errKind) => {
      const next: SessionSlice = {
        ...get()[direction],
        status,
        active: status === 'running' || status === 'finishing',
        lastError: err ?? (status === 'failed' ? 'unknown' : null),
        lastErrorKind: err || status === 'failed' ? (errKind ?? null) : null
      };
      // Session boundary: a cancelled session never delivers its
      // session-finished event, so settle here too — otherwise its partials
      // linger on the overlay and get glued onto the next session's text.
      if (status === 'connecting' || status === 'idle' || status === 'failed') {
        // The throwaway session (if any) is over once it has settled.
        settleDirection(direction, next, { endTransient: status !== 'connecting' });
        return;
      }
      set({ [direction]: next });
    },

    setCurrentMeeting: (m) => {
      const st = get();
      if (m === null) {
        if (st.currentMeeting === null) return;
        // Meeting ended — persist any in-progress sentences into the meeting
        // that just ended before dropping local state.
        const meetingId = st.currentMeeting.id;
        const speak = settle(st.transcript.speak);
        const listen = settle(st.transcript.listen);
        set({
          currentMeeting: null,
          history: [],
          transcript: { speak: speak.transcript, listen: listen.transcript },
          speak: clearLiveText(st.speak),
          listen: clearLiveText(st.listen)
        });
        persist([...speak.committed, ...listen.committed], meetingId);
        return;
      }
      // Same meeting re-hydrated (control page remount, window refocus):
      // keep in-flight finals, the stitched sentence and session seq —
      // resetting them would drop the sentence being spoken and misalign
      // every pair after it.
      if (st.currentMeeting?.id === m.id) {
        set({ currentMeeting: m });
        return;
      }
      // New meeting opened — reset in-flight assembly state.
      set({
        currentMeeting: m,
        history: [],
        transcript: {
          speak: resetForMeeting(st.transcript.speak),
          listen: resetForMeeting(st.transcript.listen)
        }
      });
    },

    pushToast: (text) =>
      set({ toast: { id: crypto.randomUUID(), text, at: Date.now() } }),

    dismissToast: (id) =>
      set((st) => (st.toast?.id === id ? { toast: null } : {})),

    pushEvent: (event) => {
      const st = get();
      const direction = event.direction;
      const slice = st[direction];
      switch (event.type) {
        case 'session-started':
          set({
            transcript: {
              ...st.transcript,
              [direction]: beginSession(st.transcript[direction])
            },
            [direction]: { ...slice, lastError: null, lastErrorKind: null }
          });
          return;
        case 'session-finished':
          // Status/active are driven by IPC.TranslationStatus; this branch
          // only flushes pending text and clears in-flight buffers.
          settleDirection(direction, slice, { endTransient: false });
          return;
        case 'session-failed':
          settleDirection(
            direction,
            { ...slice, lastError: event.message, lastErrorKind: event.kind },
            { endTransient: false }
          );
          return;
        case 'source-subtitle-start':
          if (slice.speaker !== event.speaker) {
            set({ [direction]: { ...slice, speaker: event.speaker } });
          }
          return;
        case 'source-subtitle-delta':
          set({ [direction]: { ...slice, partialSrc: event.text } });
          return;
        case 'translation-subtitle-delta':
          set({ [direction]: { ...slice, partialTgt: event.text } });
          return;
        case 'source-subtitle-final':
        case 'translation-subtitle-final': {
          const isSource = event.type === 'source-subtitle-final';
          const step = isSource
            ? pushFinal(st.transcript[direction], 'src', event.text, systemClock, event.speaker)
            : pushFinal(st.transcript[direction], 'tgt', event.text);
          const { stitch } = step.transcript;
          let nextSlice: SessionSlice;
          if (step.paired) {
            // Clear the in-flight delta so the live caption doesn't double-render
            // the fragment we just folded into the stitched buffer.
            nextSlice = {
              ...slice,
              partialSrc: '',
              partialTgt: '',
              stitchedSrc: stitch?.src ?? '',
              stitchedTgt: stitch?.tgt ?? ''
            };
          } else {
            nextSlice = isSource
              ? { ...slice, partialSrc: event.text }
              : { ...slice, partialTgt: event.text };
          }
          set({
            history: appendHistory(st.history, step.committed, st.historyLimit),
            transcript: { ...st.transcript, [direction]: step.transcript },
            [direction]: nextSlice
          });
          persist(step.committed, st.currentMeeting?.id);
          return;
        }
        default:
          // TTS chunks, usage, sentence markers... nothing the UI renders from
          // the store. Skipping `set` avoids a subscriber fan-out on the
          // highest-frequency event type.
          return;
      }
    }
  };
});

/**
 * Imperative entry points for code outside React (renderer entry files,
 * session commands); each forwards to the store action of the same name.
 */
export const setHistoryLimit = (limit: number): void =>
  useAppStore.getState().setHistoryLimit(limit);

export const enableMeetingPersistence = (): void =>
  useAppStore.getState().enableMeetingPersistence();

/**
 * Mark `direction` as carrying a throwaway session (the onboarding probe).
 * Its text still renders live, but is never added to the meeting's history
 * or written to the DB. Cleared automatically once that direction settles
 * back to idle/failed.
 */
export const setDirectionTransient = (
  direction: Direction,
  transient: boolean
): void => useAppStore.getState().setDirectionTransient(direction, transient);
