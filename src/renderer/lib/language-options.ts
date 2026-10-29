import type { SupportedLanguage } from '@shared/config-types.js';
import {
  QWEN_PRESET_VOICES,
  type QwenVoice,
  type SpeakerVoice
} from '@shared/engine-types.js';

/**
 * Picker catalogs. User-facing copy lives in the `languages` namespace:
 * language names under `names.<value>`, voices under `<i18nKey>.label` /
 * `<i18nKey>.hint`.
 */
export const LANGUAGE_OPTIONS: { value: SupportedLanguage; i18nKey: string }[] = (
  ['zh', 'en', 'ja', 'id', 'es', 'pt', 'de', 'fr'] as const
).map((value) => ({ value, i18nKey: `names.${value}` }));

export const SPEAKER_OPTIONS: { value: SpeakerVoice; i18nKey: string }[] = [
  { value: 'clone', i18nKey: 'voices.doubao.clone' },
  { value: 'zh_female_vv_uranus_bigtts', i18nKey: 'voices.doubao.femaleNatural' },
  { value: 'zh_male_jingqiangkanye_emo_mars_bigtts', i18nKey: 'voices.doubao.maleNatural' }
];

export const QWEN_VOICE_OPTIONS: { value: QwenVoice; i18nKey: string }[] = (
  ['clone', ...QWEN_PRESET_VOICES] as const
).map((value) => ({ value, i18nKey: `voices.qwen.${value}` }));

/**
 * Per the API doc: "非中英互译源语言与目标语言其中之一必须为中文或英文".
 * In other words: at most one side may be a non-zh/en language.
 */
export const isPivot = (l: SupportedLanguage): boolean => l === 'zh' || l === 'en';

export const isOptionDisabled = (
  candidate: SupportedLanguage,
  otherSide: SupportedLanguage
): boolean => {
  if (!isPivot(candidate) && !isPivot(otherSide)) return true;
  return false;
};

export interface LanguagePair {
  mine: SupportedLanguage;
  other: SupportedLanguage;
}

/**
 * Resolve a pick on one side into a pair that is safe to persist. Picking
 * the language the other side already has swaps the two sides (a src === tgt
 * pair would otherwise be saved and could start a meeting). If the stored
 * pair was already degenerate, or the pick would leave no pivot language,
 * the other side falls back to a pivot.
 */
export const resolveLanguagePick = (
  side: keyof LanguagePair,
  picked: SupportedLanguage,
  current: LanguagePair
): LanguagePair => {
  const otherSide: keyof LanguagePair = side === 'mine' ? 'other' : 'mine';
  let counterpart = current[otherSide];
  if (counterpart === picked) counterpart = current[side];
  if (counterpart === picked || isOptionDisabled(picked, counterpart)) {
    counterpart = picked === 'zh' ? 'en' : 'zh';
  }
  return side === 'mine'
    ? { mine: picked, other: counterpart }
    : { mine: counterpart, other: picked };
};
