/**
 * Engine identity + provider-specific config types. Owned in shared so
 * both main (which mints TranslationClients via client-factory) and
 * renderer (which renders per-engine settings UI) agree on the shapes.
 *
 * Adding a provider:
 *   1. add the id to ENGINE_IDS
 *   2. add a *EngineConfig interface here
 *   3. add the slot to EngineConfigs (required if the engine has user-tunable
 *      params; absent otherwise — mock has no config and is intentionally not
 *      a key here)
 *   4. add a case in src/main/translation/client-factory.ts
 *   5. add the displayName entry in src/renderer/engines/factory.ts
 */
export const ENGINE_IDS = ['doubao', 'qwen', 'gemini', 'openai', 'mock'] as const;

export type EngineId = (typeof ENGINE_IDS)[number];

/**
 * Persisted prefs can carry an engine this build doesn't know (written by a
 * newer version), so validate before trusting a stored `engineId`.
 */
export const isEngineId = (v: unknown): v is EngineId =>
  (ENGINE_IDS as readonly unknown[]).includes(v);

/** Engines backed by a real provider — i.e. the ones that need user credentials. */
export type CredentialedEngineId = Exclude<EngineId, 'mock'>;

/**
 * Seed value for `DEFAULT_PREFERENCES.engineId` and the engine to fall back
 * to when stored prefs are missing. Historically also force-overrode the
 * runtime engine in packaged builds (see ADR-0002 commit `d2734a3`); that
 * gate has since been lifted now that Settings exposes a user-facing engine
 * switcher — see ADR-0002 amendment.
 */
export const PRODUCTION_ENGINE: EngineId = 'doubao';

/**
 * `clone` (default): no `speaker_id` is sent, so the server clones the input
 * speaker's voice into the target language. The two preset voices are the
 * "premium" speakers documented by the API; both are zh-flavored TTS models
 * that also produce intelligible English/JA/etc output.
 */
export type SpeakerVoice =
  | 'clone'
  | 'zh_female_vv_uranus_bigtts'
  | 'zh_male_jingqiangkanye_emo_mars_bigtts';

export interface DoubaoEngineConfig {
  speakerVoice: SpeakerVoice;
  /**
   * 自定义术语：原文→译文映射，写入 `corpus.glossary_list`。引导模型按你的
   * 写法翻译专有名词。空对象表示不发该字段。
   */
  glossary: Record<string, string>;
  /**
   * 识别热词，写入 `corpus.hot_words_list`。空数组表示不发该字段。
   */
  hotWords: string[];
  /**
   * 替换词：find→replace。落盘是 dict，发到 API 时 JSON.stringify 成
   * `corpus.correct_words`（API 文档明确要求 JSON 字符串形态）。
   */
  correctWords: Record<string, string>;
}

/**
 * Preset TTS voices of qwen3.8-livetranslate-flash-realtime (the realtime
 * 3.8 / 3.5 table of the DashScope voice list). Each speaks Mandarin (Cindy
 * with a Taiwanese accent) + 28 foreign languages. A curated subset — the
 * full table also has character voices that don't suit meetings. The
 * qwen3 voices (Cherry, Nofish, …) are not valid on 3.8.
 */
export const QWEN_PRESET_VOICES = [
  'Tina',
  'Serena',
  'Maia',
  'Cindy',
  'Jennifer',
  'Ethan',
  'Raymond',
  'Andre',
  'Harvey',
  'Aiden'
] as const;

export type QwenPresetVoice = (typeof QWEN_PRESET_VOICES)[number];

/**
 * `clone`: no preset; the server clones the input speaker's voice
 * (`enable_voice_clone`). Otherwise one of the preset voices.
 */
export type QwenVoice = 'clone' | QwenPresetVoice;

/** Narrows stored values, which may predate the 3.8 voices. */
export const isQwenVoice = (v: unknown): v is QwenVoice =>
  v === 'clone' || (QWEN_PRESET_VOICES as readonly unknown[]).includes(v);

export interface QwenEngineConfig {
  voice: QwenVoice;
}

/**
 * User-tunable per-engine settings. Engines without user-tunable params
 * (e.g. `mock`) are intentionally absent from this shape.
 */
export interface EngineConfigs {
  doubao: DoubaoEngineConfig;
  qwen: QwenEngineConfig;
}

export const DEFAULT_ENGINE_CONFIGS: EngineConfigs = {
  doubao: {
    speakerVoice: 'clone',
    glossary: {},
    hotWords: [],
    correctWords: {}
  },
  qwen: { voice: 'Tina' }
};

/**
 * Renderer-safe view of stored credentials. The plaintext keys never leave
 * the main process; only `configured` flags + the last 4 chars of the
 * primary key (for visual confirmation) are forwarded over IPC.
 */
export interface CredentialStatus {
  doubao: { configured: boolean; appKeyTail?: string };
  /** `workspaceId` is not a secret (it's part of a hostname), so it's shown in full. */
  qwen: { configured: boolean; apiKeyTail?: string; workspaceId?: string };
  gemini: { configured: boolean; apiKeyTail?: string };
  openai: { configured: boolean; apiKeyTail?: string };
}

export const EMPTY_CREDENTIAL_STATUS: CredentialStatus = {
  doubao: { configured: false },
  qwen: { configured: false },
  gemini: { configured: false },
  openai: { configured: false }
};

/** True when `engineId` can start a session with the stored credentials. */
export const isEngineConfigured = (
  status: CredentialStatus,
  engineId: EngineId
): boolean => (engineId === 'mock' ? true : status[engineId].configured);
