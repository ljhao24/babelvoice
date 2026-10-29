import { useEffect, useRef } from 'react';
import { pushEscapeLayer } from '../lib/escape-stack.js';

/**
 * Register a modal on the Esc stack while `active`. Only the most recently
 * opened active layer receives Esc. `onEscape` may change between renders
 * (e.g. closes only when not busy) without re-ordering the stack.
 */
export const useEscapeLayer = (active: boolean, onEscape: () => void): void => {
  const handlerRef = useRef(onEscape);
  handlerRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    return pushEscapeLayer(() => handlerRef.current());
  }, [active]);
};
