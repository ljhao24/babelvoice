import { useCredentialStatusWiring } from './useCredentialStatus.js';
import { useMeetingWiring } from './useMeeting.js';
import { useMeetingMetricsWiring } from './useMeetingMetrics.js';
import { usePreferencesWiring } from './usePreferences.js';
import { useSubtitleOverlayVisibleWiring } from './useSubtitleOverlayVisible.js';
import { useTranslationEvents } from './useTranslationEvents.js';

/**
 * Main → store wiring, mounted exactly once per renderer root. Each window is
 * its own renderer with its own store, so each root wires what it renders;
 * the read hooks (`usePreferences`, `useCredentialStatus`, `useMeeting`,
 * `useSubtitleOverlayVisible`…) only select from the store and
 * never fetch or subscribe themselves.
 */
export function useControlPanelWiring(): void {
  usePreferencesWiring();
  useTranslationEvents();
  useMeetingWiring();
  useMeetingMetricsWiring();
  useCredentialStatusWiring();
  useSubtitleOverlayVisibleWiring();
}

/** The overlay renders subtitles from preferences + translation events only. */
export function useSubtitleOverlayWiring(): void {
  usePreferencesWiring();
  useTranslationEvents();
}
