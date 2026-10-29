import { useTranslation } from 'react-i18next';
import { LoaderCircleIcon, PlayIcon, SquareIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { TranslationErrorKind } from '@shared/translation-error-types.js';
import { describeSessionError } from '../../../lib/session-error.js';
import type { SessionStatus } from '../../../store/app-store.js';

/** Copy for each lifecycle state; `finishing*` already says finish vs cancel. */
export interface DirectionCardLabels {
  statusStarting: string;
  statusFinishing: string;
  statusRunning: string;
  statusIdle: string;
  buttonCancelStart: string;
  buttonFinishing: string;
  buttonStop: string;
  buttonStart: string;
}

/** Per-Direction colour: you speaking (speak) vs. them speaking (listen). */
const TONES = {
  speak: { tile: 'bg-speak text-speak-foreground', ring: 'ring-speak/50', dot: 'bg-speak', text: 'text-speak' },
  listen: { tile: 'bg-listen text-listen-foreground', ring: 'ring-listen/50', dot: 'bg-listen', text: 'text-listen' }
} as const;

/**
 * One Direction in the open meeting (speak and listen share it), laid out
 * as a grouped card: what it does and between which languages, its state,
 * a few facts as rows (`children`), then the one action — start, stop, or
 * cancel while it connects. The last error shows underneath, localized by
 * main's error kind, with a way into Settings when credentials are the fix.
 */
export function DirectionCard({
  tone,
  icon,
  title,
  subtitle,
  status,
  active,
  lastError,
  lastErrorKind,
  labels,
  onToggle,
  onOpenSettings,
  children
}: {
  tone: keyof typeof TONES;
  icon: React.ReactNode;
  title: string;
  /** "中文 → English · 送入会议". */
  subtitle: string;
  status: SessionStatus;
  active: boolean;
  lastError: string | null;
  lastErrorKind: TranslationErrorKind | null;
  labels: DirectionCardLabels;
  onToggle: () => void;
  onOpenSettings: () => void;
  /** Rows between the header and the action (ListRow). */
  children?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation('control');
  const colors = TONES[tone];
  const error = lastError ? describeSessionError(t, lastErrorKind, lastError) : null;
  const starting = status === 'connecting';
  const finishing = status === 'finishing' || status === 'cancelling';
  const on = active || starting;

  return (
    <section
      className={cn(
        'rounded-xl border border-border bg-card transition-shadow',
        on && cn('ring-2', colors.ring)
      )}
    >
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span
          aria-hidden
          className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4', colors.tile)}
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{title}</h3>
          <p className="truncate text-callout text-muted-foreground">{subtitle}</p>
        </div>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1.5 text-callout',
            active ? cn('font-medium', colors.text) : 'text-muted-foreground'
          )}
        >
          {starting || finishing ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <span
              aria-hidden
              className={cn('size-1.5 rounded-full', active ? cn(colors.dot, 'animate-pulse') : 'bg-muted-foreground/50')}
            />
          )}
          {starting
            ? labels.statusStarting
            : finishing
              ? labels.statusFinishing
              : active
                ? labels.statusRunning
                : labels.statusIdle}
        </span>
      </div>

      {children}

      <div className="flex flex-col gap-3 border-t border-border px-3.5 py-3">
        <Button
          className="w-full"
          variant={on || finishing ? 'outline' : 'default'}
          disabled={finishing}
          onClick={onToggle}
        >
          {starting ? (
            <>
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              {labels.buttonCancelStart}
            </>
          ) : finishing ? (
            <>
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              {labels.buttonFinishing}
            </>
          ) : active ? (
            <>
              <SquareIcon data-icon="inline-start" className="fill-current" />
              {labels.buttonStop}
            </>
          ) : (
            <>
              <PlayIcon data-icon="inline-start" />
              {labels.buttonStart}
            </>
          )}
        </Button>

        {error && (
          <Alert variant="destructive">
            <AlertDescription className="flex flex-col items-start gap-2 break-words">
              <span>{error.text}</span>
              {error.detail && <span className="break-all opacity-75">{error.detail}</span>}
              {error.needsSettings && (
                <Button size="sm" variant="outline" onClick={onOpenSettings}>
                  {t('credentialBanner.goToSettings')}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}
      </div>
    </section>
  );
}
