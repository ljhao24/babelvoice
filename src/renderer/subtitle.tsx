import React from 'react';
import ReactDOM from 'react-dom/client';
import { SubtitleOverlay } from './pages/SubtitleOverlay.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { changeRendererLocale, initRendererI18n } from './i18n/index.js';
import { DEFAULT_LOCALE, type Locale } from '@shared/i18n-types.js';
import { DEFAULT_PREFERENCES } from '@shared/config-types.js';
import { setHistoryLimit } from './store/app-store.js';
import { useSubtitleOverlayWiring } from './hooks/useRendererWiring.js';

// The overlay shows the live pair plus a short scroll-back, and lives for the
// whole app session across meetings — keep its store bounded (the overlay
// then follows `subtitleHistoryLimit`).
setHistoryLimit(DEFAULT_PREFERENCES.subtitleHistoryLimit);

/** This renderer root's main → store wiring (see `useRendererWiring`). */
function OverlayWiring(): null {
  useSubtitleOverlayWiring();
  return null;
}

const bootstrap = async (): Promise<void> => {
  let initial: Locale = DEFAULT_LOCALE;
  try {
    initial = (await window.babelVoiceBridge.getLocale()) ?? DEFAULT_LOCALE;
  } catch (err) {
    console.warn('[i18n] failed to fetch locale from main, using default:', err);
  }
  await initRendererI18n(initial);
  window.babelVoiceBridge.onLocaleChanged((locale) => {
    void changeRendererLocale(locale);
  });
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary compact>
        <OverlayWiring />
        <SubtitleOverlay />
      </ErrorBoundary>
    </React.StrictMode>
  );
};

void bootstrap();
