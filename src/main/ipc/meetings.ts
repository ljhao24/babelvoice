import { ipcMain } from 'electron';
import { MEETING_IPC } from '@shared/meeting-types.js';
import { METRICS_IPC } from '@shared/meeting-metrics-types.js';
import type {
  AppendLinePayload,
  ListMeetingsFilter
} from '@shared/meeting-types.js';
import { log } from '@core/utils/logger.js';
import type { SessionOrchestrator } from '../sessions/session-orchestrator.js';
import type { MeetingMonitor } from '../meetings/meeting-monitor.js';
import { loadMeetingUsage } from '../meetings/meeting-usage-repo.js';
import { getActiveEngineId } from '../translation/engine-selection.js';
import {
  appendLine,
  endMeeting,
  getCurrentMeeting,
  listMeetings,
  loadMeeting,
  openMeeting,
  renameMeeting,
  softDeleteMeeting
} from '../meetings/index.js';

export const registerMeetingHandlers = (
  sessions: SessionOrchestrator,
  monitor: MeetingMonitor
): void => {
  ipcMain.handle(
    MEETING_IPC.Open,
    (_evt, params: { langSrc: string; langTgt: string }) => {
      // engineId is authoritative in main (`getActiveEngineId()` reads prefs
      // in both dev and packaged builds — see ADR-0002 amendment); do not
      // trust the renderer's view, otherwise a stale prefs.engineId could
      // tag the meeting with a different engine than translation uses.
      const result = openMeeting({ ...params, engineId: getActiveEngineId() });
      monitor.sync();
      return result;
    }
  );

  ipcMain.handle(MEETING_IPC.End, async () => {
    await sessions.cancelAll('resume');
    const ended = endMeeting('manual');
    // Persist the last usage and clear the control window's monitor now,
    // not on the next tick.
    monitor.sync();
    return ended;
  });

  ipcMain.handle(METRICS_IPC.Get, () => monitor.snapshot());

  ipcMain.handle(METRICS_IPC.Usage, (_evt, id: unknown) =>
    typeof id === 'string' ? loadMeetingUsage(id) : []
  );

  ipcMain.handle(MEETING_IPC.AppendLine, (_evt, payload: AppendLinePayload) => {
    try {
      appendLine(payload);
    } catch (err) {
      log.error('appendLine failed:', err);
    }
  });

  ipcMain.handle(MEETING_IPC.List, (_evt, filter: ListMeetingsFilter) => {
    return listMeetings(filter ?? {});
  });

  ipcMain.handle(MEETING_IPC.Load, (_evt, id: string) => {
    return loadMeeting(id);
  });

  ipcMain.handle(MEETING_IPC.Rename, (_evt, id: string, title: string) => {
    return renameMeeting(id, title);
  });

  ipcMain.handle(MEETING_IPC.SoftDelete, (_evt, id: string) => {
    softDeleteMeeting(id);
  });

  ipcMain.handle(MEETING_IPC.Current, () => {
    return getCurrentMeeting();
  });
};
