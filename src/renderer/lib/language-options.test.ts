import { describe, expect, it } from 'vitest';
import { isOptionDisabled, resolveLanguagePick } from './language-options.js';

describe('resolveLanguagePick', () => {
  it('keeps the other side when the pick does not collide', () => {
    expect(resolveLanguagePick('mine', 'ja', { mine: 'zh', other: 'en' })).toEqual({
      mine: 'ja',
      other: 'en'
    });
  });

  it('swaps sides instead of persisting a same-language pair', () => {
    expect(resolveLanguagePick('mine', 'en', { mine: 'zh', other: 'en' })).toEqual({
      mine: 'en',
      other: 'zh'
    });
    expect(resolveLanguagePick('other', 'ja', { mine: 'ja', other: 'en' })).toEqual({
      mine: 'en',
      other: 'ja'
    });
  });

  it('repairs an already-degenerate stored pair with a pivot language', () => {
    expect(resolveLanguagePick('mine', 'en', { mine: 'en', other: 'en' })).toEqual({
      mine: 'en',
      other: 'zh'
    });
    expect(resolveLanguagePick('other', 'zh', { mine: 'zh', other: 'zh' })).toEqual({
      mine: 'en',
      other: 'zh'
    });
  });

  it('never yields a pair the API rejects (both sides non-pivot)', () => {
    const pair = resolveLanguagePick('mine', 'fr', { mine: 'zh', other: 'de' });
    expect(pair.mine).toBe('fr');
    expect(isOptionDisabled(pair.mine, pair.other)).toBe(false);
    expect(pair.mine).not.toBe(pair.other);
  });
});
