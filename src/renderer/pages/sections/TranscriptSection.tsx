import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRightIcon, HistoryIcon, SearchIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { MIN_LISTED_LINE_COUNT, type MeetingSummary } from '@shared/meeting-types.js';
import { ListGroup } from '../../components/grouped-list.js';
import { PageToolbar } from '../../components/page-toolbar.js';
import { SearchField } from '../../components/search-field.js';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.js';
import { useAppStore } from '../../store/app-store.js';
import type { PageId } from '../ControlPanel.js';
import { MeetingActionsMenu } from './history/MeetingActions.js';
import {
  groupByDay,
  meetingLengthMs,
  meetingStatus,
  useMeetingFormat
} from './history/meeting-format.js';

// Each list query aggregates transcript_lines synchronously in main; don't
// run one per keystroke while the user is still typing.
const SEARCH_DEBOUNCE_MS = 250;

const LIST_LIMIT = 200;

interface Props {
  onNavigate: (page: PageId, meetingId?: string) => void;
}

type Loaded = { meetings: MeetingSummary[]; error: null } | { meetings: null; error: string };

/**
 * 历史: every meeting, newest first, grouped by the day it started. A row
 * opens its replay (the open meeting goes back to the 会议 page); its "…"
 * menu renames or deletes it. Very short meetings (a mis-click, a quick
 * test) are folded away behind a note at the end.
 */
export function TranscriptSection({ onNavigate }: Props): React.JSX.Element {
  const { t } = useTranslation('transcript');
  const { t: tNav } = useTranslation('nav');
  const currentId = useAppStore((s) => s.currentMeeting?.id ?? null);
  const [query, setQuery] = useState('');
  const [showShort, setShowShort] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const debouncedQuery = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);

  const reload = useCallback(async () => {
    try {
      // Short meetings come along so the note can say how many are folded.
      const meetings = await window.babelVoiceBridge.listMeetings({
        includeEmpty: true,
        query: debouncedQuery || undefined,
        limit: LIST_LIMIT
      });
      setLoaded({ meetings, error: null });
    } catch (err) {
      setLoaded({ meetings: null, error: err instanceof Error ? err.message : String(err) });
    }
  }, [debouncedQuery]);

  // The open meeting's row changes when it ends (or a new one opens).
  useEffect(() => {
    void reload();
  }, [reload, currentId]);

  const update = (id: string, patch: Partial<MeetingSummary> | null): void =>
    setLoaded((prev) =>
      prev?.meetings
        ? {
            meetings: patch
              ? prev.meetings.map((m) => (m.id === id ? { ...m, ...patch } : m))
              : prev.meetings.filter((m) => m.id !== id),
            error: null
          }
        : prev
    );

  const all = loaded?.meetings ?? [];
  const isShort = (m: MeetingSummary): boolean =>
    m.lineCount < MIN_LISTED_LINE_COUNT && m.id !== currentId;
  const shortCount = all.filter(isShort).length;
  const visible = showShort ? all : all.filter((m) => !isShort(m));

  return (
    <>
      <PageToolbar
        title={tNav('items.transcript')}
        meta={
          visible.length > 0 && (
            <span className="text-callout text-muted-foreground tabular-nums">
              {t('list.count', { count: visible.length })}
            </span>
          )
        }
      >
        <SearchField
          value={query}
          onChange={setQuery}
          label={t('list.searchLabel')}
          placeholder={t('list.searchPlaceholder')}
          findShortcut
        />
      </PageToolbar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-5 px-5 py-5">
          {loaded?.error != null && (
            <Alert variant="destructive">
              <AlertDescription>{t('list.loadFailed', { message: loaded.error })}</AlertDescription>
              <AlertAction>
                <Button size="sm" variant="outline" onClick={() => void reload()}>
                  {t('list.retry')}
                </Button>
              </AlertAction>
            </Alert>
          )}

          {loaded?.meetings &&
            (visible.length === 0 ? (
              <EmptyHistory
                query={debouncedQuery}
                shortCount={shortCount}
                onClearSearch={() => setQuery('')}
                onShowShort={() => setShowShort(true)}
                onStartMeeting={() => onNavigate('control')}
              />
            ) : (
              <>
                {groupByDay(visible).map((group) => (
                  <DayGroup
                    key={group.day}
                    day={group.day}
                    meetings={group.items}
                    currentId={currentId}
                    onOpen={(m) =>
                      m.id === currentId ? onNavigate('control') : onNavigate('replay', m.id)
                    }
                    onRenamed={(id, title) => update(id, { title })}
                    onDeleted={(id) => update(id, null)}
                  />
                ))}
                {shortCount > 0 && (
                  <p className="flex items-center justify-center gap-1.5 text-callout text-muted-foreground">
                    {showShort
                      ? null
                      : t('list.shortHidden', { count: shortCount, min: MIN_LISTED_LINE_COUNT })}
                    <Button
                      variant="link"
                      size="xs"
                      className="h-auto px-0"
                      onClick={() => setShowShort((v) => !v)}
                    >
                      {showShort
                        ? t('list.hideShort', { min: MIN_LISTED_LINE_COUNT })
                        : t('list.showShort')}
                    </Button>
                  </p>
                )}
                {all.length >= LIST_LIMIT && (
                  <p className="text-center text-callout text-muted-foreground">
                    {t('list.limited', { count: LIST_LIMIT })}
                  </p>
                )}
              </>
            ))}
        </div>
      </div>
    </>
  );
}

function DayGroup({
  day,
  meetings,
  currentId,
  onOpen,
  onRenamed,
  onDeleted
}: {
  day: number;
  meetings: MeetingSummary[];
  currentId: string | null;
  onOpen: (m: MeetingSummary) => void;
  onRenamed: (id: string, title: string) => void;
  onDeleted: (id: string) => void;
}): React.JSX.Element {
  const format = useMeetingFormat();
  return (
    <ListGroup title={format.day(day)}>
      {meetings.map((m) => (
        <MeetingRow
          key={m.id}
          meeting={m}
          currentId={currentId}
          onOpen={() => onOpen(m)}
          onRenamed={(title) => onRenamed(m.id, title)}
          onDeleted={() => onDeleted(m.id)}
        />
      ))}
    </ListGroup>
  );
}

/**
 * Title and status on the first line; when, how long, which languages and
 * how much was said on the second. The whole row opens the meeting.
 */
function MeetingRow({
  meeting: m,
  currentId,
  onOpen,
  onRenamed,
  onDeleted
}: {
  meeting: MeetingSummary;
  currentId: string | null;
  onOpen: () => void;
  onRenamed: (title: string) => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('transcript');
  const format = useMeetingFormat();
  const status = meetingStatus(m, currentId);
  const live = status === 'live';
  const details = [
    live ? t('list.startedAt', { time: format.clock(m.startedAt) }) : format.timeRange(m.startedAt, m.endedAt),
    !live && format.length(meetingLengthMs(m)),
    format.languages(m),
    t('list.lineCount', { count: m.lineCount })
  ].filter((d): d is string => Boolean(d));

  return (
    <div className="flex items-center border-t border-border first:border-t-0 first:rounded-t-xl last:rounded-b-xl has-[>button:first-child:hover]:bg-muted has-[>button:first-child:focus-visible]:bg-muted">
      <button
        type="button"
        onClick={onOpen}
        aria-label={live ? t('list.openLive', { title: m.title }) : undefined}
        className="flex min-h-13 min-w-0 flex-1 items-center gap-3 py-2 pl-3.5 text-left outline-none"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{m.title}</span>
            {live && (
              <Badge variant="secondary" className="shrink-0 gap-1.5">
                <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-speak" />
                {t('status.live')}
              </Badge>
            )}
            {status === 'interrupted' && (
              <Badge variant="outline" className="shrink-0 text-muted-foreground" title={t('status.interruptedHint')}>
                {t('status.interrupted')}
              </Badge>
            )}
          </span>
          <span className="truncate text-callout text-muted-foreground tabular-nums">
            {details.join(' · ')}
          </span>
        </span>
      </button>
      <div className={cn('flex shrink-0 items-center gap-1 pr-2.5', live ? 'pl-3' : 'pl-2')}>
        {live ? (
          <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
        ) : (
          <MeetingActionsMenu
            meeting={m}
            onRenamed={onRenamed}
            onDeleted={onDeleted}
            className="text-muted-foreground"
          />
        )}
      </div>
    </div>
  );
}

/** Why the list is empty, and the one thing to do about it. */
function EmptyHistory({
  query,
  shortCount,
  onClearSearch,
  onShowShort,
  onStartMeeting
}: {
  query: string;
  shortCount: number;
  onClearSearch: () => void;
  onShowShort: () => void;
  onStartMeeting: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('transcript');
  const min = MIN_LISTED_LINE_COUNT;
  const showShort = (
    <Button variant="outline" onClick={onShowShort}>
      {t('list.showShort')}
    </Button>
  );

  let content: { icon: React.ReactNode; title: string; description: string; action: React.ReactNode };
  if (query) {
    content = {
      icon: <SearchIcon />,
      title: t('list.noResults.title'),
      description:
        shortCount > 0
          ? t('list.noResults.descriptionShort', { query, count: shortCount, min })
          : t('list.noResults.description', { query }),
      action:
        shortCount > 0 ? (
          showShort
        ) : (
          <Button variant="outline" onClick={onClearSearch}>
            {t('list.clearSearch')}
          </Button>
        )
    };
  } else if (shortCount > 0) {
    content = {
      icon: <HistoryIcon />,
      title: t('list.onlyShort.title'),
      description: t('list.onlyShort.description', { count: shortCount, min }),
      action: showShort
    };
  } else {
    content = {
      icon: <HistoryIcon />,
      title: t('list.empty.title'),
      description: t('list.empty.description'),
      action: <Button onClick={onStartMeeting}>{t('list.empty.action')}</Button>
    };
  }

  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyMedia variant="icon">{content.icon}</EmptyMedia>
        <EmptyTitle>{content.title}</EmptyTitle>
        <EmptyDescription>{content.description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{content.action}</EmptyContent>
    </Empty>
  );
}
