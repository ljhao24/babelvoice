import { describe, expect, it } from 'vitest';
import {
  acceleratorToTokens,
  keyEventToAccelerator,
  validateAccelerator
} from './accelerator.js';

const ev = (
  patch: Partial<{
    key: string;
    code: string;
    location: number;
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }>
) => ({
  key: '',
  code: '',
  location: 0,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...patch
});

describe('keyEventToAccelerator — combos', () => {
  it('serialises Alt+Space (legacy default)', () => {
    expect(
      keyEventToAccelerator(ev({ key: ' ', code: 'Space', altKey: true }))
    ).toBe('Option+Space');
  });

  it('keeps modifier order Command+Control+Option+Shift', () => {
    expect(
      keyEventToAccelerator(
        ev({
          key: ' ',
          code: 'Space',
          metaKey: true,
          ctrlKey: true,
          altKey: true,
          shiftKey: true
        })
      )
    ).toBe('Command+Control+Option+Shift+Space');
  });

  it('uses physical KeyA → "A" even when layout reports key="q"', () => {
    expect(
      keyEventToAccelerator(ev({ key: 'q', code: 'KeyA', metaKey: true }))
    ).toBe('Command+A');
  });

  it('handles function keys without modifier', () => {
    expect(keyEventToAccelerator(ev({ key: 'F2', code: 'F2' }))).toBe('F2');
    expect(keyEventToAccelerator(ev({ key: 'F19', code: 'F19' }))).toBe('F19');
  });

  it('handles arrows and named keys via code', () => {
    expect(
      keyEventToAccelerator(ev({ key: 'ArrowUp', code: 'ArrowUp', metaKey: true }))
    ).toBe('Command+Up');
    expect(
      keyEventToAccelerator(ev({ key: 'Tab', code: 'Tab', ctrlKey: true }))
    ).toBe('Control+Tab');
  });
});

describe('keyEventToAccelerator — solo modifier preview', () => {
  it('returns the bare modifier name regardless of side', () => {
    expect(
      keyEventToAccelerator(ev({ key: 'Meta', location: 1, metaKey: true }))
    ).toBe('Command');
    expect(
      keyEventToAccelerator(ev({ key: 'Alt', location: 2, altKey: true }))
    ).toBe('Option');
    expect(
      keyEventToAccelerator(ev({ key: 'Shift', location: 0, shiftKey: true }))
    ).toBe('Shift');
  });

  it('Fn previews as Fn (still rejected by validateAccelerator)', () => {
    expect(keyEventToAccelerator(ev({ key: 'Fn' }))).toBe('Fn');
  });

  it('Esc returns null (universal cancel)', () => {
    expect(
      keyEventToAccelerator(ev({ key: 'Escape', code: 'Escape' }))
    ).toBeNull();
  });
});

describe('validateAccelerator — mirrors native parser', () => {
  it('accepts modifier + Space (legacy default)', () => {
    expect(validateAccelerator('Option+Space').ok).toBe(true);
    expect(validateAccelerator('Alt+Space').ok).toBe(true);
    expect(validateAccelerator('Command+Shift+Space').ok).toBe(true);
  });

  it('accepts letter / digit combos with modifiers', () => {
    expect(validateAccelerator('Command+T').ok).toBe(true);
    expect(validateAccelerator('Control+Shift+9').ok).toBe(true);
  });

  it('accepts function keys solo or with modifiers', () => {
    expect(validateAccelerator('F2').ok).toBe(true);
    expect(validateAccelerator('F19').ok).toBe(true);
    expect(validateAccelerator('Command+F12').ok).toBe(true);
  });

  it('accepts arrow / Tab / Return combos', () => {
    expect(validateAccelerator('Command+Up').ok).toBe(true);
    expect(validateAccelerator('Control+Tab').ok).toBe(true);
    expect(validateAccelerator('Command+Return').ok).toBe(true);
  });

  it('rejects solo modifiers under the toggle hotkey model', () => {
    expect(validateAccelerator('Option')).toEqual({
      ok: false,
      reason: 'unsupported-key'
    });
    expect(validateAccelerator('Command')).toEqual({
      ok: false,
      reason: 'unsupported-key'
    });
    expect(validateAccelerator('Fn')).toEqual({
      ok: false,
      reason: 'unsupported-key'
    });
  });

  it('rejects single bare letter / digit (would intercept typing)', () => {
    expect(validateAccelerator('A')).toEqual({
      ok: false,
      reason: 'unsupported-key'
    });
    expect(validateAccelerator('5')).toEqual({
      ok: false,
      reason: 'unsupported-key'
    });
  });

  it('rejects unknown tokens', () => {
    expect(validateAccelerator('Command+Zoom')).toEqual({
      ok: false,
      reason: 'unsupported-key'
    });
  });

  it('rejects empty input', () => {
    expect(validateAccelerator('')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('acceleratorToTokens — display', () => {
  it('renders modifiers as macOS symbols', () => {
    expect(acceleratorToTokens('Command+Shift+T')).toEqual([
      { display: '⌘', kind: 'modifier' },
      { display: '⇧', kind: 'modifier' },
      { display: 'T', kind: 'key' }
    ]);
  });

  it('renders function keys uppercased', () => {
    expect(acceleratorToTokens('F2')).toEqual([
      { display: 'F2', kind: 'key' }
    ]);
  });

  it('renders Fn as fn glyph', () => {
    expect(acceleratorToTokens('Fn')).toEqual([
      { display: 'fn', kind: 'modifier' }
    ]);
  });

  it('renders arrow keys as arrow glyphs', () => {
    expect(acceleratorToTokens('Command+Up')).toEqual([
      { display: '⌘', kind: 'modifier' },
      { display: '↑', kind: 'key' }
    ]);
  });
});
