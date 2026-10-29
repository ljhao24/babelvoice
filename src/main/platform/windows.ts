/**
 * TODO(v2-windows): real Windows implementation.
 * v1 ships macOS only — Windows users will see warnings until v2.
 */

import type {
  InstallVirtualOutputResult,
  ScreenPermissionRequestResult,
  ScreenPermissionStatus,
  VirtualOutputStatus
} from '@shared/ipc-types.js';
import { t } from '../i18n.js';

const TODO = (fn: string): never => {
  throw new Error(`TODO(v2-windows): ${fn} not implemented`);
};

export const getVirtualAudioDeviceHint = (): string =>
  t('audio:virtualDeviceHintWindows');

export const getSetupGuideRelativePath = (): string => 'docs/SETUP-windows.md';

export const openSetupGuide = async (): Promise<void> => {
  TODO('openSetupGuide');
};

export const getScreenCapturePermission = (): ScreenPermissionStatus => 'granted';

export const hasMicrophonePermission = (): boolean => true;

export const requestScreenCapturePermission =
  async (): Promise<ScreenPermissionRequestResult> => ({
    statusBefore: 'granted',
    statusAfter: 'granted',
    sourceCount: 0
  });

export const openScreenCaptureSettings = async (): Promise<void> => {
  // TODO(v2-windows): Windows uses Settings > Privacy > Screen Recording.
};

export const getVirtualOutputStatus = async (): Promise<VirtualOutputStatus> => ({
  installed: false
});

export const requestVirtualOutputInstall =
  async (): Promise<InstallVirtualOutputResult> => ({
    started: false,
    error: t('errors:windowsInstallTodo')
  });
