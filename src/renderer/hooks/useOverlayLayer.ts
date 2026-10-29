import { useLayoutEffect, useState } from 'react';
import { pushNativeEscapeLayer } from '../lib/escape-stack.js';
import { yieldFocus } from '../components/ui/focus-trap.js';

/**
 * Bind a Base UI overlay root (Dialog, Select …) to the app's Esc stack and
 * focus traps. Base UI closes these on Esc and manages their focus itself,
 * from a portal outside any legacy <Modal> panel. While one is open it takes
 * Esc (layers beneath and "Esc stops speaking" stay out) and the legacy focus
 * traps stand down.
 *
 * Mirrors the root's open state from `open` / `defaultOpen` and the returned
 * handler, which the root must get as its `onOpenChange`. Layers go on in a
 * layout effect: Base UI moves focus in a microtask + frame after commit, so
 * the trap has already yielded by then.
 */
export const useOverlayLayer = <Details extends { isCanceled: boolean }>(
  open: boolean | undefined,
  defaultOpen: boolean | undefined,
  onOpenChange: ((open: boolean, details: Details) => void) | undefined
): ((open: boolean, details: Details) => void) => {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;

  useLayoutEffect(() => {
    if (!isOpen) return;
    const releaseEscape = pushNativeEscapeLayer();
    const releaseFocus = yieldFocus();
    return () => {
      releaseEscape();
      releaseFocus();
    };
  }, [isOpen]);

  return (next, details) => {
    onOpenChange?.(next, details);
    if (!details.isCanceled) setUncontrolledOpen(next);
  };
};
