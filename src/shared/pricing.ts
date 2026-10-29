import { isEngineId, type EngineId } from './engine-types.js';
import {
  PRICE_CURRENCIES,
  TOKEN_CATEGORIES,
  type PriceCurrency,
  type PriceSheet
} from './meeting-metrics-types.js';

/** A built-in price, with where it came from so the UI can cite it. */
export interface DefaultPriceSheet extends PriceSheet {
  /** Official pricing page the numbers were taken from. */
  source: string;
  /** When they were checked (YYYY-MM-DD). */
  asOf: string;
}

/**
 * Official list prices, prefilled so a meeting's cost shows without setup.
 * The user can override any engine in Settings (`prefs.pricing`); the
 * settings copy (`settings:pricing.notes.<engine>`) carries each one's
 * caveats. An engine missing here is unpriced: usage still shows, cost
 * doesn't.
 */
export const DEFAULT_PRICE_SHEETS: Partial<Record<EngineId, DefaultPriceSheet>> = {
  // 同声传译 2.0, pay-as-you-go list price. "Input" is one price for audio
  // and text; resource packs bring it down to 40–56.
  doubao: {
    currency: 'CNY',
    perMillionTokens: { inputAudio: 80, inputText: 80, outputText: 80, outputAudio: 300 },
    source: 'https://docs.volcengine.com/docs/DoubaoVoice/Billinginstructions-21',
    asOf: '2026-10-21'
  },
  // qwen3.8-livetranslate-flash-realtime, 华北2（北京）. Input text has no
  // listed price, but the usage reports it: counted as free.
  qwen: {
    currency: 'CNY',
    perMillionTokens: { inputAudio: 40, inputText: 0, outputText: 100, outputAudio: 160 },
    source: 'https://help.aliyun.com/zh/model-studio/model-pricing',
    asOf: '2026-10-21'
  },
  // gemini-3.5-live-translate-preview, Standard tier. Billed on audio tokens
  // only (25/s each way); GeminiClient estimates them from duration.
  gemini: {
    currency: 'USD',
    perMillionTokens: { inputAudio: 3.5, outputAudio: 21 },
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    asOf: '2026-10-21'
  },
  // gpt-realtime-translate $0.034/min + gpt-realtime-whisper (the source
  // transcript, always on) $0.017/min, per minute of audio streamed.
  openai: {
    currency: 'USD',
    perMillionTokens: {},
    perAudioMinute: 0.051,
    source: 'https://developers.openai.com/api/docs/pricing',
    asOf: '2026-10-21'
  }
};

export type PricingOverrides = Partial<Record<EngineId, PriceSheet>>;

/** The price in force for `engineId`: the user's override, else the default. */
export const resolvePriceSheet = (
  engineId: EngineId,
  overrides: PricingOverrides | undefined
): PriceSheet | null => overrides?.[engineId] ?? DEFAULT_PRICE_SHEETS[engineId] ?? null;

const isCurrency = (v: unknown): v is PriceCurrency =>
  (PRICE_CURRENCIES as readonly unknown[]).includes(v);

const isPrice = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A well-formed PriceSheet from untrusted input (IPC, a stored file), or null. */
export const sanitizePriceSheet = (v: unknown): PriceSheet | null => {
  if (!v || typeof v !== 'object') return null;
  const raw = v as Record<string, unknown>;
  if (!isCurrency(raw.currency)) return null;
  const perMillionTokens: PriceSheet['perMillionTokens'] = {};
  const tokens = raw.perMillionTokens;
  if (tokens && typeof tokens === 'object') {
    for (const cat of TOKEN_CATEGORIES) {
      const price = (tokens as Record<string, unknown>)[cat];
      if (isPrice(price)) perMillionTokens[cat] = price;
    }
  }
  const sheet: PriceSheet = { currency: raw.currency, perMillionTokens };
  if (isPrice(raw.perAudioMinute)) sheet.perAudioMinute = raw.perAudioMinute;
  return sheet;
};

/** Keep only known engines with well-formed sheets; undefined when none survive. */
export const sanitizePricing = (v: unknown): PricingOverrides | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const out: PricingOverrides = {};
  for (const [engineId, sheet] of Object.entries(v)) {
    if (!isEngineId(engineId)) continue;
    const clean = sanitizePriceSheet(sheet);
    if (clean) out[engineId] = clean;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};
