import { describe, expect, it, vi } from 'vitest';
import {
  hasEscapeLayer,
  pushEscapeLayer,
  pushNativeEscapeLayer,
  routeEscapeKey
} from './escape-stack.js';

const keydown = (key: string) => ({
  key,
  preventDefault: vi.fn(),
  stopImmediatePropagation: vi.fn()
});

describe('escape stack', () => {
  it('lets only the topmost layer handle Esc and stops the event there', () => {
    const settings = vi.fn();
    const capture = vi.fn();
    const popSettings = pushEscapeLayer(settings);
    const popCapture = pushEscapeLayer(capture);

    const e = keydown('Escape');
    expect(routeEscapeKey(e)).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(settings).not.toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalled();

    popCapture();
    routeEscapeKey(keydown('Escape'));
    expect(settings).toHaveBeenCalledTimes(1);
    popSettings();
  });

  it('lets Esc through to a topmost overlay that closes itself, keeping layers beneath out', () => {
    const settings = vi.fn();
    const popSettings = pushEscapeLayer(settings);
    // A Base UI Select opened inside Settings closes itself on Esc.
    const popSelect = pushNativeEscapeLayer();

    const e = keydown('Escape');
    expect(routeEscapeKey(e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    // Still taken: the bare "Esc stops speaking" shortcut stays out.
    expect(hasEscapeLayer()).toBe(true);

    popSelect();
    routeEscapeKey(keydown('Escape'));
    expect(settings).toHaveBeenCalledTimes(1);
    popSettings();
    expect(hasEscapeLayer()).toBe(false);
  });

  it('ignores other keys and does nothing without layers', () => {
    const onEscape = vi.fn();
    const pop = pushEscapeLayer(onEscape);
    const enter = keydown('Enter');
    expect(routeEscapeKey(enter)).toBe(false);
    expect(enter.stopImmediatePropagation).not.toHaveBeenCalled();
    pop();

    expect(hasEscapeLayer()).toBe(false);
    const esc = keydown('Escape');
    // No dialog open: leave Esc to the global "stop speaking" shortcut.
    expect(routeEscapeKey(esc)).toBe(false);
    expect(esc.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('removes a middle layer without disturbing the order of the rest', () => {
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const popA = pushEscapeLayer(a);
    const popB = pushEscapeLayer(b);
    const popC = pushEscapeLayer(c);
    popB();
    popB(); // idempotent
    expect(hasEscapeLayer()).toBe(true);
    routeEscapeKey(keydown('Escape'));
    expect(c).toHaveBeenCalledTimes(1);
    popC();
    routeEscapeKey(keydown('Escape'));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    popA();
    expect(hasEscapeLayer()).toBe(false);
  });
});
