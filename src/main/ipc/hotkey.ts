import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-types.js';
import { resumeHotkey, suspendHotkey } from '../hotkey-manager.js';

export const registerHotkeyHandlers = (): void => {
  // A renderer that reloads or dies mid-capture never sends the resume, so
  // watch the suspending one — one watch at a time, dropped on resume.
  let unwatchSuspender: (() => void) | null = null;
  ipcMain.handle(IPC.HotkeySetSuspended, (evt, suspended: boolean) => {
    unwatchSuspender?.();
    unwatchSuspender = null;
    if (suspended !== true) {
      resumeHotkey();
      return;
    }
    suspendHotkey();
    const sender = evt.sender;
    const resume = (): void => {
      unwatchSuspender?.();
      unwatchSuspender = null;
      resumeHotkey();
    };
    sender.once('did-start-loading', resume);
    sender.once('destroyed', resume);
    unwatchSuspender = () => {
      sender.removeListener('did-start-loading', resume);
      sender.removeListener('destroyed', resume);
    };
  });
};
