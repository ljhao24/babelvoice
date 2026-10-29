import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * At most `lines` lines of text, showing the tail — the newest words — when
 * there is more: the box is bottom-aligned and clips its top, which fades
 * out instead of cutting a line in half. `reserve` holds the full height
 * even for short text, so what sits above doesn't move as a sentence grows.
 * `grow` lifts the cap: the box takes whatever height its flex parent can
 * give and only clips once that runs out.
 */
export function TailClamp({
  lines,
  lineHeight,
  reserve = false,
  grow = false,
  className = '',
  style,
  children
}: {
  lines: number;
  /** Unitless line height; the box is `lines × lineHeight` em tall. */
  lineHeight: number;
  reserve?: boolean;
  grow?: boolean;
  className?: string;
  /** Set `fontSize` here: the height is in em of this box. */
  style?: CSSProperties;
  children: ReactNode;
}): React.JSX.Element {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    const check = (): void => setClipped(inner.scrollHeight > outer.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(inner);
    observer.observe(outer);
    return () => observer.disconnect();
  }, []);

  const height = `${lines * lineHeight}em`;
  return (
    <div
      ref={outerRef}
      className={`${className} ${clipped ? 'subtitle-tail-fade' : ''}`}
      style={{
        ...style,
        lineHeight,
        maxHeight: grow ? undefined : height,
        minHeight: reserve ? height : undefined,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end'
      }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
