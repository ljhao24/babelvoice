import { useTranslation } from 'react-i18next';
import type { Direction } from '@shared/ipc-types.js';
import { splitLive } from '../../lib/subtitle-timeline.js';
import type { SentencePair } from '../../store/transcript-assembler.js';
import { ACCENT_CLASS, SpeakerTag, namesSpeaker } from './SpeakerTag.js';
import { TailClamp } from './TailClamp.js';

/** What a Direction is saying right now (the store's live fields). */
export interface LiveText {
  active: boolean;
  stitchedSrc: string;
  partialSrc: string;
  stitchedTgt: string;
  partialTgt: string;
  /** Who is saying the line in flight, when the engine tells speakers apart. */
  speaker?: number;
}

const TGT_LINE_HEIGHT = 1.36;
const SRC_LINE_HEIGHT = 1.45;

/**
 * One Direction's sentence in progress: the translation large, holding
 * `lines` lines and growing up over the history as a run-on sentence gets
 * longer (only once it fills the panel does it show just its newest words),
 * the source as a single line above it. The part ASR may still rewrite is
 * drawn lighter.
 * With nothing in flight it keeps showing `fallback` — the sentence that
 * just closed — so a commit doesn't blank the area.
 */
export function LiveCaption({
  direction,
  live,
  fallback,
  fontSize,
  lines,
  showSource,
  showSpeaker
}: {
  direction: Direction;
  live: LiveText;
  fallback: SentencePair | null;
  fontSize: number;
  lines: number;
  showSource: boolean;
  /**
   * Name the speaker (more than one Direction on screen). A numbered
   * speaker is named regardless.
   */
  showSpeaker: boolean;
}): React.JSX.Element {
  const { t } = useTranslation('subtitle');
  const src = splitLive(live.stitchedSrc, live.partialSrc);
  const tgt = splitLive(live.stitchedTgt, live.partialTgt);
  const inFlight = Boolean(src.settled || src.pending || tgt.settled || tgt.pending);
  const shown = inFlight
    ? { src, tgt }
    : {
        src: { settled: fallback?.src ?? '', pending: '' },
        tgt: { settled: fallback?.tgt ?? '', pending: '' }
      };
  const speaker = inFlight ? live.speaker : fallback?.speaker;
  const named = showSpeaker || namesSpeaker(direction, speaker);
  const empty = !shown.tgt.settled && !shown.tgt.pending;
  const sourceSize = Math.max(11, Math.round(fontSize * 0.62));

  return (
    <div className="subtitle-live">
      {(named || showSource) && (
        // Who and the source share one row: the translation gets the room.
        <div className="flex shrink-0 items-center gap-2.5">
          {named && <SpeakerTag direction={direction} speaker={speaker} live={live.active} />}
          {showSource && (
            <TailClamp
              lines={1}
              lineHeight={SRC_LINE_HEIGHT}
              reserve
              className="selectable subtitle-text subtitle-live-src min-w-0 flex-1"
              style={{ fontSize: sourceSize }}
            >
              {shown.src.settled}
              <span className="subtitle-pending">{shown.src.pending}</span>
            </TailClamp>
          )}
        </div>
      )}
      <TailClamp
        lines={lines}
        lineHeight={TGT_LINE_HEIGHT}
        reserve
        grow
        className={`selectable subtitle-text subtitle-live-tgt sub-translation ${ACCENT_CLASS[direction]}`}
        style={{ fontSize }}
      >
        {empty ? (
          <span className="subtitle-placeholder">
            {live.active ? t('placeholder.listening') : t('placeholder.idle')}
          </span>
        ) : (
          <>
            {shown.tgt.settled}
            <span className="subtitle-pending">{shown.tgt.pending}</span>
          </>
        )}
      </TailClamp>
    </div>
  );
}
