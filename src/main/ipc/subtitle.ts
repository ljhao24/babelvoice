import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-types.js';
import {
  getSubtitleWindow,
  isSubtitleOverlayVisible,
  markSubtitleOverlayReady,
  toggleSubtitleOverlay
} from '../window-manager.js';

export const registerSubtitleHandlers = (): void => {
  ipcMain.handle(IPC.SubtitleToggle, () => toggleSubtitleOverlay());

  ipcMain.handle(IPC.SubtitleGetVisible, () => isSubtitleOverlayVisible());

  ipcMain.handle(IPC.SubtitleReady, (evt) => {
    // Only the overlay's own renderer may announce it mounted.
    const overlay = getSubtitleWindow();
    if (!overlay || overlay.isDestroyed() || evt.sender !== overlay.webContents) {
      return false;
    }
    markSubtitleOverlayReady();
    return true;
  });
};
