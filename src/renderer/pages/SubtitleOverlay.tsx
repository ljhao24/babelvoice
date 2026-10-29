import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/shallow';
import type { Direction } from '@shared/ipc-types.js';
import { usePreferences } from '../hooks/usePreferences.js';
import { useTheme } from '../hooks/useTheme.js';
import { setHistoryLimit, useAppStore } from '../store/app-store.js';
import { SubtitlePanel } from '../components/subtitle/SubtitlePanel.js';
import type { LiveText } from '../components/subtitle/LiveCaption.js';
import { chromeClassFor, chromeStyleFor } from '../components/subtitle/chrome.js';

/** The live fields of one Direction's slice, compared shallowly. */
const selectLive =
  (direction: Direction) =>
  (s: ReturnType<typeof useAppStore.getState>): LiveText => ({
    active: s[direction].active,
    stitchedSrc: s[direction].stitchedSrc,
    partialSrc: s[direction].partialSrc,
    stitchedTgt: s[direction].stitchedTgt,
    partialTgt: s[direction].partialTgt,
    speaker: s[direction].speaker
  });

export function SubtitleOverlay(): React.JSX.Element {
  const { t } = useTranslation('subtitle');
  useTheme();
  const { preferences, set } = usePreferences();

  // The overlay lives across meetings; keep its scroll-back to the setting.
  useEffect(() => {
    setHistoryLimit(preferences.subtitleHistoryLimit);
  }, [preferences.subtitleHistoryLimit]);

  useEffect(() => {
    document.body.classList.add('subtitle-shell');
    return () => document.body.classList.remove('subtitle-shell');
  }, []);

  useEffect(() => {
    void window.babelVoiceBridge.notifySubtitleReady();
  }, []);

  const history = useAppStore((s) => s.history);
  const speakLive = useAppStore(useShallow(selectLive('speak')));
  const listenLive = useAppStore(useShallow(selectLive('listen')));
  const speakActive = speakLive.active;
  const listenActive = listenLive.active;
  // Keep a direction visible after its session ends as long as there's still
  // a finished pair to show — the live caption falls back to the last history
  // entry. Otherwise short tests (e.g. the onboarding probes that auto-stop
  // after one finalized sentence) blink straight back to the idle placeholder.
  const speakHasHistory = useAppStore((s) =>
    s.history.some((p) => p.direction === 'speak')
  );
  const listenHasHistory = useAppStore((s) =>
    s.history.some((p) => p.direction === 'listen')
  );

  const showSpeak = speakActive || speakHasHistory;
  const showListen = listenActive || listenHasHistory;
  const idle = !showSpeak && !showListen;
  const directions: Direction[] = [
    ...(showListen ? (['listen'] as const) : []),
    ...(showSpeak ? (['speak'] as const) : [])
  ];

  const chromeClass = chromeClassFor(preferences.subtitleBackground);
  const chromeStyle = chromeStyleFor(
    preferences.subtitleBackground,
    preferences.subtitleOpacity
  );

  const handleClose = (): void => {
    void window.babelVoiceBridge.toggleSubtitleOverlay();
  };

  return (
    <main className="h-screen w-screen select-none">
      {/* The whole panel drags the window; the history list and close button
          opt out (app-no-drag) so they still scroll, select and click. */}
      <div
        className={`app-drag ${chromeClass} rounded-[1rem] h-full w-full text-fg animate-fade-in flex flex-col px-6 pt-3.5 pb-4 overflow-hidden relative ${
          idle ? 'opacity-70 justify-center' : 'opacity-100'
        }`}
        style={chromeStyle}
      >
        <CloseButton onClick={handleClose} />
        {idle ? (
          <div className="flex items-center justify-center gap-2.5 py-1.5 text-[13px] text-fg-subtle">
            <span className="idle-dot" />
            {t('placeholder.waiting')}
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-hidden">
            <SubtitlePanel
              directions={directions}
              history={history}
              live={{ speak: speakLive, listen: listenLive }}
              layout={preferences.subtitleLayout}
              fontSize={preferences.subtitleFontSize}
              liveLines={preferences.subtitleLiveLines}
              showSource={preferences.subtitleShowSource}
              showHistory={preferences.subtitleShowHistory}
              languages={{
                mine: preferences.mySpokenLanguage,
                meeting: preferences.meetingLanguage
              }}
              onToggleSource={() =>
                void set({ subtitleShowSource: !preferences.subtitleShowSource })
              }
            />
          </div>
        )}
      </div>
    </main>
  );
}

function CloseButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  const { t } = useTranslation('subtitle');
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      aria-label={t('closeAria')}
      title={t('closeTitle')}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="subtitle-close-btn app-no-drag"
      data-hover={hovered ? 'true' : 'false'}
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        width: 24,
        height: 24,
        borderRadius: 12,
        border: 'none',
        cursor: 'pointer',
        display: 'grid',
        placeItems: 'center',
        transition: 'background 120ms ease, color 120ms ease',
        zIndex: 2
      }}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden focusable="false">
        <path
          d="M2 2 L10 10 M10 2 L2 10"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
