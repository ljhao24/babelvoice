import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { usePreferences } from '../../../hooks/usePreferences.js';
import { useDraftValue } from '../../../hooks/useDraftValue.js';
import {
  SUBTITLE_HISTORY_LIMITS,
  SUBTITLE_LIVE_LINES_MAX,
  SUBTITLE_LIVE_LINES_MIN,
  type SubtitleBackground,
  type SubtitleLayout,
  type UserPreferences
} from '@shared/config-types.js';
import { PAUSE_GAP_MS } from '../../../lib/subtitle-timeline.js';
import type { SentencePair } from '../../../store/transcript-assembler.js';
import { SubtitlePanel } from '../../../components/subtitle/SubtitlePanel.js';
import type { LiveText } from '../../../components/subtitle/LiveCaption.js';
import { chromeClassFor, chromeStyleFor } from '../../../components/subtitle/chrome.js';
import { ListGroup, ListRow } from '../../../components/grouped-list.js';
import { OptionSelect } from '../../../components/option-select.js';

const IDLE: LiveText = {
  active: false,
  stitchedSrc: '',
  partialSrc: '',
  stitchedTgt: '',
  partialTgt: ''
};

/** Split a sample sentence into a settled head and an in-flight tail. */
const asLive = (src: string, tgt: string): LiveText => {
  const cut = (s: string): [string, string] => {
    const at = Math.floor(s.length * 0.62);
    return [s.slice(0, at), s.slice(at)];
  };
  const [stitchedSrc, partialSrc] = cut(src);
  const [stitchedTgt, partialTgt] = cut(tgt);
  return { active: true, stitchedSrc, partialSrc, stitchedTgt, partialTgt };
};

/**
 * The real overlay panel over a mock meeting, fed a short sample: two
 * speakers, a pause, and a sentence still being recognized. Draft slider
 * values flow in so it tracks the pointer.
 */
function SubtitlePreview({
  preferences,
  opacity,
  fontSize
}: {
  preferences: UserPreferences;
  opacity: number;
  fontSize: number;
}): React.JSX.Element {
  const { t } = useTranslation('settings');
  const sample = useMemo(() => {
    const base = Date.now() - 120_000;
    const history: SentencePair[] = [
      {
        id: 'sample-1',
        direction: 'listen',
        src: t('subtitle.preview.earlierSrc'),
        tgt: t('subtitle.preview.earlierTgt'),
        at: base,
        sessionSeq: 1
      },
      {
        id: 'sample-2',
        direction: 'speak',
        src: t('subtitle.preview.speakSrc'),
        tgt: t('subtitle.preview.speakTgt'),
        at: base + 6_000,
        sessionSeq: 1
      },
      {
        id: 'sample-3',
        direction: 'listen',
        src: t('subtitle.preview.historySrc'),
        tgt: t('subtitle.preview.historyTgt'),
        at: base + 6_000 + PAUSE_GAP_MS + 4_000,
        sessionSeq: 1
      }
    ];
    const live = {
      listen: asLive(t('subtitle.preview.sampleSrc'), t('subtitle.preview.sampleTgt')),
      speak: { ...IDLE, active: true }
    };
    return { history, live };
  }, [t]);

  const bg: SubtitleBackground = preferences.subtitleBackground;
  // A meeting is a dark video grid in either theme; the panel floats over it
  // the way the real overlay floats over the call window.
  return (
    <div
      aria-hidden
      className="relative h-[300px] overflow-hidden rounded-xl bg-[#1c1c1e] ring-1 ring-foreground/10"
    >
      <div className="absolute inset-0 grid grid-cols-2 gap-1.5 p-1.5">
        {['A', 'M', 'L', 'J'].map((who) => (
          <div
            key={who}
            className="flex items-center justify-center rounded-lg bg-white/[0.06] text-title1 font-semibold text-white/20"
          >
            {who}
          </div>
        ))}
      </div>
      <div className="absolute bottom-3 left-1/2 w-[94%] -translate-x-1/2">
        <div
          className={`${chromeClassFor(bg)} rounded-[1rem] px-5 pt-3 pb-3.5 text-fg flex flex-col`}
          style={{ ...chromeStyleFor(bg, opacity), height: 232 }}
        >
          <SubtitlePanel
            directions={['listen', 'speak']}
            history={sample.history}
            live={sample.live}
            layout={preferences.subtitleLayout}
            fontSize={fontSize}
            liveLines={preferences.subtitleLiveLines}
            showSource={preferences.subtitleShowSource}
            showHistory={preferences.subtitleShowHistory}
            languages={{
              mine: preferences.mySpokenLanguage,
              meeting: preferences.meetingLanguage
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function SubtitleSettings(): React.JSX.Element {
  const { t } = useTranslation('settings');
  const { preferences, set } = usePreferences();
  const { subtitleBackground, subtitleShowHistory } = preferences;
  const opacityDisabled = subtitleBackground === 'transparent';
  // Sliders track the pointer locally and persist debounced / on release:
  // each PreferencesSet is a sync disk write plus a broadcast to every window.
  const opacity = useDraftValue(preferences.subtitleOpacity, (v) =>
    void set({ subtitleOpacity: v })
  );
  const fontSize = useDraftValue(preferences.subtitleFontSize, (v) =>
    void set({ subtitleFontSize: v })
  );

  const backgroundOptions: { value: SubtitleBackground; label: string }[] = [
    { value: 'glass', label: t('subtitle.background.options.glass') },
    { value: 'solid', label: t('subtitle.background.options.solid') },
    { value: 'transparent', label: t('subtitle.background.options.transparent') }
  ];
  const layoutOptions: { value: SubtitleLayout; label: string }[] = [
    { value: 'timeline', label: t('subtitle.layout.options.timeline') },
    { value: 'split', label: t('subtitle.layout.options.split') }
  ];
  const liveLineOptions = Array.from(
    { length: SUBTITLE_LIVE_LINES_MAX - SUBTITLE_LIVE_LINES_MIN + 1 },
    (_, i) => SUBTITLE_LIVE_LINES_MIN + i
  ).map((n) => ({ value: n, label: t('subtitle.liveLines.option', { count: n }) }));
  const historyLimitOptions = SUBTITLE_HISTORY_LIMITS.map((n) => ({
    value: n,
    label: t('subtitle.history.limitOption', { count: n })
  }));

  return (
    <div className="flex flex-col gap-6">
      <SubtitlePreview
        preferences={preferences}
        opacity={opacity.draft}
        fontSize={fontSize.draft}
      />

      <ListGroup title={t('subtitle.groups.style')}>
        <ListRow
          label={t('subtitle.layout.label')}
          description={t('subtitle.layout.hint')}
          htmlFor="subtitle-layout"
        >
          <OptionSelect
            id="subtitle-layout"
            className="min-w-36"
            items={layoutOptions}
            value={preferences.subtitleLayout}
            onChange={(v) => void set({ subtitleLayout: v })}
          />
        </ListRow>
        <ListRow
          label={t('subtitle.background.label')}
          description={t('subtitle.background.hint')}
          htmlFor="subtitle-background"
        >
          <OptionSelect
            id="subtitle-background"
            className="min-w-36"
            items={backgroundOptions}
            value={subtitleBackground}
            onChange={(v) => void set({ subtitleBackground: v })}
          />
        </ListRow>
        <ListRow
          label={t('subtitle.opacity.label')}
          description={
            opacityDisabled ? t('subtitle.opacity.hintDisabled') : t('subtitle.opacity.hintEnabled')
          }
        >
          <div className="flex w-52 items-center gap-3">
            <Slider
              aria-label={t('subtitle.opacity.label')}
              min={0}
              max={100}
              value={opacity.draft}
              disabled={opacityDisabled}
              onValueChange={(v) => opacity.change(v as number)}
              onValueCommitted={opacity.flush}
            />
            <span className="w-12 text-right text-callout whitespace-nowrap text-muted-foreground tabular-nums">
              {opacity.draft}%
            </span>
          </div>
        </ListRow>
        <ListRow label={t('subtitle.fontSize.label')} description={t('subtitle.fontSize.hint')}>
          <div className="flex w-52 items-center gap-3">
            <Slider
              aria-label={t('subtitle.fontSize.label')}
              min={16}
              max={48}
              value={fontSize.draft}
              onValueChange={(v) => fontSize.change(v as number)}
              onValueCommitted={fontSize.flush}
            />
            <span className="w-12 text-right text-callout whitespace-nowrap text-muted-foreground tabular-nums">
              {fontSize.draft} px
            </span>
          </div>
        </ListRow>
      </ListGroup>

      <ListGroup title={t('subtitle.groups.content')}>
        <ListRow
          label={t('subtitle.liveLines.label')}
          description={t('subtitle.liveLines.hint')}
          htmlFor="subtitle-live-lines"
        >
          <OptionSelect
            id="subtitle-live-lines"
            className="min-w-20"
            items={liveLineOptions}
            value={preferences.subtitleLiveLines}
            onChange={(v) => void set({ subtitleLiveLines: v })}
          />
        </ListRow>
        <ListRow label={t('subtitle.source.label')} description={t('subtitle.source.hint')}>
          <Switch
            aria-label={t('subtitle.source.label')}
            checked={preferences.subtitleShowSource}
            onCheckedChange={(checked) => void set({ subtitleShowSource: checked })}
          />
        </ListRow>
        <ListRow label={t('subtitle.history.label')} description={t('subtitle.history.hint')}>
          <Switch
            aria-label={t('subtitle.history.label')}
            checked={subtitleShowHistory}
            onCheckedChange={(checked) => void set({ subtitleShowHistory: checked })}
          />
        </ListRow>
        <ListRow label={t('subtitle.history.limitLabel')} htmlFor="subtitle-history-limit">
          <OptionSelect
            id="subtitle-history-limit"
            className="min-w-24"
            items={historyLimitOptions}
            value={preferences.subtitleHistoryLimit}
            disabled={!subtitleShowHistory}
            onChange={(v) => void set({ subtitleHistoryLimit: v })}
          />
        </ListRow>
      </ListGroup>
    </div>
  );
}
