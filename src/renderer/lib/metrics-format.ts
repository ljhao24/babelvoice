import type { MeetingUsageLine, PriceCurrency } from '@shared/meeting-metrics-types.js';

/** 940 · 12.4k · 1.23M — token counts at a glance. */
export const formatTokens = (n: number): string => {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 2 : 1).replace(/\.?0+$/, '')}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
};

/** 0:42 · 12:05 · 1:02:09 */
export const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

const CURRENCY_SYMBOL: Record<PriceCurrency, string> = { CNY: '¥', USD: '$' };

/**
 * ¥0.42 · $0.0031 — enough digits that a short meeting's cost isn't shown
 * as zero, without pretending to more precision than an estimate has.
 */
export const formatCost = (amount: number, currency: PriceCurrency): string => {
  const digits = amount === 0 ? 2 : amount < 0.01 ? 4 : amount < 1 ? 3 : 2;
  return `${CURRENCY_SYMBOL[currency]}${amount.toFixed(digits)}`;
};

/** Stored usage lines' cost, per currency; `incomplete` if any line undercounts. */
export const costTotalsOf = (
  lines: readonly MeetingUsageLine[]
): { totals: Partial<Record<PriceCurrency, number>>; incomplete: boolean } => {
  const totals: Partial<Record<PriceCurrency, number>> = {};
  let incomplete = false;
  for (const { cost } of lines) {
    if (!cost) continue;
    totals[cost.currency] = (totals[cost.currency] ?? 0) + cost.amount;
    if (!cost.complete) incomplete = true;
  }
  return { totals, incomplete };
};
