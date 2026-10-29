import React from 'react';
import ReactDOM from 'react-dom/client';
import { ControlPanel } from './pages/ControlPanel.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { changeRendererLocale, initRendererI18n } from './i18n/index.js';
import { DEFAULT_LOCALE, type Locale } from '@shared/i18n-types.js';
import { enableMeetingPersistence } from './store/app-store.js';

// Only the control window writes transcript lines to the meeting DB; the
// subtitle overlay assembles the same events into its own store.
enableMeetingPersistence();

const bootstrap = async (): Promise<void> => {
  // Pull the locale main authoritatively owns before mounting so the first
  // paint is already in the right language. Falls back to the default if
  // the bridge isn't available (browser dev shim covers this too).
  let initial: Locale = DEFAULT_LOCALE;
  try {
    initial = (await window.babelVoiceBridge.getLocale()) ?? DEFAULT_LOCALE;
  } catch (err) {
    console.warn('[i18n] failed to fetch locale from main, using default:', err);
  }
  await initRendererI18n(initial);

  // Stay in sync with main: language switcher writes to main → main
  // broadcasts back → every renderer (control + subtitle overlay) updates.
  window.babelVoiceBridge.onLocaleChanged((locale) => {
    void changeRendererLocale(locale);
  });

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <ControlPanel />
      </ErrorBoundary>
    </React.StrictMode>
  );
};

void bootstrap();
