/**
 * App-wide Esc routing for stacked dialogs. Each open modal pushes a layer;
 * a single window-level capture listener hands Esc to the *topmost* layer
 * only and stops the event there. Without this every modal listened on
 * window independently, so one Esc in the hotkey-capture dialog also closed
 * Settings underneath and stopped the running speak session.
 *
 * The bare "Esc stops speaking" shortcut (`useGlobalHotkey`) only applies
 * when no layer is open — see `hasEscapeLayer`.
 */

type EscapeHandler = () => void;

/** `onEscape: null` is an overlay that closes itself (`pushNativeEscapeLayer`). */
const layers: { id: number; onEscape: EscapeHandler | null }[] = [];
let nextId = 1;
let listening = false;

interface EscapeKeyEvent {
  key: string;
  preventDefault: () => void;
  stopImmediatePropagation: () => void;
}

/** Routes one keydown; returns true when a layer consumed it. Exported for tests. */
export const routeEscapeKey = (e: EscapeKeyEvent): boolean => {
  if (e.key !== 'Escape') return false;
  const top = layers[layers.length - 1];
  // No layer, or the topmost overlay handles Esc itself: let the key through.
  if (!top?.onEscape) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  top.onEscape();
  return true;
};

const onKeyDown = (e: KeyboardEvent): void => {
  routeEscapeKey(e);
};

const pushLayer = (onEscape: EscapeHandler | null): (() => void) => {
  const id = nextId++;
  layers.push({ id, onEscape });
  if (!listening && typeof window !== 'undefined') {
    // Capture phase on window runs before any other keydown listener in the
    // page, so the stack wins regardless of registration order.
    window.addEventListener('keydown', onKeyDown, true);
    listening = true;
  }
  return () => {
    const idx = layers.findIndex((l) => l.id === id);
    if (idx !== -1) layers.splice(idx, 1);
  };
};

/** Push a layer; the returned function removes it (idempotent). */
export const pushEscapeLayer = (onEscape: EscapeHandler): (() => void) =>
  pushLayer(onEscape);

/**
 * Push a layer for an overlay that closes itself on Esc (Base UI popups
 * listen on `document`). While it is topmost the key passes through
 * untouched for the overlay to handle; layers beneath and the bare "Esc
 * stops speaking" shortcut still leave it alone.
 */
export const pushNativeEscapeLayer = (): (() => void) => pushLayer(null);

export const hasEscapeLayer = (): boolean => layers.length > 0;
