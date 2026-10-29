/**
 * Tiny inline spinner. Re-uses the global `@keyframes spin` defined in
 * index.css so we don't ship one-off CSS per call site.
 */
export function Spinner({
  size = 14,
  color = 'currentColor'
}: {
  size?: number;
  color?: string;
}): React.JSX.Element {
  return (
    <span
      role="presentation"
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        border: `2px solid ${color}`,
        borderTopColor: 'transparent',
        animation: 'spin 0.8s linear infinite',
        verticalAlign: 'middle',
        flexShrink: 0
      }}
    />
  );
}
