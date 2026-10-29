import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaptionsIcon, CaptionsOffIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageToolbar } from '../../../components/page-toolbar.js';
import { useSubtitleOverlayVisible } from '../../../hooks/useSubtitleOverlayVisible.js';
import { useAppStore, type SessionSlice } from '../../../store/app-store.js';

const busy = (s: SessionSlice): boolean =>
  s.active || s.status === 'connecting' || s.status === 'finishing' || s.status === 'cancelling';

function useFormatDuration(): (ms: number) => string {
  const { t } = useTranslation('control');
  return (ms: number): string => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return t('active.duration.hourMinute', { h, m });
    if (m > 0) return t('active.duration.minuteSecond', { m, s });
    return t('active.duration.second', { s });
  };
}

/**
 * The open meeting's toolbar: its title, a live badge with elapsed time and
 * line count, the subtitle-overlay toggle and 结束会议. Ending asks first
 * only while a Direction is still running — then it would cut someone off.
 */
export function MeetingToolbar({
  title,
  startedAt,
  lineCount,
  onEnd
}: {
  title: string;
  startedAt: number;
  lineCount: number;
  onEnd: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useTranslation('control');
  const { t: tc } = useTranslation('common');
  const formatDuration = useFormatDuration();
  const overlay = useSubtitleOverlayVisible();
  const running = useAppStore((s) => busy(s.speak) || busy(s.listen));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <PageToolbar
      title={title}
      meta={
        <span className="flex shrink-0 items-center gap-2 text-callout text-muted-foreground">
          <Badge variant="secondary" className="gap-1.5">
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-speak" />
            {t('active.live')}
          </Badge>
          <span className="tabular-nums">
            {t('active.headerStatus', { duration: formatDuration(now - startedAt), count: lineCount })}
          </span>
        </span>
      }
    >
      <Button variant="outline" size="sm" onClick={() => void overlay.toggle()}>
        {overlay.visible ? <CaptionsOffIcon data-icon="inline-start" /> : <CaptionsIcon data-icon="inline-start" />}
        {overlay.visible ? t('active.hideOverlay') : t('active.showOverlay')}
      </Button>
      {running ? (
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>
            {t('active.endMeeting')}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('active.endConfirm.title')}</AlertDialogTitle>
              <AlertDialogDescription>{t('active.endConfirm.description')}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{tc('cancel')}</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void onEnd()}>
                {t('active.endMeeting')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <Button variant="destructive" size="sm" onClick={() => void onEnd()}>
          {t('active.endMeeting')}
        </Button>
      )}
    </PageToolbar>
  );
}
