import Store from 'electron-store';
import type {
  PersistedConfig,
  UserPreferences
} from '@shared/config-types.js';
import {
  DEFAULT_PREFERENCES,
  SUBTITLE_HISTORY_LIMITS,
  SUBTITLE_LAYOUTS,
  SUBTITLE_LIVE_LINES_MAX,
  SUBTITLE_LIVE_LINES_MIN
} from '@shared/config-types.js';
import type { SpeakerVoice } from '@shared/engine-types.js';
import {
  DEFAULT_ENGINE_CONFIGS,
  isEngineId,
  isQwenVoice
} from '@shared/engine-types.js';
import { sanitizePricing } from '@shared/pricing.js';
import { log } from '@core/utils/logger.js';

const store = new Store<PersistedConfig>({
  name: 'babelvoice',
  defaults: {
    preferences: DEFAULT_PREFERENCES
  }
});

// One-shot migration of legacy preferences. Add new branches as defaults
// evolve so that returning users get sane behaviour without having to wipe
// their config dir.
type LegacyPreferences = UserPreferences & {
  preferredMicrophoneDeviceId?: string;
  speakerVoice?: SpeakerVoice;
};

const migratePreferences = (): void => {
  const stored = store.get('preferences') as LegacyPreferences | undefined;
  if (!stored) return;
  let changed = false;
  const next: LegacyPreferences = { ...stored };
  if (stored.hotkey === 'F19') {
    next.hotkey = DEFAULT_PREFERENCES.hotkey;
    changed = true;
  }
  // Slice 4 of the DirectionSession refactor (ADR-0001) deleted the browser
  // microphone path; the mic preference now stores a CoreAudio UID rather
  // than a Chromium MediaDeviceInfo hash. Drop the legacy key so it can't
  // accidentally be passed to the native bridge.
  if ('preferredMicrophoneDeviceId' in stored) {
    delete next.preferredMicrophoneDeviceId;
    changed = true;
  }
  // Candidate #2 (ADR-0002 follow-up): per-engine user config moved into
  // `engineConfigs`. Old top-level `speakerVoice` was Doubao-only.
  if ('speakerVoice' in stored && stored.speakerVoice) {
    next.engineConfigs = {
      ...DEFAULT_ENGINE_CONFIGS,
      ...next.engineConfigs,
      doubao: {
        ...DEFAULT_ENGINE_CONFIGS.doubao,
        speakerVoice: stored.speakerVoice
      }
    };
    delete next.speakerVoice;
    changed = true;
  }
  if (!stored.engineConfigs) {
    next.engineConfigs = DEFAULT_ENGINE_CONFIGS;
    changed = true;
  }
  if (changed) {
    store.set('preferences', next as UserPreferences);
    log.info('migrated preferences:', next);
  }
};
migratePreferences();

// Drop credential ciphertext left by an older storage format; keys now live
// per engine under `credentials` (credential-vault).
const legacyCipher = (store as unknown as {
  get: (k: string) => unknown;
  delete: (k: string) => void;
}).get('credentialsCipher');
if (legacyCipher) {
  (store as unknown as { delete: (k: string) => void }).delete(
    'credentialsCipher'
  );
  log.info('cleared legacy user-entered credentials');
}

/**
 * electron-store re-reads and re-parses the JSON file on every `get`, and
 * PreferencesSet calls getPreferences several times per slider tick — so
 * keep the normalized value in memory. This module is the only writer.
 */
let cached: UserPreferences | null = null;

const normalize = (stored: UserPreferences): UserPreferences => {
  const storedQwen = stored.engineConfigs?.qwen;
  return {
    ...DEFAULT_PREFERENCES,
    ...stored,
    engineId: isEngineId(stored.engineId)
      ? stored.engineId
      : DEFAULT_PREFERENCES.engineId,
    pricing: sanitizePricing(stored.pricing),
    // Overlay layout knobs: a value from a newer build (or a hand-edited
    // config) falls back instead of breaking the overlay.
    subtitleLayout: SUBTITLE_LAYOUTS.includes(stored.subtitleLayout)
      ? stored.subtitleLayout
      : DEFAULT_PREFERENCES.subtitleLayout,
    subtitleLiveLines:
      Number.isInteger(stored.subtitleLiveLines) &&
      stored.subtitleLiveLines >= SUBTITLE_LIVE_LINES_MIN &&
      stored.subtitleLiveLines <= SUBTITLE_LIVE_LINES_MAX
        ? stored.subtitleLiveLines
        : DEFAULT_PREFERENCES.subtitleLiveLines,
    subtitleHistoryLimit: SUBTITLE_HISTORY_LIMITS.includes(stored.subtitleHistoryLimit)
      ? stored.subtitleHistoryLimit
      : DEFAULT_PREFERENCES.subtitleHistoryLimit,
    subtitleShowSource:
      typeof stored.subtitleShowSource === 'boolean'
        ? stored.subtitleShowSource
        : DEFAULT_PREFERENCES.subtitleShowSource,
    // Deep-merge engineConfigs so newly-introduced engine slots (e.g. `qwen`)
    // and newly-introduced sub-fields (e.g. doubao.glossary/hotWords/correctWords)
    // get default values for users whose stored prefs predate them. Without
    // this, `engineConfigs.qwen` would be undefined and engine-selection
    // would crash on `prefs.engineConfigs.qwen.voice`; same applies to corpus
    // fields read by buildClientStartParams.
    engineConfigs: {
      ...DEFAULT_ENGINE_CONFIGS,
      ...stored.engineConfigs,
      doubao: {
        ...DEFAULT_ENGINE_CONFIGS.doubao,
        ...stored.engineConfigs?.doubao
      },
      // qwen3 voices (Cherry, Nofish, …) are rejected by qwen3.8; stored
      // prefs may still carry one, so fall back to the default.
      qwen:
        storedQwen && isQwenVoice(storedQwen.voice)
          ? storedQwen
          : DEFAULT_ENGINE_CONFIGS.qwen
    }
  };
};

export const getPreferences = (): UserPreferences => {
  cached ??= normalize(store.get('preferences', DEFAULT_PREFERENCES));
  // Callers may mutate what they get back; never hand out the cache itself.
  return structuredClone(cached);
};

export const setPreferences = (prefs: Partial<UserPreferences>): void => {
  const next = { ...getPreferences(), ...prefs };
  store.set('preferences', next);
  cached = normalize(next);
};
