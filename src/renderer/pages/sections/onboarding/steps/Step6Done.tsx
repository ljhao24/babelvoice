import { useTranslation } from 'react-i18next';
import { SparkleIcon } from '../../../../components/Icons.js';
import { StepShell } from '../StepShell.js';
import { ThemedHeroVideo } from '../ThemedHeroVideo.js';
import conferenceUsageLightUrl from '../../../../assets/videos/conference-usage-light.mp4';
import conferenceUsageDarkUrl from '../../../../assets/videos/conference-usage-dark.mp4';

/** Step 6 — done: how to point meeting software at BabelVoice. */
export function Step6Done({
  onFinish
}: {
  onFinish: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  return (
    <StepShell
      step={6}
      title={t('step6.title')}
      desc={t('step6.desc')}
      visual={
        <ThemedHeroVideo light={conferenceUsageLightUrl} dark={conferenceUsageDarkUrl} />
      }
      footer={
        <button className="btn btn-primary" onClick={() => void onFinish()}>
          <SparkleIcon size={13} /> {t('step6.finish')}
        </button>
      }
    />
  );
}
