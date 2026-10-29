import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/shallow';
import { CheckIcon, HeadphonesIcon, MicIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AcceleratorKeys } from '../../../components/accelerator-keys.js';
import { ListRow } from '../../../components/grouped-list.js';
import { useAppStore } from '../../../store/app-store.js';
import { useSpeakSession } from '../../../hooks/useSpeakSession.js';
import { useListenSession } from '../../../hooks/useListenSession.js';
import { usePreferences } from '../../../hooks/usePreferences.js';
import { useAudioCapableApps } from '../../../hooks/useAudioCapableApps.js';
import { QWEN_VOICE_OPTIONS, SPEAKER_OPTIONS } from '../../../lib/language-options.js';
import type { ScreenPermissionStatus } from '@shared/ipc-types.js';
import { CredentialAlert } from './CredentialAlert.js';
import { DirectionCard } from './DirectionCard.js';
import { LiveTranscript } from './LiveTranscript.js';
import { MeetingMonitorCard } from './MeetingMonitorCard.js';

/**
 * The open meeting: speak and listen with the meeting monitor in a column
 * on the left, the conversation filling the rest.
 */
export function ActiveMeetingBody({
  onOpenSettings,
  onOpenPricing
}: {
  onOpenSettings: () => void;
  onOpenPricing: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('control');
  const { t: tq } = useTranslation('quickPicker');
  const { t: tLang } = useTranslation('languages');
  // Only the lifecycle fields: the live partial/stitched text changes on
  // every subtitle delta and is rendered by the overlay, not here.
  const speak = useAppStore(
    useShallow((s) => ({
      status: s.speak.status,
      active: s.speak.active,
      lastError: s.speak.lastError,
      lastErrorKind: s.speak.lastErrorKind
    }))
  );
  const listen = useAppStore(
    useShallow((s) => ({
      status: s.listen.status,
      active: s.listen.active,
      lastError: s.listen.lastError,
      lastErrorKind: s.listen.lastErrorKind
    }))
  );
  const speakSession = useSpeakSession();
  const listenSession = useListenSession();
  const { preferences } = usePreferences();
  const { apps, processTapSupported } = useAudioCapableApps();

  const [permission, setPermission] = useState<ScreenPermissionStatus>('unknown');
  const refreshPermission = async (): Promise<void> => {
    try {
      setPermission(await window.babelVoiceBridge.getScreenPermission());
    } catch {
      setPermission('unknown');
    }
  };
  useEffect(() => {
    void refreshPermission();
  }, []);

  const onListenClick = async (): Promise<void> => {
    if (listen.status === 'idle' || listen.status === 'failed') {
      await listenSession.start();
      void refreshPermission();
    } else {
      await listenSession.stop();
    }
  };

  const mine = tLang(`names.${preferences.mySpokenLanguage}`);
  const other = tLang(`names.${preferences.meetingLanguage}`);
  const engineId = preferences.engineId;
  // Gemini and OpenAI always follow the speaker's own voice — nothing to show.
  const voiceOption =
    engineId === 'qwen'
      ? QWEN_VOICE_OPTIONS.find((o) => o.value === preferences.engineConfigs.qwen.voice)
      : engineId === 'doubao'
        ? SPEAKER_OPTIONS.find((o) => o.value === preferences.engineConfigs.doubao.speakerVoice)
        : undefined;
  const sourceId = preferences.listenSourceAppBundleId;
  const sourceName = sourceId
    ? (apps.find((a) => a.bundleId === sourceId)?.name ?? sourceId)
    : tq('source.allAudio');

  return (
    <div className="flex min-h-0 flex-1 gap-4 p-4">
      <div className="flex w-[340px] shrink-0 flex-col gap-4 overflow-y-auto">
        <CredentialAlert onGoToSettings={onOpenSettings} />

        <DirectionCard
          tone="speak"
          icon={<MicIcon />}
          title={t('speak.title')}
          subtitle={`${mine} → ${other} · ${t('speak.target')}`}
          status={speak.status}
          active={speak.active}
          lastError={speak.lastError}
          lastErrorKind={speak.lastErrorKind}
          onOpenSettings={onOpenSettings}
          labels={{
            statusStarting: t('speak.status.starting'),
            statusFinishing:
              speak.status === 'finishing'
                ? t('speak.status.finishingPlayback')
                : t('speak.status.stopping'),
            statusRunning: t('speak.status.running'),
            statusIdle: t('speak.status.idle'),
            buttonCancelStart: t('speak.buttons.cancelStart'),
            buttonFinishing:
              speak.status === 'finishing'
                ? t('speak.buttons.finishPlayback')
                : t('speak.buttons.stopping'),
            buttonStop: t('speak.buttons.stop'),
            buttonStart: t('speak.buttons.start')
          }}
          onToggle={() => void speakSession.toggle()}
        >
          {voiceOption && (
            <ListRow label={t('idle.voice')}>
              <span className="text-muted-foreground">{tLang(`${voiceOption.i18nKey}.label`)}</span>
            </ListRow>
          )}
          <ListRow label={t('speak.hotkeyLabel')} description={t('speak.hotkeyHint')}>
            <AcceleratorKeys accelerator={preferences.hotkey} />
          </ListRow>
        </DirectionCard>

        <DirectionCard
          tone="listen"
          icon={<HeadphonesIcon />}
          title={t('listen.title')}
          subtitle={`${other} → ${mine} · ${t('listen.target')}`}
          status={listen.status}
          active={listen.active}
          lastError={listen.lastError}
          lastErrorKind={listen.lastErrorKind}
          onOpenSettings={onOpenSettings}
          labels={{
            statusStarting: t('listen.status.starting'),
            statusFinishing:
              listen.status === 'finishing'
                ? t('listen.status.finishingSubtitle')
                : t('listen.status.stopping'),
            statusRunning: t('listen.status.running'),
            statusIdle: t('listen.status.idle'),
            buttonCancelStart: t('listen.buttons.cancelStart'),
            buttonFinishing:
              listen.status === 'finishing'
                ? t('listen.buttons.finishSubtitle')
                : t('listen.buttons.stopping'),
            buttonStop: t('listen.buttons.stop'),
            buttonStart: t('listen.buttons.start')
          }}
          onToggle={() => void onListenClick()}
        >
          {processTapSupported && (
            <ListRow label={tq('source.prefix')}>
              <span className="truncate text-muted-foreground">{sourceName}</span>
            </ListRow>
          )}
          <ListRow
            label={t('listen.permission.label')}
            description={
              permission === 'granted' || permission === 'unknown'
                ? undefined
                : t('listen.permission.needed')
            }
          >
            {permission === 'granted' ? (
              <span className="flex items-center gap-1 text-callout text-speak">
                <CheckIcon className="size-3.5" strokeWidth={2.5} />
                {t('listen.permission.grantedShort')}
              </span>
            ) : permission === 'unknown' ? (
              <span className="text-callout text-muted-foreground">{t('listen.permission.checking')}</span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await window.babelVoiceBridge.requestScreenPermission();
                  void refreshPermission();
                }}
              >
                {t('listen.permission.grantCta')}
              </Button>
            )}
          </ListRow>
        </DirectionCard>

        <MeetingMonitorCard onEditPrices={onOpenPricing} />
      </div>

      <LiveTranscript />
    </div>
  );
}
