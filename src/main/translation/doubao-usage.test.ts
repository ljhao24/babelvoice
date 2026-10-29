import { describe, expect, it } from 'vitest';
import { addTokens, type TokenCounts } from '@shared/meeting-metrics-types.js';
import { DoubaoUsageTracker } from './doubao-usage.js';

/** Feed reports and sum the deltas, as the MeetingMonitor does. */
const run = (
  reports: [TokenCounts, number, number][]
): { total: TokenCounts; tracker: DoubaoUsageTracker } => {
  const tracker = new DoubaoUsageTracker();
  let total: TokenCounts = {};
  for (const [tokens, durationMs, sentMs] of reports) {
    const delta = tracker.report(tokens, durationMs, sentMs);
    if (delta) total = addTokens(total, delta);
  }
  return { total, tracker };
};

describe('DoubaoUsageTracker', () => {
  it('sums per-segment reports as deltas', () => {
    const { total, tracker } = run([
      [{ inputAudio: 4, outputText: 15 }, 640, 2_000],
      [{ inputAudio: 19, outputText: 30 }, 3_000, 6_000],
      [{ inputAudio: 13, outputText: 22 }, 2_100, 9_000]
    ]);
    expect(tracker.cumulative).toBe(false);
    expect(total).toEqual({ inputAudio: 36, outputText: 67 });
  });

  it('detects running totals once their durations outgrow the audio sent', () => {
    // Running totals at 2 s, 5 s, 8 s, 11 s of a continuously sent stream.
    const { total, tracker } = run([
      [{ inputAudio: 12 }, 2_000, 2_000],
      [{ inputAudio: 31 }, 5_000, 5_000],
      [{ inputAudio: 50 }, 8_000, 8_000],
      [{ inputAudio: 69 }, 11_000, 11_000]
    ]);
    expect(tracker.cumulative).toBe(true);
    // Corrected to the latest running total, not 12 + 31 + 50 + 69.
    expect(total).toEqual({ inputAudio: 69 });
  });

  it('skips a report that adds nothing', () => {
    const tracker = new DoubaoUsageTracker();
    expect(tracker.report({}, 0, 1_000)).toBeNull();
  });
});
