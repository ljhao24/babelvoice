/**
 * Browser-only stub for `window.babelVoiceBridge`. Loaded by the web Vite
 * dev server (vite.config.web.mjs) so the renderer can render outside
 * Electron — useful for fast UI iteration in a regular browser tab.
 *
 * NOT bundled into Electron builds.
 */

import type { BabelVoiceBridge } from '../../preload/index.js';
import {
  DEFAULT_PREFERENCES,
  type UserPreferences
} from '../../shared/config-types.js';
import type { CredentialStatus } from '../../shared/engine-types.js';
import type { Meeting } from '../../shared/meeting-types.js';
import type { MeetingMetricsSnapshot } from '../../shared/meeting-metrics-types.js';

let shimPreferences: UserPreferences = {
  ...DEFAULT_PREFERENCES,
  setupCompletedAt: Date.now()
};

let shimOverlayVisible = true;
const overlayListeners = new Set<(visible: boolean) => void>();

const noopUnsub = (): void => {
  /* no-op */
};

/** A busy two-engine meeting, so the monitor card can be styled in a browser. */
const demoMetrics = (): MeetingMetricsSnapshot => {
  const now = Date.now();
  return {
    meetingId: 'demo',
    links: {
      speak: {
        direction: 'speak',
        engineId: 'doubao',
        state: 'live',
        since: now - 312_000,
        handshakeMs: 212,
        readyMs: 386,
        rttMs: 48,
        lastRxAt: now - 600
      },
      listen: {
        direction: 'listen',
        engineId: 'gemini',
        state: 'reconnecting',
        since: now - 2_000,
        handshakeMs: 640,
        readyMs: 910,
        rttMs: 233,
        lastRxAt: now - 4_200
      }
    },
    usage: [
      {
        engineId: 'doubao',
        direction: 'speak',
        tokens: { inputAudio: 15_620, outputText: 1_240, outputAudio: 11_870 },
        estimated: false,
        audioInMs: 312_000,
        audioOutMs: 141_000,
        sessions: 3,
        reconnects: 0,
        failures: 0,
        cost: { amount: 0.42, currency: 'CNY', complete: true }
      },
      {
        engineId: 'gemini',
        direction: 'listen',
        tokens: { inputAudio: 7_375, outputAudio: 3_100 },
        estimated: true,
        audioInMs: 295_000,
        audioOutMs: 0,
        sessions: 1,
        reconnects: 2,
        failures: 0,
        cost: { amount: 0.031, currency: 'USD', complete: false }
      }
    ],
    costTotals: { CNY: 0.42, USD: 0.031 },
    costIncomplete: true,
    updatedAt: now
  };
};

const credentialStatus: CredentialStatus = {
  doubao: { configured: true, appKeyTail: 'demo' },
  qwen: { configured: true, apiKeyTail: 'demo' },
  gemini: { configured: true, apiKeyTail: 'demo' },
  openai: { configured: true, apiKeyTail: 'demo' }
};

const fakeMeeting = (): Meeting => ({
  id: 'web-debug-meeting',
  userId: 'web-debug-user',
  title: '调试会议',
  startedAt: Date.now(),
  endedAt: null,
  endedBy: null,
  engineId: 'doubao',
  langSrc: 'zh',
  langTgt: 'en',
  updatedAt: Date.now(),
  deletedAt: null
});

const stub: BabelVoiceBridge = {
  onHotkeyPressed: () => noopUnsub,
  setHotkeySuspended: async () => undefined,
  onTranslationEvent: () => noopUnsub,
  onTranslationStatus: () => noopUnsub,
  getTranslationStatuses: async () => [],
  startTranslation: async () => true as const,
  finishTranslation: async () => true,
  cancelTranslation: async () => true,

  platformInfo: async () => ({
    platform: 'darwin',
    isMac: true,
    isWindows: false,
    virtualAudioDeviceHint: 'BlackHole 2ch'
  }),
  openSetupGuide: async () => undefined,
  getScreenPermission: async () => 'granted',
  requestScreenPermission: async () => ({
    statusBefore: 'granted',
    statusAfter: 'granted',
    sourceCount: 1
  }),
  openScreenSettings: async () => undefined,

  getVirtualOutputStatus: async () => ({ installed: true }),
  requestVirtualOutputInstall: async () => ({ started: false }),

  nativeCapabilities: async () => ({
    platform: 'darwin',
    systemAudioCapture: true,
    nativeTtsPlayback: true,
    processAudioCapture: true,
    hasVirtualOutput: true
  }),
  nativePermissions: async () => ({
    screen: 'granted',
    microphone: 'granted',
    inputMonitoring: 'granted',
    accessibility: 'granted'
  }),
  nativeAudioDevices: async () => [],
  nativeAudioCapableApplications: async () => [
    { pid: 101, bundleId: 'us.zoom.xos', name: 'zoom.us' },
    { pid: 102, bundleId: 'com.apple.QuickTimePlayerX', name: 'QuickTime Player' }
  ],
  nativeAudioDiagnostics: async () => {
    const empty = {
      level: 0,
      lastPcmAt: 0,
      silenceMs: 0,
      queuedSamples: 0,
      ringSamples: 0,
      droppedSamples: 0,
      routeStatus: 'idle',
      lastError: ''
    };
    return { mic: empty, listen: empty, tts: empty };
  },

  toggleSubtitleOverlay: async () => {
    shimOverlayVisible = !shimOverlayVisible;
    overlayListeners.forEach((cb) => cb(shimOverlayVisible));
    return shimOverlayVisible;
  },
  getSubtitleOverlayVisible: async () => shimOverlayVisible,
  onSubtitleOverlayVisibility: (cb) => {
    overlayListeners.add(cb);
    return () => overlayListeners.delete(cb);
  },
  notifySubtitleReady: async () => true,

  getPreferences: async () => ({ ...shimPreferences }),
  setPreferences: async (partial) => {
    // Merge like the main-process store does, so dependent picks (e.g. a
    // listen source app, then playback) survive successive writes.
    shimPreferences = { ...shimPreferences, ...partial };
    return { ...shimPreferences };
  },
  onPreferencesChanged: () => noopUnsub,

  getCredentialStatus: async () => credentialStatus,
  setCredentials: async () => credentialStatus,
  clearCredentials: async () => credentialStatus,
  validateCredentials: async () => ({ ok: true }),
  onCredentialsChanged: () => noopUnsub,

  openMeeting: async () => ({ meeting: fakeMeeting() }),
  endMeeting: async () => null,
  appendMeetingLine: async () => undefined,
  listMeetings: async () => [],
  loadMeeting: async () => null,
  renameMeeting: async () => null,
  softDeleteMeeting: async () => undefined,
  getCurrentMeeting: async () => null,
  onMeetingAutoEnded: () => noopUnsub,

  getMeetingMetrics: async () => demoMetrics(),
  onMeetingMetrics: () => noopUnsub,
  getMeetingUsage: async () => demoMetrics().usage,

  getLocale: async () => 'zh-CN' as const,
  setLocale: async (locale) => locale,
  onLocaleChanged: () => noopUnsub
};

(window as unknown as { babelVoiceBridge: BabelVoiceBridge }).babelVoiceBridge = stub;

if (typeof console !== 'undefined') {
  console.info('[web-shim] babelVoiceBridge stubbed for browser dev mode');
}
