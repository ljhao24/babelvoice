import { useEffect, useState } from 'react';
import type { AppTheme } from '@shared/config-types.js';
import { usePreferences } from './usePreferences.js';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Resolve the user's `theme` preference into a concrete `light`/`dark` value.
 * For `system`, follows OS-level `prefers-color-scheme` changes so the window
 * updates without a relaunch. `force` pins a specific resolved theme
 * regardless of the user preference.
 */
export const useResolvedTheme = (force?: 'light' | 'dark'): 'light' | 'dark' => {
  const { preferences } = usePreferences();
  const theme: AppTheme = force ?? preferences.theme;
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia(DARK_QUERY).matches
  );

  useEffect(() => {
    if (theme !== 'system') return;
    const mql = window.matchMedia(DARK_QUERY);
    setSystemDark(mql.matches);
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, [theme]);

  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
};

/**
 * Write the resolved theme to `document.documentElement` as `data-theme`.
 * CSS picks the matching token block on its own.
 */
export const useTheme = (force?: 'light' | 'dark'): void => {
  const resolved = useResolvedTheme(force);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);
};
