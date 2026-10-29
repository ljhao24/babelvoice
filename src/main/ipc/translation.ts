import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-types.js';
import type {
  Direction,
  StartTranslationParams,
  TranslationStatusPayload
} from '@shared/ipc-types.js';
import type { SessionOrchestrator } from '../sessions/session-orchestrator.js';

const isDirection = (v: unknown): v is Direction =>
  v === 'speak' || v === 'listen';

export const registerTranslationHandlers = (
  sessions: SessionOrchestrator
): void => {
  ipcMain.handle(
    IPC.TranslationStart,
    async (_evt, params: StartTranslationParams) => {
      if (!isDirection(params.direction)) {
        throw new Error(`Unknown direction ${String(params.direction)}`);
      }
      await sessions.start(params);
      return true;
    }
  );

  ipcMain.handle(IPC.TranslationGetStatuses, (): TranslationStatusPayload[] =>
    sessions.getStatuses()
  );

  ipcMain.handle(IPC.TranslationFinish, (_evt, direction: Direction) =>
    sessions.finish(direction)
  );

  ipcMain.handle(IPC.TranslationCancel, (_evt, direction: Direction) =>
    sessions.cancel(direction)
  );
};
