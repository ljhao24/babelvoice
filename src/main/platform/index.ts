/**
 * Platform dispatcher. Imports the macOS or Windows implementation
 * based on `process.platform` and re-exports a uniform API.
 *
 * v1: macOS only. Windows variant is stubbed with TODO(v2-windows).
 */
import * as macos from './macos.js';
import * as windows from './windows.js';

import type {
  InstallVirtualOutputResult,
  ScreenPermissionRequestResult,
  ScreenPermissionStatus,
  VirtualOutputStatus
} from '@shared/ipc-types.js';

export interface PlatformAdapter {
  /** Human-readable hint about the virtual audio device users should install. */
  getVirtualAudioDeviceHint(): string;
  /**
   * Path to the platform-specific setup doc, relative to the repo root in dev
   * and to the app's Resources dir when packaged (see electron-builder.yml).
   */
  getSetupGuideRelativePath(): string;
  /** Open the setup doc in the OS file viewer. */
  openSetupGuide(): Promise<void>;
  /** Returns the current screen recording permission status. */
  getScreenCapturePermission(): ScreenPermissionStatus;
  /** Returns true if the OS reports microphone permission has been granted. */
  hasMicrophonePermission(): boolean;
  /**
   * Trigger the OS-level screen-recording permission prompt.
   * On macOS this calls desktopCapturer.getSources() so TCC shows its dialog
   * the first time it sees the bundle id; subsequent calls just return the
   * cached decision (and the user must use openScreenSettings + relaunch).
   */
  requestScreenCapturePermission(): Promise<ScreenPermissionRequestResult>;
  /** Open the system settings pane for screen recording. */
  openScreenCaptureSettings(): Promise<void>;
  /** Whether the platform's virtual loopback output device is installed. */
  getVirtualOutputStatus(): Promise<VirtualOutputStatus>;
  /**
   * Trigger whatever the platform uses to install the virtual loopback
   * device. macOS launches the bundled BabelVoice .pkg installer; Windows
   * (TODO v2) opens the VB-Cable download page. Returns once the trigger
   * fires — the renderer polls `getVirtualOutputStatus` afterwards.
   */
  requestVirtualOutputInstall(): Promise<InstallVirtualOutputResult>;
}

const adapter: PlatformAdapter =
  process.platform === 'darwin' ? macos : windows;

export const platform: PlatformAdapter = adapter;
