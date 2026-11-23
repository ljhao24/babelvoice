import { useEffect, useState } from 'react';
import type { PlatformInfo } from '@shared/ipc-types.js';

// The platform never changes while the app runs: ask main once.
let cached: PlatformInfo | null = null;
let pending: Promise<PlatformInfo> | null = null;

/** null until main has answered (the first render assumes macOS copy). */
export function usePlatformInfo(): PlatformInfo | null {
  const [info, setInfo] = useState<PlatformInfo | null>(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    pending ??= window.babelVoiceBridge.platformInfo();
    pending
      .then((next) => {
        cached = next;
        if (alive) setInfo(next);
      })
      .catch(() => {
        pending = null;
      });
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/**
 * Onboarding copy differs per platform for a few keys: `key` resolves to
 * `win.key` on Windows when that exists, else to `key` itself.
 */
export const platformKey = (info: PlatformInfo | null, key: string): string[] =>
  info?.isWindows ? [`win.${key}`, key] : [key];
