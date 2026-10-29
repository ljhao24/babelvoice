import { describe, expect, it } from 'vitest';
import {
  appendFragment,
  TranscriptSegmenter,
  sentenceBoundaries
} from './transcript-segmenter.js';
import type { TranslationEventBody } from './translation-client.js';

const collect = (): {
  seg: TranscriptSegmenter;
  events: TranslationEventBody[];
  finals: () => { src: string[]; tgt: string[] };
} => {
  const events: TranslationEventBody[] = [];
  let t = 0;
  const seg = new TranscriptSegmenter(
    (e) => events.push(e),
    () => (t += 10)
  );
  const finals = () => ({
    src: events.flatMap((e) => (e.type === 'source-subtitle-final' ? [e.text] : [])),
    tgt: events.flatMap((e) =>
      e.type === 'translation-subtitle-final' ? [e.text] : []
    )
  });
  return { seg, events, finals };
};

describe('sentenceBoundaries', () => {
  it('ends Latin sentences only before whitespace', () => {
    expect(sentenceBoundaries('Hello world. How are')).toEqual([12]);
    expect(sentenceBoundaries('Version 3.5 is out')).toEqual([]);
    expect(sentenceBoundaries('Use node.js daily. Then')).toEqual([18]);
  });

  it('leaves a Latin terminal at the end of the text pending', () => {
    // The next fragment may still be "5 yuan." or "js".
    expect(sentenceBoundaries('It costs 3.')).toEqual([]);
    expect(sentenceBoundaries('Use node.js daily.')).toEqual([]);
    expect(sentenceBoundaries('He said "yes."')).toEqual([]);
  });

  it('ends a Latin sentence glued to the next one without a space', () => {
    // Streamed fragments often carry no leading space.
    expect(sentenceBoundaries('Hello.Bye.')).toEqual([6]);
    expect(sentenceBoundaries('你好吗?我很好。')).toEqual([4, 8]);
    // Still mid-sentence: decimals, dotted names, initialisms.
    expect(sentenceBoundaries('It costs 3.5 yuan')).toEqual([]);
    expect(sentenceBoundaries('Try node.js now')).toEqual([]);
    expect(sentenceBoundaries('The U.S.A is big')).toEqual([]);
  });

  it('ends CJK sentences unconditionally', () => {
    expect(sentenceBoundaries('你好。我们开始吧！好')).toEqual([3, 9]);
    expect(sentenceBoundaries('我们开始吧。')).toEqual([6]);
  });

  it('counts a run of terminals once and keeps closing quotes', () => {
    expect(sentenceBoundaries('Really?! Yes')).toEqual([8]);
    expect(sentenceBoundaries('Wait... ok')).toEqual([7]);
    expect(sentenceBoundaries('他说“好。”然后')).toEqual([6]);
  });
});

describe('appendFragment', () => {
  it('concatenates incremental fragments', () => {
    expect(appendFragment(' Hello', ' world')).toBe(' Hello world');
  });

  it('replaces instead of doubling when a fragment restates everything', () => {
    expect(appendFragment('Hello wor', 'Hello world')).toBe('Hello world');
  });
});

describe('TranscriptSegmenter', () => {
  it('streams deltas as the full trimmed partial', () => {
    const { seg, events } = collect();
    seg.appendSource(' Hello');
    seg.appendSource(' world');
    expect(events.map((e) => e.type)).toEqual([
      'source-subtitle-start',
      'source-subtitle-delta',
      'source-subtitle-delta'
    ]);
    expect(events[2]).toMatchObject({ text: 'Hello world' });
  });

  it('closes source and translation as a pair on a translation terminal', () => {
    const { seg, events, finals } = collect();
    seg.appendSource(' Hello world. How');
    seg.appendTranslation('你好');
    seg.appendTranslation('世界。');
    expect(finals()).toEqual({ src: ['Hello world.'], tgt: ['你好世界。'] });
    // Every final is preceded by its line's start.
    const types = events.map((e) => e.type);
    expect(types.indexOf('source-subtitle-start')).toBeLessThan(
      types.indexOf('source-subtitle-final')
    );
    expect(types.indexOf('translation-subtitle-start')).toBeLessThan(
      types.indexOf('translation-subtitle-final')
    );
    seg.flush();
    expect(finals()).toEqual({ src: ['Hello world.', 'How'], tgt: ['你好世界。', ''] });
    expect(seg.hasPending()).toBe(false);
  });

  it('keeps a decimal streamed across fragments in one line (B20)', () => {
    const { seg, finals } = collect();
    seg.appendSource(' It costs 3');
    seg.appendTranslation('价格是3.5元。');
    seg.appendSource('.');
    // "3." could still become "3.5": nothing closes yet.
    expect(finals()).toEqual({ src: [], tgt: [] });
    seg.appendSource('5 yuan.');
    expect(finals()).toEqual({ src: [], tgt: [] });
    // The next fragment (or the client's line timer) settles the terminal.
    seg.appendSource(' Next');
    expect(finals()).toEqual({ src: ['It costs 3.5 yuan.'], tgt: ['价格是3.5元。'] });
  });

  it('a pending terminal closes on flush (line timer) as well', () => {
    const { seg, finals } = collect();
    seg.appendTranslation('The price is 3');
    seg.appendTranslation('.');
    seg.appendTranslation('5 yuan.');
    seg.appendSource('价格是三点五元。');
    expect(finals().tgt).toEqual([]);
    seg.flush();
    expect(finals()).toEqual({ src: ['价格是三点五元。'], tgt: ['The price is 3.5 yuan.'] });
  });

  it('waits for the source when the translation finishes a sentence first', () => {
    const { seg, finals } = collect();
    seg.appendSource(' Some users said it lags by two or three');
    seg.appendTranslation('一些用户说滞后两三秒。');
    expect(finals().tgt).toEqual([]);
    seg.appendSource(' seconds. Our goal');
    expect(finals()).toEqual({
      src: ['Some users said it lags by two or three seconds.'],
      tgt: ['一些用户说滞后两三秒。']
    });
  });

  it('closes the second half of a split translation on its own', () => {
    const { seg, finals } = collect();
    seg.appendSource(' Otherwise, move on to the next topic.');
    seg.appendTranslation('否则，我们继续。下一个');
    seg.appendSource(' Thanks');
    seg.appendTranslation('话题。');
    seg.appendSource(' everyone.');
    seg.appendTranslation('谢谢大家。');
    seg.appendSource(' Bye.');
    seg.appendTranslation('再见。');
    // "Bye." ends the stream: its terminal stays pending until the flush.
    seg.flush();
    expect(finals()).toEqual({
      src: ['Otherwise, move on to the next topic.', '', 'Thanks everyone.', 'Bye.'],
      tgt: ['否则，我们继续。', '下一个话题。', '谢谢大家。', '再见。']
    });
  });

  it('aligns a recorded Gemini session sentence-for-sentence', () => {
    const { seg, finals } = collect();
    for (const [side, text] of RECORDED_SESSION) {
      if (side === 'input') seg.appendSource(text);
      else seg.appendTranslation(text);
    }
    seg.flush();
    const { src, tgt } = finals();
    expect(src).toHaveLength(9);
    expect(src.map((s, i) => [s, tgt[i]])).toEqual([
      ['Good morning, everyone.', '大家早上好。'],
      ["Thanks for joining today's call.", '感谢大家参加今天的电话会议。'],
      ["Let's start with a quick update on the product launch.", '我们先快速更新一下产品发布的情况。'],
      [
        'We shipped the beta to about 200 users last week, and the feedback has been mostly positive.',
        '我们向大约200名用户发布了测试版，反馈大多是积极的。'
      ],
      ['The biggest complaint so far is latency.', '目前最大的抱怨是延迟。'],
      ['Some users said the translation lags behind by two or three seconds.', '一些用户说翻译滞后两三秒。'],
      ['Our goal for the next sprint is to cut that delay in half.', '我们对下一个冲刺的目标是将延迟减半。'],
      ['Sarah, could you walk us through the numbers from the user survey?', '莎拉，你能带我们了解一下用户调查的数据吗？'],
      [
        'Also, please remember that the quarterly review has moved to Thursday afternoon at 3:00.',
        '另外，请记住，季度审查已经移到周四下午3点。'
      ]
    ]);
  });

  it('carries text past the translation boundary into the next line', () => {
    const { seg, events, finals } = collect();
    seg.appendSource(' One. Two');
    seg.appendTranslation('一。二');
    expect(finals()).toEqual({ src: ['One.'], tgt: ['一。'] });
    const last = events.at(-1);
    expect(last).toEqual({ type: 'translation-subtitle-delta', text: '二' });
    expect(seg.hasPending()).toBe(true);
  });

  it('flush() closes both sides, with an empty final on the silent side', () => {
    const { seg, finals } = collect();
    // Speech already in the target language: no translation is produced.
    seg.appendSource(' 我们开始吧');
    expect(seg.awaitingTranslation()).toBe(true);
    seg.flush();
    expect(finals()).toEqual({ src: ['我们开始吧'], tgt: [''] });
    seg.flush();
    expect(finals().src).toHaveLength(1);
  });

  it('force-closes a line that never reaches a terminal', () => {
    const { seg, finals } = collect();
    seg.appendSource(' ' + 'word '.repeat(60));
    expect(finals().src).toHaveLength(1);
    expect(seg.hasPending()).toBe(false);
  });
});

/**
 * Fragments exactly as gemini-3.5-live-translate-preview streamed them for
 * a 36 s English test clip (GEMINI_VERBOSE=2 log, 2026-10-20). Note the
 * translation sometimes completes a sentence before the source transcript
 * gets its period ("两三秒。" before " seconds.").
 */
const RECORDED_SESSION: ['input' | 'output', string][] = [
  ['input', "Good morning, everyone. Thanks"],
  ['output', "大家早上好。"],
  ['input', " for joining today's"],
  ['output', "感谢大家参加"],
  ['input', " call. Let's"],
  ['output', "今天的电话会议。"],
  ['input', " start with a quick update"],
  ['output', "我们先"],
  ['input', " on the product"],
  ['output', "快速更新一下"],
  ['input', " launch. We shipped the"],
  ['output', "产品发布的情况。"],
  ['input', " beta to about"],
  ['output', "我们向"],
  ['input', " 200 users"],
  ['output', "大约200"],
  ['input', " last week, and the"],
  ['output', "名用户发布了"],
  ['input', " feedback has been"],
  ['output', "测试版，"],
  ['input', " mostly positive."],
  ['output', "反馈大多"],
  ['input', " The biggest complaint"],
  ['output', "是积极的。"],
  ['input', " so far is"],
  ['output', "目前最大的"],
  ['input', " latency. Some"],
  ['output', "抱怨是延迟。"],
  ['input', " users said the"],
  ['output', "一些用户"],
  ['input', " translation lags behind"],
  ['output', "说翻译滞后"],
  ['input', " by two or three"],
  ['output', "两三秒。"],
  ['input', " seconds. Our goal for"],
  ['output', "我们对"],
  ['input', " the next sprint is"],
  ['output', "下一个冲刺的目标"],
  ['input', " to cut that delay in"],
  ['output', "是将延迟减半。"],
  ['input', " half."],
  ['output', "莎拉，"],
  ['input', " Sarah, could you walk us"],
  ['output', "你能带我们"],
  ['input', " through the numbers from the"],
  ['output', "了解一下用户"],
  ['input', " user survey?"],
  ['output', "调查的数据吗？"],
  ['input', " Also, please"],
  ['output', "另外，"],
  ['input', " remember that the"],
  ['output', "请记住，"],
  ['input', " quarterly review has"],
  ['output', "季度审查"],
  ['input', " moved to Thursday"],
  ['output', "已经移到周四"],
  ['input', " afternoon at 3:00."],
  ['output', "下午3点。"],
];
