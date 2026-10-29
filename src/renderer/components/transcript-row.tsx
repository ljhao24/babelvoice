import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { Direction } from '@shared/ipc-types.js';

export interface TranscriptLine {
  direction: Direction;
  src: string;
  tgt: string;
  at: number;
  /** The engine's speaker number, when it tells the other side's speakers apart. */
  speaker?: number;
}

const clock = (at: number, withSeconds: boolean): string =>
  new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {})
  });

/** `text` with every case-insensitive occurrence of `query` marked. */
function Highlighted({ text, query }: { text: string; query?: string }): React.JSX.Element {
  if (!query) return <>{text}</>;
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  // Lower-casing can change the length (İ → i̇); the indices would not line up.
  if (haystack.length !== text.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let from = 0;
  for (let hit = haystack.indexOf(needle); hit !== -1; hit = haystack.indexOf(needle, from)) {
    if (hit > from) parts.push(text.slice(from, hit));
    parts.push(
      <mark key={hit} className="rounded-[3px] bg-highlight text-highlight-foreground">
        {text.slice(hit, hit + needle.length)}
      </mark>
    );
    from = hit + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

/**
 * One sentence pair: time, who said it (你 in the speak colour, 对方 in the
 * listen colour, numbered when the engine tells speakers apart), the
 * original muted above its translation. Committed pairs never change, so a
 * row renders once.
 */
export const TranscriptRow = memo(function TranscriptRow({
  row,
  highlight,
  showTime = true
}: {
  row: TranscriptLine;
  /** Marks this text in both lines (find in transcript). */
  highlight?: string;
  /** Off for a row in the same minute as the one above it. */
  showTime?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation('control');
  const isSpeak = row.direction === 'speak';
  const speaker = isSpeak ? undefined : row.speaker;
  return (
    <div className="grid grid-cols-[2.75rem_2rem_minmax(0,1fr)] gap-x-3 border-t border-border px-4 py-2.5 first:border-t-0">
      <time
        dateTime={new Date(row.at).toISOString()}
        title={clock(row.at, true)}
        className={cn('pt-px text-subheadline text-muted-foreground tabular-nums', !showTime && 'invisible')}
      >
        {clock(row.at, false)}
      </time>
      <div className="flex flex-col items-start gap-1">
        <span className={cn('text-callout font-semibold', isSpeak ? 'text-speak' : 'text-listen')}>
          {isSpeak ? t('transcriptPanel.you') : t('transcriptPanel.other')}
        </span>
        {speaker !== undefined && (
          // "对方" already fills the column; the number goes under it.
          <span
            title={t('transcriptPanel.otherSpeaker', { n: speaker })}
            className="rounded-full bg-listen/15 px-1.5 text-footnote font-semibold text-listen tabular-nums"
          >
            {speaker}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-callout text-muted-foreground">
          <Highlighted text={row.src} query={highlight} />
        </p>
        <p className="leading-relaxed">
          <Highlighted text={row.tgt} query={highlight} />
        </p>
      </div>
    </div>
  );
});

/** Same local minute: the second row's time would just repeat the first's. */
export const sameMinute = (a: number, b: number): boolean =>
  Math.floor(a / 60_000) === Math.floor(b / 60_000);
