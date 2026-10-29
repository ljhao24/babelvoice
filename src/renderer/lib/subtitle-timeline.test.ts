import { describe, expect, it } from 'vitest';
import type { SentencePair } from '../store/transcript-assembler.js';
import {
  buildTimeline,
  historyGrade,
  lastPairOf,
  PAUSE_GAP_MS,
  splitLive
} from './subtitle-timeline.js';

const pair = (id: string, direction: 'speak' | 'listen', at: number): SentencePair => ({
  id,
  direction,
  src: `src ${id}`,
  tgt: `tgt ${id}`,
  at,
  sessionSeq: 1
});

describe('buildTimeline', () => {
  it('marks speaker runs and ages lines from the newest', () => {
    const items = buildTimeline([
      pair('a', 'listen', 0),
      pair('b', 'listen', 5_000),
      pair('c', 'speak', 9_000),
      pair('d', 'listen', 12_000)
    ]);
    expect(items.map((i) => (i.kind === 'line' ? [i.pair.id, i.groupStart, i.age] : i.kind))).toEqual([
      ['a', true, 3],
      ['b', false, 2],
      ['c', true, 1],
      ['d', true, 0]
    ]);
  });

  it('starts a new run when the numbered speaker changes', () => {
    const items = buildTimeline([
      { ...pair('a', 'listen', 0), speaker: 1 },
      { ...pair('b', 'listen', 1_000), speaker: 1 },
      { ...pair('c', 'listen', 2_000), speaker: 2 },
      { ...pair('d', 'listen', 3_000), speaker: 1 }
    ]);
    expect(items.map((i) => (i.kind === 'line' ? [i.pair.id, i.groupStart] : i.kind))).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
      ['d', true]
    ]);
  });

  it('puts a divider at a pause and restarts the speaker run there', () => {
    const items = buildTimeline([
      pair('a', 'listen', 0),
      pair('b', 'listen', PAUSE_GAP_MS + 1_000)
    ]);
    expect(items.map((i) => (i.kind === 'line' ? `${i.pair.id}:${i.groupStart}` : `pause@${i.at}`))).toEqual([
      'a:true',
      `pause@${PAUSE_GAP_MS + 1_000}`,
      'b:true'
    ]);
  });

  it('only counts silence in the whole conversation as a pause', () => {
    const all = [
      pair('a', 'speak', 0),
      pair('b', 'listen', 15_000),
      pair('c', 'speak', 30_000)
    ];
    // The speak column alone has a 30 s gap, but the other side was talking.
    const speakOnly = buildTimeline(all.filter((p) => p.direction === 'speak'), { context: all });
    expect(speakOnly.some((i) => i.kind === 'pause')).toBe(false);
    expect(
      buildTimeline(all.filter((p) => p.direction === 'speak')).some((i) => i.kind === 'pause')
    ).toBe(true);
  });

  it('is empty for no lines', () => {
    expect(buildTimeline([])).toEqual([]);
  });
});

describe('historyGrade', () => {
  it('steps down from near-live size and fades with age, then settles', () => {
    const newest = historyGrade(0, 22);
    const older = historyGrade(2, 22);
    const old = historyGrade(10, 22);
    expect(newest.fontSize).toBe(16);
    expect(older.fontSize).toBeLessThan(newest.fontSize);
    expect(old.fontSize).toBe(13);
    expect(historyGrade(30, 22).fontSize).toBe(old.fontSize);
    expect(newest.opacity).toBe(1);
    expect(older.opacity).toBeLessThan(1);
    expect(old.opacity).toBe(0.42);
  });

  it('follows the font size setting', () => {
    expect(historyGrade(0, 40).fontSize).toBe(30);
    expect(historyGrade(0, 40).sourceSize).toBe(23);
  });
});

describe('splitLive', () => {
  it('separates the stitched sentence from the in-flight fragment', () => {
    expect(splitLive('Hello there.', 'How are')).toEqual({
      settled: 'Hello there.',
      pending: ' How are'
    });
    expect(splitLive('你好，', '我们开始')).toEqual({ settled: '你好，', pending: '我们开始' });
  });

  it('handles either side missing', () => {
    expect(splitLive('', 'only partial')).toEqual({ settled: '', pending: 'only partial' });
    expect(splitLive('only stitched', '')).toEqual({ settled: 'only stitched', pending: '' });
    expect(splitLive('', '')).toEqual({ settled: '', pending: '' });
  });
});

describe('lastPairOf', () => {
  it('finds the newest line of a direction', () => {
    const pairs = [pair('a', 'listen', 0), pair('b', 'speak', 1), pair('c', 'listen', 2)];
    expect(lastPairOf(pairs, 'speak')?.id).toBe('b');
    expect(lastPairOf(pairs, 'listen')?.id).toBe('c');
    expect(lastPairOf([], 'speak')).toBeNull();
  });
});
