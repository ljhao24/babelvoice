import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon, MessagesSquareIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { TranscriptRow } from '../../../components/transcript-row.js';
import { useAppStore } from '../../../store/app-store.js';

type Filter = 'all' | 'speak' | 'listen';

/**
 * The live panel renders only the newest lines; the full transcript is
 * persisted and readable on the 历史 page. Keeps a long meeting from
 * reconciling up to `historyLimit` rows on every committed sentence.
 */
const VISIBLE_TRANSCRIPT_ROWS = 200;

/** Within this many px of the end counts as "following the conversation". */
const FOLLOW_SLACK_PX = 32;

/**
 * The meeting's committed sentence pairs in reading order, newest at the
 * bottom. It follows new lines while you are at the end; scroll up to
 * read back and it stays put, with a way back to the latest.
 */
export function LiveTranscript(): React.JSX.Element {
  const { t } = useTranslation('control');
  const history = useAppStore((s) => s.history);
  const [filter, setFilter] = useState<Filter>('all');
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const { rows, truncated } = useMemo(() => {
    const matching = filter === 'all' ? history : history.filter((r) => r.direction === filter);
    return {
      rows: matching.slice(-VISIBLE_TRANSCRIPT_ROWS),
      truncated: matching.length > VISIBLE_TRANSCRIPT_ROWS
    };
  }, [history, filter]);

  const scrollToEnd = (): void => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  useLayoutEffect(() => {
    if (following) scrollToEnd();
  }, [rows, following]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-border bg-card">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <h3 className="font-semibold">{t('transcriptPanel.title')}</h3>
        {history.length > 0 && (
          <span className="text-callout text-muted-foreground tabular-nums">
            {t('transcriptPanel.lineCount', { count: history.length })}
          </span>
        )}
        <ToggleGroup
          variant="segmented"
          size="sm"
          className="ml-auto"
          aria-label={t('transcriptPanel.title')}
          value={[filter]}
          onValueChange={(next) => {
            const f = next[0] as Filter | undefined;
            if (!f) return;
            setFilter(f);
            setFollowing(true);
          }}
        >
          <ToggleGroupItem value="all">{t('transcriptPanel.all')}</ToggleGroupItem>
          <ToggleGroupItem value="speak">{t('transcriptPanel.you')}</ToggleGroupItem>
          <ToggleGroupItem value="listen">{t('transcriptPanel.other')}</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="relative min-h-0 flex-1">
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <MessagesSquareIcon className="size-8 opacity-50" strokeWidth={1.5} />
            <p className="max-w-64">{t('transcriptPanel.empty')}</p>
          </div>
        ) : (
          <div
            ref={scrollRef}
            className="selectable h-full overflow-y-auto"
            onScroll={(e) => {
              const el = e.currentTarget;
              setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX);
            }}
          >
            {truncated && (
              <p className="px-4 py-2 text-center text-callout text-muted-foreground">
                {t('transcriptPanel.olderHidden', { count: VISIBLE_TRANSCRIPT_ROWS })}
              </p>
            )}
            {rows.map((row) => (
              <TranscriptRow key={row.id} row={row} />
            ))}
          </div>
        )}
        {!following && rows.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
            onClick={() => {
              setFollowing(true);
              scrollToEnd();
            }}
          >
            <ArrowDownIcon data-icon="inline-start" />
            {t('transcriptPanel.jumpToLatest')}
          </Button>
        )}
      </div>
    </section>
  );
}
