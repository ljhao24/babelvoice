import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeftIcon, CopyIcon, MessagesSquareIcon, SearchXIcon } from 'lucide-react';
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { EngineId } from '@shared/engine-types.js';
import type { Meeting, MeetingTranscriptLine } from '@shared/meeting-types.js';
import type { MeetingUsageLine } from '@shared/meeting-metrics-types.js';
import { ListGroup, ListItem } from '../../components/grouped-list.js';
import { PageToolbar } from '../../components/page-toolbar.js';
import { SearchField } from '../../components/search-field.js';
import { sameMinute, TranscriptRow } from '../../components/transcript-row.js';
import { getEngine } from '../../engines/factory.js';
import { useAppStore } from '../../store/app-store.js';
import type { PageId } from '../ControlPanel.js';
import { MeetingUsageSummary } from './control/MeetingMonitorCard.js';
import { MeetingActionsMenu } from './history/MeetingActions.js';
import { meetingLengthMs, meetingStatus, useMeetingFormat } from './history/meeting-format.js';

type Filter = 'all' | 'speak' | 'listen';

interface Props {
  meetingId: string | null;
  onNavigate: (page: PageId, meetingId?: string) => void;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'ready'; meeting: Meeting; lines: MeetingTranscriptLine[] };

/**
 * A finished meeting, laid out like the open one on the 会议 page: facts and
 * cost in the left column, the whole conversation on the right with find
 * and a 你 / 对方 filter. The toolbar copies the conversation as text and
 * holds the rename / delete menu.
 */
export function MeetingReplaySection({ meetingId, onNavigate }: Props): React.JSX.Element {
  const { t } = useTranslation('transcript');
  const { t: tNav } = useTranslation('nav');
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [usage, setUsage] = useState<MeetingUsageLine[]>([]);
  const currentId = useAppStore((s) => s.currentMeeting?.id ?? null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(meetingId ? { status: 'loading' } : { status: 'missing' });
    setUsage([]);
    if (!meetingId) return;
    // Usage is extra: a meeting from before the monitor simply has none.
    void window.babelVoiceBridge
      .getMeetingUsage(meetingId)
      .then((lines) => {
        if (!cancelled) setUsage(lines);
      })
      .catch(() => undefined);
    void window.babelVoiceBridge
      .loadMeeting(meetingId)
      .then((result) => {
        if (cancelled) return;
        setLoaded(result ? { status: 'ready', ...result } : { status: 'missing' });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ status: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  const back = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t('replay.back')}
      title={t('replay.back')}
      onClick={() => onNavigate('transcript')}
    >
      <ChevronLeftIcon />
    </Button>
  );

  if (loaded.status !== 'ready') {
    return (
      <>
        <PageToolbar leading={back} title={tNav('items.transcript')} />
        {loaded.status === 'missing' && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchXIcon />
              </EmptyMedia>
              <EmptyTitle>{t('replay.missing.title')}</EmptyTitle>
              <EmptyDescription>{t('replay.missing.description')}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={() => onNavigate('transcript')}>
                {t('replay.back')}
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </>
    );
  }

  const { meeting, lines } = loaded;
  return (
    <>
      <PageToolbar
        leading={back}
        title={meeting.title}
        meta={
          meetingStatus(meeting, currentId) === 'interrupted' && (
            <Badge variant="outline" className="shrink-0 text-muted-foreground" title={t('status.interruptedHint')}>
              {t('status.interrupted')}
            </Badge>
          )
        }
      >
        <CopyTranscriptButton meeting={meeting} lines={lines} />
        <MeetingActionsMenu
          meeting={{ id: meeting.id, title: meeting.title, lineCount: lines.length }}
          onRenamed={(title) => setLoaded({ ...loaded, meeting: { ...meeting, title } })}
          onDeleted={() => onNavigate('transcript')}
        />
      </PageToolbar>
      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <div className="flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto">
          <MeetingOverview meeting={meeting} lines={lines} />
          {usage.length > 0 && <MeetingUsageSummary usage={usage} />}
        </div>
        <ReplayTranscript lines={lines} />
      </div>
    </>
  );
}

/** A fact row: label leading, value trailing (System Settings "About" style). */
function Fact({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <ListItem className="min-h-9 justify-between gap-4 py-1.5">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 text-right text-muted-foreground tabular-nums">{children}</span>
    </ListItem>
  );
}

function MeetingOverview({
  meeting,
  lines
}: {
  meeting: Meeting;
  lines: MeetingTranscriptLine[];
}): React.JSX.Element {
  const { t } = useTranslation('transcript');
  const { t: tLang } = useTranslation('languages');
  const format = useMeetingFormat();
  const speakCount = lines.filter((l) => l.direction === 'speak').length;
  const lastAt = lines[lines.length - 1]?.at;
  const language = (code: string): string => tLang(`names.${code}`, { defaultValue: code });

  return (
    <ListGroup title={t('replay.overview')}>
      <Fact label={t('replay.date')}>{format.fullDate(meeting.startedAt)}</Fact>
      <Fact label={t('replay.time')}>{format.timeRange(meeting.startedAt, meeting.endedAt)}</Fact>
      <Fact label={t('replay.length')}>
        {format.length(meetingLengthMs({ ...meeting, lastActivityAt: lastAt }))}
      </Fact>
      <Fact label={t('replay.youSpeak')}>{language(meeting.langSrc)}</Fact>
      <Fact label={t('replay.theySpeak')}>{language(meeting.langTgt)}</Fact>
      <Fact label={t('replay.engine')}>{tLang(getEngine(meeting.engineId as EngineId).nameKey)}</Fact>
      <Fact label={t('replay.lines')}>
        {t('replay.linesSplit', {
          count: lines.length,
          speak: speakCount,
          listen: lines.length - speakCount
        })}
      </Fact>
      {meeting.endedBy && meeting.endedBy !== 'manual' && (
        <Fact label={t('replay.endedBy')}>{t(`endedBy.${meeting.endedBy}`)}</Fact>
      )}
    </ListGroup>
  );
}

/** Copies the whole conversation as plain text, header first. */
function CopyTranscriptButton({
  meeting,
  lines
}: {
  meeting: Meeting;
  lines: MeetingTranscriptLine[];
}): React.JSX.Element {
  const { t } = useTranslation('transcript');
  const { t: tControl } = useTranslation('control');
  const format = useMeetingFormat();
  const pushToast = useAppStore((s) => s.pushToast);

  const copy = async (): Promise<void> => {
    const header = `${meeting.title}\n${format.fullDate(meeting.startedAt)} ${format.timeRange(meeting.startedAt, meeting.endedAt)}`;
    const body = lines.map((l) => {
      const who =
        l.direction === 'speak'
          ? tControl('transcriptPanel.you')
          : l.speaker !== undefined
            ? tControl('transcriptPanel.otherSpeaker', { n: l.speaker })
            : tControl('transcriptPanel.other');
      return `${format.clock(l.at)} ${who}\n${l.src}\n${l.tgt}`;
    });
    try {
      await navigator.clipboard.writeText([header, ...body].join('\n\n'));
      pushToast(t('replay.copied', { count: lines.length }));
    } catch (err) {
      pushToast(t('replay.copyFailed', { message: err instanceof Error ? err.message : String(err) }));
    }
  };

  return (
    <Button variant="outline" disabled={lines.length === 0} onClick={() => void copy()}>
      <CopyIcon data-icon="inline-start" />
      {t('replay.copy')}
    </Button>
  );
}

const matches = (line: MeetingTranscriptLine, needle: string): boolean =>
  line.src.toLocaleLowerCase().includes(needle) || line.tgt.toLocaleLowerCase().includes(needle);

/**
 * The full conversation in reading order. Find (⌘F) narrows it to the
 * sentences containing the text and marks it; the filter shows one side.
 */
function ReplayTranscript({ lines }: { lines: MeetingTranscriptLine[] }): React.JSX.Element {
  const { t } = useTranslation('transcript');
  const { t: tControl } = useTranslation('control');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();

  const rows = useMemo(
    () =>
      lines.filter(
        (l) => (filter === 'all' || l.direction === filter) && (!needle || matches(l, needle))
      ),
    [lines, filter, needle]
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-border bg-card">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border px-4 py-2">
        <h3 className="font-semibold">{t('replay.transcript')}</h3>
        {lines.length > 0 && (
          <span className="text-callout text-muted-foreground tabular-nums">
            {needle || filter !== 'all'
              ? t('replay.shown', { count: rows.length, total: lines.length })
              : t('list.lineCount', { count: lines.length })}
          </span>
        )}
        {lines.length > 0 && (
          <div className="ml-auto flex items-center gap-2">
            <SearchField
              className="w-40"
              value={query}
              onChange={setQuery}
              label={t('replay.findLabel')}
              placeholder={t('replay.findPlaceholder')}
              findShortcut
            />
            <ToggleGroup
              variant="segmented"
              size="sm"
              aria-label={t('replay.filterLabel')}
              value={[filter]}
              onValueChange={(next) => {
                const f = next[0] as Filter | undefined;
                if (f) setFilter(f);
              }}
            >
              <ToggleGroupItem value="all">{tControl('transcriptPanel.all')}</ToggleGroupItem>
              <ToggleGroupItem value="speak">{tControl('transcriptPanel.you')}</ToggleGroupItem>
              <ToggleGroupItem value="listen">{tControl('transcriptPanel.other')}</ToggleGroupItem>
            </ToggleGroup>
          </div>
        )}
      </div>

      <div className="selectable min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <MessagesSquareIcon className="size-8 opacity-50" strokeWidth={1.5} />
            <p className="max-w-64">
              {lines.length === 0
                ? t('replay.empty')
                : needle
                  ? t('replay.noMatches', { query: query.trim() })
                  : t('replay.noLinesForFilter')}
            </p>
          </div>
        ) : (
          rows.map((row, i) => (
            <TranscriptRow
              key={row.id}
              row={row}
              highlight={needle || undefined}
              showTime={i === 0 || !sameMinute(rows[i - 1]!.at, row.at)}
            />
          ))
        )}
      </div>
    </section>
  );
}
