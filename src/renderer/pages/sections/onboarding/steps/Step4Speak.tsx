import { useTranslation } from 'react-i18next';
import { MicIcon } from '../../../../components/Icons.js';
import { useDirectionProbe } from '../../../../hooks/useDirectionProbe.js';
import type { StartTranslationParams } from '@shared/ipc-types.js';
import { ProbeCard } from '../ProbeCard.js';
import { NextButton, StepShell } from '../StepShell.js';
import { ThemedHeroVideo } from '../ThemedHeroVideo.js';
import translationTestLightUrl from '../../../../assets/videos/translation-test-light.mp4';
import translationTestDarkUrl from '../../../../assets/videos/translation-test-dark.mp4';

const SPEAK_TIMEOUT_MS = 30_000;

/**
 * The onboarding speak test always runs zh → en regardless of the user's
 * saved language settings. This way we can give a deterministic prompt
 * ("说一句中文，应该听到英文") and don't need a same-language guard. Their
 * real meeting prefs live in Settings and only affect ControlPanel.
 */
const SPEAK_PROBE_PARAMS: StartTranslationParams = {
  direction: 'speak',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  mode: 's2s',
  // The probe renders its own preview card — keep the floating overlay
  // out of the wizard so we can design dedicated onboarding UI.
  suppressOverlay: true
};

/** Step 4 — end-to-end speak test: mic → translation → TTS played back. */
export function Step4Speak({ onAdvance }: { onAdvance: () => void }): React.JSX.Element {
  const { t } = useTranslation('onboarding');

  // The speak-test TTS is heard through useTtsMonitor (allowSpeak), which
  // already plays through a real output — the system default when the
  // preferred device is BabelVoice or unset — so no device juggling here.
  // Done on `tts-sentence-end`: "we transcribed, translated, AND played
  // back TTS".
  const speak = useDirectionProbe({
    params: SPEAK_PROBE_PARAMS,
    doneOn: 'tts-sentence-end',
    timeoutMs: SPEAK_TIMEOUT_MS,
    messages: {
      failed: t('step4.errors.translationFailed'),
      timeout: t('step4.errors.speakTimeout')
    }
  });
  const done = speak.phase === 'done';

  const stages = t('probeStages.speak', { returnObjects: true }) as string[];

  return (
    <StepShell
      step={4}
      title={t('step4.title')}
      desc={t('step4.desc')}
      visual={
        <ThemedHeroVideo
          light={translationTestLightUrl}
          dark={translationTestDarkUrl}
          done={done}
          badge={t('badges.speakOk')}
        />
      }
      footer={<NextButton enabled={done} onClick={onAdvance} />}
    >
      <ProbeCard
        probe={speak}
        title={t('step4.card.title')}
        desc={t('step4.card.desc')}
        icon={<MicIcon size={18} />}
        primaryLabel={t('step4.card.primary')}
        primaryActiveLabel={t('step4.card.active')}
        primaryDoneLabel={t('step4.card.done')}
        retryLabel={t('step4.card.retry')}
        stages={stages}
      />
    </StepShell>
  );
}
