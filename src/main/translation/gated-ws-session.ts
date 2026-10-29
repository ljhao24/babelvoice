/**
 * The lifecycle the gated WebSocket providers share (DoubaoClient,
 * QwenClient, OpenAiClient): a two-phase start — the WS handshake, then a
 * provider "ready" event before audio may flow — plus keepalive, the
 * ready-timeout, failure convergence, finish bookkeeping and cancel.
 *
 * Composed into a client, not inherited: the client owns its wire format and
 * tells the session what happened (`markReady`, `complete`, `fail`); the
 * session calls back through a few hooks (`configure`, `onMessage`, …).
 *
 * Lifecycle contract (ADR-0002), identical for every client built on it:
 *   - Single use. start() runs once per instance; a second call rejects
 *     ("already started") whether the first is in flight, live or over.
 *   - cancel() is a permanent latch, safe in any state and idempotent. A
 *     pending start() rejects; a start() after it rejects without opening a
 *     socket. Nothing is emitted after cancel().
 *   - Before ready, every failure (handshake rejection, socket error/close,
 *     ready timeout, keepalive death, provider error frame) rejects start()
 *     — never an out-of-band event. After ready, a failure emits exactly one
 *     `session-failed`. Either way it is a `TranslationError` with a kind.
 *   - finish() and cancel() are idempotent; every terminal path clears all
 *     timers and closes the socket.
 *   - A socket's listeners come off once it closed (or was replaced), so a
 *     dead socket can't reach the client.
 *
 * Reconnect is opt-in (`reconnect`): a live connection that drops mid-session
 * is replaced instead of failing the session, per a `ReconnectPolicy`. A
 * replacement that fails before its ready event (refused, timed out, closed)
 * is tried again after the policy's back-off, from the same budget; one the
 * policy won't retry ends the session. All three providers enable it with
 * `LIVE_RECONNECT_BUDGET` — see the policy for the rules.
 */
import { WebSocket, type RawData } from 'ws';
import type { Agent } from 'node:http';
import type { EngineId } from '@shared/engine-types.js';
import { log } from '@core/utils/logger.js';
import type { ReconnectPolicy } from './reconnect-policy.js';
import type { ClientTelemetry, TranslationEventBody } from './translation-client.js';
import {
  kindFromCloseCode,
  sessionFailedBody,
  toTranslationError,
  TranslationError,
  type TranslationErrorDetails
} from './translation-error.js';
import {
  BackpressureGuard,
  closeSocket,
  createStartGate,
  openSocket,
  PROXY_RESOLVE_TIMEOUT_MS,
  resolveAgentWithin,
  startKeepalive,
  type StartGate,
  type WsTiming
} from './ws-transport.js';

export interface GatedWsSessionHooks {
  /**
   * The socket just opened: send the provider's configure frame. Runs again
   * on every replacement when reconnect is on. Throwing fails the attempt.
   */
  configure(ws: WebSocket, attempt: { reconnect: boolean }): void;
  /** An inbound frame while the session is not over (opening included). */
  onMessage(data: Buffer): void;
  /**
   * An inbound frame after the session ended. Must not emit; Doubao uses it
   * to spot the ack of its CancelSession.
   */
  onMessageAfterEnd?(data: Buffer, ws: WebSocket): void;
  /** The socket finished closing after the session ended. */
  onClosedAfterEnd?(): void;
  /**
   * The server closed the socket after finish(): is that the end we asked
   * for? Default: a clean 1000 only.
   */
  closeEndsFinish?(code: number): boolean;
  /** Close anything still open, just before 'session-finished' goes out. */
  flush?(): void;
  /** The session ended, on any path: stop the provider's own timers. */
  onEnd?(): void;
  /**
   * cancel() found the socket OPEN. Return true to take over closing it
   * (Doubao's CancelSession + grace window); otherwise it closes right away.
   */
  closeOnCancel?(ws: WebSocket): boolean;
  /**
   * Reconnect only: the live connection dropped and a replacement is on
   * its way. Close anything that was open on the old one.
   */
  onLinkLost?(): void;
}

export interface GatedWsSessionOptions {
  /** Recorded on every TranslationError the session raises. */
  provider: EngineId;
  /** Provider name: log and error-message prefix ("Doubao", "Qwen"). */
  label: string;
  /** The provider event start() waits for ("SessionStarted"). */
  readyEvent: string;
  /** What `configure` sends, for its failure message ("StartSession"). */
  configureFrame: string;
  timing: WsTiming;
  /** Log scope, e.g. `Doubao[speak/1a2b3c4d]`. */
  tag: () => string;
  onEvent: (event: TranslationEventBody) => void;
  onTelemetry?: (sample: ClientTelemetry) => void;
  hooks: GatedWsSessionHooks;
  /**
   * What the provider calls the upgrade's trace id in failure messages
   * (Doubao: 'logid'). Omit to keep it out of them.
   */
  traceLabel?: string;
  /** Replace a connection that drops mid-session instead of failing. */
  reconnect?: ReconnectPolicy;
}

export interface GatedWsOpenSpec {
  url: string;
  headers?: Record<string, string>;
  /** Response header carrying the server's trace id (see `openSocket`). */
  traceHeader?: string;
  /** Look up an HTTP agent (the system proxy) before connecting. */
  resolveAgent?: (url: string) => Promise<Agent | undefined>;
  proxyResolveTimeoutMs?: number;
  /** Runs alongside the first handshake (Doubao's proto load); a rejection fails start(). */
  alongside?: Promise<unknown>;
}

interface Link {
  readonly ws: WebSocket;
  readonly stopKeepalive: () => void;
  /** Takes this session's listeners (and keepalive) off `ws`. Idempotent. */
  readonly detach: () => void;
}

/** Events that prove the link works (see `ReconnectPolicy.progressed`). */
const CONTENT_EVENTS: ReadonlySet<TranslationEventBody['type']> = new Set([
  'source-subtitle-delta',
  'source-subtitle-final',
  'translation-subtitle-delta',
  'translation-subtitle-final',
  'tts-audio'
] as const);

/** Failure kinds a reconnect can't fix. */
const UNRECOVERABLE_KINDS: ReadonlySet<TranslationError['kind']> = new Set([
  'auth',
  'quota',
  'protocol'
] as const);

const noop = (): void => undefined;

const isCleanClose = (code: number): boolean => code === 1000;

export class GatedWsSession {
  /** The connection in use or being opened; null once the session let go of it. */
  private link: Link | null = null;
  private spec: GatedWsOpenSpec | null = null;
  /** Settles the in-flight connection attempt (the first, or a replacement). */
  private gate: StartGate | null = null;
  private started = false;
  /** The first ready event arrived (start() resolved). */
  private ready = false;
  /** The in-flight attempt is waiting for its ready event. */
  private awaitingReady = false;
  /**
   * Terminal latch: set once the session is over for any reason (finished,
   * failed, start failure, cancel). Nothing is emitted after it is set.
   */
  private ended = false;
  private cancelled = false;
  private finishing = false;
  private reconnecting = false;
  private trace = '';
  private warnedNotOpen = false;
  private readyTimer: NodeJS.Timeout | null = null;
  /** When the in-flight attempt's socket opened (for the ready latency). */
  private openedAt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly backpressure: BackpressureGuard;

  constructor(private readonly opts: GatedWsSessionOptions) {
    this.backpressure = new BackpressureGuard(opts.tag);
  }

  /** The current socket, if any. */
  get socket(): WebSocket | null {
    return this.link?.ws ?? null;
  }

  get isOpen(): boolean {
    return this.link?.ws.readyState === WebSocket.OPEN;
  }

  /** The provider's ready event arrived; start() resolved. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Over (finished, failed or cancelled): nothing more is emitted. */
  get isEnded(): boolean {
    return this.ended;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** finish() went out: no more uplink audio. */
  get isFinishing(): boolean {
    return this.finishing;
  }

  /** The server's trace id from the upgrade response, or ''. */
  get traceId(): string {
    return this.trace;
  }

  /**
   * Reserve the session for this start(). Throws if it already started or
   * was cancelled — call it before touching any per-session state, so a
   * second start() can't clobber a live session's.
   */
  claim(): void {
    if (this.started) throw new Error(`${this.opts.label} session already started`);
    if (this.cancelled) throw this.canceledError();
    this.started = true;
  }

  /**
   * Open the socket, run `configure`, and resolve only once the client
   * calls `markReady()`. cancel() racing in rejects this promise.
   */
  async open(spec: GatedWsOpenSpec): Promise<void> {
    if (!this.started) this.claim();
    else if (this.spec) throw new Error(`${this.opts.label} session already started`);
    if (this.cancelled) throw this.canceledError();
    this.spec = spec;
    try {
      await this.connect(spec, false);
    } catch (err) {
      // Whatever failed, nothing of this session keeps running.
      this.end();
      throw err;
    }
  }

  /** The provider's ready event: resolve start() (or finish a reconnect). */
  markReady(): void {
    if (this.ended || !this.awaitingReady) return;
    this.awaitingReady = false;
    this.clearReadyTimer();
    this.gate?.resolve();
    this.opts.reconnect?.connected();
    this.telemetry({ type: 'link', phase: 'ready', ms: Date.now() - this.openedAt });
    if (!this.ready) {
      this.ready = true;
      this.emit({ type: 'session-started' });
      return;
    }
    this.reconnecting = false;
    log.info(`${this.opts.tag()} reconnected`);
  }

  /**
   * Report a measurement. Unlike events it may trail the session's end (a
   * provider's last usage report can follow its finish) — but never cancel().
   */
  telemetry(sample: ClientTelemetry): void {
    if (this.cancelled) return;
    this.opts.onTelemetry?.(sample);
  }

  /** Forward an event to the owner; dropped once the session is over. */
  emit(event: TranslationEventBody): void {
    if (this.ended) return;
    // Only output on a live link proves it works — not what onLinkLost
    // closes out while a replacement is coming.
    if (!this.reconnecting && CONTENT_EVENTS.has(event.type)) {
      this.opts.reconnect?.progressed();
    }
    this.opts.onEvent(event);
  }

  /**
   * Gate for sendAudio(). False ⇒ drop the chunk quietly: the session is
   * over or finishing (capture has stopped by then, so stragglers are
   * expected), the socket is closing, or a reconnect is in progress. Throws
   * before start() connected — audio then is a caller bug.
   */
  admitAudio(): boolean {
    if (this.ended || this.finishing || this.reconnecting) return false;
    const ws = this.link?.ws;
    if (!ws || ws.readyState === WebSocket.CONNECTING) {
      throw new Error(`${this.opts.label} session not connected`);
    }
    if (ws.readyState !== WebSocket.OPEN) {
      // CLOSING/CLOSED ahead of the 'close' event (a close handshake may
      // take up to 30 s): the close handler settles the session. Say so
      // once rather than once per chunk.
      if (!this.warnedNotOpen) {
        this.warnedNotOpen = true;
        log.warn(`${this.opts.tag()} socket closing; dropping uplink audio`);
      }
      return false;
    }
    if (!this.ready) {
      // Defensive: start() resolves only once ready, so this shouldn't fire
      // under normal flow. If it does, drop rather than break the protocol.
      log.warn(`${this.opts.tag()} dropping audio before ${this.opts.readyEvent}`);
      return false;
    }
    return true;
  }

  /**
   * The socket to put one uplink audio frame on, or null to drop it: gone,
   * or its send buffer is backed up. A slow link would otherwise queue audio
   * without bound, and every queued second is a second of subtitle delay
   * that never recovers.
   */
  audioSocket(): WebSocket | null {
    const ws = this.link?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    if (this.backpressure.shouldDrop(ws.bufferedAmount)) return null;
    return ws;
  }

  /**
   * Send a control frame on the open socket. False if there is none, or
   * (with a warning) if the send threw.
   */
  sendControl(data: string | Uint8Array, what: string): boolean {
    const ws = this.link?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(data);
      return true;
    } catch (err) {
      log.warn(`${this.opts.tag()} failed to send ${what}:`, err);
      return false;
    }
  }

  /**
   * finish() entry. Marks the session finishing and returns the open socket
   * for the provider's end-of-stream frame, or null when there is nothing
   * to finish (never connected, already finishing, over).
   */
  beginFinish(): WebSocket | null {
    if (this.ended || this.finishing) return null;
    if (this.reconnecting) {
      // Mid-reconnect: nothing in flight can still produce output.
      this.finishing = true;
      this.complete('finished during reconnect');
      return null;
    }
    const ws = this.link?.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    this.finishing = true;
    return ws;
  }

  /**
   * Clean end: the server confirmed end-of-stream, or the client stopped
   * waiting for it. Closes anything open (`flush`), emits
   * 'session-finished', closes the socket.
   */
  complete(reason: string): void {
    if (this.ended) return;
    this.opts.hooks.flush?.();
    this.end();
    const ws = this.dropLink()?.ws ?? null;
    this.opts.onEvent({ type: 'session-finished' });
    closeSocket(ws, 1000, reason);
  }

  /**
   * The single failure path. Before ready it rejects start() (the message
   * prefixed with the code and trace id); after, it emits exactly one
   * 'session-failed'. Either way the session is over and the socket closed.
   */
  fail(err: TranslationError): void {
    if (this.ended) return;
    if (this.ready && this.awaitingReady) {
      // A replacement failed before its ready event: replaceLink decides
      // whether another one is worth trying.
      this.abortAttempt(err);
      return;
    }
    const beforeReady = !this.ready;
    this.end();
    const ws = this.dropLink()?.ws ?? null;
    // Close, don't just drop the reference: cancel() finds no socket once
    // it's dropped, so an unclosed one would leak with its listeners live.
    closeSocket(ws);
    if (beforeReady) {
      const detail = this.describeFailure(err);
      this.gate?.reject(
        err.withMessage(
          `${this.opts.label} handshake failed${detail ? ` (${detail})` : ''}: ${err.message}`
        )
      );
      return;
    }
    // A replacement may still be mid-handshake: unwind it.
    this.gate?.reject(err);
    const trace = this.traceSuffix();
    this.opts.onEvent(
      sessionFailedBody(err, trace ? `${err.message} (${trace})` : err.message)
    );
  }

  /** A TranslationError attributed to this session's provider. */
  error(
    kind: TranslationError['kind'],
    message: string,
    details: Omit<TranslationErrorDetails, 'provider'> = {}
  ): TranslationError {
    return new TranslationError(kind, message, { ...details, provider: this.opts.provider });
  }

  /**
   * Drop the session: safe in any state, idempotent, emits nothing. A
   * pending start() rejects.
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.end();
    // Unblock start() if it is still waiting. The gate is pre-marked
    // handled, so this is safe even before start() awaits it.
    this.gate?.reject(this.canceledError());
    const ws = this.dropLink()?.ws;
    if (!ws) return;
    // CONNECTING is aborted outright: deferring the close would let the
    // upgrade complete into a session nobody owns.
    if (ws.readyState === WebSocket.OPEN && this.opts.hooks.closeOnCancel?.(ws)) return;
    closeSocket(ws, 1000, 'client cancel');
  }

  // -------------------------------------------------------------------------

  private canceledError(): Error {
    return new Error(`${this.opts.label} session canceled before ${this.opts.readyEvent}`);
  }

  private describeFailure(err: TranslationError): string {
    const { traceLabel } = this.opts;
    const parts = [err.codeLabel];
    if (traceLabel) parts.push(`${traceLabel}=${this.trace || 'n/a'}`);
    return parts.filter(Boolean).join(', ');
  }

  private traceSuffix(): string {
    const { traceLabel } = this.opts;
    return traceLabel && this.trace ? `${traceLabel}=${this.trace}` : '';
  }

  /** One connection attempt, up to its ready event. */
  private async connect(spec: GatedWsOpenSpec, reconnect: boolean): Promise<void> {
    const { label, timing } = this.opts;
    const gate = createStartGate();
    this.gate = gate;
    this.telemetry({ type: 'link', phase: 'connecting', reconnect });

    let agent: Agent | undefined;
    if (spec.resolveAgent) {
      // Bounded, so a PAC lookup that never answers can't stall start()
      // before the handshake timer exists; raced against the gate so
      // cancel() still rejects start() right away.
      agent = await Promise.race([
        resolveAgentWithin(
          spec.resolveAgent,
          spec.url,
          spec.proxyResolveTimeoutMs ?? PROXY_RESOLVE_TIMEOUT_MS,
          this.opts.tag()
        ).catch((err: unknown) => {
          throw toTranslationError(err, 'network', { provider: this.opts.provider });
        }),
        gate.promise.then(() => undefined)
      ]);
      if (this.ended) throw this.canceledError();
    }

    const dialedAt = Date.now();
    const { ws, opened } = openSocket(spec.url, {
      label,
      provider: this.opts.provider,
      headers: spec.headers,
      handshakeTimeoutMs: timing.handshakeTimeoutMs,
      traceHeader: spec.traceHeader,
      agent
    });
    // Assigned before the first await so cancel() can always reach it.
    this.link = { ws, stopKeepalive: noop, detach: noop };

    // Phase 1: handshake. Only `openSocket`'s one-shot listeners are live,
    // so a 401/403 surfaces once, as this rejection (status, body, trace id).
    try {
      const [{ traceId }] = await Promise.all([
        opened,
        reconnect
          ? undefined
          : spec.alongside?.catch((err: unknown) => {
              throw toTranslationError(err, 'unknown', { provider: this.opts.provider });
            })
      ]);
      this.trace = traceId;
      if (traceId && this.opts.traceLabel) {
        log.info(`${this.opts.tag()} ${this.opts.traceLabel}=${traceId}`);
      }
    } catch (err) {
      if (this.link?.ws === ws) this.link = null;
      closeSocket(ws);
      // cancel() during CONNECTING terminates the socket, which surfaces
      // here as a generic abort — report it as the cancel it was.
      if (this.cancelled) throw this.canceledError();
      throw err;
    }
    // cancel() may have landed between 'open' and this continuation; it has
    // already closed the socket and rejected the gate.
    if (this.ended || this.link?.ws !== ws) throw this.canceledError();

    // Phase 2: connection is up — install the persistent listeners, then
    // configure and wait for the ready event.
    this.openedAt = Date.now();
    this.telemetry({ type: 'link', phase: 'open', ms: this.openedAt - dialedAt });
    this.link = this.attach(ws);
    this.awaitingReady = true;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      this.fail(
        this.error(
          'timeout',
          `timed out after ${timing.sessionReadyTimeoutMs}ms waiting for ${this.opts.readyEvent}`
        )
      );
    }, timing.sessionReadyTimeoutMs);
    try {
      this.opts.hooks.configure(ws, { reconnect });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fail(
        this.error('unknown', `failed to send ${this.opts.configureFrame}: ${message}`, {
          cause: err
        })
      );
    }
    await gate.promise;
  }

  private attach(ws: WebSocket): Link {
    const { hooks, timing } = this.opts;
    const onMessage = (data: RawData): void => {
      if (this.ended) {
        hooks.onMessageAfterEnd?.(data as Buffer, ws);
        return;
      }
      hooks.onMessage(data as Buffer);
    };
    const onError = (err: Error): void =>
      this.linkDown(ws, 'error', this.error('network', `ws: ${err.message}`, { cause: err }));
    const onClose = (code: number, reason: Buffer): void => {
      // The socket's last event: nothing of this session stays on it.
      detach();
      if (this.ended) {
        hooks.onClosedAfterEnd?.();
        return;
      }
      const text = reason.toString();
      this.linkDown(
        ws,
        'close',
        this.error(kindFromCloseCode(code, text), `ws closed: ${text || 'no reason'}`, {
          closeCode: code
        })
      );
    };
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
    const stopKeepalive = startKeepalive(ws, {
      intervalMs: timing.keepaliveIntervalMs,
      timeoutMs: timing.keepaliveTimeoutMs,
      onRtt: (ms) => this.telemetry({ type: 'link', phase: 'rtt', ms }),
      onDead: () => {
        // The peer is unresponsive: don't wait on a close handshake.
        ws.terminate();
        this.linkDown(
          ws,
          'dead',
          this.error(
            'network',
            `connection lost: no response from server for ${Math.round(timing.keepaliveTimeoutMs / 1000)}s`
          )
        );
      }
    });
    let attached = true;
    const detach = (): void => {
      if (!attached) return;
      attached = false;
      stopKeepalive();
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    return { ws, stopKeepalive, detach };
  }

  /** The socket errored, closed or went silent while the session was live. */
  private linkDown(
    ws: WebSocket,
    via: 'error' | 'close' | 'dead',
    err: TranslationError
  ): void {
    if (this.ended || this.link?.ws !== ws) return;
    // finish() asked the server to wrap up; a close in place of its
    // terminal event can still be the end we asked for.
    if (
      via === 'close' &&
      this.finishing &&
      this.ready &&
      (this.opts.hooks.closeEndsFinish ?? isCleanClose)(err.closeCode ?? -1)
    ) {
      this.complete('server closed');
      return;
    }
    if (this.reconnectAfter(err)) return;
    this.fail(err);
  }

  /** Replace a live connection that dropped, if the policy allows. */
  private reconnectAfter(err: TranslationError): boolean {
    const policy = this.opts.reconnect;
    // Only a live link is replaced: a replacement that fails before its
    // ready event goes through retryReplacement, and a drop after finish()
    // ends the session.
    if (!policy || !this.ready || this.awaitingReady || this.finishing) return false;
    // A new connection can't fix a rejected key, an empty balance or a
    // refused request.
    if (UNRECOVERABLE_KINDS.has(err.kind)) return false;
    const code = err.closeCode ?? -1;
    const decision = policy.onDrop(code);
    if (!decision.retry) return false;
    const old = this.dropLink();
    old?.detach();
    closeSocket(old?.ws ?? null);
    this.reconnecting = true;
    log.warn(
      `${this.opts.tag()} connection dropped mid-session (code=${code}): ${err.message}; reconnecting (${decision.attempt}/${policy.maxAttempts})`
    );
    this.opts.hooks.onLinkLost?.();
    this.scheduleReplacement(decision.delayMs);
    return true;
  }

  private scheduleReplacement(delayMs: number): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.replaceLink();
    }, delayMs);
  }

  private async replaceLink(): Promise<void> {
    const spec = this.spec;
    if (!spec || this.ended) return;
    try {
      await this.connect(spec, true);
    } catch (err) {
      if (this.ended) return;
      const error = toTranslationError(err, 'network', { provider: this.opts.provider });
      if (!this.retryReplacement(error)) this.fail(error);
    }
  }

  /** A replacement failed before it went live: try another, if the policy allows. */
  private retryReplacement(err: TranslationError): boolean {
    const policy = this.opts.reconnect;
    if (!policy || UNRECOVERABLE_KINDS.has(err.kind)) return false;
    const decision = policy.onFailedAttempt(err.closeCode ?? -1);
    if (!decision.retry) return false;
    log.warn(
      `${this.opts.tag()} replacement connection failed: ${err.message}; retrying in ${decision.delayMs}ms (${decision.attempt}/${policy.maxAttempts})`
    );
    this.scheduleReplacement(decision.delayMs);
    return true;
  }

  /**
   * Unwind a replacement that failed before its ready event, leaving the
   * session live: its connect() rejects with `err`, and nothing more from
   * its socket reaches the client.
   */
  private abortAttempt(err: TranslationError): void {
    this.awaitingReady = false;
    this.clearReadyTimer();
    const link = this.dropLink();
    link?.detach();
    closeSocket(link?.ws ?? null);
    this.gate?.reject(err);
  }

  /**
   * Let go of the current socket. Its listeners stay until it closes, so
   * the after-end hooks still see a cancel ack or the final close.
   */
  private dropLink(): Link | null {
    const link = this.link;
    this.link = null;
    return link;
  }

  /** Latch the terminal state and stop every session timer. Idempotent. */
  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.awaitingReady = false;
    this.reconnecting = false;
    this.clearReadyTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.link?.stopKeepalive();
    this.opts.hooks.onEnd?.();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }
}
