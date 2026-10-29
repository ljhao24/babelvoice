/**
 * IPC channel names + payload types shared between main and renderer.
 * Keep this file dependency-free (no Node, no Electron, no React).
 */

import type { CredentialedEngineId } from './engine-types.js';
import type { TranslationErrorKind } from './translation-error-types.js';

export type { TranslationErrorKind } from './translation-error-types.js';

export const IPC = {
  HotkeyPressed: 'hotkey:pressed',
  HotkeySetSuspended: 'hotkey:set-suspended',

  TranslationStart: 'translation:start',
  TranslationFinish: 'translation:finish',
  TranslationCancel: 'translation:cancel',
  TranslationEvent: 'translation:event',
  TranslationStatus: 'translation:status',
  TranslationGetStatuses: 'translation:get-statuses',

  PlatformInfo: 'platform:info',
  PlatformOpenSetupGuide: 'platform:open-setup-guide',
  PlatformScreenPermission: 'platform:screen-permission',
  PlatformRequestScreenPermission: 'platform:request-screen-permission',
  PlatformOpenScreenSettings: 'platform:open-screen-settings',

  AudioVirtualOutputStatus: 'audio:virtual-output-status',
  AudioInstallVirtualOutput: 'audio:install-virtual-output',

  NativeCapabilities: 'native:get-capabilities',
  NativePermissions: 'native:get-permissions',
  NativeAudioDevices: 'native:list-audio-devices',
  NativeAudioCapableApplications: 'native:list-audio-capable-apps',
  NativeAudioDiagnostics: 'native:get-audio-diagnostics',

  SubtitleToggle: 'subtitle:toggle',
  SubtitleReady: 'subtitle:ready',
  SubtitleGetVisible: 'subtitle:get-visible',
  /** main → control window: overlay shown/hidden (payload: boolean). */
  SubtitleVisibility: 'subtitle:visibility',

  PreferencesGet: 'preferences:get',
  PreferencesSet: 'preferences:set',
  PreferencesChanged: 'preferences:changed',

  CredentialsGet: 'credentials:get',
  CredentialsSet: 'credentials:set',
  CredentialsClear: 'credentials:clear',
  CredentialsChanged: 'credentials:changed',
  CredentialsValidate: 'credentials:validate',

  I18nGetLocale: 'i18n:get-locale',
  I18nSetLocale: 'i18n:set-locale',
  I18nLocaleChanged: 'i18n:locale-changed'
} as const;

/**
 * Plaintext credentials submitted by the user via Settings. The renderer
 * sends this over IPC exactly once per save; main encrypts at rest with
 * `safeStorage` and never echoes plaintext back. See ADR-0002 amendment
 * (per-user keys).
 */
export type SetCredentialsPayload =
  | { engineId: 'doubao'; appKey: string; accessKey: string }
  | { engineId: 'qwen'; apiKey: string; workspaceId?: string }
  | { engineId: 'gemini'; apiKey: string }
  | { engineId: 'openai'; apiKey: string };

export type ClearCredentialsPayload = { engineId: CredentialedEngineId };

/**
 * Onboarding-time smoke test: open a session against the provider just far
 * enough to know "the credentials are accepted and we can reach the server",
 * then immediately cancel. No audio is sent → providers don't bill duration
 * or tokens. See `src/main/translation/connectivity-tester.ts`.
 */
export type ValidateCredentialsPayload = { engineId: CredentialedEngineId };

export interface ValidateCredentialsResult {
  ok: boolean;
  /** Provider-specific error code when ok === false (e.g. Doubao 45000003). */
  code?: number;
  /** Human-readable error message when ok === false. */
  message?: string;
  /** Main's classification of the failure (see translation-error-types). */
  errorKind?: TranslationErrorKind;
}

export type ScreenPermissionStatus =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown';

/**
 * Two independent translation directions can run concurrently:
 *   - 'speak': PTT — local mic → English TTS routed to BlackHole/Zoom
 *   - 'listen': continuous capture of meeting audio → Chinese subtitles
 * IPC handlers in main route by direction; events are tagged with it.
 */
export type Direction = 'speak' | 'listen';

/**
 * Lifecycle of a DirectionSession (see CONTEXT.md). Authoritative in main;
 * broadcast to renderers via IPC.TranslationStatus. The renderer mirrors it
 * into the store and never invents transitions of its own.
 */
export type SessionStatus =
  | 'idle'
  | 'connecting'
  | 'running'
  | 'finishing'
  | 'cancelling'
  | 'failed';

export interface TranslationStatusPayload {
  direction: Direction;
  status: SessionStatus;
  /** Raw technical detail of a failure — for logs/diagnostics, not UI copy. */
  errorMessage?: string;
  /** Why the session failed (status `failed`), for the UI to word. */
  errorKind?: TranslationErrorKind;
}

/**
 * Languages accepted by the protocol (kept inline to avoid a circular import
 * with config-types.ts; SupportedLanguage there is the same set).
 */
export type ProtocolLanguage =
  | 'zh'
  | 'en'
  | 'ja'
  | 'id'
  | 'es'
  | 'pt'
  | 'de'
  | 'fr';

/**
 * Universal translation intent crossing the IPC boundary. Provider-specific
 * knobs (Doubao's speakerId/denoise/corpus, Qwen's voice, etc.) and TTS
 * sample rate live inside main and are resolved from `prefs.engineConfigs`
 * by `buildClientStartParams` — see ADR-0002.
 */
export interface StartTranslationParams {
  direction: Direction;
  sourceLanguage: ProtocolLanguage;
  targetLanguage: ProtocolLanguage;
  /** s2t: subtitles only. s2s: subtitles + TTS audio. */
  mode: 's2t' | 's2s';
  /**
   * When true, main does not auto-create or show the floating subtitle
   * window for this session. The onboarding wizard sets this so its inline
   * test cards can render their own preview UI instead.
   */
  suppressOverlay?: boolean;
  /**
   * Listen only: capture the whole system's audio even when a meeting app
   * is set as the listen source. The 测试翻译 panel sets it — its sample
   * clips play from BabelVoice itself, which a tap on the meeting app never
   * hears. Whole-system capture would re-capture locally played TTS, so it
   * only goes with `mode: 's2t'`.
   */
  captureSystemAudio?: boolean;
}

export interface DirectionPayload {
  direction: Direction;
}

/**
 * Translation events flowing main → renderer over IPC.
 * Mirrors the LiveInterpret response event taxonomy from
 * `protos/common/events.proto` (650-655 / 350-352 / 250 / 154 / 150-153).
 * Every event carries `direction` so multi-session renderers can route.
 */
export type TranslationEvent =
  | { direction: Direction; type: 'session-started' }
  | { direction: Direction; type: 'session-finished' }
  | {
      direction: Direction;
      type: 'session-failed';
      /** Why it failed, for the UI to word (see TranslationErrorKind). */
      kind: TranslationErrorKind;
      /** Raw technical detail — for logs/diagnostics, not UI copy. */
      message: string;
      /**
       * Provider-specific numeric diagnostic when one applies: a business
       * code (Doubao 45000001), the HTTP status of a refused upgrade, or the
       * WebSocket close code.
       */
      code?: number;
    }
  | {
      direction: Direction;
      type: 'source-subtitle-start';
      startMs: number;
      speakerChanged: boolean;
      /**
       * Who is talking, numbered 1, 2, … in order of first appearance within
       * this engine session. Only engines that tell speakers apart send it
       * (Qwen 3.8); absent otherwise. Numbers don't carry across sessions.
       */
      speaker?: number;
    }
  | { direction: Direction; type: 'source-subtitle-delta'; text: string }
  | {
      direction: Direction;
      type: 'source-subtitle-final';
      text: string;
      startMs: number;
      endMs: number;
      /** Same as on `source-subtitle-start`. */
      speaker?: number;
    }
  | { direction: Direction; type: 'translation-subtitle-start'; startMs: number; speakerChanged: boolean }
  | { direction: Direction; type: 'translation-subtitle-delta'; text: string }
  | { direction: Direction; type: 'translation-subtitle-final'; text: string; startMs: number; endMs: number }
  | { direction: Direction; type: 'tts-sentence-start'; startMs: number }
  | {
      direction: Direction;
      type: 'tts-audio';
      /** 16-bit mono LE PCM. */
      data: ArrayBuffer;
      /**
       * Rate of `data`, filled in by main from the running client
       * (main-authoritative, ADR-0002) — renderers play each chunk at this
       * rate rather than inferring one from prefs.engineId.
       */
      sampleRate: number;
    }
  | { direction: Direction; type: 'tts-sentence-end'; endMs: number }
  | { direction: Direction; type: 'audio-muted'; durationMs: number };

export interface PlatformInfo {
  platform: NodeJS.Platform;
  isMac: boolean;
  isWindows: boolean;
  virtualAudioDeviceHint: string;
}

export interface VirtualOutputStatus {
  installed: boolean;
  /** Optional macOS-only diagnostic: the driver path the detector probed. */
  driverPath?: string;
}

export interface InstallVirtualOutputResult {
  /** True if the install trigger (system installer / download page / ...) fired. */
  started: boolean;
  /** Reason for failure if started === false. */
  error?: string;
}

export interface NativeAudioCapabilities {
  platform: NodeJS.Platform;
  minimumMacOS?: string;
  systemAudioCapture: boolean;
  nativeTtsPlayback: boolean;
  microphoneCapture?: boolean;
  /** macOS 14.4+ Core Audio Process Tap. False on older systems. */
  processAudioCapture?: boolean;
  audioDevices?: boolean;
  permissions?: boolean;
  windowBehavior?: boolean;
  hasVirtualOutput: boolean;
  reason?: string;
}

/**
 * One running application that can plausibly be tapped via Process Tap.
 * Returned by `listAudioCapableApplications`. `pid` is volatile (changes
 * across launches) — persist `bundleId` only.
 */
export interface AudioCapableApplication {
  pid: number;
  bundleId: string;
  name: string;
}

export type NativeCapabilities = NativeAudioCapabilities;

export interface NativePermissionSnapshot {
  screen: ScreenPermissionStatus;
  microphone: ScreenPermissionStatus;
  inputMonitoring: ScreenPermissionStatus;
  accessibility: ScreenPermissionStatus;
}

export interface NativeAudioDevice {
  id: number;
  uid: string;
  name: string;
  kind: 'input' | 'output';
  isDefault: boolean;
  isVirtual: boolean;
  isAlive: boolean;
  sampleRate: number;
  channels: number;
}

export interface NativeAudioRouteDiagnostics {
  level: number;
  lastPcmAt: number;
  silenceMs: number;
  queuedSamples: number;
  ringSamples: number;
  droppedSamples: number;
  /** TTS route only: passthrough jitter-buffer underruns since unit creation. */
  underruns?: number;
  routeStatus: string;
  lastError: string;
}

export interface NativeAudioDiagnostics {
  mic: NativeAudioRouteDiagnostics;
  listen: NativeAudioRouteDiagnostics;
  tts: NativeAudioRouteDiagnostics;
}

export interface NativeWindowBehavior {
  alwaysOnTop?: boolean;
  visibleOnAllSpaces?: boolean;
  visibleOnFullScreen?: boolean;
  ignoresMouseEvents?: boolean;
}

export interface ScreenPermissionRequestResult {
  /** Status before triggering the system prompt — useful for diagnostics. */
  statusBefore: ScreenPermissionStatus;
  /** Status after the TCC prompt resolved (or after the call returned). */
  statusAfter: ScreenPermissionStatus;
  /** Number of sources returned (0 means the user denied or TCC blocked). */
  sourceCount: number;
  /** Hint string for the UI when the prompt didn't appear. */
  hint?: string;
  /** Underlying error message if desktopCapturer.getSources threw. */
  error?: string;
}
