import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/shallow';
import {
  FlaskConicalIcon,
  HeadphonesIcon,
  LoaderCircleIcon,
  MicIcon,
  PlayIcon,
  SquareIcon,
  TriangleAlertIcon
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { useAppStore, type SessionSlice } from '../store/app-store.js';
import { useSpeakSession } from '../hooks/useSpeakSession.js';
import { useListenSession } from '../hooks/useListenSession.js';
import { usePreferences } from '../hooks/usePreferences.js';
import { useCredentialStatus } from '../hooks/useCredentialStatus.js';
import { isEngineCredentialed } from '../engines/factory.js';
import { ListItem } from './grouped-list.js';
import {
  TEST_AUDIO_CLIPS,
  type TestAudioClip
} from '../assets/test-audio/manifest.js';

const sessionBusy = (slice: SessionSlice): boolean =>
  slice.active ||
  slice.status === 'connecting' ||
  slice.status === 'finishing' ||
  slice.status === 'cancelling';

/**
 * Entry point for the test sandbox next to 开始会议: a secondary button that
 * opens a dialog with the actual controls, and shows a dot while a test
 * session is still running.
 *
 * Closing the dialog does *not* stop the speak/listen sessions — the user
 * may dismiss it intentionally and come back to stop it later. Audio
 * playback is stopped on close because background audio with no visible
 * controls is just confusing.
 */
export function TestPanelTrigger(): React.JSX.Element {
  const { t } = useTranslation('control');
  // Booleans only: subscribing to the whole slices re-rendered the page on
  // every subtitle delta.
  const anyActive = useAppStore((s) => sessionBusy(s.speak) || sessionBusy(s.listen));
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        size="lg"
        variant="outline"
        title={anyActive ? t('testPanel.hintActive') : t('testPanel.hintIdle')}
        onClick={() => setOpen(true)}
      >
        <FlaskConicalIcon data-icon="inline-start" />
        {t('testPanel.trigger')}
        {anyActive && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-speak" />}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !next && setOpen(false)}>
        <DialogContent className="sm:max-w-[30rem]">
          <DialogHeader>
            <DialogTitle>{t('testPanel.modal.title')}</DialogTitle>
            <DialogDescription>{t('testPanel.modal.sub')}</DialogDescription>
          </DialogHeader>
          <TestBody />
        </DialogContent>
      </Dialog>
    </>
  );
}

function TestBody(): React.JSX.Element {
  const { t } = useTranslation('control');
  const { t: tLang } = useTranslation('languages');
  const speak = useAppStore(
    useShallow((s) => ({ status: s.speak.status, active: s.speak.active }))
  );
  const listen = useAppStore(
    useShallow((s) => ({ status: s.listen.status, active: s.listen.active }))
  );
  const speakSession = useSpeakSession();
  // The sample clips play from BabelVoice itself: a listen session tapping
  // the configured meeting app would never hear them.
  const listenSession = useListenSession({ captureSystemAudio: true });
  const { preferences } = usePreferences();
  const { status, loaded } = useCredentialStatus();

  const credsConfigured = isEngineCredentialed(status, preferences.engineId);
  const ready = loaded && credsConfigured;
  const mine = tLang(`names.${preferences.mySpokenLanguage}`);
  const other = tLang(`names.${preferences.meetingLanguage}`);

  const speakStarting = speak.status === 'connecting';
  const speakFinishing = speak.status === 'finishing' || speak.status === 'cancelling';
  const speakOn = speak.active || speakStarting;

  const listenStarting = listen.status === 'connecting';
  const listenFinishing = listen.status === 'finishing' || listen.status === 'cancelling';
  const listenOn = listen.active || listenStarting;

  const [playingClipId, setPlayingClipId] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopAudio = (): void => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
      audioRef.current = null;
    }
    setPlayingClipId(null);
  };

  // Stop audio when the dialog unmounts. Sessions intentionally keep running
  // — the trigger button shows a status dot so the user can come back.
  useEffect(() => () => stopAudio(), []);

  useEffect(() => {
    if (!listenOn && playingClipId !== null) stopAudio();
  }, [listenOn, playingClipId]);

  const playClip = async (clip: TestAudioClip): Promise<void> => {
    setAudioError(null);
    stopAudio();

    if (!listen.active && !listenStarting) {
      // Never play the clip into a session that didn't open — it would just
      // blare out of the speakers with nothing translating it.
      if (!(await listenSession.start())) {
        const message = useAppStore.getState().listen.lastError;
        setAudioError(
          message
            ? t('testPanel.errors.listenStartFailed', { message })
            : t('testPanel.errors.listenStartFailedSimple')
        );
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    const audio = new Audio(clip.src);
    audio.onended = (): void => {
      if (audioRef.current === audio) {
        audioRef.current = null;
        setPlayingClipId(null);
      }
    };
    audio.onerror = (): void => {
      setAudioError(t('testPanel.errors.audioLoadFailed', { label: t(clip.labelKey) }));
      if (audioRef.current === audio) {
        audioRef.current = null;
        setPlayingClipId(null);
      }
    };
    audioRef.current = audio;
    setPlayingClipId(clip.id);
    audio.play().catch((err) => {
      setAudioError(
        err instanceof Error
          ? t('testPanel.errors.playFailed', { message: err.message })
          : t('testPanel.errors.playFailedSimple')
      );
      if (audioRef.current === audio) {
        audioRef.current = null;
        setPlayingClipId(null);
      }
    });
  };

  const handleSpeakClick = async (): Promise<void> => {
    if (speakFinishing || speakStarting) return;
    if (speak.active) await speakSession.stop();
    else await speakSession.start();
  };

  const handleListenClick = async (): Promise<void> => {
    if (listenFinishing || listenStarting) return;
    if (listen.active) {
      stopAudio();
      await listenSession.stop();
    } else {
      await listenSession.start();
    }
  };

  const sessionButton = (
    kind: 'speak' | 'listen',
    on: boolean,
    starting: boolean,
    finishing: boolean,
    onClick: () => void
  ): React.JSX.Element => (
    <Button
      variant={on || finishing ? 'outline' : 'default'}
      disabled={!ready || finishing}
      onClick={onClick}
    >
      {starting || finishing ? (
        <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
      ) : on ? (
        <SquareIcon data-icon="inline-start" className="fill-current" />
      ) : kind === 'speak' ? (
        <MicIcon data-icon="inline-start" />
      ) : (
        <HeadphonesIcon data-icon="inline-start" />
      )}
      {starting
        ? t(`testPanel.${kind}.starting`)
        : finishing
          ? t(`testPanel.${kind}.stopping`)
          : on
            ? t(`testPanel.${kind}.stop`)
            : t(`testPanel.${kind}.start`)}
    </Button>
  );

  return (
    <>
      {!ready && (
        <Alert>
          <TriangleAlertIcon className="text-destructive" />
          <AlertDescription className="text-foreground">{t('testPanel.noKey')}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-2">
        {sessionButton('speak', speakOn, speakStarting, speakFinishing, () => void handleSpeakClick())}
        {sessionButton('listen', listenOn, listenStarting, listenFinishing, () => void handleListenClick())}
      </div>

      <ul className="flex flex-col gap-1.5 text-callout text-muted-foreground">
        <li className="flex gap-2">
          <MicIcon className="mt-px size-3.5 shrink-0 text-speak" />
          {t('testPanel.helpSpeak', { src: mine, tgt: other })}
        </li>
        <li className="flex gap-2">
          <HeadphonesIcon className="mt-px size-3.5 shrink-0 text-listen" />
          {t('testPanel.helpListen', { src: mine })}
        </li>
      </ul>

      <TestAudioList
        clips={TEST_AUDIO_CLIPS}
        listenActive={listen.active}
        listenStarting={listenStarting}
        playingClipId={playingClipId}
        disabled={!ready}
        onPlay={playClip}
        onStop={stopAudio}
      />

      {audioError && (
        <Alert variant="destructive">
          <AlertDescription>{audioError}</AlertDescription>
        </Alert>
      )}

      <DialogFooter className="items-center sm:justify-between">
        <span className="text-callout text-muted-foreground">
          {speakOn || listenOn ? t('testPanel.footer.hintRunning') : t('testPanel.footer.hintIdle')}
        </span>
        <DialogClose render={<Button variant="outline" />}>{t('testPanel.footer.close')}</DialogClose>
      </DialogFooter>
    </>
  );
}

function TestAudioList({
  clips,
  listenActive,
  listenStarting,
  playingClipId,
  disabled,
  onPlay,
  onStop
}: {
  clips: TestAudioClip[];
  listenActive: boolean;
  listenStarting: boolean;
  playingClipId: string | null;
  disabled: boolean;
  onPlay: (clip: TestAudioClip) => Promise<void>;
  onStop: () => void;
}): React.JSX.Element {
  const { t } = useTranslation('control');
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 px-3.5">
        <h3 className="text-callout font-semibold text-muted-foreground">{t('testPanel.audio.title')}</h3>
        <span className="ml-auto text-subheadline text-muted-foreground">
          {listenActive
            ? t('testPanel.audio.statusActive')
            : listenStarting
              ? t('testPanel.audio.statusStarting')
              : t('testPanel.audio.statusIdle')}
        </span>
      </div>
      <div className="rounded-xl border border-border bg-card">
        {clips.length === 0 ? (
          <ListItem className="flex-col items-start gap-0.5 text-muted-foreground">
            <span>{t('testPanel.audio.empty')}</span>
            <span className="text-callout">{t('testPanel.audio.emptySub')}</span>
          </ListItem>
        ) : (
          clips.map((clip) => {
            const isPlaying = playingClipId === clip.id;
            return (
              <ListItem key={clip.id}>
                  <Button
                    size="icon-sm"
                    variant={isPlaying ? 'default' : 'outline'}
                    className="rounded-full"
                    disabled={disabled}
                    aria-label={isPlaying ? t('testPanel.audio.stop') : t('testPanel.audio.play')}
                    onClick={() => {
                      if (isPlaying) onStop();
                      else void onPlay(clip);
                    }}
                  >
                    {isPlaying ? <SquareIcon className="fill-current" /> : <PlayIcon />}
                  </Button>
                  <div className="min-w-0 flex-1">
                    <div className={cn('flex items-center gap-2', isPlaying && 'text-primary')}>
                      {t(clip.labelKey)}
                      <span className="text-subheadline text-muted-foreground uppercase">{clip.language}</span>
                    </div>
                    {clip.hint && <div className="text-callout text-muted-foreground">{clip.hint}</div>}
                  </div>
                  {clip.durationLabel && (
                    <span className="text-callout text-muted-foreground tabular-nums">{clip.durationLabel}</span>
                  )}
              </ListItem>
            );
          })
        )}
      </div>
    </section>
  );
}
