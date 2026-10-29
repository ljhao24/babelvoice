import { describe, expect, it } from 'vitest';
import { FinalPairing } from './final-pairing.js';
import type { TranslationEventBody } from './translation-client.js';

const src = (text: string): TranslationEventBody => ({
  type: 'source-subtitle-final',
  text,
  startMs: 0,
  endMs: 0
});
const tgt = (text: string): TranslationEventBody => ({
  type: 'translation-subtitle-final',
  text,
  startMs: 0,
  endMs: 0
});

describe('FinalPairing', () => {
  it('drops an empty translation with no source line waiting', () => {
    const p = new FinalPairing();
    expect(p.pass(src('Okay.'))).toBe(true);
    expect(p.pass(tgt('好的。'))).toBe(true);
    expect(p.pass(tgt(''))).toBe(false);
    expect(p.behind('source')).toBe(0);
    expect(p.behind('translation')).toBe(0);
  });

  it('gives a waiting source line its empty translation', () => {
    const p = new FinalPairing();
    expect(p.pass(src('Hmm.'))).toBe(true);
    expect(p.pass(tgt(''))).toBe(true);
  });

  it('passes a translation ahead of its source, and an empty source to pair with it', () => {
    const p = new FinalPairing();
    expect(p.pass(tgt('Hello.'))).toBe(true);
    expect(p.behind('source')).toBe(1);
    expect(p.pass(src(''))).toBe(true);
    expect(p.behind('source')).toBe(0);
  });

  it('counts what a flush must pad on the short side', () => {
    const p = new FinalPairing();
    p.pass(src('一'));
    p.pass(src('二'));
    p.pass(tgt('One'));
    expect(p.behind('translation')).toBe(1);
    expect(p.behind('source')).toBe(0);
    // The pad itself is admitted: a source line waits for it.
    expect(p.pass(tgt(''))).toBe(true);
    expect(p.behind('translation')).toBe(0);
  });

  it('lets every other event through', () => {
    const p = new FinalPairing();
    expect(p.pass({ type: 'translation-subtitle-delta', text: '' })).toBe(true);
    expect(p.pass({ type: 'translation-subtitle-start', startMs: 0, speakerChanged: false })).toBe(
      true
    );
  });
});
