import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeAudioDevice, NativePermissionSnapshot } from '@shared/ipc-types.js';

const INSTALL_POLL_MS = 2000;
const INSTALL_POLL_LIMIT_MS = 5 * 60 * 1000;

/** The BabelVoice driver: on disk, and loaded by Core Audio (meeting apps can pick it). */
export type DriverState = 'checking' | 'missing' | 'installing' | 'not-loaded' | 'ready';

export interface AudioRouting {
  driver: DriverState;
  /** The last install attempt didn't start; '' when the installer gave no reason. */
  installError: string | null;
  install: () => Promise<void>;
  permissions: NativePermissionSnapshot | null;
  /** Real (non-virtual) live microphones, from Core Audio. */
  microphones: NativeAudioDevice[];
  /** Chromium's outputs: the only ids `AudioContext.setSinkId` takes. */
  outputs: MediaDeviceInfo[];
  /** Core Audio's default output: named in "系统默认（…）", and a hazard when virtual. */
  defaultOutput: NativeAudioDevice | null;
  refresh: () => Promise<void>;
}

/**
 * Everything the 音频路由 page shows, kept current: re-read when devices
 * come and go and when the window regains focus (back from System Settings
 * or the Installer), and polled while the driver installs.
 */
export const useAudioRouting = (): AudioRouting => {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [permissions, setPermissions] = useState<NativePermissionSnapshot | null>(null);
  const [nativeDevices, setNativeDevices] = useState<NativeAudioDevice[]>([]);
  const [browserDevices, setBrowserDevices] = useState<MediaDeviceInfo[]>([]);
  const pollRef = useRef<number | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const bridge = window.babelVoiceBridge;
    const [status, devices, perms, browser] = await Promise.all([
      bridge.getVirtualOutputStatus().catch(() => null),
      bridge.nativeAudioDevices().catch(() => []),
      bridge.nativePermissions().catch(() => null),
      navigator.mediaDevices.enumerateDevices().catch(() => [])
    ]);
    if (status) setInstalled(status.installed);
    setNativeDevices(devices);
    if (perms) setPermissions(perms);
    setBrowserDevices(browser);
  }, []);

  const stopPolling = (): void => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    void refresh();
    const onChange = (): void => void refresh();
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    window.addEventListener('focus', onChange);
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', onChange);
      window.removeEventListener('focus', onChange);
      stopPolling();
    };
  }, [refresh]);

  // The poll owns `installing` until the driver shows up or it gives up.
  useEffect(() => {
    if (installing && installed) {
      stopPolling();
      setInstalling(false);
    }
  }, [installing, installed]);

  const install = async (): Promise<void> => {
    setInstallError(null);
    setInstalling(true);
    try {
      const result = await window.babelVoiceBridge.requestVirtualOutputInstall();
      if (!result.started) {
        setInstallError(result.error ?? '');
        setInstalling(false);
        return;
      }
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
      setInstalling(false);
      return;
    }
    const startedAt = Date.now();
    stopPolling();
    pollRef.current = window.setInterval(() => {
      if (Date.now() - startedAt > INSTALL_POLL_LIMIT_MS) {
        stopPolling();
        setInstalling(false);
      }
      void refresh();
    }, INSTALL_POLL_MS);
  };

  const virtualLoaded = nativeDevices.some((d) => d.kind === 'output' && d.isVirtual && d.isAlive);
  const driver: DriverState = installing
    ? 'installing'
    : installed === null
      ? 'checking'
      : !installed
        ? 'missing'
        : virtualLoaded
          ? 'ready'
          : 'not-loaded';

  return {
    driver,
    installError,
    install,
    permissions,
    microphones: nativeDevices.filter((d) => d.kind === 'input' && d.isAlive && !d.isVirtual),
    outputs: browserDevices.filter((d) => d.kind === 'audiooutput'),
    defaultOutput: nativeDevices.find((d) => d.kind === 'output' && d.isDefault && d.isAlive) ?? null,
    refresh
  };
};
