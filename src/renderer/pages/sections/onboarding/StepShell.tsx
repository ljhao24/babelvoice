import { useTranslation } from 'react-i18next';

export const TOTAL_STEPS = 6;

/** Common frame of a wizard step: hero, eyebrow, title, copy, body, footer actions. */
export function StepShell({
  step,
  eyebrow,
  title,
  desc,
  visual,
  children,
  footer
}: {
  step?: number;
  eyebrow?: string;
  title: string;
  desc: string;
  visual?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const eyebrowText =
    eyebrow ?? (step !== undefined ? t('stepCounter', { n: step, total: TOTAL_STEPS }) : '');
  return (
    <div
      key={step ?? title}
      className="onb-step-shell fade-in"
      style={{ width: '100%' }}
    >
      {visual && <div className="onb-hero">{visual}</div>}
      <div className="onb-eyebrow">{eyebrowText}</div>
      <h1 className="onb-title">{title}</h1>
      <p className="onb-desc">{desc}</p>
      {children}
      {footer && (
        <div
          style={{
            marginTop: 32,
            paddingTop: 20,
            borderTop: '1px solid rgb(var(--line))',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 10
          }}
        >
          {footer}
        </div>
      )}
    </div>
  );
}

/** The footer's "next" button, enabled once the step is satisfied. */
export function NextButton({
  enabled,
  onClick
}: {
  enabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  return (
    <button className="btn btn-primary" disabled={!enabled} onClick={onClick}>
      {t('next')}
    </button>
  );
}
