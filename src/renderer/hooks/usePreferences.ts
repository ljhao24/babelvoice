import { useEffect } from 'react';
import { useAppStore } from '../store/app-store.js';
import {
  DEFAULT_PREFERENCES,
  type UserPreferences
} from '@shared/config-types.js';

/**
 * Wires the store's preferences slice to main: hydrate once, then stay in
 * sync with writes from other windows (e.g. the control panel changes
 * subtitleStyle while the floating overlay is open) and cloud sync.
 *
 * Mounted once per renderer root — the control panel and the subtitle
 * overlay each run their own store (see `useRendererWiring`). `usePreferences`
 * callers only read.
 */
export function usePreferencesWiring(): void {
  const apply = useAppStore((s) => s.applyPreferences);

  useEffect(() => {
    let cancelled = false;
    void window.babelVoiceBridge
      .getPreferences()
      .then((prefs) => {
        if (!cancelled) apply(prefs);
      })
      .catch((err: unknown) => {
        // Still mark prefs as loaded (with defaults) — the shell waits on
        // `loaded`, so leaving it false would be a permanent blank window.
        // A later PreferencesChanged broadcast replaces these; never clobber
        // prefs a broadcast already hydrated. Treat setup as done: we can't
        // tell a returning user from a new one here, and dropping a
        // returning user into the first-run wizard (which writes real prefs)
        // is worse than showing the main panel. Only the fields a later
        // `set` sends are persisted, so this stand-in never reaches disk.
        console.error('[prefs] getPreferences failed, using defaults', err);
        if (!cancelled && !useAppStore.getState().preferencesLoaded) {
          apply({ ...DEFAULT_PREFERENCES, setupCompletedAt: Date.now() });
        }
      });
    const unsub = window.babelVoiceBridge.onPreferencesChanged((prefs) => {
      apply(prefs);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [apply]);
}

/** Write-through: persists immediately, then mirrors main's merged result. */
const savePreferences = async (
  partial: Partial<UserPreferences>
): Promise<void> => {
  const next = await window.babelVoiceBridge.setPreferences(partial);
  useAppStore.getState().applyPreferences(next);
};

/**
 * The preferences slice plus a write-through `set`. Components only need to
 * render based on `preferences`; they don't have to await anything because
 * the store starts seeded with `DEFAULT_PREFERENCES`. Hydration and the
 * cross-window subscription live in `usePreferencesWiring` at the root.
 */
export const usePreferences = (): {
  preferences: UserPreferences;
  loaded: boolean;
  set: (partial: Partial<UserPreferences>) => Promise<void>;
} => {
  const preferences = useAppStore((s) => s.preferences);
  const loaded = useAppStore((s) => s.preferencesLoaded);
  return { preferences, loaded, set: savePreferences };
};
