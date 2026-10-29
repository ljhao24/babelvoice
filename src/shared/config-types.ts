import type { EngineConfigs, EngineId } from './engine-types.js';
import type { PricingOverrides } from './pricing.js';
import { DEFAULT_ENGINE_CONFIGS } from './engine-types.js';

/**
 * The 8 simultaneous-translation languages Doubao LiveInterpret 2.0 supports
 * (excluding `zhen` mixed-language mode, which has special pairing rules).
 *
 * Per the API doc: for any non-zhen pair, at least one of source or target
 * MUST be `zh` or `en`. We don't enforce that in the type system — the
 * settings UI presents all combinations and the server rejects invalid pairs
 * with status 45000001.
 */
export type SupportedLanguage =
  | 'zh'
  | 'en'
  | 'ja'
  | 'id'
  | 'es'
  | 'pt'
  | 'de'
  | 'fr';

/**
 * Background chrome for the floating subtitle overlay.
 *  - glass:       frosted card (`backdrop-filter` blur)
 *  - solid:       opaque dark surface, no blur
 *  - transparent: no chrome at all, text floats on top of the desktop
 */
export type SubtitleBackground = 'glass' | 'solid' | 'transparent';

/**
 * How the overlay lays out two running Directions:
 *  - timeline: one chronological history, both Directions interleaved
 *  - split:    a column per Direction
 * With one Direction both look the same.
 */
export type SubtitleLayout = 'timeline' | 'split';
export const SUBTITLE_LAYOUTS: readonly SubtitleLayout[] = ['timeline', 'split'];

/** Bounds for `subtitleLiveLines`. */
export const SUBTITLE_LIVE_LINES_MIN = 1;
export const SUBTITLE_LIVE_LINES_MAX = 4;
/** Choices for `subtitleHistoryLimit`. */
export const SUBTITLE_HISTORY_LIMITS: readonly number[] = [20, 50, 100, 200];

/**
 * Application color theme for the control panel window.
 *  - system: follow the OS `prefers-color-scheme` setting (default).
 *  - light:  force the warm cream / dark-text variant.
 *  - dark:   force the original near-black variant.
 *
 * Only the control panel respects this — the floating subtitle overlay is
 * pinned to the dark variant since it sits on top of unknown screen content.
 */
export type AppTheme = 'system' | 'light' | 'dark';

export interface UserPreferences {
  hotkey: string;
  preferredOutputDeviceId?: string;
  /**
   * CoreAudio device UID for the speak microphone (e.g. AppleHDAEngineInput
   * UIDs). Empty/undefined means "use system default input". Replaces the
   * legacy `preferredMicrophoneDeviceId` (Chromium hash) — old values are
   * dropped at load time by config-store.
   */
  preferredMicrophoneUid?: string;
  showSubtitleOverlay: boolean;
  /** Subtitle window chrome — see SubtitleBackground. */
  subtitleBackground: SubtitleBackground;
  /** Background opacity in 0–100 (ignored for `transparent`). */
  subtitleOpacity: number;
  /** Translation text size in px (16–48). The source partial scales from this. */
  subtitleFontSize: number;
  /** Whether the rolling history list is visible inside the overlay. */
  subtitleShowHistory: boolean;
  /** Two-Direction layout — see SubtitleLayout. */
  subtitleLayout: SubtitleLayout;
  /** Show the source text under each translation (history and live). */
  subtitleShowSource: boolean;
  /**
   * Lines the live translation may take; a longer sentence shows its tail
   * (the newest words) instead of pushing everything else out.
   */
  subtitleLiveLines: number;
  /** Committed sentences the overlay keeps for scroll-back. */
  subtitleHistoryLimit: number;
  /** Color theme for the control panel window. See AppTheme. */
  theme: AppTheme;
  /**
   * Authoritative *only* in dev builds. Production builds route to
   * `PRODUCTION_ENGINE` regardless — `getActiveEngineId()` enforces it.
   */
  engineId: EngineId;

  /**
   * The language you speak when pressing PTT. The speak session uses
   * `mySpokenLanguage → meetingLanguage`; the listen session uses the inverse
   * (`meetingLanguage → mySpokenLanguage`). Single source of truth, two
   * derived directions.
   */
  mySpokenLanguage: SupportedLanguage;
  /** The language the other party speaks in the meeting. */
  meetingLanguage: SupportedLanguage;
  /** Per-engine user-tunable settings. See engine-types.ts. */
  engineConfigs: EngineConfigs;
  /**
   * Listen mode: when true, request `s2s` so the provider also returns TTS PCM
   * for the translation, played locally through `useTtsMonitor` (which targets
   * `preferredOutputDeviceId` and skips virtual devices). The main-side sink
   * for listen direction stays a no-op, so the translated audio never reaches
   * BabelVoice — i.e. the meeting peer does not hear it back.
   *
   * False (default) keeps the historic listen behavior: subtitles only.
   *
   * Only takes effect together with `listenSourceAppBundleId` (see
   * `isListenPlaybackActive`): the locally-played TTS would otherwise feed
   * back into the full-screen system loopback and re-translate forever, so
   * `true` without a source app simply means subtitles only.
   */
  listenModePlayTts: boolean;
  /**
   * Bundle ID of the meeting app whose audio output the listen direction taps
   * (macOS 14.4+ Core Audio Process Tap; e.g. `us.zoom.xos`,
   * `com.tencent.meeting`, `com.microsoft.teams2`). When unset, the listen
   * direction falls back to the historic ScreenCaptureKit full-screen capture.
   * Independent of `listenModePlayTts`: subtitles-only listening can tap a
   * single app too, but playback requires one.
   */
  listenSourceAppBundleId?: string;
  /**
   * Timestamp (ms) marking the moment the user finished the first-run
   * onboarding wizard. `undefined` means the wizard has not been completed
   * — `ControlPanel` gates on this and routes new users into
   * `OnboardingSection`. Reset to `undefined` from Settings to re-run the
   * wizard (e.g. after wiping creds or training a new operator).
   */
  setupCompletedAt?: number;
  /**
   * When true and no translation session is running, the app keeps the
   * microphone open and tees raw mic audio into the BabelVoice virtual
   * output device. This lets meeting attendees who don't need translation
   * (e.g. a fluent English speaker in a zh→en meeting) be heard without
   * making them switch the meeting app's input device on the fly.
   *
   * Mutually exclusive with active translation: each `TranslationStart`
   * suspends passthrough, each session termination resumes it. Runs only
   * while a meeting is open; ending the meeting releases the mic. Default
   * `false` to preserve existing behaviour for users who haven't opted in.
   */
  micPassthroughWhenIdle: boolean;
  /**
   * The user's own prices per engine, for the meeting cost estimate; an
   * engine without one uses the built-in list price (DEFAULT_PRICE_SHEETS).
   */
  pricing?: PricingOverrides;
}

export interface PersistedConfig {
  preferences: UserPreferences;
  /**
   * Per-engine credentials. Each value is an opaque base64 ciphertext
   * produced by Electron's `safeStorage.encryptString`; the plaintext
   * shape lives in main only (`*-credentials.ts`). Absent until the
   * user enters a key in Settings — see ADR-0002 amendment.
   */
  credentials?: {
    doubao?: string;
    qwen?: string;
    gemini?: string;
    openai?: string;
  };
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  // Native macOS hotkey capture supports key down/up for true PTT. Option+Space
  // remains the default because it is discoverable and unlikely to collide.
  hotkey: 'Alt+Space',
  showSubtitleOverlay: true,
  subtitleBackground: 'glass',
  subtitleOpacity: 72,
  subtitleFontSize: 22,
  subtitleShowHistory: true,
  subtitleLayout: 'timeline',
  subtitleShowSource: true,
  subtitleLiveLines: 2,
  subtitleHistoryLimit: 50,
  theme: 'system',
  engineId: 'doubao',
  mySpokenLanguage: 'zh',
  meetingLanguage: 'en',
  engineConfigs: DEFAULT_ENGINE_CONFIGS,
  listenModePlayTts: false,
  micPassthroughWhenIdle: false
};

/**
 * Whether listen mode should request and play TTS: the user wants playback
 * and a source app is tapped, so our own playback can't loop back in.
 */
export const isListenPlaybackActive = (
  prefs: Pick<UserPreferences, 'listenModePlayTts' | 'listenSourceAppBundleId'>
): boolean => prefs.listenModePlayTts && !!prefs.listenSourceAppBundleId;
