import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import type { EngineId } from '@shared/engine-types.js';
import type { Direction } from '@shared/ipc-types.js';
import {
  PRICE_CURRENCIES,
  TOKEN_CATEGORIES,
  type DirectionLinkSnapshot,
  type LinkState,
  type MeetingUsageLine,
  type PriceCurrency
} from '@shared/meeting-metrics-types.js';
import { ListItem } from '../../../components/grouped-list.js';
import { getEngine } from '../../../engines/factory.js';
import { useMeetingMetrics } from '../../../hooks/useMeetingMetrics.js';
import {
  costTotalsOf,
  formatCost,
  formatDuration,
  formatTokens
} from '../../../lib/metrics-format.js';

const STATE_DOT: Record<LinkState, string> = {
  live: 'bg-speak',
  connecting: 'bg-chart-3',
  reconnecting: 'bg-chart-3',
  finishing: 'bg-muted-foreground/50',
  idle: 'bg-muted-foreground/50',
  failed: 'bg-destructive'
};

const DIRECTIONS: readonly Direction[] = ['speak', 'listen'];

/** Re-render every second while there is a clock on screen ("2 s ago"). */
const useNow = (ticking: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);
  return now;
};

/** "你 · 豆包" with the Direction in its colour. */
function Who({ direction, engineId }: { direction: Direction; engineId: EngineId }): React.JSX.Element {
  const { t } = useTranslation('control');
  const { t: tLang } = useTranslation('languages');
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={cn('font-semibold', direction === 'speak' ? 'text-speak' : 'text-listen')}>
        {direction === 'speak' ? t('transcriptPanel.you') : t('transcriptPanel.other')}
      </span>
      <span className="truncate">{tLang(getEngine(engineId).nameKey)}</span>
    </span>
  );
}

/** One line per Direction: who, the link state, and its round trip. */
function LinkSummary({ link }: { link: DirectionLinkSnapshot }): React.JSX.Element {
  const { t } = useTranslation('control');
  return (
    <ListItem className="min-h-9 gap-2 py-1.5">
      <Who direction={link.direction} engineId={link.engineId} />
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-callout text-muted-foreground">
        <span aria-hidden className={cn('size-1.5 rounded-full', STATE_DOT[link.state])} />
        {t(`monitor.state.${link.state}`)}
        {link.rttMs !== null && <span className="tabular-nums">· {link.rttMs} ms</span>}
      </span>
    </ListItem>
  );
}

/** The fine print for one link: timings, last data, reconnects, failures. */
function LinkDetails({
  link,
  usage,
  now
}: {
  link: DirectionLinkSnapshot;
  usage: MeetingUsageLine | undefined;
  now: number;
}): React.JSX.Element {
  const { t } = useTranslation('control');
  const age = (ms: number): string =>
    ms < 60_000
      ? t('monitor.seconds', { n: Math.max(0, Math.round(ms / 1000)) })
      : t('monitor.minutes', { n: Math.floor(ms / 60_000) });
  const open = link.state === 'live' || link.state === 'reconnecting';
  const details = [
    open && formatDuration(now - link.since),
    link.handshakeMs !== null && t('monitor.handshake', { ms: link.handshakeMs }),
    link.readyMs !== null && t('monitor.ready', { ms: link.readyMs }),
    open && link.lastRxAt !== null && t('monitor.lastRx', { age: age(now - link.lastRxAt) }),
    usage && usage.reconnects > 0 && t('monitor.reconnects', { count: usage.reconnects }),
    usage && usage.failures > 0 && t('monitor.failures', { count: usage.failures })
  ].filter((d): d is string => Boolean(d));
  return (
    <div className="flex flex-col gap-0.5">
      <Who direction={link.direction} engineId={link.engineId} />
      <p className="text-callout text-muted-foreground tabular-nums">{details.join(' · ')}</p>
    </div>
  );
}

/** What one engine × Direction used, and its estimated cost. */
function UsageDetails({ line }: { line: MeetingUsageLine }): React.JSX.Element {
  const { t } = useTranslation('control');
  const tokens = TOKEN_CATEGORIES.filter((c) => (line.tokens[c] ?? 0) > 0);
  const parts = [
    ...tokens.map((c) => `${t(`monitor.tokens.${c}`)} ${formatTokens(line.tokens[c] ?? 0)}`),
    t('monitor.audioIn', { duration: formatDuration(line.audioInMs) }),
    line.audioOutMs > 0 && t('monitor.audioOut', { duration: formatDuration(line.audioOutMs) })
  ].filter((d): d is string => Boolean(d));
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <Who direction={line.direction} engineId={line.engineId} />
        <span className="ml-auto shrink-0 tabular-nums">
          {line.cost ? (
            <>
              {formatCost(line.cost.amount, line.cost.currency)}
              {!line.cost.complete && <span title={t('monitor.costIncomplete')}>*</span>}
            </>
          ) : (
            <span className="text-muted-foreground">{t('monitor.costNone')}</span>
          )}
        </span>
      </div>
      <p className="text-callout text-muted-foreground tabular-nums">
        {parts.join(' · ')}
        {tokens.length > 0 && line.estimated && (
          <span title={t('monitor.estimatedHint')}> · {t('monitor.estimated')}</span>
        )}
      </p>
    </div>
  );
}

/** Card header: title and the estimated total(s). */
function CostHeader({
  title,
  costTotals,
  incomplete
}: {
  title: string;
  costTotals: Partial<Record<PriceCurrency, number>>;
  incomplete: boolean;
}): React.JSX.Element {
  const { t } = useTranslation('control');
  const currencies = PRICE_CURRENCIES.filter((c) => costTotals[c] !== undefined);
  return (
    <div className="flex items-start gap-2 px-3.5 pt-3 pb-2.5">
      <ActivityIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <h3 className="font-semibold">{title}</h3>
      <div className="ml-auto flex flex-col items-end text-right">
        <span className="text-subheadline text-muted-foreground">{t('monitor.costLabel')}</span>
        {currencies.length > 0 ? (
          <span className="font-semibold tabular-nums">
            {currencies.map((c) => formatCost(costTotals[c]!, c)).join(' · ')}
          </span>
        ) : (
          <span className="text-muted-foreground">{t('monitor.costNone')}</span>
        )}
        {incomplete && (
          <span className="text-subheadline text-muted-foreground">{t('monitor.costIncomplete')}</span>
        )}
      </div>
    </div>
  );
}

/**
 * A finished meeting's stored usage and cost (replay). The cost is what was
 * estimated while it ran, with the prices in force then.
 */
export function MeetingUsageSummary({
  usage
}: {
  usage: readonly MeetingUsageLine[];
}): React.JSX.Element {
  const { t } = useTranslation('control');
  const { totals, incomplete } = costTotalsOf(usage);
  return (
    <section className="rounded-xl border border-border bg-card text-body text-foreground">
      <CostHeader title={t('monitor.summaryTitle')} costTotals={totals} incomplete={incomplete} />
      {usage.map((line) => (
        <ListItem key={`${line.engineId}|${line.direction}`} className="py-2">
          <div className="min-w-0 flex-1">
            <UsageDetails line={line} />
          </div>
        </ListItem>
      ))}
      <p className="border-t border-border px-3.5 py-2 text-callout text-muted-foreground">
        {t('monitor.footnote')}
      </p>
    </section>
  );
}

/**
 * The open meeting's link health and estimated cost at a glance — one line
 * per Direction — with timings and usage behind a disclosure. Everything is
 * measured in main (MeetingMonitor); this only renders the latest snapshot.
 */
export function MeetingMonitorCard({
  onEditPrices
}: {
  onEditPrices: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('control');
  const metrics = useMeetingMetrics();
  const links = DIRECTIONS.map((d) => metrics?.links[d]).filter(
    (l): l is DirectionLinkSnapshot => Boolean(l)
  );
  const usage = metrics?.usage ?? [];
  const now = useNow(links.some((l) => l.state !== 'idle'));

  return (
    <section className="rounded-xl border border-border bg-card">
      <CostHeader
        title={t('monitor.title')}
        costTotals={metrics?.costTotals ?? {}}
        incomplete={metrics?.costIncomplete ?? false}
      />

      {links.length === 0 && usage.length === 0 ? (
        <ListItem className="text-callout text-muted-foreground">{t('monitor.empty')}</ListItem>
      ) : (
        <>
          {links.map((link) => (
            <LinkSummary key={link.direction} link={link} />
          ))}
          <Accordion className="border-t border-border">
            <AccordionItem value="details">
              <AccordionTrigger className="rounded-none px-3.5 py-2 text-callout text-muted-foreground">
                {t('monitor.details')}
              </AccordionTrigger>
              <AccordionContent className="flex flex-col gap-3 px-3.5 pb-3">
                {links.map((link) => (
                  <LinkDetails
                    key={link.direction}
                    link={link}
                    usage={usage.find(
                      (u) => u.direction === link.direction && u.engineId === link.engineId
                    )}
                    now={now}
                  />
                ))}
                {usage.length > 0 && (
                  <div className="flex flex-col gap-3 border-t border-border pt-3">
                    {usage.map((line) => (
                      <UsageDetails key={`${line.engineId}|${line.direction}`} line={line} />
                    ))}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </>
      )}

      <div className="flex items-center gap-2 border-t border-border px-3.5 py-2 text-callout text-muted-foreground">
        <span className="flex-1">{t('monitor.footnote')}</span>
        <Button variant="link" size="xs" className="h-auto px-0" onClick={onEditPrices}>
          {t('monitor.editPrices')}
        </Button>
      </div>
    </section>
  );
}
