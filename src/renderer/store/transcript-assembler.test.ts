import { describe, expect, it } from 'vitest';
import {
  MAX_STITCH_CHARS,
  MAX_STITCH_MS,
  appendHistory,
  beginSession,
  createTranscript,
  isSentenceEnd,
  joinFragment,
  pushFinal,
  resetForMeeting,
  setTransient,
  settle,
  type DirectionTranscript,
  type SentencePair,
  type TranscriptClock
} from './transcript-assembler.js';

/** Deterministic clock: ids count up, time only moves when told to. */
const fakeClock = (start = 1_000): TranscriptClock & { advance: (ms: number) => void } => {
  let now = start;
  let seq = 0;
  return {
    now: () => now,
    newId: () => `id-${++seq}`,
    advance: (ms) => {
      now += ms;
    }
  };
};

/** Feed alternating or arbitrary finals; collects everything committed. */
const feed = (
  t: DirectionTranscript,
  finals: Array<['src' | 'tgt', string]>,
  clock: TranscriptClock
): { transcript: DirectionTranscript; committed: SentencePair[] } => {
  let cur = t;
  const committed: SentencePair[] = [];
  for (const [side, text] of finals) {
    const step = pushFinal(cur, side, text, clock);
    cur = step.transcript;
    committed.push(...step.committed);
  }
  return { transcript: cur, committed };
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

describe('joinFragment', () => {
  it('glues CJK fragments without a space but keeps spaces for Latin text', () => {
    expect(joinFragment('我们今天', '讨论预算')).toBe('我们今天讨论预算');
    expect(joinFragment('会议开始了，', 'OK')).toBe('会议开始了，OK');
    expect(joinFragment('今日は', 'いい天気')).toBe('今日はいい天気');
    expect(joinFragment('we are', 'aligned')).toBe('we are aligned');
    expect(joinFragment('API', '设计')).toBe('API 设计');
    expect(joinFragment('안녕하세요', '여러분')).toBe('안녕하세요 여러분');
  });

  it('trims the seam when gluing CJK text', () => {
    expect(joinFragment('我们 ', ' 今天')).toBe('我们今天');
    expect(joinFragment('好的。 ', 'Next')).toBe('好的。Next');
  });

  it('returns the other side when one is empty', () => {
    expect(joinFragment('', 'next')).toBe('next');
    expect(joinFragment('prev', '')).toBe('prev');
    expect(joinFragment('', '')).toBe('');
  });
});

describe('isSentenceEnd', () => {
  it('recognises terminal punctuation, optionally followed by a closer', () => {
    for (const s of ['Done.', 'Really?', 'Wow!', '好。', '真的吗？', '太好了！', 'Hmm…', 'He said "ok."', '(fine.)', '「はい。」']) {
      expect(isSentenceEnd(s)).toBe(true);
    }
  });

  it('accepts a curly closing quote after the terminal', () => {
    for (const s of ['他说“好。”', 'She said “fine.”', 'It’s ‘done.’']) {
      expect(isSentenceEnd(s)).toBe(true);
    }
  });

  it('ignores trailing whitespace', () => {
    expect(isSentenceEnd('Done.  ')).toBe(true);
  });

  it('treats commas and bare text as unfinished', () => {
    for (const s of ['and then', '然后，', 'so,', '']) {
      expect(isSentenceEnd(s)).toBe(false);
    }
  });
});

describe('pushFinal', () => {
  it('pairs finals FIFO when the source side runs ahead', () => {
    const clock = fakeClock();
    const { committed, transcript } = feed(
      createTranscript('listen'),
      [
        ['src', 'One.'],
        ['src', 'Two.'],
        ['tgt', '一。'],
        ['tgt', '二。']
      ],
      clock
    );
    expect(committed.map((p) => [p.src, p.tgt])).toEqual([
      ['One.', '一。'],
      ['Two.', '二。']
    ]);
    expect(transcript).toMatchObject({ pendingSrc: [], pendingTgt: [], stitch: null });
  });

  it('pairs finals FIFO when the translation side runs ahead', () => {
    const { committed } = feed(
      createTranscript('speak'),
      [
        ['tgt', 'One.'],
        ['tgt', 'Two.'],
        ['tgt', 'Three.'],
        ['src', '一。'],
        ['src', '二。']
      ],
      fakeClock()
    );
    expect(committed.map((p) => [p.src, p.tgt])).toEqual([
      ['一。', 'One.'],
      ['二。', 'Two.']
    ]);
  });

  it('queues an unpaired final without touching the stitched sentence', () => {
    const step = pushFinal(createTranscript('listen'), 'src', 'Hello', fakeClock());
    expect(step.paired).toBe(false);
    expect(step.committed).toEqual([]);
    expect(step.transcript).toMatchObject({
      pendingSrc: [{ text: 'Hello' }],
      pendingTgt: [],
      stitch: null
    });
  });

  it('carries the source speaker onto the sentence', () => {
    const clock = fakeClock();
    const src = pushFinal(createTranscript('listen'), 'src', 'Hi.', clock, 2);
    const step = pushFinal(src.transcript, 'tgt', '嗨。', clock);
    expect(step.committed).toEqual([expect.objectContaining({ src: 'Hi.', speaker: 2 })]);
  });

  it('starts a new sentence when the speaker changes, punctuation or not', () => {
    const clock = fakeClock();
    let t = createTranscript('listen');
    const committed: SentencePair[] = [];
    for (const [text, tgt, speaker] of [
      ['so the budget', '所以预算', 1],
      ['is fine', '没问题', 1],
      ['I disagree', '我不同意', 2]
    ] as const) {
      t = pushFinal(t, 'src', text, clock, speaker).transcript;
      const step = pushFinal(t, 'tgt', tgt, clock);
      t = step.transcript;
      committed.push(...step.committed);
    }
    expect(committed.map((p) => [p.src, p.speaker])).toEqual([['so the budget is fine', 1]]);
    expect(t.stitch).toMatchObject({ src: 'I disagree', speaker: 2 });
  });

  it('keeps stitching across a fragment of unknown speaker', () => {
    const clock = fakeClock();
    const { transcript } = feed(
      pushFinal(createTranscript('listen'), 'src', 'we', clock, 1).transcript,
      [['tgt', '我们'], ['src', 'agree'], ['tgt', '同意']],
      clock
    );
    expect(transcript.stitch).toMatchObject({ src: 'we agree', speaker: 1 });
  });

  it('leaves the speaker off when the engine sends none', () => {
    const { committed } = feed(createTranscript('listen'), [['src', 'Hi.'], ['tgt', '嗨。']], fakeClock());
    expect(committed[0]).not.toHaveProperty('speaker');
  });

  it('stitches unpunctuated fragments and keeps them open', () => {
    const clock = fakeClock();
    const { transcript, committed } = feed(
      createTranscript('listen'),
      [
        ['src', '我们今天'],
        ['tgt', 'Today we'],
        ['src', '讨论'],
        ['tgt', 'discuss']
      ],
      clock
    );
    expect(committed).toEqual([]);
    expect(transcript.stitch).toMatchObject({ src: '我们今天讨论', tgt: 'Today we discuss' });
  });

  it('commits the stitched sentence at terminal punctuation on the source side', () => {
    const clock = fakeClock(5_000);
    const t = beginSession(createTranscript('listen'));
    const first = feed(t, [['src', '我们今天'], ['tgt', 'Today we']], clock);
    clock.advance(500);
    const second = pushFinal(first.transcript, 'src', '讨论预算。', clock);
    expect(second.committed).toEqual([]);
    const last = pushFinal(second.transcript, 'tgt', 'discuss the budget', clock);
    expect(last.paired).toBe(true);
    expect(last.committed).toEqual([
      {
        id: 'id-1',
        direction: 'listen',
        src: '我们今天讨论预算。',
        tgt: 'Today we discuss the budget',
        // Stamped when the sentence opened, not when it closed.
        at: 5_000,
        sessionSeq: 1
      }
    ]);
    expect(last.transcript.stitch).toBeNull();
  });

  it('only looks at the source side for the sentence boundary', () => {
    const step = feed(
      createTranscript('listen'),
      [['src', 'no stop'], ['tgt', '有句号。']],
      fakeClock()
    );
    expect(step.committed).toEqual([]);
    expect(step.transcript.stitch?.tgt).toBe('有句号。');
  });

  it('commits and reopens within one push when several pairs complete', () => {
    const clock = fakeClock();
    const ahead = feed(
      createTranscript('listen'),
      [['tgt', '一。'], ['tgt', '二']],
      clock
    );
    const a = pushFinal(ahead.transcript, 'src', 'One.', clock);
    expect(a.committed.map((p) => p.src)).toEqual(['One.']);
    const b = pushFinal(a.transcript, 'src', 'Two', clock);
    expect(b.committed).toEqual([]);
    expect(b.transcript.stitch).toMatchObject({ id: 'id-2', src: 'Two', tgt: '二' });
  });

  it('commits once either side reaches the length cap', () => {
    const clock = fakeClock();
    const long = 'x'.repeat(MAX_STITCH_CHARS);
    const { committed } = feed(
      createTranscript('listen'),
      [['src', 'short'], ['tgt', long]],
      clock
    );
    expect(committed.map((p) => p.src)).toEqual(['short']);
  });

  it('cuts an unpunctuated sentence at the first fragment past the length cap', () => {
    const clock = fakeClock();
    const chunk = 'word '.repeat(10).trim();
    let t = createTranscript('listen');
    let committed: SentencePair[] = [];
    let fragments = 0;
    while (committed.length === 0) {
      const step = feed(t, [['src', chunk], ['tgt', chunk]], clock);
      t = step.transcript;
      committed = step.committed;
      fragments += 1;
      expect(fragments).toBeLessThan(100);
    }
    expect(committed[0].src.length).toBeGreaterThanOrEqual(MAX_STITCH_CHARS);
    expect(committed[0].src.length).toBeLessThan(MAX_STITCH_CHARS + chunk.length + 1);
    expect(t.stitch).toBeNull();
  });

  it('commits once the sentence has been open for the time cap', () => {
    const clock = fakeClock();
    const opened = feed(
      createTranscript('listen'),
      [['src', 'no punctuation here'], ['tgt', '这里没有标点']],
      clock
    );
    clock.advance(MAX_STITCH_MS - 1);
    const early = feed(opened.transcript, [['src', 'still'], ['tgt', '还在']], clock);
    expect(early.committed).toEqual([]);
    clock.advance(1);
    const late = feed(early.transcript, [['src', 'going'], ['tgt', '继续']], clock);
    expect(late.committed.map((p) => [p.src, p.tgt])).toEqual([
      ['no punctuation here still going', '这里没有标点还在继续']
    ]);
  });

  it('stamps a sentence with the session it opened in', () => {
    const clock = fakeClock();
    const opened = feed(
      beginSession(createTranscript('speak')),
      [['src', 'open'], ['tgt', '开']],
      clock
    );
    const later = beginSession(opened.transcript);
    const { committed } = feed(later, [['src', 'closed.'], ['tgt', '关。']], clock);
    expect(committed[0].sessionSeq).toBe(1);
  });

  it('assembles a transient direction live but never commits it', () => {
    const clock = fakeClock();
    const t = setTransient(createTranscript('listen'), true);
    const { transcript, committed } = feed(
      t,
      [
        ['src', 'Probe line.'],
        ['tgt', '探针。'],
        ['src', 'tail'],
        ['tgt', '尾巴']
      ],
      clock
    );
    expect(committed).toEqual([]);
    expect(transcript.stitch).toMatchObject({ src: 'tail', tgt: '尾巴' });
  });

  it('never mutates its input', () => {
    const clock = fakeClock();
    const base = feed(
      createTranscript('listen'),
      [['src', 'a'], ['tgt', 'b'], ['src', 'queued']],
      clock
    ).transcript;
    const frozen = deepFreeze(structuredClone(base));
    expect(() => pushFinal(frozen, 'tgt', 'c.', clock)).not.toThrow();
    expect(() => pushFinal(frozen, 'src', 'd', clock)).not.toThrow();
    expect(() => settle(frozen, clock)).not.toThrow();
    expect(frozen).toEqual(base);
  });
});

describe('settle', () => {
  it('commits the stitched sentence and resets the queues', () => {
    const clock = fakeClock();
    const open = feed(createTranscript('listen'), [['src', 'half a'], ['tgt', '半句']], clock);
    const step = settle(open.transcript, clock);
    expect(step.committed.map((p) => [p.src, p.tgt])).toEqual([['half a', '半句']]);
    expect(step.transcript).toMatchObject({ pendingSrc: [], pendingTgt: [], stitch: null });
  });

  it('folds unpaired finals into the sentence so nothing is lost', () => {
    const clock = fakeClock();
    const open = feed(
      createTranscript('listen'),
      [['src', 'first half'], ['tgt', '前半句'], ['src', 'and'], ['src', 'the rest']],
      clock
    );
    const { committed } = settle(open.transcript, clock);
    expect(committed.map((p) => [p.src, p.tgt])).toEqual([
      ['first half and the rest', '前半句']
    ]);
  });

  it("doesn't fold another speaker's unpaired final into the open sentence", () => {
    const clock = fakeClock();
    let t = pushFinal(createTranscript('listen'), 'src', 'first', clock, 1).transcript;
    t = pushFinal(t, 'tgt', '第一', clock).transcript;
    t = pushFinal(t, 'src', 'second', clock, 2).transcript;
    const { committed } = settle(t, clock);
    expect(committed.map((p) => [p.src, p.tgt, p.speaker])).toEqual([
      ['first', '第一', 1],
      ['second', '', 2]
    ]);
  });

  it('commits a lone unpaired final with an empty partner', () => {
    const clock = fakeClock();
    const open = pushFinal(createTranscript('speak'), 'tgt', 'orphan', clock).transcript;
    const { committed } = settle(open, clock);
    expect(committed).toEqual([
      expect.objectContaining({ direction: 'speak', src: '', tgt: 'orphan' })
    ]);
  });

  it('is a no-op on an empty transcript', () => {
    const t = beginSession(createTranscript('listen'));
    const step = settle(t, fakeClock());
    expect(step.committed).toEqual([]);
    expect(step.transcript).toBe(t);
  });

  it('drops a transient sentence but keeps the flag for the caller to clear', () => {
    const clock = fakeClock();
    const open = feed(
      setTransient(createTranscript('listen'), true),
      [['src', 'probe'], ['tgt', '探针'], ['src', 'more']],
      clock
    );
    const step = settle(open.transcript, clock);
    expect(step.committed).toEqual([]);
    expect(step.transcript).toMatchObject({
      pendingSrc: [],
      pendingTgt: [],
      stitch: null,
      transient: true
    });
  });
});

describe('session and meeting boundaries', () => {
  it('counts sessions per direction', () => {
    const t = beginSession(beginSession(createTranscript('listen')));
    expect(t.sessionSeq).toBe(2);
  });

  it('resets in-flight state for a new meeting but keeps the probe flag', () => {
    const clock = fakeClock();
    const busy = feed(
      setTransient(beginSession(createTranscript('speak')), true),
      [['src', 'open'], ['tgt', '开'], ['src', 'queued']],
      clock
    ).transcript;
    expect(resetForMeeting(busy)).toEqual({
      ...createTranscript('speak'),
      transient: true
    });
  });

  it('returns the same transcript when the probe flag does not change', () => {
    const t = createTranscript('listen');
    expect(setTransient(t, false)).toBe(t);
    const on = setTransient(t, true);
    expect(on).not.toBe(t);
    expect(on.transient).toBe(true);
    expect(setTransient(on, true)).toBe(on);
  });
});

describe('appendHistory', () => {
  const line = (src: string): SentencePair => ({
    id: src,
    direction: 'listen',
    src,
    tgt: src,
    at: 0,
    sessionSeq: 0
  });

  it('keeps the same array when nothing was committed', () => {
    const history = [line('a')];
    expect(appendHistory(history, [], 10)).toBe(history);
  });

  it('appends in order and drops the oldest past the limit', () => {
    const history = [line('a'), line('b')];
    expect(
      appendHistory(history, [line('c'), line('d')], 3).map((p) => p.src)
    ).toEqual(['b', 'c', 'd']);
    expect(history.map((p) => p.src)).toEqual(['a', 'b']);
  });
});
