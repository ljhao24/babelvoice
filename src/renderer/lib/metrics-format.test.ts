import { describe, expect, it } from 'vitest';
import { costTotalsOf, formatCost, formatDuration, formatTokens } from './metrics-format.js';

describe('formatTokens', () => {
  it('abbreviates thousands and millions', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(940)).toBe('940');
    expect(formatTokens(1_240)).toBe('1.24k');
    expect(formatTokens(15_620)).toBe('15.6k');
    expect(formatTokens(20_000)).toBe('20k');
    expect(formatTokens(1_234_567)).toBe('1.23M');
  });
});

describe('formatDuration', () => {
  it('uses m:ss, and h:mm:ss past an hour', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(42_900)).toBe('0:42');
    expect(formatDuration(725_000)).toBe('12:05');
    expect(formatDuration(3_729_000)).toBe('1:02:09');
  });
});

describe('formatCost', () => {
  it('keeps small amounts visible', () => {
    expect(formatCost(0, 'CNY')).toBe('¥0.00');
    expect(formatCost(0.0031, 'USD')).toBe('$0.0031');
    expect(formatCost(0.42, 'CNY')).toBe('¥0.420');
    expect(formatCost(12.345, 'USD')).toBe('$12.35');
  });
});

describe('costTotalsOf', () => {
  const line = (cost: { amount: number; currency: 'CNY' | 'USD'; complete: boolean } | null) => ({
    engineId: 'qwen' as const,
    direction: 'speak' as const,
    tokens: {},
    estimated: false,
    audioInMs: 0,
    audioOutMs: 0,
    sessions: 1,
    reconnects: 0,
    failures: 0,
    cost
  });

  it('sums per currency and skips unpriced lines', () => {
    expect(
      costTotalsOf([
        line({ amount: 0.5, currency: 'CNY', complete: true }),
        line({ amount: 0.25, currency: 'CNY', complete: false }),
        line({ amount: 0.03, currency: 'USD', complete: true }),
        line(null)
      ])
    ).toEqual({ totals: { CNY: 0.75, USD: 0.03 }, incomplete: true });
  });
});
