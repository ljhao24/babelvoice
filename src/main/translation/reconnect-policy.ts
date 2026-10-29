/**
 * When a long-lived provider socket that dropped mid-session may be
 * replaced, and when the session should give up instead. Pure bookkeeping —
 * no sockets, no timers — so a client keeps its own connection logic and
 * asks this for the decision (GeminiClient's rotation, or GatedWsSession's
 * opt-in reconnect).
 *
 * The rules, learned on Gemini Live:
 *   - Count consecutive reconnects; past `maxAttempts` without proof the
 *     link works, fail rather than reconnect forever.
 *   - Only real output proves a reconnect worked (`progressed()`). A
 *     connection that takes the handshake and then streams nothing but
 *     padding must keep using up the budget.
 *   - A connection that stayed up `stableAfterMs` before dropping was
 *     healthy: a quiet meeting produces no output to reset the budget with,
 *     so an occasional drop must not count.
 *   - Close codes in `fatalCloseCodes` mean the request itself is wrong
 *     (bad key, bad config): reconnecting can't help.
 *   - A replacement that fails before it goes live (`onFailedAttempt`)
 *     spends the same budget, and never counts as stable — no connection
 *     lived. The network is often still down then, so it backs off.
 */

export interface ReconnectPolicyOptions {
  /** Consecutive reconnects allowed without real output in between. */
  maxAttempts: number;
  /** A connection that lived this long before dropping resets the count. */
  stableAfterMs: number;
  /** Close codes that are never retried. */
  fatalCloseCodes?: ReadonlySet<number>;
  /** Delay before reconnect `attempt` (1-based). Default: reconnect at once. */
  backoffMs?: (attempt: number) => number;
  /**
   * Delay before the next try after `failures` replacements in a row failed
   * before going live (1-based). Default: retry at once.
   */
  retryBackoffMs?: (failures: number) => number;
  /** Clock; tests mock `Date.now`, so the default reads it on every call. */
  now?: () => number;
}

export type ReconnectDecision =
  | { retry: true; attempt: number; delayMs: number }
  | { retry: false; reason: 'fatal' | 'exhausted' };

/**
 * Exponential backoff for `backoffMs` / `retryBackoffMs`: `baseMs`, 2×, 4×,
 * … capped at `maxMs`.
 */
export const exponentialBackoff =
  (baseMs: number, maxMs: number) =>
  (attempt: number): number =>
    Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));

/**
 * The budget learned on Gemini Live, shared by every provider that
 * reconnects: three consecutive reconnects without real output in between,
 * and a connection that stayed up a minute was healthy (a quiet meeting
 * produces no output to reset the count with, so an occasional drop must
 * not use it up). A drop is replaced at once; a replacement that couldn't
 * connect (Wi-Fi switching, a proxy coming back) is retried after 2 s, then
 * 4 s. Gemini's rotation never reports a failed attempt, so only
 * GatedWsSession backs off.
 */
export const LIVE_RECONNECT_BUDGET = {
  maxAttempts: 3,
  stableAfterMs: 60_000,
  retryBackoffMs: exponentialBackoff(2_000, 8_000)
} as const satisfies Pick<
  ReconnectPolicyOptions,
  'maxAttempts' | 'stableAfterMs' | 'retryBackoffMs'
>;

export class ReconnectPolicy {
  private consecutive = 0;
  /** Replacements in a row that failed before going live. */
  private failures = 0;
  private connectedAt = 0;
  private readonly now: () => number;

  constructor(private readonly opts: ReconnectPolicyOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  get maxAttempts(): number {
    return this.opts.maxAttempts;
  }

  /** Reconnects made since the link last proved itself. */
  get attempts(): number {
    return this.consecutive;
  }

  /** A connection became the live one (first connect or a replacement). */
  connected(): void {
    this.connectedAt = this.now();
    this.failures = 0;
  }

  /** Real output arrived on the live connection: the link works. */
  progressed(): void {
    this.consecutive = 0;
  }

  /**
   * The live connection dropped unexpectedly. A `retry` decision counts as
   * one attempt; the caller reconnects after `delayMs`.
   */
  onDrop(closeCode: number): ReconnectDecision {
    if (this.now() - this.connectedAt >= this.opts.stableAfterMs) {
      this.consecutive = 0;
    }
    return this.decide(closeCode, this.opts.backoffMs?.(this.consecutive + 1) ?? 0);
  }

  /**
   * A replacement failed before it went live (handshake refused or timed
   * out, no ready event). A `retry` decision counts as one attempt from the
   * same budget; the caller tries again after `delayMs`.
   */
  onFailedAttempt(closeCode: number): ReconnectDecision {
    this.failures++;
    return this.decide(closeCode, this.opts.retryBackoffMs?.(this.failures) ?? 0);
  }

  private decide(closeCode: number, delayMs: number): ReconnectDecision {
    if (this.opts.fatalCloseCodes?.has(closeCode)) {
      return { retry: false, reason: 'fatal' };
    }
    if (this.consecutive >= this.opts.maxAttempts) {
      return { retry: false, reason: 'exhausted' };
    }
    this.consecutive++;
    return { retry: true, attempt: this.consecutive, delayMs };
  }
}
