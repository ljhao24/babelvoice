import { useTranslation } from 'react-i18next';
import { HeadphonesIcon } from '../../../../components/Icons.js';
import { useDirectionProbe } from '../../../../hooks/useDirectionProbe.js';
import { VIRTUAL_AUDIO_DISPLAY_NAME } from '../../../../audio/virtual-device.js';
import type { StartTranslationParams } from '@shared/ipc-types.js';
import { ProbeCard } from '../ProbeCard.js';
import { NextButton, StepShell } from '../StepShell.js';
import { ThemedHeroVideo } from '../ThemedHeroVideo.js';
// Bundled English clip used by the listen-direction smoke test. Vite's
// asset pipeline resolves this to a hashed URL in both dev and packaged
// builds, so we don't have to wire it through electron-builder.
import listenSampleUrl from '../../../../assets/listen-sample.m4a';
import subtitleStreamLightUrl from '../../../../assets/videos/subtitle-stream-light.mp4';
import subtitleStreamDarkUrl from '../../../../assets/videos/subtitle-stream-dark.mp4';

const LISTEN_TIMEOUT_MS = 15_000;

/** Fixed en → zh, mirroring the speak probe's fixed zh → en. */
const LISTEN_PROBE_PARAMS: StartTranslationParams = {
  direction: 'listen',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  mode: 's2t',
  suppressOverlay: true
};

/**
 * Step 5 — listen-direction probe: play the bundled clip through the
 * speakers into the system-audio capture, done on the first final
 * translation.
 */
export function Step5Listen({ onAdvance }: { onAdvance: () => void }): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const listen = useDirectionProbe({
    params: LISTEN_PROBE_PARAMS,
    doneOn: 'translation-subtitle-final',
    timeoutMs: LISTEN_TIMEOUT_MS,
    messages: {
      failed: t('step5.errors.listenFailed'),
      timeout: t('step5.errors.listenTimeout')
    },
    stimulus: {
      // Wait briefly so the listen client is connected before we play the
      // sample audio — otherwise the first second can be lost.
      delayMs: 400,
      play: (fail) => {
        const audio = new Audio(listenSampleUrl);
        audio.onerror = (): void => {
          fail(t('step5.errors.audioLoadFailed'));
        };
        audio.play().catch((err) => {
          fail(
            err instanceof Error
              ? t('step5.errors.audioPlayFailed', { message: err.message })
              : t('step5.errors.audioPlayFailedSimple')
          );
        });
        return () => audio.pause();
      }
    }
  });
  const done = listen.phase === 'done';

  const stages = t('probeStages.listen', { returnObjects: true }) as string[];

  return (
    <StepShell
      step={5}
      title={t('step5.title')}
      desc={t('step5.desc', { deviceName: VIRTUAL_AUDIO_DISPLAY_NAME })}
      visual={
        <ThemedHeroVideo
          light={subtitleStreamLightUrl}
          dark={subtitleStreamDarkUrl}
          done={done}
          badge={t('badges.listenOk')}
        />
      }
      footer={<NextButton enabled={done} onClick={onAdvance} />}
    >
      <ProbeCard
        probe={listen}
        title={t('step5.card.title')}
        desc={t('step5.card.desc', { deviceName: VIRTUAL_AUDIO_DISPLAY_NAME })}
        icon={<HeadphonesIcon size={18} />}
        primaryLabel={t('step5.card.primary')}
        primaryActiveLabel={t('step5.card.active')}
        primaryDoneLabel={t('step5.card.done')}
        retryLabel={t('step5.card.retry')}
        stages={stages}
      />
    </StepShell>
  );
}
