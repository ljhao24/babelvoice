import {
  CheckIcon,
  PlayIcon,
  RefreshIcon,
  StopIcon
} from '../../../components/Icons.js';
import type { DirectionProbe, ProbePhase } from '../../../hooks/useDirectionProbe.js';

const isActive = (phase: ProbePhase): boolean =>
  phase === 'connecting' || phase === 'running' || phase === 'finishing';

/** Test card for one Direction: stage timeline, start/stop, captured text, error. */
export function ProbeCard({
  probe,
  title,
  desc,
  icon,
  primaryLabel,
  primaryActiveLabel,
  primaryDoneLabel,
  retryLabel,
  stages
}: {
  probe: DirectionProbe;
  title: string;
  desc: string;
  icon: React.JSX.Element;
  primaryLabel: string;
  primaryActiveLabel: string;
  primaryDoneLabel: string;
  retryLabel: string;
  stages: string[];
}): React.JSX.Element {
  const { phase, error, partials } = probe;
  const active = isActive(phase);
  const done = phase === 'done';
  const failed = phase === 'failed';
  return (
    <section
      className={`card card-pad onb-probe-card ${active ? 'active' : ''} ${done ? 'done' : ''}`}
      style={{
        boxShadow: done
          ? '0 0 0 1px rgb(var(--success) / 0.4)'
          : active
            ? '0 0 0 1px rgb(var(--brand) / 0.4)'
            : undefined
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div
          className="brand-mark"
          style={{
            width: 36,
            height: 36,
            borderRadius: 12,
            background: done
              ? 'rgb(var(--success) / 0.18)'
              : active
                ? 'linear-gradient(135deg, rgb(var(--brand)), rgb(var(--accent-warm)))'
                : 'rgb(var(--bg-elev-2))',
            color: done
              ? 'rgb(var(--success))'
              : active
                ? 'rgb(var(--brand-fg))'
                : 'rgb(var(--fg-muted))'
          }}
        >
          {done ? <CheckIcon size={18} /> : icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14.5,
              fontWeight: 700,
              color: 'rgb(var(--fg))'
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 11.5,
              color: 'rgb(var(--fg-subtle))',
              marginTop: 4,
              lineHeight: 1.5
            }}
          >
            {desc}
          </div>
        </div>
      </div>

      <ProbeTimeline phase={phase} stages={stages} />

      <button
        className={`btn btn-block btn-lg ${
          active ? 'btn-danger' : done ? 'btn-secondary' : 'btn-primary'
        }`}
        style={{ marginTop: 16 }}
        onClick={() => void (active ? probe.stop() : probe.start())}
      >
        {active ? (
          <>
            <StopIcon size={14} /> {primaryActiveLabel}
          </>
        ) : done ? (
          <>
            <RefreshIcon size={14} /> {primaryDoneLabel}
          </>
        ) : (
          <>
            <PlayIcon size={14} /> {failed ? retryLabel : primaryLabel}
          </>
        )}
      </button>

      {(partials.src || partials.tgt) && (
        <div
          style={{
            marginTop: 14,
            padding: '12px 14px',
            borderRadius: 10,
            background: 'rgb(var(--bg-elev))',
            border: '1px solid rgb(var(--line))',
            fontSize: 12.5,
            lineHeight: 1.55
          }}
        >
          {partials.src && (
            <div style={{ color: 'rgb(var(--fg-muted))' }}>{partials.src}</div>
          )}
          {partials.tgt && (
            <div style={{ color: 'rgb(var(--fg))', marginTop: 4 }}>
              {partials.tgt}
            </div>
          )}
        </div>
      )}

      {error && (
        <div
          className="fade-in"
          style={{
            marginTop: 12,
            padding: '8px 10px',
            borderRadius: 8,
            fontSize: 11.5,
            color: 'rgb(var(--danger))',
            background: 'rgb(var(--danger) / 0.08)',
            border: '1px solid rgb(var(--danger) / 0.25)'
          }}
        >
          {error}
        </div>
      )}
    </section>
  );
}

function ProbeTimeline({
  phase,
  stages
}: {
  phase: ProbePhase;
  stages: string[];
}): React.JSX.Element {
  const activeIndex =
    phase === 'done'
      ? stages.length
      : phase === 'failed'
        ? 0
        : phase === 'connecting'
          ? 1
          : phase === 'running'
            ? 2
            : phase === 'finishing'
              ? 3
              : 0;

  return (
    <div className="onb-probe-timeline" aria-hidden>
      {stages.map((label, index) => {
        const n = index + 1;
        const complete = activeIndex > n || phase === 'done';
        const active = activeIndex === n && phase !== 'done';
        return (
          <div
            key={label}
            className={`onb-probe-stage ${active ? 'active' : ''} ${complete ? 'complete' : ''}`}
          >
            <span className="onb-probe-dot">
              {complete ? <CheckIcon size={10} /> : n}
            </span>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}
