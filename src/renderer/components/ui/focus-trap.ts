/**
 * Focus containment for stacked modal dialogs — the focus counterpart of
 * `lib/escape-stack.ts`. Each open <Modal> pushes its panel; two document
 * listeners act for the *topmost* panel only:
 *
 *   - Tab / Shift+Tab cycle through that panel's tabbable elements, wrapping
 *     at either end, so focus never walks into the page (or a dialog) behind.
 *   - Focus that lands outside it anyway (script, an element mounting with
 *     `autoFocus` underneath) is pulled back to where it last was inside.
 *
 * The keydown listener runs in the bubble phase on purpose: a dialog that
 * captures raw keys (the hotkey recorder swallows Tab in a window capture
 * listener) keeps them away from the trap.
 *
 * Kept framework-free so the routing rules are unit-testable; <Modal> binds
 * it to React.
 */

interface TrapLayer {
  /** `null`: an overlay on top manages focus itself (`yieldFocus`). */
  panel: HTMLElement | null;
  /** Last element focused inside `panel`; where stray focus is sent back. */
  lastFocused: HTMLElement | null;
}

const layers: TrapLayer[] = [];
let listening = false;

const TABBABLE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]'
].join(',');

/** Tabbable descendants of `panel` in DOM order: enabled, rendered, tabIndex ≥ 0. */
export const tabbablesIn = (panel: HTMLElement): HTMLElement[] =>
  Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
    (el) =>
      el.tabIndex >= 0 &&
      !el.matches(':disabled') &&
      // display:none (itself or an ancestor) leaves no boxes.
      el.getClientRects().length > 0
  );

/**
 * Where Tab (or Shift+Tab with `backwards`) lands: the next / previous item,
 * wrapping at either end. Focus outside the list — the panel itself, or
 * `body` after a click on the backdrop — enters at the first / last item.
 */
export const nextInCycle = <T>(
  items: readonly T[],
  current: unknown,
  backwards: boolean
): T => {
  const i = items.indexOf(current as T);
  if (backwards) return items[i <= 0 ? items.length - 1 : i - 1];
  return items[i === -1 || i === items.length - 1 ? 0 : i + 1];
};

interface TabKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
  preventDefault: () => void;
}

/** Routes one keydown; returns true when the trap moved focus. Exported for tests. */
export const routeTabKey = (e: TabKeyEvent): boolean => {
  if (e.key !== 'Tab' || e.defaultPrevented) return false;
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  const top = layers[layers.length - 1];
  if (!top?.panel) return false;
  e.preventDefault();
  const items = tabbablesIn(top.panel);
  const next =
    items.length === 0 ? top.panel : nextInCycle(items, e.target, e.shiftKey);
  next.focus();
  return true;
};

/** Routes one focusin. Exported for tests. */
export const routeFocusIn = (e: { target: EventTarget | null }): void => {
  const top = layers[layers.length - 1];
  if (!top?.panel) return;
  const target = e.target as HTMLElement | null;
  if (target && top.panel.contains(target)) {
    top.lastFocused = target;
    return;
  }
  const back =
    top.lastFocused?.isConnected && top.panel.contains(top.lastFocused)
      ? top.lastFocused
      : top.panel;
  back.focus({ preventScroll: true });
};

const onKeyDown = (e: KeyboardEvent): void => {
  routeTabKey(e);
};

const onFocusIn = (e: FocusEvent): void => {
  routeFocusIn(e);
};

/**
 * Contain focus in `panel` until the returned release runs (idempotent).
 * Focus moves in — to `initialFocus`, else the panel itself (give it
 * `tabIndex={-1}`) — unless something inside, e.g. an `autoFocus` input,
 * already took it. On release it returns to whatever had it before, but
 * only while focus is still this panel's to give back: a dialog opened on
 * top of it owns focus by then.
 */
export const trapFocus = (
  panel: HTMLElement,
  initialFocus?: HTMLElement | null
): (() => void) => {
  const doc = panel.ownerDocument;
  const opener = doc.activeElement as HTMLElement | null;
  const layer: TrapLayer = { panel, lastFocused: null };
  layers.push(layer);
  if (!listening) {
    doc.addEventListener('keydown', onKeyDown);
    doc.addEventListener('focusin', onFocusIn);
    listening = true;
  }
  if (!panel.contains(doc.activeElement)) {
    (initialFocus ?? panel).focus({ preventScroll: true });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const idx = layers.indexOf(layer);
    if (idx !== -1) layers.splice(idx, 1);
    const active = doc.activeElement;
    // An unmounted panel takes focus down with it (`body`); StrictMode's
    // simulated unmount leaves it inside.
    const focusIsOurs =
      active === null || active === doc.body || panel.contains(active);
    if (focusIsOurs && opener && opener !== doc.body && opener.isConnected) {
      opener.focus({ preventScroll: true });
    }
  };
};

/**
 * Stand the traps down while an overlay that manages focus itself (a Base UI
 * popup, portalled outside every panel) is open on top, so focus moving into
 * it is not pulled back. The overlay returns focus to its trigger on close;
 * release (idempotent) then.
 */
export const yieldFocus = (): (() => void) => {
  const layer: TrapLayer = { panel: null, lastFocused: null };
  layers.push(layer);
  return () => {
    const idx = layers.indexOf(layer);
    if (idx !== -1) layers.splice(idx, 1);
  };
};
