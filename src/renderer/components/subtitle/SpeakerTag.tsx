import { useTranslation } from 'react-i18next';
import type { Direction } from '@shared/ipc-types.js';

export const ACCENT_CLASS: Record<Direction, string> = {
  speak: 'sub-accent-speak',
  listen: 'sub-accent-listen'
};

/**
 * The other side's speakers are numbered when the engine tells them apart;
 * your side is the microphone, so it stays "你" whatever the engine says.
 */
export const namesSpeaker = (direction: Direction, speaker: number | undefined): boolean =>
  direction === 'listen' && speaker !== undefined;

/** Who is talking: a dot in the Direction's color and "对方" / "对方 2" / "你". */
export function SpeakerTag({
  direction,
  speaker,
  live = false,
  detail
}: {
  direction: Direction;
  /** The engine's speaker number (see `namesSpeaker`). */
  speaker?: number;
  /** The Direction's session is running: the dot pulses. */
  live?: boolean;
  /** Trailing muted text, e.g. "English → 中文". */
  detail?: string;
}): React.JSX.Element {
  const { t } = useTranslation('subtitle');
  return (
    <span className="subtitle-speaker">
      <span className={`subtitle-dot ${ACCENT_CLASS[direction]} ${live ? 'is-live' : ''}`} />
      <span className={ACCENT_CLASS[direction]}>
        {namesSpeaker(direction, speaker)
          ? t('who.listenSpeaker', { n: speaker })
          : t(`who.${direction}`)}
      </span>
      {detail && <span className="subtitle-speaker-detail">{detail}</span>}
    </span>
  );
}
