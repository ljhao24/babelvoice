import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  WebSocket,
  WebSocketServer,
  type ServerOptions,
  type WebSocket as ServerSocket
} from 'ws';
import { setLogSink } from '@core/utils/logger.js';
import {
  GatedWsSession,
  type GatedWsSessionHooks,
  type GatedWsSessionOptions
} from './gated-ws-session.js';
import { ReconnectPolicy } from './reconnect-policy.js';
import type { TranslationEventBody } from './translation-client.js';
import { TranslationError } from './translation-error.js';
import { DEFAULT_WS_TIMING } from './ws-transport.js';

/**
 * A toy provider protocol, JSON both ways:
 *   client → { type: 'configure', reconnect }
 *   server → { type: 'ready' } | { type: 'text', text } | { type: 'done' }
 *          | { type: 'error', code, message, kind }
 */
interface ServerFrame {
  type: string;
  text?: string;
  code?: number;
  message?: string;
  kind?: TranslationError['kind'];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FakeConn {
  socket: ServerSocket;
  received: { type: string; reconnect?: boolean }[];
  closed: Promise<void>;
  send(frame: ServerFrame): void;
  waitForConfigure(): Promise<void>;
}

interface FakeServer {
  url: string;
  connections: FakeConn[];
  nextConnection(): Promise<FakeConn>;
  close(): Promise<void>;
}

const startServer = async (opts: ServerOptions = {}): Promise<FakeServer> => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', ...opts });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const connections: FakeConn[] = [];
  const ready: FakeConn[] = [];
  const waiters: Array<(c: FakeConn) => void> = [];
  wss.on('connection', (socket) => {
    const received: FakeConn['received'] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));
    const conn: FakeConn = {
      socket,
      received,
      closed: new Promise<void>((r) => socket.once('close', () => r())),
      send: (frame) => socket.send(JSON.stringify(frame)),
      waitForConfigure: () =>
        vi.waitFor(() => expect(received.some((m) => m.type === 'configure')).toBe(true), {
          timeout: 2000,
          interval: 5
        })
    };
    connections.push(conn);
    const waiter = waiters.shift();
    if (waiter) waiter(conn);
    else ready.push(conn);
  });
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    connections,
    nextConnection: () => {
      const conn = ready.shift();
      return conn ? Promise.resolve(conn) : new Promise((r) => waiters.push(r));
    },
    close: () =>
      new Promise<void>((r) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => r());
      })
  };
};

describe('GatedWsSession', () => {
  let server: FakeServer | null = null;
  let sessions: GatedWsSession[] = [];

  beforeAll(() => setLogSink({ info() {}, warn() {}, error() {}, debug() {} }));

  afterEach(async () => {
    for (const s of sessions) s.cancel();
    sessions = [];
    await server?.close();
    server = null;
  });

  const makeSession = (
    overrides: Partial<Omit<GatedWsSessionOptions, 'hooks'>> & {
      hooks?: Partial<GatedWsSessionHooks>;
    } = {}
  ) => {
    const events: TranslationEventBody[] = [];
    const calls: string[] = [];
    const { hooks: hookOverrides, ...rest } = overrides;
    // Assigned below; the hooks only run once the session exists.
    let session: GatedWsSession;
    const hooks: GatedWsSessionHooks = {
      configure: (ws, { reconnect }) => {
        calls.push(reconnect ? 'configure(reconnect)' : 'configure');
        ws.send(JSON.stringify({ type: 'configure', reconnect }));
      },
      onMessage: (data) => {
        const frame = JSON.parse(data.toString()) as ServerFrame;
        switch (frame.type) {
          case 'ready':
            session.markReady();
            break;
          case 'text':
            session.emit({ type: 'source-subtitle-delta', text: frame.text ?? '' });
            break;
          case 'done':
            session.complete('server finished');
            break;
          case 'error':
            session.fail(
              session.error(frame.kind ?? 'protocol', frame.message ?? 'error', {
                providerCode: frame.code
              })
            );
            break;
        }
      },
      flush: () => {
        calls.push('flush');
        session.emit({ type: 'source-subtitle-final', text: 'flushed', startMs: 0, endMs: 0 });
      },
      onEnd: () => calls.push('end'),
      ...hookOverrides
    };
    session = new GatedWsSession({
      label: 'Toy',
      readyEvent: 'ready',
      configureFrame: 'configure',
      timing: DEFAULT_WS_TIMING,
      tag: () => 'Toy[]',
      onEvent: (e) => events.push(e),
      hooks,
      ...rest,
      provider: rest.provider ?? 'mock'
    });
    sessions.push(session);
    const types = () => events.map((e) => e.type);
    return { session, events, calls, types };
  };

  /** open() through the ready event. */
  const openedSession = async (overrides: Parameters<typeof makeSession>[0] = {}) => {
    server ??= await startServer();
    const ctx = makeSession(overrides);
    const opened = ctx.session.open({ url: server.url });
    const conn = await server.nextConnection();
    await conn.waitForConfigure();
    conn.send({ type: 'ready' });
    await opened;
    return { ...ctx, conn };
  };

  describe('start', () => {
    it('resolves only on markReady() and emits session-started once', async () => {
      server = await startServer();
      const { session, types, calls } = makeSession();
      let resolved = false;
      const opened = session.open({ url: server.url }).then(() => {
        resolved = true;
      });
      const conn = await server.nextConnection();
      await conn.waitForConfigure();
      await sleep(20);
      expect(resolved).toBe(false);

      conn.send({ type: 'ready' });
      conn.send({ type: 'ready' }); // a duplicate ready changes nothing
      await opened;
      await sleep(20);
      expect(types()).toEqual(['session-started']);
      expect(calls).toEqual(['configure']);
      expect(session.isReady).toBe(true);
    });

    it('rejects before ready with the code and trace id, closes the socket, emits nothing', async () => {
      server = await startServer();
      const { session, events } = makeSession({ traceLabel: 'logid' });
      const opened = session.open({ url: server.url });
      const conn = await server.nextConnection();
      await conn.waitForConfigure();
      conn.send({ type: 'error', code: 45_000_001, message: 'bad params' });

      const err = await opened.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TranslationError);
      expect(err).toMatchObject({
        message: 'Toy handshake failed (code=45000001, logid=n/a): bad params',
        kind: 'protocol',
        provider: 'mock',
        code: 45_000_001
      });
      await conn.closed;
      expect(events).toEqual([]);
      expect(session.isEnded).toBe(true);
    });

    it('rejects when the ready event never comes', async () => {
      server = await startServer();
      const { session, events } = makeSession({
        timing: { ...DEFAULT_WS_TIMING, sessionReadyTimeoutMs: 40 }
      });
      const opened = session.open({ url: server.url });
      const conn = await server.nextConnection();
      const err = await opened.catch((e: unknown) => e);
      expect(err).toMatchObject({
        kind: 'timeout',
        message: 'Toy handshake failed: timed out after 40ms waiting for ready'
      });
      await conn.closed;
      expect(events).toEqual([]);
    });

    it('a refused upgrade rejects with the kind of its HTTP status', async () => {
      server = await startServer({ verifyClient: (_info, cb) => cb(false, 429, 'slow down') });
      const { session } = makeSession();
      const err = await session.open({ url: server.url }).catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'quota', httpStatus: 429, provider: 'mock' });
      expect((err as Error).message).toMatch(/Toy handshake rejected \(HTTP 429\): slow down/);
    });

    it('fails the attempt when configure throws', async () => {
      server = await startServer();
      const { session } = makeSession({
        hooks: {
          configure: () => {
            throw new Error('encode broke');
          }
        }
      });
      const err = await session.open({ url: server.url }).catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'unknown' });
      expect((err as Error).message).toMatch(/failed to send configure: encode broke/);
    });

    it('a rejection of the work run alongside the handshake fails start()', async () => {
      server = await startServer();
      const { session } = makeSession();
      const err = await session
        .open({ url: server.url, alongside: Promise.reject(new Error('proto missing')) })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TranslationError);
      expect(err).toMatchObject({ kind: 'unknown', message: 'proto missing' });
      expect(session.isEnded).toBe(true);
    });

    it('a failing proxy lookup rejects start() as a network error', async () => {
      const { session } = makeSession();
      const err = await session
        .open({
          url: 'ws://127.0.0.1:9/never',
          resolveAgent: async () => {
            throw new Error('pac broke');
          }
        })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'network', message: 'pac broke' });
    });
  });

  describe('single use + cancel latch', () => {
    it('a second start rejects, live or over', async () => {
      const { session, conn } = await openedSession();
      await expect(session.open({ url: server!.url })).rejects.toThrow('Toy session already started');
      expect(() => session.claim()).toThrow('Toy session already started');
      conn.send({ type: 'done' });
      await conn.closed;
      await expect(session.open({ url: server!.url })).rejects.toThrow('Toy session already started');
      // Still one connection: the rejected starts opened nothing.
      expect(server!.connections).toHaveLength(1);
    });

    it('cancel() before start makes start() reject without connecting', async () => {
      server = await startServer();
      const { session, events } = makeSession();
      session.cancel();
      await expect(session.open({ url: server.url })).rejects.toThrow(
        'Toy session canceled before ready'
      );
      await sleep(20);
      expect(server.connections).toHaveLength(0);
      expect(events).toEqual([]);
    });

    it('cancel() during CONNECTING rejects start() and the late upgrade revives nothing', async () => {
      let release: ((ok: boolean) => void) | undefined;
      server = await startServer({
        verifyClient: (_info, cb) => {
          release = cb;
        }
      });
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const { session, events } = makeSession();
        const opened = session.open({ url: server.url });
        await vi.waitFor(() => expect(release).toBeDefined(), { interval: 5 });
        session.cancel();
        await expect(opened).rejects.toThrow('Toy session canceled before ready');
        release!(true);
        await sleep(30);
        expect(unhandled).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        session.cancel(); // idempotent
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('cancel() while awaiting ready rejects start() and closes the socket', async () => {
      server = await startServer();
      const { session, events, calls } = makeSession();
      const opened = session.open({ url: server.url });
      const conn = await server.nextConnection();
      await conn.waitForConfigure();
      session.cancel();
      await expect(opened).rejects.toThrow('Toy session canceled before ready');
      await conn.closed;
      expect(events).toEqual([]);
      expect(calls).toEqual(['configure', 'end']);
    });

    it('cancel() during the proxy lookup rejects start() right away', async () => {
      const { session } = makeSession();
      const opened = session.open({
        url: 'ws://127.0.0.1:9/never',
        resolveAgent: () => new Promise(() => undefined)
      });
      await sleep(10);
      session.cancel();
      await expect(opened).rejects.toThrow('Toy session canceled before ready');
    });

    it('emits nothing after cancel(), whatever the server still sends', async () => {
      const { session, conn, types } = await openedSession();
      session.cancel();
      conn.send({ type: 'text', text: 'late' });
      conn.send({ type: 'done' });
      await conn.closed;
      await sleep(20);
      expect(types()).toEqual(['session-started']);
    });

    it('closeOnCancel can take over closing, and still sees frames after the end', async () => {
      const after: string[] = [];
      const { session, conn } = await openedSession({
        hooks: {
          closeOnCancel: () => true,
          onMessageAfterEnd: (data, ws) => {
            after.push(JSON.parse(data.toString()).type);
            ws.close(1000, 'acked');
          }
        }
      });
      session.cancel();
      await sleep(20);
      expect(conn.socket.readyState).toBe(WebSocket.OPEN);
      conn.send({ type: 'done' });
      await conn.closed;
      expect(after).toEqual(['done']);
    });
  });

  describe('after ready', () => {
    it('a failure emits exactly one session-failed (with the trace id) and closes', async () => {
      const { conn, events, types } = await openedSession({ traceLabel: 'logid' });
      conn.send({ type: 'error', code: 55_000_031, message: 'server busy', kind: 'server' });
      conn.send({ type: 'error', code: 1, message: 'again' });
      await conn.closed;
      await sleep(20);
      expect(types()).toEqual(['session-started', 'session-failed']);
      // No trace header configured, so nothing to append.
      expect(events[1]).toEqual({
        type: 'session-failed',
        kind: 'server',
        code: 55_000_031,
        message: 'server busy'
      });
    });

    it('a failure without a numeric code carries none', async () => {
      const { conn, events } = await openedSession();
      conn.send({ type: 'error', message: 'nope', kind: 'auth' });
      await conn.closed;
      expect(events.at(-1)).toEqual({ type: 'session-failed', kind: 'auth', message: 'nope' });
    });

    it('complete() flushes, then emits session-finished, then closes', async () => {
      const { conn, types, calls } = await openedSession();
      conn.send({ type: 'done' });
      await conn.closed;
      expect(types()).toEqual(['session-started', 'source-subtitle-final', 'session-finished']);
      expect(calls).toEqual(['configure', 'flush', 'end']);
    });

    it('a clean 1000 close after finish ends the session; other closes fail it', async () => {
      const a = await openedSession();
      expect(a.session.beginFinish()).toBeInstanceOf(WebSocket);
      expect(a.session.beginFinish()).toBeNull(); // idempotent
      a.conn.socket.close(1000, 'bye');
      await vi.waitFor(() => expect(a.types()).toContain('session-finished'), { interval: 5 });

      const b = await openedSession();
      b.session.beginFinish();
      b.conn.socket.close(1011, 'internal');
      await vi.waitFor(() => expect(b.types()).toContain('session-failed'), { interval: 5 });
      expect(b.events.at(-1)).toEqual({
        type: 'session-failed',
        kind: 'server',
        code: 1011,
        message: 'ws closed: internal'
      });

      const c = await openedSession();
      c.conn.socket.close(1000, 'idle'); // no finish(): not the end we asked for
      await vi.waitFor(() => expect(c.types()).toContain('session-failed'), { interval: 5 });
      expect(c.events.at(-1)).toMatchObject({ kind: 'network', code: 1000 });
    });

    it('closeEndsFinish can accept any close after finish', async () => {
      const { session, conn, types } = await openedSession({
        hooks: { closeEndsFinish: () => true }
      });
      session.beginFinish();
      conn.socket.close(1011, 'whatever');
      await vi.waitFor(() => expect(types()).toContain('session-finished'), { interval: 5 });
      expect(types()).not.toContain('session-failed');
    });

    it('fails when the server stops answering pings', async () => {
      server = await startServer({ autoPong: false });
      const { events } = await openedSession({
        timing: { ...DEFAULT_WS_TIMING, keepaliveIntervalMs: 10, keepaliveTimeoutMs: 60 }
      });
      await vi.waitFor(() => expect(events.map((e) => e.type)).toContain('session-failed'), {
        timeout: 1000,
        interval: 5
      });
      expect(events.at(-1)).toEqual({
        type: 'session-failed',
        kind: 'network',
        message: expect.stringMatching(/no response from server/)
      });
    });

    it('takes its listeners off the socket once it closed', async () => {
      const { session, conn } = await openedSession();
      const ws = session.socket!;
      expect(ws.listenerCount('message')).toBeGreaterThan(0);
      conn.send({ type: 'done' });
      await vi.waitFor(() => expect(ws.readyState).toBe(WebSocket.CLOSED), { interval: 5 });
      await sleep(10);
      expect(ws.listenerCount('message')).toBe(0);
      expect(ws.listenerCount('close')).toBe(0);
    });
  });

  describe('audio gate', () => {
    it('throws before connecting, then drops quietly once finishing or over', async () => {
      const fresh = makeSession();
      expect(() => fresh.session.admitAudio()).toThrow('Toy session not connected');

      const { session } = await openedSession();
      expect(session.admitAudio()).toBe(true);
      expect(session.audioSocket()).toBeInstanceOf(WebSocket);
      session.beginFinish();
      expect(session.admitAudio()).toBe(false);
      session.cancel();
      expect(session.admitAudio()).toBe(false);
    });

    it('audioSocket() is null while the send buffer is backed up', async () => {
      const { session } = await openedSession();
      const ws = session.socket!;
      let buffered = 10 * 1024 * 1024;
      Object.defineProperty(ws, 'bufferedAmount', { get: () => buffered });
      expect(session.audioSocket()).toBeNull();
      buffered = 0;
      expect(session.audioSocket()).toBe(ws);
    });
  });

  describe('opt-in reconnect', () => {
    const policy = (maxAttempts = 2) =>
      new ReconnectPolicy({ maxAttempts, stableAfterMs: 60_000, fatalCloseCodes: new Set([1008]) });

    it('replaces a dropped live connection without a second session-started', async () => {
      const lost = vi.fn();
      const { session, conn, types, calls } = await openedSession({
        reconnect: policy(),
        hooks: { onLinkLost: lost }
      });
      conn.socket.close(1011, 'internal');

      const next = await server!.nextConnection();
      await next.waitForConfigure();
      expect(next.received[0]).toEqual({ type: 'configure', reconnect: true });
      expect(lost).toHaveBeenCalledTimes(1);
      // The gap: audio is dropped quietly, not thrown at the caller.
      expect(session.admitAudio()).toBe(false);

      next.send({ type: 'ready' });
      await vi.waitFor(() => expect(session.admitAudio()).toBe(true), { interval: 5 });
      next.send({ type: 'text', text: 'still here' });
      await vi.waitFor(() => expect(types()).toContain('source-subtitle-delta'), { interval: 5 });
      expect(types()).toEqual(['session-started', 'source-subtitle-delta']);
      expect(calls).toEqual(['configure', 'configure(reconnect)']);
    });

    it('fails once the budget is spent, or on a fatal close', async () => {
      const a = await openedSession({ reconnect: policy(1) });
      a.conn.socket.close(1011, 'internal');
      const second = await server!.nextConnection();
      await second.waitForConfigure();
      second.send({ type: 'ready' });
      await vi.waitFor(() => expect(a.session.admitAudio()).toBe(true), { interval: 5 });
      second.socket.close(1011, 'internal again');
      await vi.waitFor(() => expect(a.types()).toContain('session-failed'), { interval: 5 });
      expect(a.events.at(-1)).toMatchObject({ kind: 'server', code: 1011 });

      const b = await openedSession({ reconnect: policy() });
      b.conn.socket.close(1008, 'API key not valid');
      await vi.waitFor(() => expect(b.types()).toContain('session-failed'), { interval: 5 });
      expect(b.events.at(-1)).toMatchObject({ kind: 'auth', code: 1008 });
    });

    it('never retries a drop a new connection cannot fix (auth / quota / protocol)', async () => {
      const { conn, types, events } = await openedSession({ reconnect: policy() });
      // 1011 alone would be retried; the reason says it's a quota problem.
      conn.socket.close(1011, 'Quota exceeded');
      await vi.waitFor(() => expect(types()).toContain('session-failed'), { interval: 5 });
      expect(events.at(-1)).toMatchObject({ kind: 'quota', code: 1011 });
      await sleep(20);
      expect(server!.connections).toHaveLength(1);
    });

    it('retries a replacement that fails before ready, backing off, from the same budget', async () => {
      let upgrades = 0;
      server = await startServer({
        // The first replacement is refused outright: the link is still down.
        verifyClient: (_info, done) => {
          upgrades++;
          if (upgrades === 2) done(false, 503, 'Service Unavailable');
          else done(true);
        }
      });
      const retryBackoffMs = vi.fn(() => 10);
      const { session, conn, types, calls } = await openedSession({
        reconnect: new ReconnectPolicy({ maxAttempts: 3, stableAfterMs: 60_000, retryBackoffMs }),
        timing: { ...DEFAULT_WS_TIMING, sessionReadyTimeoutMs: 80 }
      });
      conn.socket.close(1011, 'internal');

      // The next one opens but never answers configure: the ready timeout
      // gives up on it.
      const silent = await server.nextConnection();
      await silent.waitForConfigure();
      await silent.closed;

      const next = await server.nextConnection();
      await next.waitForConfigure();
      next.send({ type: 'ready' });
      await vi.waitFor(() => expect(session.admitAudio()).toBe(true), { interval: 5 });
      next.send({ type: 'text', text: 'back' });
      await vi.waitFor(() => expect(types()).toContain('source-subtitle-delta'), { interval: 5 });

      expect(upgrades).toBe(4);
      expect(retryBackoffMs.mock.calls).toEqual([[1], [2]]);
      expect(types()).toEqual(['session-started', 'source-subtitle-delta']);
      expect(calls).toEqual(['configure', 'configure(reconnect)', 'configure(reconnect)']);
    });

    it('fails once failed replacements spend the budget', async () => {
      const { conn, types, events } = await openedSession({
        reconnect: new ReconnectPolicy({ maxAttempts: 2, stableAfterMs: 60_000, retryBackoffMs: () => 10 })
      });
      conn.socket.close(1011, 'internal');
      for (let i = 0; i < 2; i++) {
        const next = await server!.nextConnection();
        await next.waitForConfigure();
        next.socket.close(1013, 'try again later');
      }
      await vi.waitFor(() => expect(types()).toContain('session-failed'), { interval: 5 });
      expect(types()).toEqual(['session-started', 'session-failed']);
      expect(events.at(-1)).toMatchObject({ kind: 'server', code: 1013 });
      await sleep(30);
      expect(server!.connections).toHaveLength(3);
    });

    it('cancel() during a retry back-off stops trying', async () => {
      const { session, conn } = await openedSession({
        reconnect: new ReconnectPolicy({ maxAttempts: 3, stableAfterMs: 60_000, retryBackoffMs: () => 60 })
      });
      conn.socket.close(1011, 'internal');
      const next = await server!.nextConnection();
      await next.waitForConfigure();
      next.socket.close(1011, 'internal');
      await next.closed;
      await sleep(20);
      session.cancel();
      await sleep(100);
      expect(server!.connections).toHaveLength(2);
    });

    it('a replacement refused for a reason a new one cannot fix ends the session', async () => {
      const { conn, types } = await openedSession({ reconnect: policy() });
      conn.socket.close(1011, 'internal');
      const next = await server!.nextConnection();
      await next.waitForConfigure();
      next.send({ type: 'error', code: 401, message: 'denied', kind: 'auth' });
      await vi.waitFor(() => expect(types()).toContain('session-failed'), { interval: 5 });
      expect(types()).toEqual(['session-started', 'session-failed']);
    });

    it('finish() during the gap completes right away', async () => {
      const { session, conn, types } = await openedSession({
        reconnect: new ReconnectPolicy({
          maxAttempts: 2,
          stableAfterMs: 60_000,
          backoffMs: () => 10_000
        })
      });
      conn.socket.close(1011, 'internal');
      await vi.waitFor(() => expect(session.admitAudio()).toBe(false), { interval: 5 });
      expect(session.beginFinish()).toBeNull();
      expect(types().at(-1)).toBe('session-finished');
      await sleep(20);
      expect(server!.connections).toHaveLength(1);
    });

    it('is off by default: a drop fails the session', async () => {
      const { conn, types } = await openedSession();
      conn.socket.close(1011, 'internal');
      await vi.waitFor(() => expect(types()).toContain('session-failed'), { interval: 5 });
      await sleep(20);
      expect(server!.connections).toHaveLength(1);
    });
  });
});
