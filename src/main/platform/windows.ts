/**
 * Windows platform adapter. The virtual loopback is VB-Audio's free
 * VB-Cable: TTS renders into "CABLE Input" and meeting apps pick
 * "CABLE Output" as their microphone. Windows has no screen-recording gate
 * for system audio, so that permission is always granted; the microphone
 * privacy switch is read by the native addon.
 */

import { app, shell } from 'electron';
import { join } from 'node:path';
import type {
  InstallVirtualOutputResult,
  ScreenPermissionRequestResult,
  ScreenPermissionStatus,
  VirtualOutputStatus
} from '@shared/ipc-types.js';
import { log } from '@core/utils/logger.js';
import { t } from '../i18n.js';
import { platformNativeBridge } from '../native/platform-native-bridge.js';

/**
 * Device names that count as the virtual loopback (matched case-insensitively
 * as '|'-separated substrings by the native addon). Includes VB-Cable's
 * capture side so it is never recorded as the user's mic.
 */
export const VIRTUAL_OUTPUT_PATTERN = 'babelvoice|vb-audio|cable input|cable output';

const VB_CABLE_DOWNLOAD_URL = 'https://vb-audio.com/Cable/';
const MICROPHONE_SETTINGS_URL = 'ms-settings:privacy-microphone';

export const getVirtualAudioDeviceHint = (): string =>
  t('audio:virtualDeviceHintWindows');

export const getSetupGuideRelativePath = (): string => 'docs/SETUP-windows.md';

export const openSetupGuide = async (): Promise<void> => {
  const p = join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    getSetupGuideRelativePath()
  );
  const error = await shell.openPath(p);
  if (error) {
    log.warn(`open setup guide failed (${p}): ${error}`);
    shell.showItemInFolder(p);
  }
};

export const getScreenCapturePermission = (): ScreenPermissionStatus => 'granted';

export const hasMicrophonePermission = (): boolean =>
  platformNativeBridge.getPermissions().microphone !== 'denied';

export const requestScreenCapturePermission =
  async (): Promise<ScreenPermissionRequestResult> => ({
    statusBefore: 'granted',
    statusAfter: 'granted',
    sourceCount: 1
  });

/** No screen-recording pane on Windows; the closest gate is the mic switch. */
export const openScreenCaptureSettings = async (): Promise<void> => {
  await shell.openExternal(MICROPHONE_SETTINGS_URL);
};

export const getVirtualOutputStatus = async (): Promise<VirtualOutputStatus> => {
  const installed = platformNativeBridge
    .listAudioDevices()
    .some((d) => d.kind === 'output' && d.isVirtual);
  return { installed };
};

/**
 * VB-Cable's installer must be run as administrator and its licence lets us
 * point users at it but not redistribute it, so open the download page; the
 * renderer keeps polling `getVirtualOutputStatus` until the device appears.
 */
export const requestVirtualOutputInstall =
  async (): Promise<InstallVirtualOutputResult> => {
    try {
      await shell.openExternal(VB_CABLE_DOWNLOAD_URL);
      return { started: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.error('open VB-Cable download page failed:', err);
      return { started: false, error };
    }
  };
