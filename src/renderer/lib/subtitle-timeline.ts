import type { Direction } from '@shared/ipc-types.js';
import { joinFragment, type SentencePair } from '../store/transcript-assembler.js';

/** A silence this long between two sentences gets a time divider. */
export const PAUSE_GAP_MS = 20_000;

export type TimelineItem =
  | { kind: 'pause'; id: string; at: number }
  | {
      kind: 'line';
      pair: SentencePair;
      /** First line of a run by the same speaker (Direction + number): show who. */
      groupStart: boolean;
      /** 0 = the newest line, 1 the one before… — drives the fade. */
      age: number;
    };

/**
 * Committed sentences as the overlay lists them: oldest first, a divider
 * wherever the conversation paused, and speaker runs marked so a merged
 * two-Direction timeline only names the speaker when it changes.
 *
 * A pause is silence in the whole conversation (`context`, default `pairs`):
 * a column showing one Direction mustn't call the other side's turn a pause.
 */
export const buildTimeline = (
  pairs: readonly SentencePair[],
  { pauseMs = PAUSE_GAP_MS, context = pairs }: { pauseMs?: number; context?: readonly SentencePair[] } = {}
): TimelineItem[] => {
  const previousAt = new Map<string, number>();
  context.forEach((p, i) => {
    if (i > 0) previousAt.set(p.id, context[i - 1].at);
  });
  const items: TimelineItem[] = [];
  let prev: SentencePair | null = null;
  pairs.forEach((pair, i) => {
    const before = previousAt.get(pair.id) ?? prev?.at;
    const paused = prev !== null && before !== undefined && pair.at - before >= pauseMs;
    if (paused) items.push({ kind: 'pause', id: `pause-${pair.id}`, at: pair.at });
    items.push({
      kind: 'line',
      pair,
      groupStart:
        prev === null ||
        paused ||
        prev.direction !== pair.direction ||
        prev.speaker !== pair.speaker,
      age: pairs.length - 1 - i
    });
    prev = pair;
  });
  return items;
};

export interface HistoryGrade {
  /** Translation size in px. */
  fontSize: number;
  /** Source size in px. */
  sourceSize: number;
  opacity: number;
}

/** How many of the newest lines step down in size before the rest settle. */
const GRADE_STEPS = 3;
const NEWEST_SCALE = 0.74;
const SETTLED_SCALE = 0.6;
const MIN_OPACITY = 0.42;

/**
 * Newest history line nearly the live size, older ones smaller and fainter,
 * so a sentence leaving the live area doesn't jump from 22 px to 13 px and
 * the eye can tell recent from old at a glance.
 */
export const historyGrade = (age: number, liveFontSize: number): HistoryGrade => {
  const step = Math.min(age, GRADE_STEPS) / GRADE_STEPS;
  const scale = NEWEST_SCALE - (NEWEST_SCALE - SETTLED_SCALE) * step;
  const fontSize = Math.max(13, Math.round(liveFontSize * scale));
  return {
    fontSize,
    sourceSize: Math.max(11, Math.round(fontSize * 0.78)),
    opacity: Math.max(MIN_OPACITY, 1 - age * 0.12)
  };
};

/**
 * The live text split at the point where it can still change: `settled`
 * is the stitched sentence-so-far, `pending` the in-flight ASR fragment
 * (with the joining space, if any). `settled + pending` is exactly what
 * `joinFragment` shows.
 */
export const splitLive = (
  stitched: string,
  partial: string
): { settled: string; pending: string } => {
  const joined = joinFragment(stitched, partial);
  if (!partial) return { settled: joined, pending: '' };
  if (!stitched) return { settled: '', pending: joined };
  const settled = joined.startsWith(stitched) ? stitched : stitched.trimEnd();
  return { settled, pending: joined.slice(settled.length) };
};

/** The newest committed sentence of `direction`, if any. */
export const lastPairOf = (
  pairs: readonly SentencePair[],
  direction: Direction
): SentencePair | null => {
  for (let i = pairs.length - 1; i >= 0; i--) {
    if (pairs[i].direction === direction) return pairs[i];
  }
  return null;
};

/** Clock label for a pause divider. */
export const formatPauseTime = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
