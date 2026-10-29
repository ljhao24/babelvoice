/**
 * Resolves "which engine should this session run on" and packs the
 * provider-tagged params for that engine. Reads `prefs.engineId` in both
 * dev and packaged builds — Settings exposes a user-facing engine
 * switcher, so the historical packaged-build hard-pin to
 * `PRODUCTION_ENGINE` (commit `d2734a3`, ADR-0002) has been lifted.
 * `PRODUCTION_ENGINE` survives as the seed value for
 * `DEFAULT_PREFERENCES.engineId`. See ADR-0002 amendment.
 */
import type { StartTranslationParams } from '@shared/ipc-types.js';
import {
  PRODUCTION_ENGINE,
  isEngineId,
  type EngineId
} from '@shared/engine-types.js';
import { log } from '@core/utils/logger.js';
import { getPreferences } from '../config-store.js';
import type { CorpusInput } from './doubao-codec.js';
import type { ClientStartParams } from './translation-client.js';

/** Last unknown id warned about, so a stale pref doesn't warn every call. */
let warnedEngineId: unknown;

/**
 * `prefs.engineId` may name an engine this build doesn't have (written by a
 * newer build, or a hand-edited config). Run on the default engine instead
 * of crashing every session start (the renderer still shows the stored
 * value).
 */
export const getActiveEngineId = (): EngineId => {
  const stored: unknown = getPreferences().engineId;
  if (isEngineId(stored)) return stored;
  if (stored !== warnedEngineId) {
    warnedEngineId = stored;
    log.warn(
      `unknown engineId ${JSON.stringify(stored)} in preferences; falling back to ${PRODUCTION_ENGINE}`
    );
  }
  return PRODUCTION_ENGINE;
};

/**
 * Build the engine-tagged params a TranslationClient consumes. Per-engine
 * knobs (speakerId for Doubao; voice / voice cloning for Qwen) come from
 * `prefs.engineConfigs[engineId]`. The renderer never sends these — the
 * IPC envelope carries only the universal translation intent.
 */
export const buildClientStartParams = (
  envelope: StartTranslationParams,
  engineId: EngineId
): ClientStartParams => {
  const base = {
    sourceLanguage: envelope.sourceLanguage,
    targetLanguage: envelope.targetLanguage,
    mode: envelope.mode
  };
  switch (engineId) {
    case 'doubao': {
      const cfg = getPreferences().engineConfigs.doubao;
      const voice = cfg.speakerVoice;
      // Translation tuning: glossary / hot words / replacements.
      const corpus: CorpusInput = {};
      if (Object.keys(cfg.glossary).length > 0) {
        corpus.glossary_list = cfg.glossary;
      }
      if (cfg.hotWords.length > 0) {
        corpus.hot_words_list = cfg.hotWords;
      }
      if (Object.keys(cfg.correctWords).length > 0) {
        corpus.correct_words = JSON.stringify(cfg.correctWords);
      }
      return {
        engineId: 'doubao',
        ...base,
        speakerId: voice === 'clone' ? undefined : voice,
        ...(Object.keys(corpus).length > 0 ? { corpus } : {})
        // Future: speechRate / denoise also resolved from prefs here.
      };
    }
    case 'qwen': {
      const voice = getPreferences().engineConfigs.qwen.voice;
      if (voice === 'clone') {
        // Speak is one speaker (you): clone once. Listen hears everyone in
        // the meeting: re-clone per output so the voice follows the speaker.
        return {
          engineId: 'qwen',
          ...base,
          voiceClone: envelope.direction === 'speak' ? 'once' : 'always'
        };
      }
      return { engineId: 'qwen', ...base, voice };
    }
    case 'gemini':
      return { engineId: 'gemini', ...base };
    case 'openai':
      return { engineId: 'openai', ...base };
    case 'mock':
      return { engineId: 'mock', ...base };
    default:
      // Unreachable for typed callers; see createTranslationClient.
      throw new Error(`Unknown translation engine: ${String(engineId)}`);
  }
};
