import type { Direction } from './ipc-types.js';
import type { EngineId } from './engine-types.js';

/**
 * Per-meeting monitoring: link health of each Direction's provider
 * connection, the tokens the providers report, and what that is estimated
 * to cost. Main measures and aggregates (MeetingMonitor); the renderer only
 * displays snapshots.
 */

/** Billable token categories, normalized across providers. */
export const TOKEN_CATEGORIES = [
  'inputAudio',
  'inputText',
  'cachedInput',
  'outputText',
  'outputAudio'
] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];
export type TokenCounts = Partial<Record<TokenCategory, number>>;

export const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => {
  const out: TokenCounts = { ...a };
  for (const cat of TOKEN_CATEGORIES) {
    const n = b[cat];
    if (n) out[cat] = (out[cat] ?? 0) + n;
  }
  return out;
};

export const totalTokens = (t: TokenCounts): number =>
  TOKEN_CATEGORIES.reduce((sum, cat) => sum + (t[cat] ?? 0), 0);

export const PRICE_CURRENCIES = ['CNY', 'USD'] as const;
export type PriceCurrency = (typeof PRICE_CURRENCIES)[number];

/** What one engine charges. Every price is optional: unpriced is not free. */
export interface PriceSheet {
  currency: PriceCurrency;
  /** Price per 1M tokens, per category. */
  perMillionTokens: Partial<Record<TokenCategory, number>>;
  /** Price per minute of uplink audio, for duration-billed models. */
  perAudioMinute?: number;
}

export interface CostEstimate {
  amount: number;
  currency: PriceCurrency;
  /**
   * False when some usage had no price (a category with tokens but no
   * per-token price): `amount` then undercounts.
   */
  complete: boolean;
}

/** Estimated cost of `tokens` + `audioInMs` under `sheet`; null when unpriced. */
export const estimateCost = (
  tokens: TokenCounts,
  audioInMs: number,
  sheet: PriceSheet | null | undefined
): CostEstimate | null => {
  if (!sheet) return null;
  let amount = 0;
  let priced = false;
  let complete = true;
  for (const cat of TOKEN_CATEGORIES) {
    const n = tokens[cat] ?? 0;
    if (n <= 0) continue;
    const price = sheet.perMillionTokens[cat];
    if (price === undefined) {
      complete = false;
      continue;
    }
    amount += (n / 1_000_000) * price;
    priced = true;
  }
  if (sheet.perAudioMinute !== undefined) {
    amount += (audioInMs / 60_000) * sheet.perAudioMinute;
    priced = true;
  }
  if (!priced && totalTokens(tokens) > 0) return null;
  return { amount, currency: sheet.currency, complete };
};

/**
 * Where one Direction's provider link stands. `live`: the provider is
 * ready and audio flows; `reconnecting`: the link dropped mid-session and a
 * replacement is on its way.
 */
export type LinkState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'finishing'
  | 'failed';

export interface DirectionLinkSnapshot {
  direction: Direction;
  engineId: EngineId;
  state: LinkState;
  /** When `state` was entered (epoch ms). */
  since: number;
  /** WebSocket upgrade, start → open, of the latest connection. */
  handshakeMs: number | null;
  /** Open → the provider's ready event, of the latest connection. */
  readyMs: number | null;
  /** Latest keepalive ping → pong round trip. */
  rttMs: number | null;
  /** Last event received from the provider (epoch ms). */
  lastRxAt: number | null;
}

/** Usage of one engine in one Direction over a meeting. */
export interface MeetingUsageLine {
  engineId: EngineId;
  direction: Direction;
  tokens: TokenCounts;
  /**
   * Some of `tokens` were derived from audio duration rather than reported
   * by the provider (Gemini), so they are an estimate too.
   */
  estimated: boolean;
  /** Uplink audio sent to the provider. */
  audioInMs: number;
  /** TTS audio received back. */
  audioOutMs: number;
  sessions: number;
  reconnects: number;
  failures: number;
  /** Estimated with the prices in force when last updated; null = unpriced. */
  cost: CostEstimate | null;
}

export interface MeetingMetricsSnapshot {
  meetingId: string;
  links: Partial<Record<Direction, DirectionLinkSnapshot>>;
  usage: MeetingUsageLine[];
  /** Per currency: a meeting can mix providers billed in CNY and USD. */
  costTotals: Partial<Record<PriceCurrency, number>>;
  /** Some priced usage had categories without a price. */
  costIncomplete: boolean;
  updatedAt: number;
}

export const METRICS_IPC = {
  /** Pull the current meeting's snapshot (null outside a meeting). */
  Get: 'meeting-metrics:get',
  /** Main → control window, throttled while a meeting runs. */
  Changed: 'meeting-metrics:changed',
  /** A finished meeting's stored usage (replay / history). */
  Usage: 'meeting-metrics:usage'
} as const;
