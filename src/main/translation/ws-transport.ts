/**
 * Transport plumbing shared by the WebSocket-based TranslationClients
 * (DoubaoClient, QwenClient, GeminiClient, OpenAiClient). Provider-agnostic:
 * nothing here knows a wire format. It exists so every client gets the same
 * answers to the questions a long-lived meeting socket has to answer:
 *
 *   - How long may the proxy lookup take?                (`resolveAgentWithin`)
 *   - How long may the opening handshake take?           (`openSocket`)
 *   - What did the server say when it refused the upgrade? (`openSocket`)
 *   - How do we notice a half-open socket (sleep/wake,
 *     Wi-Fi switch) that never errors and never closes?   (`startKeepalive`)
 *   - What happens when the uplink can't keep up?         (`BackpressureGuard`)
 *   - How does start() wait on a "provider ready" event
 *     that cancel()/failure may settle at any moment?     (`createStartGate`)
 */
import { WebSocket } from 'ws';
import type { Agent, IncomingMessage } from 'node:http';
import type { EngineId } from '@shared/engine-types.js';
import { log } from '@core/utils/logger.js';
import {
  kindFromCloseCode,
  kindFromHttpStatus,
  TranslationError
} from './translation-error.js';

export interface WsTiming {
  /**
   * Upper bound on the whole opening handshake — proxy CONNECT, TCP, TLS and
   * the HTTP upgrade (see `openSocket`).
   */
  handshakeTimeoutMs: number;
  /** Upper bound on the provider's "ready" event after the socket opens. */
  sessionReadyTimeoutMs: number;
  /** How often to ping while the session is alive. */
  keepaliveIntervalMs: number;
  /** No pong / inbound frame for this long ⇒ socket is presumed dead. */
  keepaliveTimeoutMs: number;
}

export const DEFAULT_WS_TIMING: WsTiming = {
  handshakeTimeoutMs: 10_000,
  sessionReadyTimeoutMs: 10_000,
  keepaliveIntervalMs: 10_000,
  keepaliveTimeoutMs: 30_000
};

/**
 * Uplink back-pressure threshold. 16 kHz / 16-bit mono is 32 KB/s of raw
 * PCM (≈43 KB/s once Qwen base64-encodes it), so 256 KB is ~6–8 s of
 * audio stuck in the socket. Past that point the subtitles are already
 * hopelessly late; dropping is better than unbounded memory + latency.
 */
export const MAX_BUFFERED_AMOUNT_BYTES = 256 * 1024;

/**
 * Upper bound on resolving the system proxy (Chromium's PAC lookup) before
 * a socket is even created — see `resolveAgentWithin`.
 */
export const PROXY_RESOLVE_TIMEOUT_MS = 3_000;

/** Bound on how much of a non-101 response body we read into an error. */
const MAX_ERROR_BODY_BYTES = 1024;
/** A rejecting server that never finishes its body mustn't stall start(). */
const ERROR_BODY_READ_TIMEOUT_MS = 2_000;

const noop = (): void => undefined;

export interface OpenSocketOptions {
  /** Provider name used as the error-message prefix ("Doubao", "Qwen"). */
  label: string;
  /** Recorded on the TranslationErrors the handshake rejects with. */
  provider?: EngineId;
  headers?: Record<string, string>;
  handshakeTimeoutMs: number;
  /** HTTP(S) agent for the upgrade request, e.g. the system proxy. */
  agent?: Agent;
  /**
   * Response header carrying a server-side trace id (Doubao: `x-tt-logid`).
   * Captured from both the 101 upgrade and any non-101 rejection.
   */
  traceHeader?: string;
}

export interface OpenedSocket {
  /** Value of `traceHeader` from the upgrade response, or ''. */
  traceId: string;
}

export interface OpeningSocket {
  /** Exposed immediately so cancel() can terminate a CONNECTING socket. */
  ws: WebSocket;
  /**
   * Resolves on 'open'; rejects with a provider-prefixed TranslationError
   * carrying the HTTP status, a bounded body slice and the trace id when the
   * server refuses the upgrade ('auth' for a 401, 'quota' for a 429, …),
   * 'timeout' past `handshakeTimeoutMs` (which bounds it, proxy tunnel
   * included — it is never left pending) and 'network' otherwise.
   */
  opened: Promise<OpenedSocket>;
}

const headerValue = (res: IncomingMessage, name?: string): string => {
  if (!name) return '';
  const v = res.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? '';
  return typeof v === 'string' ? v : '';
};

const readBoundedBody = (res: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      res.off('data', onData);
      const text = Buffer.concat(chunks)
        .subarray(0, MAX_ERROR_BODY_BYTES)
        .toString('utf8')
        .replace(/\s+/g, ' ')
        .trim();
      resolve(text);
    };
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.byteLength;
      if (size >= MAX_ERROR_BODY_BYTES) finish();
    };
    const timer = setTimeout(finish, ERROR_BODY_READ_TIMEOUT_MS);
    res.on('data', onData);
    res.once('end', finish);
    res.once('close', finish);
    res.once('error', finish);
  });

/**
 * Create the socket and a promise for its opening handshake.
 *
 * Why not just `new WebSocket()` + once('open'): without a listener for
 * 'unexpected-response', ws collapses a 401/403/429 into the bare
 * "Unexpected server response: 403" and drops the body (where Volcengine /
 * DashScope put the actual reason) and the trace header (only captured on
 * a successful upgrade). With a listener, ws leaves the request and socket
 * alive, so we must abort them ourselves — `ws.terminate()` while
 * CONNECTING does exactly that (req.abort() + socket.destroy()).
 *
 * Why our own timer on top of ws's `handshakeTimeout`: ws arms that on the
 * request's socket, and a proxy agent (agent-base / HttpsProxyAgent) hands
 * the socket over only once its CONNECT succeeded. A proxy that accepts TCP
 * but never answers CONNECT would leave the handshake pending forever.
 */
export const openSocket = (url: string, opts: OpenSocketOptions): OpeningSocket => {
  const ws = new WebSocket(url, {
    headers: opts.headers,
    handshakeTimeout: opts.handshakeTimeoutMs,
    ...(opts.agent ? { agent: opts.agent } : {})
  });
  // Permanent sink. ws emits 'error' on every failure path (including the
  // one triggered by our own terminate()); an EventEmitter 'error' with no
  // listener throws, which in the main process means a crash. Clients add
  // their own listeners on top of this one.
  ws.on('error', noop);

  let traceId = '';
  let httpStatus = 0;
  const describe = (): string => {
    const parts: string[] = [];
    if (httpStatus) parts.push(`HTTP ${httpStatus}`);
    if (traceId) parts.push(`logid=${traceId}`);
    return parts.length ? ` (${parts.join(', ')})` : '';
  };

  const opened = new Promise<OpenedSocket>((resolve, reject) => {
    let settled = false;
    const fail = (
      kind: TranslationError['kind'],
      message: string,
      closeCode?: number
    ): TranslationError =>
      new TranslationError(kind, message, {
        provider: opts.provider,
        httpStatus: httpStatus || undefined,
        closeCode
      });
    const timer = setTimeout(() => {
      settle(
        fail(
          'timeout',
          `${opts.label} handshake timed out after ${opts.handshakeTimeoutMs}ms${describe()}`
        )
      );
      // Aborts the request even while the agent is still tunnelling.
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }, opts.handshakeTimeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      ws.off('upgrade', onUpgrade);
      ws.off('unexpected-response', onUnexpectedResponse);
      ws.off('open', onOpen);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve({ traceId });
    };

    const onUpgrade = (res: IncomingMessage): void => {
      traceId = headerValue(res, opts.traceHeader) || traceId;
    };
    const onUnexpectedResponse = (_req: unknown, res: IncomingMessage): void => {
      // The server answered; the body read below has its own bound.
      clearTimeout(timer);
      httpStatus = res.statusCode ?? 0;
      traceId = headerValue(res, opts.traceHeader) || traceId;
      void readBoundedBody(res).then((body) => {
        settle(
          fail(
            kindFromHttpStatus(httpStatus, body),
            `${opts.label} handshake rejected${describe()}${body ? `: ${body}` : ''}`
          )
        );
        // ws keeps the request open when 'unexpected-response' is handled;
        // abort it and destroy the socket so nothing outlives start().
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        res.destroy();
      });
    };
    const onOpen = (): void => settle();
    const onError = (err: Error): void =>
      settle(fail('network', `${opts.label} handshake failed${describe()}: ${err.message}`));
    const onClose = (code: number, reason: Buffer): void =>
      settle(
        fail(
          kindFromCloseCode(code, reason.toString()),
          `${opts.label} ws closed before open${describe()} (code=${code}): ${reason.toString() || 'no reason'}`,
          code
        )
      );

    ws.on('upgrade', onUpgrade);
    ws.on('unexpected-response', onUnexpectedResponse);
    ws.once('open', onOpen);
    ws.on('error', onError);
    ws.once('close', onClose);
  });

  return { ws, opened };
};

/**
 * Bound a proxy-agent lookup (`proxy-agent.ts`). A PAC script that never
 * loads would otherwise stall start() — or a Gemini rotation — before any
 * handshake timer exists. On timeout, connect directly: the same fallback
 * `resolveProxyAgent` takes when the lookup fails. A rejection still
 * propagates.
 */
export const resolveAgentWithin = (
  resolve: (url: string) => Promise<Agent | undefined>,
  url: string,
  timeoutMs: number,
  label: string
): Promise<Agent | undefined> =>
  new Promise((done, fail) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      log.warn(`${label} proxy lookup timed out after ${timeoutMs}ms; connecting directly`);
      done(undefined);
    }, timeoutMs);
    // Via then(): a resolver that throws synchronously rejects too.
    Promise.resolve()
      .then(() => resolve(url))
      .then(
        (agent) => {
          if (settled) return; // too late: already connecting directly
          settled = true;
          clearTimeout(timer);
          done(agent);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fail(err);
        }
      );
  });

/**
 * Close a socket without throwing, whatever state it is in. OPEN gets a
 * proper close frame (ws itself destroys the socket if the peer never
 * answers it); CONNECTING is aborted outright so the pending HTTP request
 * doesn't linger.
 */
export const closeSocket = (
  ws: WebSocket | null,
  code = 1000,
  reason = ''
): void => {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
    else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
  } catch {
    // ignore
  }
};

/** The slice of a ws WebSocket that the keepalive needs (fakeable in tests). */
export interface KeepaliveSocket {
  readonly readyState: number;
  ping(): void;
  on(event: 'pong' | 'message', listener: () => void): unknown;
  off(event: 'pong' | 'message', listener: () => void): unknown;
}

export interface KeepaliveOptions {
  intervalMs: number;
  timeoutMs: number;
  /** Called once when the peer has been silent for `timeoutMs`. */
  onDead: () => void;
  /** Ping → pong round trip, for each pong that answers our ping. */
  onRtt?: (ms: number) => void;
}

/**
 * Ping every `intervalMs`; if neither a pong nor any other inbound frame
 * arrived for `timeoutMs`, stop and call `onDead`. Inbound frames count as
 * liveness too, so a busy session is never killed because a pong was
 * queued behind TTS audio. Returns an idempotent stop function — callers
 * must invoke it on every terminal path.
 */
export const startKeepalive = (
  ws: KeepaliveSocket,
  opts: KeepaliveOptions
): (() => void) => {
  let lastSeen = Date.now();
  let stopped = false;
  /** When our unanswered ping went out; 0 = none outstanding. */
  let pingSentAt = 0;
  const markAlive = (): void => {
    lastSeen = Date.now();
  };
  const onPong = (): void => {
    markAlive();
    if (pingSentAt) {
      opts.onRtt?.(lastSeen - pingSentAt);
      pingSentAt = 0;
    }
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    ws.off('pong', onPong);
    ws.off('message', markAlive);
  };
  const timer = setInterval(() => {
    if (Date.now() - lastSeen >= opts.timeoutMs) {
      stop();
      opts.onDead();
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.ping();
      pingSentAt = Date.now();
    } catch {
      // A failing ping surfaces through the socket's own error/close path.
    }
  }, opts.intervalMs);
  ws.on('pong', onPong);
  ws.on('message', markAlive);
  return stop;
};

/**
 * Decides whether an uplink audio chunk should be dropped because the
 * socket's send buffer is already deep, with a rate-limited warning so a
 * stalled link doesn't also flood the log.
 */
export class BackpressureGuard {
  private dropped = 0;
  private lastWarnAt = 0;

  constructor(
    private readonly label: () => string,
    private readonly maxBufferedBytes = MAX_BUFFERED_AMOUNT_BYTES,
    private readonly warnIntervalMs = 5_000
  ) {}

  /** True ⇒ drop this chunk. */
  shouldDrop(bufferedAmount: number): boolean {
    if (bufferedAmount <= this.maxBufferedBytes) return false;
    this.dropped++;
    const now = Date.now();
    if (now - this.lastWarnAt >= this.warnIntervalMs) {
      log.warn(
        `${this.label()} uplink back-pressure: ${bufferedAmount}B buffered (limit ${this.maxBufferedBytes}B); dropped ${this.dropped} audio chunk(s)`
      );
      this.lastWarnAt = now;
      this.dropped = 0;
    }
    return true;
  }
}

/**
 * One-shot "provider is ready" gate for start(). The promise is marked
 * handled at creation: cancel() or a pre-ready failure may reject it
 * before start() has reached its `await`, and an unobserved rejection
 * would otherwise surface as an unhandledRejection. `await gate.promise`
 * still observes the rejection normally.
 */
export interface StartGate {
  readonly promise: Promise<void>;
  readonly settled: boolean;
  /** Returns false if the gate was already settled. */
  resolve(): boolean;
  /** Returns false if the gate was already settled. */
  reject(err: Error): boolean;
}

export const createStartGate = (): StartGate => {
  let settled = false;
  let resolveFn: () => void = noop;
  let rejectFn: (err: Error) => void = noop;
  const promise = new Promise<void>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  promise.catch(noop);
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve() {
      if (settled) return false;
      settled = true;
      resolveFn();
      return true;
    },
    reject(err: Error) {
      if (settled) return false;
      settled = true;
      rejectFn(err);
      return true;
    }
  };
};
