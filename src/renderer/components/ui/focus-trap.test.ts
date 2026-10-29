import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nextInCycle,
  routeFocusIn,
  routeTabKey,
  tabbablesIn,
  trapFocus,
  yieldFocus
} from './focus-trap.js';
import {
  hasEscapeLayer,
  pushEscapeLayer,
  routeEscapeKey
} from '../../lib/escape-stack.js';

// Just enough of the DOM for the trap: no jsdom in this project, so panels
// and controls are plain objects sharing one fake document.
interface FakeEl {
  name: string;
  tabIndex: number;
  disabled: boolean;
  rendered: boolean;
  isConnected: boolean;
  children: FakeEl[];
  ownerDocument: FakeDoc;
  focus: (opts?: FocusOptions) => void;
  contains: (other: unknown) => boolean;
  matches: (selector: string) => boolean;
  getClientRects: () => { length: number };
  querySelectorAll: () => FakeEl[];
}

interface FakeDoc {
  activeElement: FakeEl | null;
  body: FakeEl;
  addEventListener: (type: string, fn: unknown) => void;
}

const doc: FakeDoc = {
  activeElement: null,
  body: null as unknown as FakeEl,
  addEventListener: vi.fn()
};

const el = (
  name: string,
  opts: Partial<Pick<FakeEl, 'tabIndex' | 'disabled' | 'rendered'>> = {},
  children: FakeEl[] = []
): FakeEl => {
  const node: FakeEl = {
    name,
    tabIndex: opts.tabIndex ?? 0,
    disabled: opts.disabled ?? false,
    rendered: opts.rendered ?? true,
    isConnected: true,
    children,
    ownerDocument: doc,
    focus: () => {
      doc.activeElement = node;
    },
    contains: (other) =>
      other === node || node.children.some((c) => c.contains(other)),
    matches: (selector) => selector === ':disabled' && node.disabled,
    getClientRects: () => ({ length: node.rendered ? 1 : 0 }),
    querySelectorAll: () => node.children.flatMap((c) => [c, ...c.querySelectorAll()])
  };
  return node;
};

doc.body = el('body', { tabIndex: -1 });

const asEl = (n: FakeEl): HTMLElement => n as unknown as HTMLElement;

const tab = (target: FakeEl | null, shiftKey = false) => ({
  key: 'Tab',
  shiftKey,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  defaultPrevented: false,
  target: target as unknown as EventTarget,
  preventDefault: vi.fn()
});

const releases: (() => void)[] = [];
const trap = (panel: FakeEl, initial?: FakeEl): (() => void) => {
  const release = trapFocus(asEl(panel), initial ? asEl(initial) : undefined);
  releases.push(release);
  return release;
};

afterEach(() => {
  while (releases.length) releases.pop()!();
  doc.activeElement = doc.body;
});

describe('nextInCycle', () => {
  const items = ['a', 'b', 'c'];

  it('steps forward and wraps from the last item to the first', () => {
    expect(nextInCycle(items, 'a', false)).toBe('b');
    expect(nextInCycle(items, 'c', false)).toBe('a');
  });

  it('steps backward and wraps from the first item to the last', () => {
    expect(nextInCycle(items, 'b', true)).toBe('a');
    expect(nextInCycle(items, 'a', true)).toBe('c');
  });

  it('enters at either end when focus is outside the list', () => {
    expect(nextInCycle(items, 'panel', false)).toBe('a');
    expect(nextInCycle(items, null, true)).toBe('c');
  });
});

describe('tabbablesIn', () => {
  it('skips disabled, unrendered and tabIndex -1 elements', () => {
    const ok = el('ok');
    const panel = el('panel', { tabIndex: -1 }, [
      el('disabled', { disabled: true }),
      el('wrapper', { tabIndex: -1 }, [ok, el('hidden', { rendered: false })])
    ]);
    expect(tabbablesIn(asEl(panel)).map((n) => (n as unknown as FakeEl).name)).toEqual([
      'ok'
    ]);
  });
});

describe('trapFocus', () => {
  it('moves focus into the panel on open and back to the opener on release', () => {
    const opener = el('opener');
    opener.focus();
    const panel = el('panel', { tabIndex: -1 }, [el('a')]);
    const release = trap(panel);
    expect(doc.activeElement).toBe(panel);

    // Closing unmounts the panel; focus falls back to body with it.
    doc.activeElement = doc.body;
    release();
    expect(doc.activeElement).toBe(opener);
    // Released: Tab is the browser's again.
    expect(routeTabKey(tab(opener))).toBe(false);
  });

  it('honours an explicit initial focus target', () => {
    const save = el('save');
    const panel = el('panel', { tabIndex: -1 }, [el('a'), save]);
    trap(panel, save);
    expect(doc.activeElement).toBe(save);
  });

  it('keeps focus an autoFocus child already took', () => {
    const input = el('input');
    const panel = el('panel', { tabIndex: -1 }, [input, el('button')]);
    input.focus();
    trap(panel);
    expect(doc.activeElement).toBe(input);
  });

  it('does not restore focus to an opener that left the DOM', () => {
    const opener = el('opener');
    opener.focus();
    const panel = el('panel', { tabIndex: -1 });
    const release = trap(panel);
    opener.isConnected = false;
    doc.activeElement = doc.body;
    release();
    expect(doc.activeElement).toBe(doc.body);
  });

  it('leaves focus alone when a dialog opened on top still owns it', () => {
    const opener = el('opener');
    opener.focus();
    const lower = el('lower', { tabIndex: -1 }, [el('lower-btn')]);
    const releaseLower = trap(lower);
    const upper = el('upper', { tabIndex: -1 }, [el('upper-btn')]);
    trap(upper);
    expect(doc.activeElement).toBe(upper);

    releaseLower();
    expect(doc.activeElement).toBe(upper);
  });
});

describe('routeTabKey', () => {
  it('cycles Tab and Shift+Tab inside the panel', () => {
    const a = el('a');
    const b = el('b');
    const c = el('c');
    const panel = el('panel', { tabIndex: -1 }, [a, el('off', { disabled: true }), b, c]);
    trap(panel);

    const fromPanel = tab(panel);
    expect(routeTabKey(fromPanel)).toBe(true);
    expect(fromPanel.preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(a);

    routeTabKey(tab(a));
    expect(doc.activeElement).toBe(b);
    routeTabKey(tab(c));
    expect(doc.activeElement).toBe(a);
    routeTabKey(tab(a, true));
    expect(doc.activeElement).toBe(c);
  });

  it('re-enters the panel when focus was lost to body (backdrop click)', () => {
    const a = el('a');
    const z = el('z');
    trap(el('panel', { tabIndex: -1 }, [a, z]));
    routeTabKey(tab(doc.body));
    expect(doc.activeElement).toBe(a);
    routeTabKey(tab(doc.body, true));
    expect(doc.activeElement).toBe(z);
  });

  it('keeps focus on the panel when it has nothing tabbable', () => {
    const panel = el('panel', { tabIndex: -1 }, [el('off', { disabled: true })]);
    trap(panel);
    const e = tab(panel);
    expect(routeTabKey(e)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(doc.activeElement).toBe(panel);
  });

  it('only routes inside the topmost panel, then hands back to the one below', () => {
    const settingsBtn = el('settings-btn');
    const settings = el('settings', { tabIndex: -1 }, [settingsBtn]);
    trap(settings);
    const captureBtn = el('capture-btn');
    // The hotkey dialog nests inside the Settings panel's DOM.
    const capture = el('capture', { tabIndex: -1 }, [captureBtn]);
    settings.children.push(capture);
    const releaseCapture = trap(capture);

    routeTabKey(tab(captureBtn));
    expect(doc.activeElement).toBe(captureBtn);

    capture.isConnected = false;
    settings.children.pop();
    doc.activeElement = doc.body;
    releaseCapture();
    routeTabKey(tab(doc.body));
    expect(doc.activeElement).toBe(settingsBtn);
  });

  it('ignores other keys, modified Tab, handled events and an empty stack', () => {
    const a = el('a');
    trap(el('panel', { tabIndex: -1 }, [a, el('b')]));
    a.focus();
    expect(routeTabKey({ ...tab(a), key: 'Enter' })).toBe(false);
    expect(routeTabKey({ ...tab(a), ctrlKey: true })).toBe(false);
    expect(routeTabKey({ ...tab(a), defaultPrevented: true })).toBe(false);
    expect(doc.activeElement).toBe(a);

    while (releases.length) releases.pop()!();
    const e = tab(a);
    expect(routeTabKey(e)).toBe(false);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe('routeFocusIn', () => {
  it('pulls focus that escaped the top panel back to where it last was', () => {
    const a = el('a');
    const b = el('b');
    const outside = el('outside');
    trap(el('panel', { tabIndex: -1 }, [a, b]));
    b.focus();
    routeFocusIn({ target: b as unknown as EventTarget });

    outside.focus();
    routeFocusIn({ target: outside as unknown as EventTarget });
    expect(doc.activeElement).toBe(b);
  });

  it('falls back to the panel when nothing inside was focused yet', () => {
    const panel = el('panel', { tabIndex: -1 }, [el('a')]);
    trap(panel);
    const outside = el('outside');
    outside.focus();
    routeFocusIn({ target: outside as unknown as EventTarget });
    expect(doc.activeElement).toBe(panel);
  });

  it('does nothing without an open dialog', () => {
    const outside = el('outside');
    outside.focus();
    routeFocusIn({ target: outside as unknown as EventTarget });
    expect(doc.activeElement).toBe(outside);
  });
});

describe('yieldFocus', () => {
  it('stands the trap down while an overlay on top owns focus, then resumes', () => {
    const a = el('a');
    trap(el('panel', { tabIndex: -1 }, [a, el('b')]));
    a.focus();
    routeFocusIn({ target: a as unknown as EventTarget });

    // A Base UI Select opened from inside the dialog renders its options in
    // a portal outside the panel.
    const release = yieldFocus();
    releases.push(release);
    const option = el('option');
    option.focus();
    routeFocusIn({ target: option as unknown as EventTarget });
    expect(doc.activeElement).toBe(option);
    expect(routeTabKey(tab(option))).toBe(false);

    release();
    routeFocusIn({ target: option as unknown as EventTarget });
    expect(doc.activeElement).toBe(a);
  });
});

// B22: one Esc in the hotkey-capture dialog used to also close Settings and
// stop the running speak session. <Modal> registers each dialog on the Esc
// stack and the focus trap in the same order, so the dialog that holds
// focus is the one that gets Esc.
describe('stacked dialogs (B22)', () => {
  const keydown = (key: string) => ({
    key,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn()
  });

  it('routes Esc and Tab to the same topmost dialog, one layer per press', () => {
    const closeSettings = vi.fn();
    const closeCapture = vi.fn();
    const stopSpeaking = vi.fn();
    // useGlobalHotkey's bare-Esc shortcut, as wired in the app.
    const globalEsc = (): void => {
      if (!hasEscapeLayer()) stopSpeaking();
    };

    const settingsBtn = el('settings-btn');
    const settings = el('settings', { tabIndex: -1 }, [settingsBtn]);
    const popSettingsEsc = pushEscapeLayer(closeSettings);
    const releaseSettings = trap(settings);

    const captureBtn = el('capture-btn');
    const capture = el('capture', { tabIndex: -1 }, [captureBtn]);
    const popCaptureEsc = pushEscapeLayer(closeCapture);
    const releaseCapture = trap(capture);
    expect(doc.activeElement).toBe(capture);

    const first = keydown('Escape');
    if (!routeEscapeKey(first)) globalEsc();
    expect(closeCapture).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();
    expect(stopSpeaking).not.toHaveBeenCalled();
    expect(first.stopImmediatePropagation).toHaveBeenCalled();

    popCaptureEsc();
    doc.activeElement = doc.body;
    releaseCapture();
    routeTabKey(tab(doc.body));
    expect(doc.activeElement).toBe(settingsBtn);

    if (!routeEscapeKey(keydown('Escape'))) globalEsc();
    expect(closeSettings).toHaveBeenCalledTimes(1);
    expect(stopSpeaking).not.toHaveBeenCalled();

    popSettingsEsc();
    releaseSettings();
    if (!routeEscapeKey(keydown('Escape'))) globalEsc();
    expect(stopSpeaking).toHaveBeenCalledTimes(1);
  });
});
