import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  WebSocket,
  WebSocketServer,
  type ServerOptions,
  type WebSocket as ServerSocket
} from 'ws';

// proto-loader reads `app.isPackaged`; the vault pulls in electron-store.
vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('./credential-vault.js', () => ({
  getDoubaoCredentials: () => ({
    appKey: 'test-app',
    accessKey: 'test-access',
    resourceId: 'test-resource'
  }),
  MissingCredentialsError: class MissingCredentialsError extends Error {}
}));

import { setLogSink } from '@core/utils/logger.js';
import { ProtoEvent } from '@shared/proto-events.js';
import { getProtoTypes, type ProtoTypes } from './proto-loader.js';
import {
  DoubaoClient,
  doubaoErrorKind,
  type DoubaoClientOptions
} from './doubao-client.js';
import type { DoubaoStartParams, TranslationEventBody } from './translation-client.js';

const PARAMS: DoubaoStartParams = {
  engineId: 'doubao',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  mode: 's2t'
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

let types: ProtoTypes;

/** Server side of one client connection, speaking just enough protocol. */
interface FakeConn {
  socket: ServerSocket;
  /** Events of every TranslateRequest received, in order. */
  requests: number[];
  /** SessionID of every TranslateRequest received, in the same order. */
  sessionIds: string[];
  /** Resolves once the server sees the connection close. */
  closed: Promise<void>;
  send(event: number, meta?: { StatusCode?: number; Message?: string }): void;
  waitForRequest(event: number): Promise<void>;
}

interface FakeServer {
  url: string;
  nextConnection(): Promise<FakeConn>;
  /** Connections accepted so far. */
  connectionCount(): number;
  close(): Promise<void>;
}

const wrapConnection = (socket: ServerSocket): FakeConn => {
  const requests: number[] = [];
  const sessionIds: string[] = [];
  socket.on('message', (data) => {
    const req = types.TranslateRequest.decode(data as Buffer) as unknown as {
      event: number;
      request_meta?: { SessionID?: string };
    };
    requests.push(req.event);
    sessionIds.push(req.request_meta?.SessionID ?? '');
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  return {
    socket,
    requests,
    sessionIds,
    closed,
    send(event, meta) {
      socket.send(
        types.TranslateResponse.encode({
          event,
          ...(meta ? { response_meta: meta } : {})
        }).finish()
      );
    },
    waitForRequest: (event) =>
      vi.waitFor(() => expect(requests).toContain(event), { timeout: 2000, interval: 5 })
  };
};

const startServer = async (opts: ServerOptions = {}): Promise<FakeServer> => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', ...opts });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const ready: FakeConn[] = [];
  const waiters: Array<(conn: FakeConn) => void> = [];
  let accepted = 0;
  wss.on('connection', (socket) => {
    accepted++;
    const conn = wrapConnection(socket);
    const waiter = waiters.shift();
    if (waiter) waiter(conn);
    else ready.push(conn);
  });
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    nextConnection: () => {
      const conn = ready.shift();
      return conn ? Promise.resolve(conn) : new Promise((resolve) => waiters.push(resolve));
    },
    connectionCount: () => accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      })
  };
};

/** Run `fn` and fail if any promise rejection went unhandled meanwhile. */
const withUnhandledRejectionSpy = async (fn: () => Promise<void>): Promise<void> => {
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    await fn();
    // unhandledRejection fires after the microtask queue drains.
    await sleep(20);
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    process.off('unhandledRejection', unhandled);
  }
};

describe('DoubaoClient', () => {
  let server: FakeServer | null = null;
  let tcpServer: Server | null = null;
  let events: TranslationEventBody[] = [];
  const onEvent = (e: TranslationEventBody): void => {
    events.push(e);
  };
  let clients: DoubaoClient[] = [];
  const makeClient = (opts: Omit<DoubaoClientOptions, 'onEvent'>): DoubaoClient => {
    const client = new DoubaoClient({ onEvent, ...opts });
    clients.push(client);
    return client;
  };

  beforeAll(async () => {
    setLogSink({ info() {}, warn() {}, error() {}, debug() {} });
    types = await getProtoTypes();
  });

  afterEach(async () => {
    // Cancel first so closing the server can't make a still-live client of
    // this test report a session-failed into the next test.
    await Promise.all(clients.map((c) => c.cancel()));
    clients = [];
    events = [];
    await server?.close();
    server = null;
    await new Promise<void>((resolve) =>
      tcpServer ? tcpServer.close(() => resolve()) : resolve()
    );
    tcpServer = null;
  });

  /** start() through SessionStarted. */
  const startedClient = async (): Promise<{ client: DoubaoClient; conn: FakeConn }> => {
    server = await startServer();
    const client = makeClient({ endpoint: server.url });
    const started = client.start(PARAMS);
    const conn = await server.nextConnection();
    await conn.waitForRequest(ProtoEvent.StartSession);
    conn.send(ProtoEvent.SessionStarted);
    await started;
    return { client, conn };
  };

  describe('start() settles on pre-SessionStarted failures (item 1) and closes the socket (item 2)', () => {
    it('rejects with the server code/message on SessionFailed', async () => {
      server = await startServer();
      const client = makeClient({ endpoint: server.url });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitForRequest(ProtoEvent.StartSession);

      conn.send(ProtoEvent.SessionFailed, {
        StatusCode: 45_000_001,
        Message: 'invalid language pair'
      });

      const err = await started.catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/code=45000001.*invalid language pair/);
      expect(err).toMatchObject({ kind: 'protocol', provider: 'doubao', code: 45_000_001 });
      await conn.closed;
      expect(events).toEqual([]);
      // cancel() after the failure is a harmless no-op.
      await client.cancel();
    });

    it('rejects on a non-success status frame', async () => {
      server = await startServer();
      const client = makeClient({ endpoint: server.url });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitForRequest(ProtoEvent.StartSession);

      conn.send(ProtoEvent.None, { StatusCode: 55_000_031, Message: 'server busy' });

      await expect(started).rejects.toThrow(/code=55000031.*server busy/);
      await expect(started).rejects.toMatchObject({ kind: 'server' });
      await conn.closed;
      expect(events).toEqual([]);
    });

    it('rejects when SessionStarted never arrives (ready timeout)', async () => {
      server = await startServer();
      const client = makeClient({
        endpoint: server.url,
        timing: { sessionReadyTimeoutMs: 50 }
      });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();

      await expect(started).rejects.toThrow(/timed out after 50ms waiting for SessionStarted/);
      await expect(started).rejects.toMatchObject({ kind: 'timeout' });
      await conn.closed;
      expect(events).toEqual([]);
    });
  });

  describe('handshake failures carry server detail (item 6) and time out (item 4)', () => {
    it('includes HTTP status, body and X-Tt-Logid of a rejected upgrade', async () => {
      server = await startServer({
        verifyClient: (_info, cb) =>
          cb(false, 403, 'invalid X-Api-Access-Key', { 'X-Tt-Logid': 'LOG-123' })
      });
      const client = makeClient({ endpoint: server.url });

      const err = await client.start(PARAMS).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/HTTP 403/);
      expect((err as Error).message).toMatch(/logid=LOG-123/);
      expect((err as Error).message).toMatch(/invalid X-Api-Access-Key/);
      expect(err).toMatchObject({ kind: 'auth', httpStatus: 403, provider: 'doubao' });
      // The key itself never ends up in the message.
      expect((err as Error).message).not.toMatch(/test-access/);
    });

    it('rejects when the server never answers the upgrade', async () => {
      // Accepts TCP, never speaks HTTP. resume() drains the request so the
      // server sees the client's FIN once it gives up.
      tcpServer = createServer((socket) => socket.resume());
      await new Promise<void>((resolve) => tcpServer!.listen(0, '127.0.0.1', () => resolve()));
      const port = (tcpServer.address() as AddressInfo).port;
      const client = makeClient({
        endpoint: `ws://127.0.0.1:${port}`,
        timing: { handshakeTimeoutMs: 50 }
      });

      const err = await client.start(PARAMS).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/handshake timed out after 50ms/);
      expect(err).toMatchObject({ kind: 'timeout' });
    });
  });

  describe('cancel() during start (item 3)', () => {
    it('during CONNECTING: rejects start() without unhandled rejections or late sends', async () => {
      let release: ((ok: boolean) => void) | undefined;
      server = await startServer({
        verifyClient: (_info, cb) => {
          release = cb;
        }
      });
      await withUnhandledRejectionSpy(async () => {
        const client = makeClient({ endpoint: server!.url });
        const started = client.start(PARAMS);
        // The upgrade request reached the server; the client is CONNECTING.
        await vi.waitFor(() => expect(release).toBeDefined(), { interval: 5 });

        await client.cancel();
        await expect(started).rejects.toThrow(/canceled before SessionStarted/);

        // Letting the server accept now must not revive the session.
        release!(true);
        await sleep(30);
        expect(events).toEqual([]);
        await client.cancel(); // idempotent
      });
    });

    it('while awaiting SessionStarted: rejects start() and sends CancelSession', async () => {
      server = await startServer();
      await withUnhandledRejectionSpy(async () => {
        const client = makeClient({ endpoint: server!.url });
        const started = client.start(PARAMS);
        const conn = await server!.nextConnection();
        await conn.waitForRequest(ProtoEvent.StartSession);

        await client.cancel();
        await expect(started).rejects.toThrow(/canceled before SessionStarted/);
        await conn.waitForRequest(ProtoEvent.CancelSession);
        expect(events).toEqual([]);
      });
    });
  });

  describe('unified lifecycle (GatedWsSession)', () => {
    it('cancel() before start() makes start() reject without connecting', async () => {
      server = await startServer();
      const client = makeClient({ endpoint: server.url });
      await client.cancel();
      await expect(client.start(PARAMS)).rejects.toThrow(/canceled before SessionStarted/);
      await sleep(20);
      expect(server.connectionCount()).toBe(0);
      expect(events).toEqual([]);
    });

    it('a second start() rejects, while live and after the session ended', async () => {
      const { client, conn } = await startedClient();
      await expect(client.start(PARAMS)).rejects.toThrow('Doubao session already started');
      conn.send(ProtoEvent.SessionFinished);
      await conn.closed;
      await expect(client.start(PARAMS)).rejects.toThrow('Doubao session already started');
      expect(server!.connectionCount()).toBe(1);
      expect(events.map((e) => e.type)).toEqual(['session-started', 'session-finished']);
    });

    it('a second start() after a failed one rejects instead of reusing the client', async () => {
      server = await startServer();
      const client = makeClient({ endpoint: server.url });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitForRequest(ProtoEvent.StartSession);
      conn.send(ProtoEvent.SessionFailed, { StatusCode: 45_000_001, Message: 'bad' });
      await expect(started).rejects.toThrow(/bad/);
      // The old socket's late close can't leak into a new session either.
      await expect(client.start(PARAMS)).rejects.toThrow('Doubao session already started');
      await conn.closed;
      expect(events).toEqual([]);
    });
  });

  describe('contract (item 8)', () => {
    it('finish() is idempotent: exactly one FinishSession reaches the server', async () => {
      const { client, conn } = await startedClient();

      await client.finish();
      await client.finish();
      await conn.waitForRequest(ProtoEvent.FinishSession);
      await sleep(20);

      expect(conn.requests.filter((e) => e === ProtoEvent.FinishSession)).toHaveLength(1);

      conn.send(ProtoEvent.SessionFinished);
      await conn.closed;
      expect(events.map((e) => e.type)).toEqual(['session-started', 'session-finished']);
      // finish() after the session ended sends nothing.
      await client.finish();
    });

    it('emits nothing after cancel(), even when the server acks with SessionCanceled', async () => {
      const { client, conn } = await startedClient();

      await client.cancel();
      await conn.waitForRequest(ProtoEvent.CancelSession);
      conn.send(ProtoEvent.SourceSubtitleResponse);
      conn.send(ProtoEvent.SessionCanceled);
      // The ack closes the socket right away (well inside the 1.5 s grace).
      await conn.closed;

      expect(events.map((e) => e.type)).toEqual(['session-started']);
    });
  });

  describe('server closes after FinishSession (B42)', () => {
    it('treats a clean 1000 close in place of SessionFinished as finished', async () => {
      const { client, conn } = await startedClient();
      await client.finish();
      await conn.waitForRequest(ProtoEvent.FinishSession);
      conn.socket.close(1000, 'bye');

      await vi.waitFor(
        () => expect(events.map((e) => e.type)).toContain('session-finished'),
        { interval: 5 }
      );
      expect(events.map((e) => e.type)).toEqual(['session-started', 'session-finished']);
    });

    it('still fails on an abnormal close after FinishSession', async () => {
      const { client, conn } = await startedClient();
      await client.finish();
      await conn.waitForRequest(ProtoEvent.FinishSession);
      conn.socket.close(1011, 'internal');

      await vi.waitFor(
        () => expect(events.map((e) => e.type)).toContain('session-failed'),
        { interval: 5 }
      );
      expect(events.map((e) => e.type)).not.toContain('session-finished');
      expect(events.at(-1)).toMatchObject({ kind: 'server', code: 1011 });
    });
  });

  describe('sendAudio outside the live window (F14)', () => {
    it('drops audio quietly after finish() and cancel()', async () => {
      const { client, conn } = await startedClient();
      await client.finish();
      await expect(client.sendAudio(new Uint8Array(4))).resolves.toBeUndefined();
      await client.cancel();
      await expect(client.sendAudio(new Uint8Array(4))).resolves.toBeUndefined();
      await sleep(20);
      expect(conn.requests).not.toContain(ProtoEvent.TaskRequest);
    });

    it('drops audio while the socket is closing, warning once', async () => {
      const warn = vi.fn();
      setLogSink({ info() {}, warn, error() {}, debug() {} });
      try {
        const { client } = await startedClient();
        const ws = (client as unknown as { session: { socket: WebSocket } }).session.socket;
        Object.defineProperty(ws, 'readyState', { get: () => WebSocket.CLOSING });
        for (let i = 0; i < 5; i++) {
          await expect(client.sendAudio(new Uint8Array(4))).resolves.toBeUndefined();
        }
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        setLogSink({ info() {}, warn() {}, error() {}, debug() {} });
      }
    });

    it('still rejects audio before start()', async () => {
      const client = makeClient({ endpoint: 'ws://127.0.0.1:9' });
      await expect(client.sendAudio(new Uint8Array(4))).rejects.toThrow(/not connected/);
    });
  });

  describe('TTS audio stays on whole samples', () => {
    it('carries an odd byte into the next chunk and drops it at sentence end', async () => {
      const { conn } = await startedClient();
      const tts = (data: number[]): void => {
        conn.socket.send(
          types.TranslateResponse.encode({
            event: ProtoEvent.TTSResponse,
            data: Uint8Array.from(data)
          }).finish()
        );
      };
      conn.send(ProtoEvent.TTSSentenceStart);
      tts([1, 2, 3]);
      tts([4, 5, 6]);
      tts([7]);
      conn.send(ProtoEvent.TTSSentenceEnd);
      conn.send(ProtoEvent.TTSSentenceStart);
      tts([8, 9]);

      await vi.waitFor(
        () => expect(events.filter((e) => e.type === 'tts-audio')).toHaveLength(3),
        { interval: 5 }
      );
      const chunks = events.flatMap((e) =>
        e.type === 'tts-audio' ? [[...new Uint8Array(e.data)]] : []
      );
      expect(chunks).toEqual([[1, 2], [3, 4, 5, 6], [8, 9]]);
    });
  });

  describe('error kinds', () => {
    it('a SessionFailed after SessionStarted carries its status code and kind', async () => {
      const { conn } = await startedClient();
      conn.send(ProtoEvent.SessionFailed, { StatusCode: 55_000_031, Message: 'server busy' });
      await vi.waitFor(
        () => expect(events.map((e) => e.type)).toContain('session-failed'),
        { interval: 5 }
      );
      expect(events.at(-1)).toEqual({
        type: 'session-failed',
        kind: 'server',
        code: 55_000_031,
        message: 'server busy'
      });
    });

    it('maps the documented business codes', () => {
      expect(doubaoErrorKind(45_000_001, 'invalid param')).toBe('protocol');
      expect(doubaoErrorKind(45_000_002, 'empty audio')).toBe('protocol');
      expect(doubaoErrorKind(45_000_081, 'wait packet timeout')).toBe('timeout');
      expect(doubaoErrorKind(45_000_151, 'bad audio format')).toBe('protocol');
      expect(doubaoErrorKind(55_000_031, 'server busy')).toBe('server');
      expect(doubaoErrorKind(55_000_001, 'internal')).toBe('server');
      expect(doubaoErrorKind(45_000_030, 'quota exceeded for types: concurrency')).toBe('quota');
      expect(doubaoErrorKind(45_000_010, 'invalid X-Api-Access-Key')).toBe('auth');
      expect(doubaoErrorKind(0, 'session failed')).toBe('unknown');
    });
  });

  describe('reconnect', () => {
    const subtitle = (conn: FakeConn, event: number, text = '', startMs = 0, endMs = 0): void => {
      conn.socket.send(
        types.TranslateResponse.encode({ event, text, start_time: startMs, end_time: endMs }).finish()
      );
    };
    const finalTexts = (type: 'source-subtitle-final' | 'translation-subtitle-final'): string[] =>
      events.flatMap((e) => (e.type === type ? [e.text] : []));
    const eventTypes = (): string[] => events.map((e) => e.type);

    it('replaces a dropped connection with a new server session, closing what the old one left open', async () => {
      const { client, conn } = await startedClient();
      subtitle(conn, ProtoEvent.SourceSubtitleStart, '', 100);
      subtitle(conn, ProtoEvent.SourceSubtitleEnd, '你好', 100, 900);
      subtitle(conn, ProtoEvent.TranslationSubtitleStart, '', 100);
      subtitle(conn, ProtoEvent.TranslationSubtitleResponse, 'Hel');
      subtitle(conn, ProtoEvent.SourceSubtitleStart, '', 1000);
      subtitle(conn, ProtoEvent.SourceSubtitleResponse, '再见');
      conn.send(ProtoEvent.TTSSentenceStart);
      await vi.waitFor(() => expect(eventTypes()).toContain('tts-sentence-start'), { interval: 5 });
      conn.socket.close(1011, 'internal');

      const next = await server!.nextConnection();
      await next.waitForRequest(ProtoEvent.StartSession);
      // Closed on what the renderer showed; the short side padded so the
      // FIFO pairing stays aligned.
      expect(finalTexts('source-subtitle-final')).toEqual(['你好', '再见']);
      expect(finalTexts('translation-subtitle-final')).toEqual(['Hel', '']);
      expect(eventTypes().at(-1)).toBe('tts-sentence-end');
      expect(next.sessionIds[0]).not.toBe(conn.sessionIds[0]);

      next.send(ProtoEvent.SessionStarted);
      await vi.waitFor(async () => {
        await client.sendAudio(new Uint8Array(4));
        expect(next.requests).toContain(ProtoEvent.TaskRequest);
      }, { interval: 5 });
      expect(next.sessionIds.at(-1)).toBe(next.sessionIds[0]);
      subtitle(next, ProtoEvent.SourceSubtitleStart);
      subtitle(next, ProtoEvent.SourceSubtitleResponse, 'again');
      await vi.waitFor(
        () => expect(events.at(-1)).toEqual({ type: 'source-subtitle-delta', text: 'again' }),
        { interval: 5 }
      );
      expect(eventTypes().filter((t) => t === 'session-started')).toHaveLength(1);
      expect(eventTypes()).not.toContain('session-failed');
    });

    it('drops an empty translation no source line waits for, and pads nothing for it', async () => {
      const { conn } = await startedClient();
      subtitle(conn, ProtoEvent.SourceSubtitleEnd, '你好', 100, 900);
      subtitle(conn, ProtoEvent.TranslationSubtitleEnd, 'Hello', 100, 900);
      subtitle(conn, ProtoEvent.TranslationSubtitleStart, '', 1000);
      subtitle(conn, ProtoEvent.TranslationSubtitleEnd, '', 1000, 1200);
      subtitle(conn, ProtoEvent.SourceSubtitleEnd, '再见', 1300, 1900);
      subtitle(conn, ProtoEvent.TranslationSubtitleEnd, 'Bye', 1300, 1900);
      await vi.waitFor(() => expect(finalTexts('translation-subtitle-final')).toContain('Bye'), {
        interval: 5
      });
      conn.socket.close(1011, 'internal');

      const next = await server!.nextConnection();
      await next.waitForRequest(ProtoEvent.StartSession);
      expect(finalTexts('source-subtitle-final')).toEqual(['你好', '再见']);
      expect(finalTexts('translation-subtitle-final')).toEqual(['Hello', 'Bye']);
    });

    it('still fails on a SessionFailed frame, without reconnecting', async () => {
      const { conn } = await startedClient();
      conn.send(ProtoEvent.SessionFailed, { StatusCode: 45_000_081, Message: 'wait packet timeout' });
      await vi.waitFor(() => expect(eventTypes()).toContain('session-failed'), { interval: 5 });
      await sleep(30);
      expect(server!.connectionCount()).toBe(1);
    });
  });

  describe('liveness (item 4)', () => {
    it('replaces a connection once the server stops answering pings', async () => {
      server = await startServer({ autoPong: false });
      const client = makeClient({
        endpoint: server.url,
        timing: { keepaliveIntervalMs: 10, keepaliveTimeoutMs: 60 }
      });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitForRequest(ProtoEvent.StartSession);
      conn.send(ProtoEvent.SessionStarted);
      await started;

      await conn.closed;
      const next = await server.nextConnection();
      await next.waitForRequest(ProtoEvent.StartSession);
      // The replacement goes silent too, before its SessionStarted: that is
      // retried after a back-off, not a failure yet.
      await next.closed;
      expect(events.map((e) => e.type)).toEqual(['session-started']);
    });

    it('keeps a session alive while pongs come back', async () => {
      server = await startServer();
      const client = makeClient({
        endpoint: server.url,
        timing: { keepaliveIntervalMs: 10, keepaliveTimeoutMs: 60 }
      });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitForRequest(ProtoEvent.StartSession);
      conn.send(ProtoEvent.SessionStarted);
      await started;

      await sleep(150);
      expect(events.map((e) => e.type)).toEqual(['session-started']);
      await client.cancel();
    });
  });
});
