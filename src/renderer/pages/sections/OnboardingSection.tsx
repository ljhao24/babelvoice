/**
 * First-run setup wizard. Renders instead of the normal ControlPanel shell
 * when `preferences.setupCompletedAt` is unset; gating happens in
 * `ControlPanel.tsx`, which lazy-loads this module (the steps and their
 * hero clips stay out of the main chunk). Six sequential steps, each with
 * its own success detection, in `./onboarding/steps/`:
 *
 *   1. Install BabelVoice virtual driver
 *   2. Mic + screen-recording permissions
 *   3. Engine + API key + connectivity smoke test
 *   4. End-to-end speak test (real translation roundtrip)
 *   5. End-to-end listen test
 *   6. Done — instructions to point meeting software at BabelVoice
 *
 * The wizard is also re-enterable from Settings (resets `setupCompletedAt`
 * to undefined). Already-satisfied steps will show as done immediately so
 * a returning user can click straight through.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import appIconUrl from '../../assets/app-icon.svg';
import { usePreferences } from '../../hooks/usePreferences.js';
import { Crumb } from './onboarding/Crumb.js';
import { Step1Driver } from './onboarding/steps/Step1Driver.js';
import { Step2Permissions } from './onboarding/steps/Step2Permissions.js';
import { Step3Engine } from './onboarding/steps/Step3Engine.js';
import { Step4Speak } from './onboarding/steps/Step4Speak.js';
import { Step5Listen } from './onboarding/steps/Step5Listen.js';
import { Step6Done } from './onboarding/steps/Step6Done.js';

type StepId = 1 | 2 | 3 | 4 | 5 | 6;

interface Props {
  onFinish: () => void;
}

export function OnboardingSection({ onFinish }: Props): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const { set: setPref } = usePreferences();
  const [step, setStep] = useState<StepId>(1);

  const stepLabels: Record<StepId, string> = {
    1: t('stepLabels.1'),
    2: t('stepLabels.2'),
    3: t('stepLabels.3'),
    4: t('stepLabels.4'),
    5: t('stepLabels.5'),
    6: t('stepLabels.6')
  };

  const handleFinish = async (): Promise<void> => {
    await setPref({ setupCompletedAt: Date.now() });
    onFinish();
  };

  const handleSkip = async (): Promise<void> => {
    if (!window.confirm(t('header.skipConfirm'))) {
      return;
    }
    await setPref({ setupCompletedAt: Date.now() });
    onFinish();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgb(var(--bg))',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 50,
        WebkitAppRegion: 'no-drag'
      } as React.CSSProperties}
    >
      <div
        style={{
          height: 32,
          flexShrink: 0,
          WebkitAppRegion: 'drag'
        } as React.CSSProperties}
      />

      <header
        style={{
          padding: '20px 32px 16px',
          borderBottom: '1px solid rgb(var(--line))',
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 16
        }}
      >
        <img
          src={appIconUrl}
          alt=""
          width={40}
          height={40}
          style={{ flexShrink: 0 }}
        />
        <div>
          <div
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: 'rgb(var(--fg))'
            }}
          >
            {t('header.title')}
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'rgb(var(--fg-subtle))',
              marginTop: 2
            }}
          >
            {t('header.sub')}
          </div>
        </div>
        <button
          className="btn btn-ghost"
          style={{ fontSize: 11.5, marginLeft: 'auto' }}
          onClick={() => void handleSkip()}
        >
          {t('header.skip')}
        </button>
      </header>

      {import.meta.env.DEV && (
        <div
          style={{
            position: 'fixed',
            bottom: 16,
            right: 16,
            zIndex: 60,
            padding: '8px 10px',
            borderRadius: 12,
            background: 'rgb(var(--bg-elev) / 0.92)',
            border: '1px solid rgb(var(--line))',
            backdropFilter: 'blur(12px)',
            boxShadow: '0 8px 24px rgb(0 0 0 / 0.18)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap'
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
              color: 'rgb(var(--fg-subtle))',
              padding: '0 6px'
            }}
          >
            DEV
          </span>
          {([1, 2, 3, 4, 5, 6] as StepId[]).map((n) => (
            <Crumb
              key={n}
              n={n}
              label={stepLabels[n]}
              active={n === step}
              done={n < step}
              onClick={() => setStep(n)}
            />
          ))}
        </div>
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '24px 32px 32px',
          display: 'flex',
          justifyContent: 'center'
        }}
      >
        <div style={{ width: '100%', maxWidth: 760 }}>
          {step === 1 && <Step1Driver onAdvance={() => setStep(2)} />}
          {step === 2 && <Step2Permissions onAdvance={() => setStep(3)} />}
          {step === 3 && <Step3Engine onAdvance={() => setStep(4)} />}
          {step === 4 && <Step4Speak onAdvance={() => setStep(5)} />}
          {step === 5 && <Step5Listen onAdvance={() => setStep(6)} />}
          {step === 6 && <Step6Done onFinish={handleFinish} />}
        </div>
      </div>
    </div>
  );
}
