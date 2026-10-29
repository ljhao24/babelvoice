import { IPC } from '@shared/ipc-types.js';
import { METRICS_IPC } from '@shared/meeting-metrics-types.js';
import { resolvePriceSheet } from '@shared/pricing.js';
import {
  broadcastToAllRenderers,
  sendToControlWindow,
  showSubtitleOverlay
} from './window-manager.js';
import { getPreferences, setPreferences } from './config-store.js';
import { registerHotkey } from './hotkey-manager.js';
import { sessionRegistry } from './sessions/session-registry.js';
import { micPassthroughCoordinator } from './sessions/mic-passthrough-coordinator.js';
import { createPassthroughMicArbiter } from './sessions/mic-arbiter.js';
import { SessionOrchestrator } from './sessions/session-orchestrator.js';
import { createTranslationClient } from './translation/client-factory.js';
import {
  buildClientStartParams,
  getActiveEngineId
} from './translation/engine-selection.js';
import { stopAllNativeAudioServices } from './native/platform-native-bridge.js';
import { PreferencesService } from './preferences-service.js';
import { getCurrentMeetingId } from './meetings/index.js';
import { MeetingMonitor } from './meetings/meeting-monitor.js';
import {
  loadMeetingUsage,
  saveMeetingUsage
} from './meetings/meeting-usage-repo.js';

/**
 * Composition root for the main-process services that the IPC layer and
 * the app lifecycle (index.ts) share. The services take their
 * collaborators as constructor arguments so they can be unit-tested; this
 * is the one place that binds them to the real modules.
 */

// Before the orchestrator, which reports every session to it.
export const meetingMonitor = new MeetingMonitor({
  currentMeetingId: getCurrentMeetingId,
  priceSheet: (engineId) => resolvePriceSheet(engineId, getPreferences().pricing),
  loadUsage: loadMeetingUsage,
  saveUsage: saveMeetingUsage,
  publish: (snapshot) => sendToControlWindow(METRICS_IPC.Changed, snapshot)
});

export const sessionOrchestrator = new SessionOrchestrator({
  registry: sessionRegistry,
  createClient: createTranslationClient,
  getActiveEngineId,
  buildClientStartParams,
  getPreferences,
  broadcast: broadcastToAllRenderers,
  sendToControlWindow,
  showSubtitleOverlay,
  micArbiter: createPassthroughMicArbiter(micPassthroughCoordinator),
  stopAllNativeAudio: stopAllNativeAudioServices,
  observer: meetingMonitor
});

export const preferencesService = new PreferencesService({
  getPreferences,
  setPreferences,
  hasActiveSessions: () => sessionOrchestrator.hasActiveSessions(),
  registerHotkey,
  broadcastChanged: (prefs) =>
    broadcastToAllRenderers(IPC.PreferencesChanged, prefs),
  micPassthrough: micPassthroughCoordinator
});
