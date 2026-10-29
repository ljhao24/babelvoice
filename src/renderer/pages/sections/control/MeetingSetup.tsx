import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeftRightIcon, ChevronRightIcon, PlayIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ListGroup, ListRow } from '../../../components/grouped-list.js';
import { OptionSelect, type SelectOption } from '../../../components/option-select.js';
import { TestPanelTrigger } from '../../../components/TestPanel.js';
import { usePreferences } from '../../../hooks/usePreferences.js';
import { useAudioCapableApps } from '../../../hooks/useAudioCapableApps.js';
import {
  LANGUAGE_OPTIONS,
  QWEN_VOICE_OPTIONS,
  SPEAKER_OPTIONS,
  isOptionDisabled,
  resolveLanguagePick
} from '../../../lib/language-options.js';
import { isListenPlaybackActive, type SupportedLanguage } from '@shared/config-types.js';
import type { QwenVoice, SpeakerVoice } from '@shared/engine-types.js';
import type { MeetingSummary } from '@shared/meeting-types.js';
import type { PageId } from '../../ControlPanel.js';
import { meetingLengthMs, useMeetingFormat } from '../history/meeting-format.js';
import { CredentialAlert } from './CredentialAlert.js';

/**
 * No meeting open: start one. The start action comes first — most days it
 * is all there is to do — then the choices that shape the meeting (who
 * speaks what, the voice, what to listen to), then recent meetings.
 * Picking the language the other side already uses swaps the two sides
 * (`resolveLanguagePick`); a same-language pair is never persisted.
 */
export function MeetingSetup({
  onStart,
  onOpenSettings,
  onNavigate
}: {
  onStart: () => Promise<void>;
  onOpenSettings: () => void;
  onNavigate: (page: PageId, meetingId?: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation('control');
  const { t: tq } = useTranslation('quickPicker');
  const { t: tLang } = useTranslation('languages');
  const { preferences, set } = usePreferences();
  const { apps, processTapSupported, refresh: refreshApps } = useAudioCapableApps();
  const [starting, setStarting] = useState(false);

  const engineId = preferences.engineId;
  const mine = preferences.mySpokenLanguage;
  const other = preferences.meetingLanguage;
  const languages = (blocked: SupportedLanguage): SelectOption[] =>
    LANGUAGE_OPTIONS.map((o) => ({
      value: o.value,
      label: tLang(o.i18nKey),
      disabled: isOptionDisabled(o.value, blocked)
    }));
  const pickLanguage = (side: 'mine' | 'other', v: string): void => {
    const pair = resolveLanguagePick(side, v as SupportedLanguage, { mine, other });
    void set({ mySpokenLanguage: pair.mine, meetingLanguage: pair.other });
  };

  // Gemini and OpenAI always follow the speaker's own voice — nothing to pick.
  const hasVoice = engineId !== 'gemini' && engineId !== 'openai';
  const voices: SelectOption[] = (engineId === 'qwen' ? QWEN_VOICE_OPTIONS : SPEAKER_OPTIONS).map(
    (o) => ({ value: o.value, label: tLang(`${o.i18nKey}.label`) })
  );
  const voice =
    engineId === 'qwen'
      ? preferences.engineConfigs.qwen.voice
      : preferences.engineConfigs.doubao.speakerVoice;
  const setVoice = (v: string): void => {
    void set({
      engineConfigs:
        engineId === 'qwen'
          ? { ...preferences.engineConfigs, qwen: { voice: v as QwenVoice } }
          : {
              ...preferences.engineConfigs,
              doubao: { ...preferences.engineConfigs.doubao, speakerVoice: v as SpeakerVoice }
            }
    });
  };

  // Listen source and listen playback are separate choices; playback only
  // works with a tapped source app (see isListenPlaybackActive).
  const sourceId = preferences.listenSourceAppBundleId ?? '';
  const sourceMissing = sourceId.length > 0 && !apps.some((a) => a.bundleId === sourceId);
  const sources: SelectOption[] = [
    { value: '', label: tq('source.allAudio') },
    ...(sourceMissing
      ? [{ value: sourceId, label: tq('source.missing', { bundleId: sourceId }), disabled: true }]
      : []),
    ...apps.map((a) => ({ value: a.bundleId, label: a.name }))
  ];

  const handleStart = async (): Promise<void> => {
    setStarting(true);
    try {
      await onStart();
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-7 px-6 py-8">
      <CredentialAlert onGoToSettings={onOpenSettings} />

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-title1 font-semibold">{t('idle.title')}</h2>
          <p className="text-muted-foreground">{t('idle.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="lg" disabled={starting} onClick={() => void handleStart()}>
            <PlayIcon data-icon="inline-start" />
            {t('idle.start')}
          </Button>
          <TestPanelTrigger />
        </div>
      </div>

      <ListGroup
        title={t('idle.groups.language')}
        action={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('idle.swap')}
            title={t('idle.swap')}
            onClick={() => void set({ mySpokenLanguage: other, meetingLanguage: mine })}
          >
            <ArrowLeftRightIcon />
          </Button>
        }
      >
        <ListRow label={tq('prefix.mine')} htmlFor="meeting-lang-mine">
          <OptionSelect
            className="min-w-40"
            id="meeting-lang-mine"
            items={languages(other)}
            value={mine}
            onChange={(v) => pickLanguage('mine', v)}
          />
        </ListRow>
        <ListRow label={tq('prefix.other')} htmlFor="meeting-lang-other">
          <OptionSelect
            className="min-w-40"
            id="meeting-lang-other"
            items={languages(mine)}
            value={other}
            onChange={(v) => pickLanguage('other', v)}
          />
        </ListRow>
      </ListGroup>

      <ListGroup title={t('idle.groups.audio')}>
        {hasVoice && (
          <ListRow label={t('idle.voice')} description={t('idle.voiceHint')} htmlFor="meeting-voice">
            <OptionSelect className="min-w-40" id="meeting-voice" items={voices} value={voice} onChange={setVoice} />
          </ListRow>
        )}
        {/* Per-app capture (and so playback) needs macOS 14.4+ Process Tap. */}
        {processTapSupported && (
          <>
            <ListRow
              label={tq('source.prefix')}
              description={t('idle.sourceHint')}
              htmlFor="meeting-source"
            >
              <OptionSelect
                className="min-w-40"
                id="meeting-source"
                items={sources}
                value={sourceId}
                onOpen={() => void refreshApps()}
                onChange={(v) => void set({ listenSourceAppBundleId: v || undefined })}
              />
            </ListRow>
            <ListRow
              label={tq('playTts.label')}
              description={sourceId ? tq('playTts.hint') : tq('playTts.needsSource')}
            >
              <Switch
                aria-label={tq('playTts.label')}
                checked={isListenPlaybackActive(preferences)}
                disabled={!sourceId}
                onCheckedChange={(next) => void set({ listenModePlayTts: next })}
              />
            </ListRow>
          </>
        )}
        <ListRow label={tq('micPassthrough.ariaLabel')} description={tq('micPassthrough.hint')}>
          <Switch
            aria-label={tq('micPassthrough.ariaLabel')}
            checked={preferences.micPassthroughWhenIdle}
            onCheckedChange={(next) => void set({ micPassthroughWhenIdle: next })}
          />
        </ListRow>
      </ListGroup>

      <RecentMeetings onNavigate={onNavigate} />
    </div>
  );
}

const RECENT_COUNT = 3;

/** The last few meetings, each opening its replay; "查看全部" goes to 历史. */
function RecentMeetings({
  onNavigate
}: {
  onNavigate: (page: PageId, meetingId?: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation('control');
  const format = useMeetingFormat();
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.babelVoiceBridge.listMeetings({ limit: RECENT_COUNT }).then((list) => {
      if (!cancelled) setMeetings(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (meetings.length === 0) return null;

  return (
    <ListGroup
      title={t('idle.recent')}
      action={
        <Button variant="link" size="xs" className="h-auto px-0" onClick={() => onNavigate('transcript')}>
          {t('idle.viewAll')}
        </Button>
      }
    >
      {meetings.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => onNavigate('replay', m.id)}
          className="flex min-h-11 w-full items-center gap-3 border-t border-border px-3.5 py-2 text-left outline-none first:border-t-0 hover:bg-muted focus-visible:bg-muted"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate">{m.title}</span>
            <span className="text-callout text-muted-foreground">
              {t('idle.recentMeta', {
                day: format.day(m.startedAt),
                time: format.clock(m.startedAt),
                length: format.length(meetingLengthMs(m)),
                count: m.lineCount
              })}
            </span>
          </span>
          <ChevronRightIcon className="size-4 text-muted-foreground" />
        </button>
      ))}
    </ListGroup>
  );
}
