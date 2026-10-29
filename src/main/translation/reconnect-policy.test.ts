import { describe, expect, it } from 'vitest';
import {
  exponentialBackoff,
  LIVE_RECONNECT_BUDGET,
  ReconnectPolicy
} from './reconnect-policy.js';

const makePolicy = (overrides: Partial<ConstructorParameters<typeof ReconnectPolicy>[0]> = {}) => {
  let clock = 0;
  const policy = new ReconnectPolicy({
    maxAttempts: 3,
    stableAfterMs: 60_000,
    fatalCloseCodes: new Set([1007, 1008]),
    now: () => clock,
    ...overrides
  });
  return {
    policy,
    advance: (ms: number) => {
      clock += ms;
    }
  };
};

describe('ReconnectPolicy', () => {
  it('allows maxAttempts consecutive reconnects, then gives up', () => {
    const { policy } = makePolicy();
    policy.connected();
    expect(policy.onDrop(1011)).toEqual({ retry: true, attempt: 1, delayMs: 0 });
    policy.connected();
    expect(policy.onDrop(1006)).toEqual({ retry: true, attempt: 2, delayMs: 0 });
    policy.connected();
    expect(policy.onDrop(1011)).toEqual({ retry: true, attempt: 3, delayMs: 0 });
    policy.connected();
    expect(policy.onDrop(1011)).toEqual({ retry: false, reason: 'exhausted' });
  });

  it('never retries a fatal close code', () => {
    const { policy } = makePolicy();
    policy.connected();
    expect(policy.onDrop(1008)).toEqual({ retry: false, reason: 'fatal' });
    expect(policy.attempts).toBe(0);
  });

  it('real output refills the budget', () => {
    const { policy } = makePolicy();
    for (let i = 0; i < 3; i++) {
      policy.connected();
      expect(policy.onDrop(1011)).toMatchObject({ retry: true });
    }
    policy.connected();
    policy.progressed();
    expect(policy.onDrop(1011)).toEqual({ retry: true, attempt: 1, delayMs: 0 });
  });

  it('a connection that stayed up past stableAfterMs refills the budget without output', () => {
    const { policy, advance } = makePolicy();
    for (let i = 0; i < 3; i++) {
      policy.connected();
      policy.onDrop(1011);
    }
    policy.connected();
    advance(59_999);
    expect(policy.onDrop(1011)).toEqual({ retry: false, reason: 'exhausted' });

    policy.connected();
    advance(60_000);
    expect(policy.onDrop(1011)).toEqual({ retry: true, attempt: 1, delayMs: 0 });
  });

  it('reads Date.now on every call by default (tests mock it)', () => {
    const policy = new ReconnectPolicy({ maxAttempts: 1, stableAfterMs: 1_000 });
    const realNow = Date.now;
    let offset = 0;
    Date.now = () => realNow() + offset;
    try {
      policy.connected();
      expect(policy.onDrop(1011)).toMatchObject({ retry: true });
      policy.connected();
      offset += 1_000;
      expect(policy.onDrop(1011)).toMatchObject({ retry: true, attempt: 1 });
    } finally {
      Date.now = realNow;
    }
  });

  it('a failed replacement spends the same budget, backs off, and never counts as stable', () => {
    const { policy, advance } = makePolicy({ retryBackoffMs: exponentialBackoff(2_000, 8_000) });
    policy.connected();
    advance(60_000);
    // The live link was healthy: its drop starts a fresh count.
    expect(policy.onDrop(1006)).toEqual({ retry: true, attempt: 1, delayMs: 0 });
    // No connection has lived since: the old one's uptime refills nothing.
    advance(60_000);
    expect(policy.onFailedAttempt(1006)).toEqual({ retry: true, attempt: 2, delayMs: 2_000 });
    expect(policy.onFailedAttempt(1006)).toEqual({ retry: true, attempt: 3, delayMs: 4_000 });
    expect(policy.onFailedAttempt(1006)).toEqual({ retry: false, reason: 'exhausted' });
  });

  it('never retries a failed replacement with a fatal close code', () => {
    const { policy } = makePolicy();
    policy.connected();
    policy.onDrop(1006);
    expect(policy.onFailedAttempt(1008)).toEqual({ retry: false, reason: 'fatal' });
  });

  it('a replacement going live restarts the retry back-off', () => {
    const { policy } = makePolicy({ retryBackoffMs: exponentialBackoff(2_000, 8_000) });
    policy.connected();
    policy.onDrop(1006);
    expect(policy.onFailedAttempt(1006)).toMatchObject({ delayMs: 2_000 });
    policy.connected();
    policy.progressed();
    policy.onDrop(1006);
    expect(policy.onFailedAttempt(1006)).toMatchObject({ delayMs: 2_000 });
  });

  it('LIVE_RECONNECT_BUDGET replaces a drop at once, then retries after 2 s and 4 s', () => {
    const policy = new ReconnectPolicy({ ...LIVE_RECONNECT_BUDGET, now: () => 0 });
    policy.connected();
    const decisions = [policy.onDrop(1006), policy.onFailedAttempt(1006), policy.onFailedAttempt(1006)];
    expect(decisions.map((d) => (d.retry ? d.delayMs : null))).toEqual([0, 2_000, 4_000]);
    expect(policy.onFailedAttempt(1006)).toEqual({ retry: false, reason: 'exhausted' });
  });

  it('spaces attempts by backoffMs', () => {
    const { policy } = makePolicy({ backoffMs: exponentialBackoff(500, 1_500) });
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      policy.connected();
      const decision = policy.onDrop(1006);
      if (decision.retry) delays.push(decision.delayMs);
    }
    expect(delays).toEqual([500, 1_000, 1_500]);
  });
});
