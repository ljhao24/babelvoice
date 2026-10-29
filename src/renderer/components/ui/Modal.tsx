import { useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeLayer } from '../../hooks/useEscapeLayer.js';
import { trapFocus } from './focus-trap.js';

const BACKDROP_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 'var(--z-overlay)',
  background: 'rgb(0 0 0 / 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center'
};

const PANEL_STYLE: CSSProperties = {
  background: 'rgb(var(--bg-elev))',
  color: 'rgb(var(--fg))',
  border: '1px solid rgb(var(--line))',
  borderRadius: 16,
  boxShadow: '0 24px 80px rgb(0 0 0 / 0.5)'
};

/**
 * Shared shell for every modal dialog: backdrop, a `role="dialog"` panel,
 * Esc through the app-wide Esc stack (only the topmost dialog reacts — one
 * press never also closes the dialog underneath or stops a running speak
 * session), and focus containment (`focus-trap.ts`): focus moves into the
 * panel on open, Tab cycles inside the topmost panel, and focus returns to
 * the opener on close.
 *
 * Renders through a portal at the end of <body>, at the same `--z-overlay`
 * as Base UI popups (which portal there too), so whichever dialog opened
 * last is on top, whatever kind either is. A dialog opened from inside
 * another one (hotkey capture inside Settings) stays a React child of it.
 *
 * Styling: the default card look (inline) is used unless `className` /
 * `panelClassName` are given, in which case those classes own the look
 * (e.g. `.modal-backdrop` / `.modal-card`).
 */
export function Modal({
  open,
  onClose,
  labelledBy,
  label,
  closeOnBackdrop = true,
  initialFocus,
  width,
  className,
  panelClassName,
  panelStyle,
  children
}: {
  open: boolean;
  /**
   * Esc, and a backdrop click unless `closeOnBackdrop` is false. Guard it to
   * make the dialog temporarily undismissable (e.g. while a request is in
   * flight) — the dialog still swallows Esc meanwhile.
   */
  onClose: () => void;
  /** id of the element that titles the dialog… */
  labelledBy?: string;
  /** …or an accessible name when there is no visible title. */
  label?: string;
  closeOnBackdrop?: boolean;
  /** Focused on open; defaults to the panel itself. */
  initialFocus?: RefObject<HTMLElement>;
  /** Panel width cap in px; the panel also keeps a 24px gutter to the window. */
  width?: number;
  /** Backdrop class(es); replaces the default inline backdrop style. */
  className?: string;
  /** Panel class(es); replaces the default inline card style. */
  panelClassName?: string;
  /** Merged over the panel's default style (padding, size, layout). */
  panelStyle?: CSSProperties;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Set on mousedown so a drag that starts inside the panel (selecting text
  // in an input) and ends on the backdrop doesn't count as a backdrop click.
  const pressedBackdropRef = useRef(false);

  useEscapeLayer(open, onClose);

  useEffect(() => {
    if (!open || !panelRef.current) return;
    return trapFocus(panelRef.current, initialFocus?.current);
    // `initialFocus` is read once per open, like a native `autofocus`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className={className ?? 'fade-in'}
      style={className ? undefined : BACKDROP_STYLE}
      onMouseDown={(e) => {
        pressedBackdropRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const pressed = pressedBackdropRef.current;
        pressedBackdropRef.current = false;
        if (closeOnBackdrop && pressed && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={label}
        tabIndex={-1}
        className={panelClassName}
        style={{
          ...(panelClassName ? undefined : PANEL_STYLE),
          ...(width !== undefined
            ? { width: `min(${width}px, calc(100vw - 48px))` }
            : undefined),
          ...panelStyle,
          // The panel is only a focus anchor (never in the tab order); the
          // global :focus-visible ring would outline the whole dialog.
          outline: 'none'
        }}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
