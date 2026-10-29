import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-types.js';
import type { PlatformInfo } from '@shared/ipc-types.js';
import { platform } from '../platform/index.js';
import { platformNativeBridge } from '../native/platform-native-bridge.js';

/** OS permissions / setup, the virtual output device, and native audio queries. */
export const registerPlatformHandlers = (): void => {
  ipcMain.handle(IPC.PlatformInfo, (): PlatformInfo => {
    return {
      platform: process.platform,
      isMac: process.platform === 'darwin',
      isWindows: process.platform === 'win32',
      virtualAudioDeviceHint: platform.getVirtualAudioDeviceHint()
    };
  });

  ipcMain.handle(IPC.PlatformOpenSetupGuide, async () => {
    await platform.openSetupGuide();
  });

  ipcMain.handle(IPC.PlatformScreenPermission, () =>
    platform.getScreenCapturePermission()
  );

  ipcMain.handle(IPC.PlatformRequestScreenPermission, () =>
    platform.requestScreenCapturePermission()
  );

  ipcMain.handle(IPC.PlatformOpenScreenSettings, async () => {
    await platform.openScreenCaptureSettings();
  });

  ipcMain.handle(IPC.AudioVirtualOutputStatus, () =>
    platform.getVirtualOutputStatus()
  );

  ipcMain.handle(IPC.AudioInstallVirtualOutput, () =>
    platform.requestVirtualOutputInstall()
  );

  ipcMain.handle(IPC.NativeCapabilities, () =>
    platformNativeBridge.getCapabilities()
  );

  ipcMain.handle(IPC.NativePermissions, () =>
    platformNativeBridge.getPermissions()
  );

  ipcMain.handle(IPC.NativeAudioDevices, () =>
    platformNativeBridge.listAudioDevices()
  );

  ipcMain.handle(IPC.NativeAudioCapableApplications, () =>
    platformNativeBridge.listAudioCapableApplications()
  );

  ipcMain.handle(IPC.NativeAudioDiagnostics, () =>
    platformNativeBridge.getAudioDiagnostics()
  );
};
