import type { Direction } from '@shared/ipc-types.js';

/**
 * Pure, per-direction transcript assembly: pairs source/translation finals,
 * stitches the pairs into sentences and decides when a sentence is done.
 *
 * Every function takes a `DirectionTranscript` and returns a new one (or the
 * same object when nothing changed) — no module state, no IPC. Closed
 * sentences come back as `committed`; the caller (app-store) appends them to
 * history and persists them outside its `set` updater.
 */

export interface SentencePair {
  id: string;
  direction: Direction;
  src: string;
  tgt: string;
  at: number;
  sessionSeq: number;
  /** Who said it, when the engine tells speakers apart (1, 2, …). */
  speaker?: number;
}

/** The sentence-so-far: paired fragments waiting for a boundary. */
export interface StitchBuffer {
  id: string;
  src: string;
  tgt: string;
  startedAt: number;
  sessionSeq: number;
  speaker?: number;
}

/** A source final waiting for its translation. */
export interface SourceFinal {
  text: string;
  speaker?: number;
}

export interface DirectionTranscript {
  direction: Direction;
  /**
   * Finals queue up per side and pair FIFO. The source and translation
   * pipelines aren't lockstep (Qwen runs ASR and translation as separate
   * streams), so a single overwrite slot dropped a sentence whenever one side
   * ran two finals ahead — and misaligned every pair after it.
   */
  pendingSrc: readonly SourceFinal[];
  pendingTgt: readonly string[];
  stitch: StitchBuffer | null;
  /** Bumped on every `session-started`; back to 0 when a new meeting opens. */
  sessionSeq: number;
  /**
   * Throwaway session (the onboarding probe). Its text still assembles and
   * renders live, but is never committed to the meeting's history or the DB
   * — a re-run of onboarding mid-meeting must not leave "说一句中文" test
   * lines in the real transcript.
   */
  transient: boolean;
}

export const createTranscript = (direction: Direction): DirectionTranscript => ({
  direction,
  pendingSrc: [],
  pendingTgt: [],
  stitch: null,
  sessionSeq: 0,
  transient: false
});

/** Injected so tests can pin ids and time; the store uses `systemClock`. */
export interface TranscriptClock {
  now: () => number;
  newId: () => string;
}

export const systemClock: TranscriptClock = {
  now: () => Date.now(),
  newId: () => crypto.randomUUID()
};

export interface TranscriptStep {
  transcript: DirectionTranscript;
  /** Sentences closed by this step, oldest first. Always empty while transient. */
  committed: SentencePair[];
}

export interface FinalStep extends TranscriptStep {
  /**
   * At least one source/translation pair was folded into the stitched
   * sentence — the live partials it came from are now part of `stitch`.
   */
  paired: boolean;
}

// Terminal punctuation marks the end of a logical sentence; an optional
// closing quote/bracket may trail. We test against the trimmed source text.
const TERMINAL_RE = /[。！？!?.…]['"’”)\]）】」』]?$/;
export const isSentenceEnd = (s: string): boolean => TERMINAL_RE.test(s.trimEnd());

/**
 * Safety valves for ASR that never emits terminal punctuation: without them
 * a whole meeting would stitch into one ever-growing line. Checked whenever
 * a fragment lands (no timers), so an unpunctuated sentence is cut at the
 * first fragment past either limit.
 */
export const MAX_STITCH_CHARS = 200;
export const MAX_STITCH_MS = 15_000;

// Chinese / Japanese script, CJK punctuation and full-width forms: text that
// is written without spaces between words. Hangul is deliberately excluded —
// Korean does use spaces.
const CJ_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;
// Full-width punctuation carries its own spacing on either side.
const FULLWIDTH_PUNCT_RE = /[　-〿＀-￯]/;

/** Join two ASR fragments; CJK runs are glued without a space. */
export const joinFragment = (prev: string, next: string): string => {
  if (!prev) return next;
  if (!next) return prev;
  const tail = prev.trimEnd();
  const head = next.trimStart();
  const last = tail.slice(-1);
  const first = head.charAt(0);
  if (
    (CJ_RE.test(last) && CJ_RE.test(first)) ||
    FULLWIDTH_PUNCT_RE.test(last) ||
    FULLWIDTH_PUNCT_RE.test(first)
  ) {
    return `${tail}${head}`;
  }
  return `${prev} ${next}`;
};

/** Two known, different speakers. An unknown one changes nothing. */
const speakerChanged = (a: number | undefined, b: number | undefined): boolean =>
  a !== undefined && b !== undefined && a !== b;

const stitchFragment = (
  t: DirectionTranscript,
  stitch: StitchBuffer | null,
  fragSrc: SourceFinal,
  fragTgt: string,
  clock: TranscriptClock
): StitchBuffer => {
  const speaker = stitch?.speaker ?? fragSrc.speaker;
  if (!stitch) {
    return {
      id: clock.newId(),
      src: fragSrc.text,
      tgt: fragTgt,
      startedAt: clock.now(),
      sessionSeq: t.sessionSeq,
      ...(speaker === undefined ? {} : { speaker })
    };
  }
  return {
    ...stitch,
    src: joinFragment(stitch.src, fragSrc.text),
    tgt: joinFragment(stitch.tgt, fragTgt),
    ...(speaker === undefined ? {} : { speaker })
  };
};

const toPair = (direction: Direction, buf: StitchBuffer): SentencePair => ({
  id: buf.id,
  direction,
  src: buf.src,
  tgt: buf.tgt,
  at: buf.startedAt,
  sessionSeq: buf.sessionSeq,
  ...(buf.speaker === undefined ? {} : { speaker: buf.speaker })
});

/** A new session started in this direction (`session-started`). */
export const beginSession = (t: DirectionTranscript): DirectionTranscript => ({
  ...t,
  sessionSeq: t.sessionSeq + 1
});

export const setTransient = (
  t: DirectionTranscript,
  transient: boolean
): DirectionTranscript => (t.transient === transient ? t : { ...t, transient });

/**
 * A different meeting opened: drop in-flight finals, the stitched sentence
 * and the session counter. The transient flag belongs to the running
 * session, not the meeting, so it survives.
 */
export const resetForMeeting = (t: DirectionTranscript): DirectionTranscript => ({
  ...createTranscript(t.direction),
  transient: t.transient
});

/**
 * Queue one final and fold every complete src/tgt pair into the stitched
 * sentence, closing it at terminal punctuation, either stitch cap or a
 * change of speaker. `speaker` only means something on a source final.
 */
export const pushFinal = (
  t: DirectionTranscript,
  side: 'src' | 'tgt',
  text: string,
  clock: TranscriptClock = systemClock,
  speaker?: number
): FinalStep => {
  const final: SourceFinal = speaker === undefined ? { text } : { text, speaker };
  const pendingSrc = side === 'src' ? [...t.pendingSrc, final] : [...t.pendingSrc];
  const pendingTgt = side === 'tgt' ? [...t.pendingTgt, text] : [...t.pendingTgt];
  const committed: SentencePair[] = [];
  let stitch = t.stitch;
  let paired = false;
  while (pendingSrc.length > 0 && pendingTgt.length > 0) {
    const src = pendingSrc.shift()!;
    // Someone else talking starts a new sentence, whatever the punctuation.
    if (stitch && speakerChanged(stitch.speaker, src.speaker)) {
      if (!t.transient) committed.push(toPair(t.direction, stitch));
      stitch = null;
    }
    const updated = stitchFragment(t, stitch, src, pendingTgt.shift()!, clock);
    paired = true;
    const overlong =
      Math.max(updated.src.length, updated.tgt.length) >= MAX_STITCH_CHARS ||
      clock.now() - updated.startedAt >= MAX_STITCH_MS;
    if (isSentenceEnd(updated.src) || overlong) {
      if (!t.transient) committed.push(toPair(t.direction, updated));
      stitch = null;
    } else {
      stitch = updated;
    }
  }
  return {
    transcript: { ...t, pendingSrc, pendingTgt, stitch },
    committed,
    paired
  };
};

/**
 * Close out a direction's in-flight text: fold any unpaired finals into the
 * stitched sentence, commit it, and reset the queues. Runs on every session
 * boundary (finished / failed / cancelled / next session starting) and when
 * the meeting ends, so text from one session can never be glued onto the
 * next one.
 */
export const settle = (
  t: DirectionTranscript,
  clock: TranscriptClock = systemClock
): TranscriptStep => {
  const hasPending = t.pendingSrc.length > 0 || t.pendingTgt.length > 0;
  if (!hasPending && !t.stitch) return { transcript: t, committed: [] };
  const committed: SentencePair[] = [];
  let stitch = t.stitch;
  if (hasPending) {
    // Unpaired finals can't be split by speaker (the translations carry
    // none); they go out as one line, under their first known speaker.
    const speaker = t.pendingSrc.find((f) => f.speaker !== undefined)?.speaker;
    if (stitch && speakerChanged(stitch.speaker, speaker)) {
      committed.push(toPair(t.direction, stitch));
      stitch = null;
    }
    const text = t.pendingSrc.map((f) => f.text).reduce(joinFragment, '');
    stitch = stitchFragment(
      t,
      stitch,
      speaker === undefined ? { text } : { text, speaker },
      t.pendingTgt.reduce(joinFragment, ''),
      clock
    );
  }
  committed.push(toPair(t.direction, stitch!));
  return {
    transcript: { ...t, pendingSrc: [], pendingTgt: [], stitch: null },
    committed: t.transient ? [] : committed
  };
};

/**
 * Append committed lines to a history capped at `limit` (oldest dropped).
 * Returns `history` itself when there is nothing to add, so store selectors
 * on it stay referentially stable.
 */
export const appendHistory = (
  history: SentencePair[],
  lines: readonly SentencePair[],
  limit: number
): SentencePair[] => {
  if (lines.length === 0) return history;
  const next = [...history, ...lines];
  return next.length > limit ? next.slice(next.length - limit) : next;
};
