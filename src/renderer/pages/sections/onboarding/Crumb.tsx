import { CheckIcon } from '../../../components/Icons.js';

/** Step pill for the dev-only step jumper. */
export function Crumb({
  n,
  label,
  active,
  done,
  onClick
}: {
  n: number;
  label: string;
  active: boolean;
  done: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  const clickable = !!onClick;
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 12px 6px 6px',
        borderRadius: 999,
        border: `1px solid ${
          active
            ? 'rgb(var(--brand) / 0.45)'
            : done
              ? 'rgb(var(--success) / 0.35)'
              : 'rgb(var(--line))'
        }`,
        background: active
          ? 'rgb(var(--brand) / 0.08)'
          : done
            ? 'rgb(var(--success) / 0.06)'
            : 'transparent',
        color: active ? 'rgb(var(--fg))' : 'rgb(var(--fg-muted))',
        cursor: clickable ? 'pointer' : 'default',
        fontSize: 12,
        whiteSpace: 'nowrap'
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 11,
          background: done
            ? 'rgb(var(--success) / 0.18)'
            : active
              ? 'rgb(var(--brand) / 0.18)'
              : 'rgb(var(--bg-elev-2))',
          color: done
            ? 'rgb(var(--success))'
            : active
              ? 'rgb(var(--brand))'
              : 'rgb(var(--fg-subtle))',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--font-mono)',
          fontWeight: 700,
          fontSize: 11
        }}
      >
        {done ? <CheckIcon size={12} /> : n}
      </span>
      <span>{label}</span>
    </button>
  );
}
