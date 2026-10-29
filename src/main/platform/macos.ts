import { app, shell } from 'electron';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
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
 * Regex matching macOS virtual loopback output device names. Owned by the
 * platform module (not the native bridge) because it's macOS knowledge of
 * "which devices count as our TTS output." The native bridge takes it as
 * config — see ADR-0002 follow-up.
 */
export const VIRTUAL_OUTPUT_PATTERN = 'babelvoice|blackhole';

export const getVirtualAudioDeviceHint = (): string =>
  t('audio:virtualDeviceHintMac');

export const getSetupGuideRelativePath = (): string => 'docs/SETUP-macOS.md';

// Packaged builds ship the guide via electron-builder extraResources (outside
// the asar, so external apps can open it); dev reads it from the repo. Not
// process.cwd(): a Finder-launched app runs with cwd `/`.
export const resolveSetupGuidePath = (): string =>
  join(
    app.isPackaged ? process.resourcesPath : app.getAppPath(),
    getSetupGuideRelativePath()
  );

export const openSetupGuide = async (): Promise<void> => {
  const p = resolveSetupGuidePath();
  const error = await shell.openPath(p);
  if (error) {
    log.warn(`open setup guide failed (${p}): ${error}`);
    // e.g. no app registered for .md — at least reveal it in Finder.
    shell.showItemInFolder(p);
  }
};

export const getScreenCapturePermission = (): ScreenPermissionStatus =>
  platformNativeBridge.getPermissions().screen;

export const hasMicrophonePermission = (): boolean =>
  platformNativeBridge.getPermissions().microphone === 'granted';

const SCREEN_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export const openScreenCaptureSettings = async (): Promise<void> => {
  await shell.openExternal(SCREEN_SETTINGS_URL);
};

/**
 * Trigger the macOS Screen Recording TCC prompt.
 *
 * macOS quirk: there's no `not-determined` state for screen capture and no
 * `askForMediaAccess('screen')` API. The standard way to surface the dialog
 * is to actually try a capture — `desktopCapturer.getSources` calls into
 * ScreenCaptureKit, which is what TCC hooks. The first time it sees this
 * app's bundle id, the system dialog appears; afterwards the decision is
 * cached and only `tccutil reset ScreenCapture <bundleId>` (or toggling the
 * checkbox in System Settings) re-opens the prompt.
 */
export const requestScreenCapturePermission =
  async (): Promise<ScreenPermissionRequestResult> => {
    const before = getScreenCapturePermission();
    let sourceCount = 0;
    let error: string | undefined;
    try {
    await platformNativeBridge.startSystemAudioCapture(() => undefined);
    await platformNativeBridge.stopSystemAudioCapture();
    sourceCount = 1;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const after = getScreenCapturePermission();
    const bundleId = app.isPackaged
      ? 'com.ljhao.babelvoice'
      : 'com.github.Electron';
    const hint =
      after === 'granted'
        ? undefined
        : t('audio:screenCaptureResetHint', { bundleId });
    return { statusBefore: before, statusAfter: after, sourceCount, error, hint };
  };

const BABELVOICE_DRIVER_PATH =
  '/Library/Audio/Plug-Ins/HAL/BabelVoice.driver';

const resolveBundledPkg = (): string => {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'babelvoice', 'BabelVoice.pkg');
  }
  return join(app.getAppPath(), 'resources', 'babelvoice', 'BabelVoice.pkg');
};

export const getVirtualOutputStatus = async (): Promise<VirtualOutputStatus> => {
  try {
    await access(BABELVOICE_DRIVER_PATH);
    return { installed: true, driverPath: BABELVOICE_DRIVER_PATH };
  } catch {
    return { installed: false, driverPath: BABELVOICE_DRIVER_PATH };
  }
};

export const requestVirtualOutputInstall = async (): Promise<InstallVirtualOutputResult> => {
  const pkgPath = resolveBundledPkg();
  try {
    await access(pkgPath);
  } catch {
    return {
      started: false,
      error: t('errors:pkgNotFound', { path: pkgPath })
    };
  }
  try {
    const child = spawn('open', ['-W', pkgPath], {
      detached: true,
      stdio: 'ignore'
    });
    child.on('error', (err) => log.error('open BabelVoice pkg failed:', err));
    child.unref();
    return { started: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('spawn open(BabelVoice pkg) threw:', err);
    return { started: false, error };
  }
};
