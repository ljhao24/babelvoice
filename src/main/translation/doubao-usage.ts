import {
  addTokens,
  TOKEN_CATEGORIES,
  type TokenCounts
} from '@shared/meeting-metrics-types.js';

/**
 * Slack before running totals are assumed: the server may count a little
 * audio we consider unsent (buffering, timing of the report).
 */
const OVERRUN_RATIO = 1.25;
const OVERRUN_SLACK_MS = 2_000;

const minus = (a: TokenCounts, b: TokenCounts): TokenCounts => {
  const out: TokenCounts = {};
  for (const cat of TOKEN_CATEGORIES) {
    const d = (a[cat] ?? 0) - (b[cat] ?? 0);
    if (d !== 0) out[cat] = d;
  }
  return out;
};

/**
 * Turns Doubao's UsageResponse reports into deltas.
 *
 * The docs don't say whether a report covers its own segment or the whole
 * session so far. The documented example (640 ms of audio, 4 input tokens)
 * reads per-segment, so reports are taken as deltas — until their
 * durations add up to more audio than was ever sent, which only running
 * totals can do. From then on reports are differenced, and the first
 * differenced result corrects what was already passed on (it can be
 * negative).
 */
export class DoubaoUsageTracker {
  private runningTotals = false;
  private durationSum = 0;
  /** Everything passed on so far. */
  private passedOn: TokenCounts = {};

  /** Whether reports turned out to be running totals. */
  get cumulative(): boolean {
    return this.runningTotals;
  }

  /**
   * One report, with the audio sent to the server so far; returns the delta
   * to pass on (null when there is nothing to add).
   */
  report(tokens: TokenCounts, durationMs: number, audioSentMs: number): TokenCounts | null {
    let delta: TokenCounts;
    if (!this.runningTotals) {
      this.durationSum += Math.max(0, durationMs);
      if (this.durationSum > audioSentMs * OVERRUN_RATIO + OVERRUN_SLACK_MS) {
        this.runningTotals = true;
        delta = minus(tokens, this.passedOn);
      } else {
        delta = tokens;
      }
    } else {
      delta = minus(tokens, this.passedOn);
    }
    if (Object.keys(delta).length === 0) return null;
    this.passedOn = addTokens(this.passedOn, delta);
    return delta;
  }
}
