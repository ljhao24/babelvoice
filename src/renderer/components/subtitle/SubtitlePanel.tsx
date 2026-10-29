import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Direction } from '@shared/ipc-types.js';
import type { SubtitleLayout, SupportedLanguage } from '@shared/config-types.js';
import { buildTimeline, lastPairOf } from '../../lib/subtitle-timeline.js';
import type { SentencePair } from '../../store/transcript-assembler.js';
import { LiveCaption, type LiveText } from './LiveCaption.js';
import { SpeakerTag } from './SpeakerTag.js';
import { SubtitleHistory } from './SubtitleHistory.js';

export interface SubtitlePanelProps {
  /** Directions on screen, in display order. */
  directions: Direction[];
  /** Committed sentences, oldest first (both Directions). */
  history: readonly SentencePair[];
  live: Record<Direction, LiveText>;
  layout: SubtitleLayout;
  fontSize: number;
  liveLines: number;
  showSource: boolean;
  showHistory: boolean;
  languages: { mine: SupportedLanguage; meeting: SupportedLanguage };
  onToggleSource?: () => void;
}

const hasText = (l: LiveText): boolean =>
  Boolean(l.stitchedSrc || l.partialSrc || l.stitchedTgt || l.partialTgt);

/**
 * The subtitle overlay's content, as a pure function of its data — the
 * overlay feeds it the store, the settings preview feeds it a sample, so
 * the preview is the real thing.
 *
 * `timeline` (or a single Direction): one chronological history, then the
 * live area. `split` with two Directions: a column each.
 */
export function SubtitlePanel(props: SubtitlePanelProps): React.JSX.Element {
  const { directions, layout } = props;
  if (layout === 'split' && directions.length > 1) {
    return (
      <div className="grid h-full min-h-0 grid-cols-2 gap-7 divide-x divide-line">
        {directions.map((d, i) => (
          <div key={d} className={`flex h-full min-h-0 flex-col ${i > 0 ? 'pl-7' : ''}`}>
            <PanelHeader {...props} directions={[d]} showToggle={i === directions.length - 1} />
            <Stack {...props} directions={[d]} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader {...props} showToggle />
      <Stack {...props} />
    </div>
  );
}

function PanelHeader({
  directions,
  live,
  languages,
  showSource,
  onToggleSource,
  showToggle
}: SubtitlePanelProps & { showToggle: boolean }): React.JSX.Element {
  const { t } = useTranslation('subtitle');
  const { t: tLang } = useTranslation('languages');
  const pair = (d: Direction): string => {
    const [from, to] =
      d === 'listen' ? [languages.meeting, languages.mine] : [languages.mine, languages.meeting];
    return t('langPair', { from: tLang(`names.${from}`), to: tLang(`names.${to}`) });
  };
  return (
    <div className="subtitle-header">
      {directions.map((d) => (
        <SpeakerTag key={d} direction={d} live={live[d].active} detail={pair(d)} />
      ))}
      {showToggle && onToggleSource && (
        <button type="button" className="subtitle-source-toggle app-no-drag" onClick={onToggleSource}>
          {showSource ? t('source.hide') : t('source.show')}
        </button>
      )}
    </div>
  );
}

/** History (if any) above the live area, for one or more Directions. */
function Stack({
  directions,
  history,
  live,
  fontSize,
  liveLines,
  showSource,
  showHistory
}: SubtitlePanelProps): React.JSX.Element {
  const many = directions.length > 1;
  // Callers build `directions` per render; key the memo on its contents so
  // a live delta doesn't rebuild (and re-render) the history.
  const directionKey = directions.join(',');
  const mine = useMemo(
    () => history.filter((p) => directionKey.split(',').includes(p.direction)),
    [history, directionKey]
  );

  // Who gets a live caption: every Direction with words in flight. With none
  // in flight, one Direction shows the sentence that just closed — the
  // newest, so the live area doesn't hold two stale lines.
  const speaking = directions.filter((d) => hasText(live[d]));
  const newest = mine.length > 0 ? mine[mine.length - 1] : null;
  const captioned: Direction[] =
    speaking.length > 0 ? speaking : many ? (newest ? [newest.direction] : []) : directions;
  // A closed sentence shown in the live area is not repeated in history.
  const fallbacks = captioned
    .filter((d) => !hasText(live[d]))
    .map((d) => lastPairOf(mine, d))
    .filter((p): p is SentencePair => p !== null);
  const fallbackIds = fallbacks.map((p) => p.id).join('|');
  const items = useMemo(() => {
    const hidden = new Set(fallbackIds.split('|'));
    return buildTimeline(
      mine.filter((p) => !hidden.has(p.id)),
      { context: history }
    );
  }, [mine, fallbackIds, history]);

  const listed = showHistory && items.length > 0;
  // Two captions share the room one gets.
  const lines = captioned.length > 1 ? Math.max(1, liveLines - 1) : liveLines;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {listed ? (
        <SubtitleHistory
          items={items}
          fontSize={fontSize}
          showSource={showSource}
          showSpeaker={many}
        />
      ) : (
        <div className="flex-1" />
      )}
      {captioned.length > 0 && (
        <div className={`subtitle-live-area ${listed ? 'has-history' : ''}`}>
          {captioned.map((d) => (
            <LiveCaption
              key={d}
              direction={d}
              live={live[d]}
              fallback={fallbacks.find((p) => p.direction === d) ?? null}
              fontSize={fontSize}
              lines={lines}
              showSource={showSource}
              showSpeaker={many}
            />
          ))}
        </div>
      )}
    </div>
  );
}
