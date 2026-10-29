import { useCallback, useEffect, useState } from 'react';
import type { AudioCapableApplication } from '../../shared/ipc-types.js';

/**
 * Fetches the list of running, user-facing applications that can be tapped
 * via macOS Process Tap. The list is volatile (apps come and go) so callers
 * use `refresh()` whenever the picker UI opens.
 *
 * `processTapSupported` is false until the native capabilities answer, and
 * stays false below macOS 14.4 — callers hide per-app capture then.
 */
export const useAudioCapableApps = (): {
  apps: AudioCapableApplication[];
  processTapSupported: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
} => {
  const [apps, setApps] = useState<AudioCapableApplication[]>([]);
  const [processTapSupported, setProcessTapSupported] = useState(false);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const caps = await window.babelVoiceBridge.nativeCapabilities();
      const supported = caps.processAudioCapture === true;
      setProcessTapSupported(supported);
      setApps(
        supported
          ? await window.babelVoiceBridge.nativeAudioCapableApplications()
          : []
      );
    } catch {
      setApps([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { apps, processTapSupported, loading, refresh };
};
