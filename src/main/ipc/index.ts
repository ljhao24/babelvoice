import {
  meetingMonitor,
  preferencesService,
  sessionOrchestrator
} from '../app-services.js';
import { registerCredentialsHandlers } from './credentials.js';
import { registerHotkeyHandlers } from './hotkey.js';
import { registerMeetingHandlers } from './meetings.js';
import { registerPlatformHandlers } from './platform.js';
import { registerPreferencesHandlers } from './preferences.js';
import { registerSubtitleHandlers } from './subtitle.js';
import { registerTranslationHandlers } from './translation.js';

/**
 * The IPC layer is a thin, IPC-shaped adapter: each domain module checks
 * its arguments and forwards to the service that owns the rule. Business logic stays out of here so non-IPC entry points
 * (meeting idle timeout, quit) go through the same services.
 */
export const registerIpcHandlers = (): void => {
  registerTranslationHandlers(sessionOrchestrator);
  registerPlatformHandlers();
  registerSubtitleHandlers();
  registerHotkeyHandlers();
  registerPreferencesHandlers(preferencesService);
  registerCredentialsHandlers(sessionOrchestrator);
  registerMeetingHandlers(sessionOrchestrator, meetingMonitor);
};
