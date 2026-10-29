import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AudioLinesIcon,
  CaptionsIcon,
  CheckIcon,
  LanguagesIcon,
  LoaderCircleIcon,
  MicIcon,
  VideoIcon,
  Volume2Icon
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { isListenPlaybackActive } from '@shared/config-types.js';
import { isVirtualAudioDevice } from '../../audio/virtual-device.js';
import { ListGroup, ListRow } from '../../components/grouped-list.js';
import { OptionSelect, type SelectOption } from '../../components/option-select.js';
import { PageToolbar } from '../../components/page-toolbar.js';
import { useAudioCapableApps } from '../../hooks/useAudioCapableApps.js';
import { usePreferences } from '../../hooks/usePreferences.js';
import { RouteFlow, type FlowNode } from './audio/RouteFlow.js';
import { useAudioRouting, type AudioRouting } from './audio/useAudioRouting.js';

/**
 * 音频路由: the two paths sound takes through BabelVoice, each as its flow
 * (what every stop is set to) above the settings that make it work, and a
 * badge saying whether it is ready. What can be checked is checked live;
 * the meeting app's own microphone setting can't be, so it is an
 * instruction with the guide beside it.
 */
export function AudioSection(): React.JSX.Element {
  const { t } = useTranslation('audio');
  const { t: tNav } = useTranslation('nav');
  const routing = useAudioRouting();
  return (
    <>
      <PageToolbar title={tNav('items.audio')} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-5">
          <p className="px-3.5 text-muted-foreground">{t('intro')}</p>
          <SpeakRoute routing={routing} />
          <ListenRoute routing={routing} />
        </div>
      </div>
    </>
  );
}

function StatusText({
  tone,
  children
}: {
  tone: 'ok' | 'caution' | 'muted';
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1 text-callout',
        tone === 'ok' ? 'text-primary' : tone === 'caution' ? 'text-caution' : 'text-muted-foreground'
      )}
    >
      {tone === 'ok' && <CheckIcon className="size-3.5" strokeWidth={2.5} />}
      {children}
    </span>
  );
}

/** "已就绪", or how many steps are left. */
function ReadyBadge({ pending }: { pending: number }): React.JSX.Element {
  const { t } = useTranslation('audio');
  return (
    <Badge variant="secondary" className="gap-1.5">
      <span aria-hidden className={cn('size-1.5 rounded-full', pending === 0 ? 'bg-primary' : 'bg-caution')} />
      {pending === 0 ? t('ready') : t('pending', { count: pending })}
    </Badge>
  );
}

/** You speak → BabelVoice translates → the virtual microphone → the meeting app. */
function SpeakRoute({ routing }: { routing: AudioRouting }): React.JSX.Element {
  const { t } = useTranslation('audio');
  const { t: tLang } = useTranslation('languages');
  const { preferences, set } = usePreferences();
  const [micBusy, setMicBusy] = useState(false);

  const { driver, permissions, microphones } = routing;
  const micPermission = permissions?.microphone;
  const micGranted = micPermission === 'granted';
  const micUid = preferences.preferredMicrophoneUid ?? '';
  const selectedMic = microphones.find((d) => d.uid === micUid);
  const defaultMic = microphones.find((d) => d.isDefault);
  const micMissing = micUid !== '' && !selectedMic;
  const checking = driver === 'checking' || !permissions;

  const micItems: SelectOption[] = [
    {
      value: '',
      label: defaultMic
        ? t('speak.mic.systemDefaultNamed', { name: defaultMic.name })
        : t('speak.mic.systemDefault')
    },
    ...(micMissing ? [{ value: micUid, label: t('speak.mic.disconnected'), disabled: true }] : []),
    ...microphones.map((d) => ({ value: d.uid, label: d.name }))
  ];

  const requestMic = async (): Promise<void> => {
    setMicBusy(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      // Declined: the refresh below shows it.
    } finally {
      setMicBusy(false);
      void routing.refresh();
    }
  };

  const nodes: FlowNode[] = [
    {
      icon: MicIcon,
      label: t('speak.flow.mic'),
      detail: !permissions
        ? t('checking')
        : !micGranted
          ? t('flow.needsPermission')
          : micMissing
            ? t('speak.flow.micMissing')
            : ((selectedMic ?? defaultMic)?.name ?? t('speak.mic.systemDefault')),
      state: !permissions ? 'neutral' : micGranted && !micMissing ? 'ok' : 'attention'
    },
    {
      icon: LanguagesIcon,
      label: 'BabelVoice',
      detail: t('flow.translateTo', { language: tLang(`names.${preferences.meetingLanguage}`) }),
      state: 'ok'
    },
    {
      icon: AudioLinesIcon,
      label: t('speak.flow.virtualMic'),
      detail: t(`speak.flow.driver.${driver}`),
      state: driver === 'ready' ? 'ok' : driver === 'checking' || driver === 'installing' ? 'neutral' : 'attention'
    },
    {
      icon: VideoIcon,
      label: t('speak.flow.meetingApp'),
      detail: t('speak.flow.meetingAppDetail'),
      state: 'neutral'
    }
  ];

  return (
    <div className="flex flex-col gap-1.5">
      <ListGroup
        title={t('speak.title')}
        action={
          !checking && (
            <ReadyBadge pending={(driver === 'ready' ? 0 : 1) + (micGranted ? 0 : 1) + (micMissing ? 1 : 0)} />
          )
        }
      >
        <RouteFlow direction="speak" nodes={nodes} label={t('speak.title')} />
        <DriverRow routing={routing} />
        {permissions && !micGranted && (
          <ListRow
            label={t('speak.micPermission.label')}
            description={
              micPermission === 'denied' ? t('speak.micPermission.denied') : t('speak.micPermission.needed')
            }
          >
            {micPermission !== 'denied' && (
              <Button size="sm" disabled={micBusy} onClick={() => void requestMic()}>
                {t('speak.micPermission.allow')}
              </Button>
            )}
          </ListRow>
        )}
        <ListRow
          label={t('speak.mic.label')}
          description={micMissing ? t('speak.mic.missing') : t('speak.mic.description')}
          htmlFor="audio-mic"
        >
          <OptionSelect
            id="audio-mic"
            className="max-w-72 min-w-48"
            items={micItems}
            value={micUid}
            onOpen={() => void routing.refresh()}
            onChange={(v) => void set({ preferredMicrophoneUid: v || undefined })}
          />
        </ListRow>
        <ListRow label={t('speak.meetingApp.label')} description={t('speak.meetingApp.description')}>
          <Button size="sm" variant="outline" onClick={() => void window.babelVoiceBridge.openSetupGuide()}>
            {t('guide')}
          </Button>
        </ListRow>
      </ListGroup>
      <p className="px-3.5 text-callout text-muted-foreground">{t('speak.verify')}</p>
    </div>
  );
}

/** The BabelVoice driver: install it, wait for it, or confirm it is there. */
function DriverRow({ routing }: { routing: AudioRouting }): React.JSX.Element {
  const { t } = useTranslation('audio');
  const { driver, installError, install } = routing;
  const failed = driver === 'missing' && installError !== null;

  return (
    <ListRow
      label={t('speak.driver.label')}
      description={
        failed ? (
          <span className="text-destructive">
            {installError
              ? t('speak.driver.installFailed', { message: installError })
              : t('speak.driver.installFailedSimple')}
          </span>
        ) : (
          t(`speak.driver.description.${driver}`)
        )
      }
    >
      {driver === 'ready' ? (
        <StatusText tone="ok">{t('speak.driver.installed')}</StatusText>
      ) : driver === 'missing' ? (
        <Button size="sm" onClick={() => void install()}>
          {failed ? t('speak.driver.retry') : t('speak.driver.install')}
        </Button>
      ) : driver === 'installing' ? (
        <Button size="sm" disabled>
          <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
          {t('speak.driver.installing')}
        </Button>
      ) : driver === 'not-loaded' ? (
        <StatusText tone="caution">{t('speak.driver.notLoaded')}</StatusText>
      ) : (
        <StatusText tone="muted">{t('checking')}</StatusText>
      )}
    </ListRow>
  );
}

/** The meeting's sound → BabelVoice translates → subtitles (and, if on, your speakers). */
function ListenRoute({ routing }: { routing: AudioRouting }): React.JSX.Element {
  const { t } = useTranslation('audio');
  const { t: tLang } = useTranslation('languages');
  const { t: tq } = useTranslation('quickPicker');
  const { preferences, set } = usePreferences();
  const { apps } = useAudioCapableApps();
  const [busy, setBusy] = useState(false);
  // Set once a request didn't end in "granted": the prompt won't come back.
  const [hint, setHint] = useState<string | null>(null);

  const { permissions, outputs, defaultOutput } = routing;
  const screen = permissions?.screen;
  const granted = screen === 'granted';
  const sourceId = preferences.listenSourceAppBundleId;
  const sourceName = sourceId ? (apps.find((a) => a.bundleId === sourceId)?.name ?? sourceId) : null;
  const playback = isListenPlaybackActive(preferences);

  // Translated audio is for your ears only: never BabelVoice (the meeting
  // would hear it). A virtual, unplugged or legacy 'default' pick shows as
  // system default, which is also what useTtsMonitor falls back to.
  const monitorOutputs = outputs.filter((d) => !isVirtualAudioDevice(d) && d.deviceId !== 'default');
  const outputId = preferences.preferredOutputDeviceId ?? '';
  const outputValue = monitorOutputs.some((d) => d.deviceId === outputId) ? outputId : '';
  const outputItems: SelectOption[] = [
    {
      value: '',
      label:
        defaultOutput && !defaultOutput.isVirtual
          ? t('listen.output.systemDefaultNamed', { name: defaultOutput.name })
          : t('listen.output.systemDefault')
    },
    ...monitorOutputs.map((d) => ({ value: d.deviceId, label: d.label || t('deviceLabelMissing') }))
  ];
  const defaultIsVirtual = outputValue === '' && defaultOutput?.isVirtual === true;

  const requestScreen = async (): Promise<void> => {
    setBusy(true);
    setHint(null);
    try {
      const result = await window.babelVoiceBridge.requestScreenPermission();
      if (result.statusAfter !== 'granted') setHint(result.hint ?? t('listen.permission.restartHint'));
    } catch {
      setHint(t('listen.permission.restartHint'));
    } finally {
      setBusy(false);
      void routing.refresh();
    }
  };

  const nodes: FlowNode[] = [
    {
      icon: Volume2Icon,
      label: t('listen.flow.source'),
      detail: !permissions
        ? t('checking')
        : granted
          ? (sourceName ?? t('listen.flow.allAudio'))
          : t('flow.needsPermission'),
      state: !permissions ? 'neutral' : granted ? 'ok' : 'attention'
    },
    {
      icon: LanguagesIcon,
      label: 'BabelVoice',
      detail: t('flow.translateTo', { language: tLang(`names.${preferences.mySpokenLanguage}`) }),
      state: 'ok'
    },
    {
      icon: CaptionsIcon,
      label: t('listen.flow.subtitles'),
      detail: playback ? t('listen.flow.withVoice') : t('listen.flow.subtitlesOnly'),
      state: 'ok'
    }
  ];

  return (
    <div className="flex flex-col gap-1.5">
      <ListGroup title={t('listen.title')} action={permissions && <ReadyBadge pending={granted ? 0 : 1} />}>
        <RouteFlow direction="listen" nodes={nodes} label={t('listen.title')} />
        <ListRow
          label={t('listen.permission.label')}
          description={granted ? t('listen.permission.granted') : (hint ?? t('listen.permission.needed'))}
        >
          {!permissions ? (
            <StatusText tone="muted">{t('checking')}</StatusText>
          ) : granted ? (
            <StatusText tone="ok">{t('listen.permission.allowed')}</StatusText>
          ) : hint ? (
            <Button size="sm" onClick={() => void window.babelVoiceBridge.openScreenSettings()}>
              {t('listen.permission.openSettings')}
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => void requestScreen()}>
              {t('listen.permission.allow')}
            </Button>
          )}
        </ListRow>
        <ListRow
          label={t('listen.output.label')}
          description={
            defaultIsVirtual ? (
              <span className="text-caution">{t('listen.output.defaultIsVirtual')}</span>
            ) : playback ? (
              t('listen.output.description')
            ) : (
              t('listen.output.unused', { setting: tq('playTts.label') })
            )
          }
          htmlFor="audio-output"
        >
          <OptionSelect
            id="audio-output"
            className="max-w-72 min-w-48"
            items={outputItems}
            value={outputValue}
            onOpen={() => void routing.refresh()}
            onChange={(v) => void set({ preferredOutputDeviceId: v || undefined })}
          />
        </ListRow>
      </ListGroup>
      <p className="px-3.5 text-callout text-muted-foreground">{t('listen.footnote')}</p>
    </div>
  );
}
