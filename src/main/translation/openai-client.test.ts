import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';
import {
  WebSocket,
  WebSocketServer,
  type ServerOptions,
  type WebSocket as ServerSocket
} from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

vi.mock('./credential-vault.js', () => ({
  getOpenAiCredentials: () => ({ apiKey: 'sk-test' }),
  MissingCredentialsError: class MissingCredentialsError extends Error {}
}));
vi.mock('./proxy-agent.js', () => ({
  resolveProxyAgent: async () => undefined
}));

import { setLogSink } from '@core/utils/logger.js';
import { OpenAiClient, type OpenAiClientOptions } from './openai-client.js';
import { Pcm16Carry } from './pcm.js';
import type { OpenAiStartParams, TranslationEventBody } from './translation-client.js';

const PARAMS: OpenAiStartParams = {
  engineId: 'openai',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  mode: 's2s'
};

// Short silence heuristics so the tests run in milliseconds.
const TIMINGS = {
  lineIdleMs: 40,
  lineAwaitTranslationMs: 60,
  ttsIdleMs: 30,
  finishMaxMs: 2_000
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 20 ms of 24 kHz capture, each sample tagged with the chunk index. */
const capture = (index: number): Uint8Array => {
  const buf = Buffer.alloc(960);
  for (let i = 0; i < 480; i++) buf.writeInt16LE(index, i * 2);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

/** Base64 24 kHz output chunk. */
const outputAudio = (audible: boolean): string => {
  const buf = Buffer.alloc(960);
  if (audible) {
    for (let i = 0; i < 480; i++) buf.writeInt16LE(i % 2 ? 5000 : -5000, i * 2);
  }
  return buf.toString('base64');
};

/** Audible 16-bit PCM (alternating ±5000), `bytes` long. */
const speechBytes = (bytes: number): Buffer => {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i + 1 < bytes; i += 2) buf.writeInt16LE((i / 2) % 2 ? 5000 : -5000, i);
  return buf;
};

/** An HTTP proxy that accepts TCP and never answers the CONNECT. */
const startBlackHoleProxy = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.resume();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((r) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => r());
      })
  };
};

interface ClientMessage {
  type: string;
  audio?: string;
  session?: Record<string, unknown>;
}

interface FakeConn {
  socket: ServerSocket;
  request: IncomingMessage;
  received: ClientMessage[];
  closed: Promise<void>;
  send(event: Record<string, unknown>): void;
  waitFor(type: string): Promise<void>;
  count(type: string): number;
}

interface FakeServer {
  url: string;
  nextConnection(): Promise<FakeConn>;
  /** Connections accepted so far. */
  connectionCount(): number;
  close(): Promise<void>;
}

const startServer = async (opts: ServerOptions = {}): Promise<FakeServer> => {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', ...opts });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const ready: FakeConn[] = [];
  const waiters: Array<(conn: FakeConn) => void> = [];
  let accepted = 0;
  wss.on('connection', (socket, request) => {
    accepted++;
    const received: ClientMessage[] = [];
    socket.on('message', (data) => {
      received.push(JSON.parse(data.toString()) as ClientMessage);
    });
    const count = (type: string): number => received.filter((m) => m.type === type).length;
    const conn: FakeConn = {
      socket,
      request,
      received,
      closed: new Promise<void>((resolve) => socket.once('close', () => resolve())),
      count,
      send: (event) => socket.send(JSON.stringify(event)),
      waitFor: (type) =>
        vi.waitFor(() => expect(count(type)).toBeGreaterThan(0), {
          timeout: 2000,
          interval: 5
        })
    };
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

describe('OpenAiClient', () => {
  let server: FakeServer | null = null;
  let events: TranslationEventBody[] = [];
  const onEvent = (e: TranslationEventBody): void => {
    events.push(e);
  };
  const types = (): string[] => events.map((e) => e.type);
  const textsOf = (type: string): string[] =>
    events.filter((e) => e.type === type).map((e) => (e as { text: string }).text.trim());
  let clients: OpenAiClient[] = [];
  const makeClient = (opts: Omit<OpenAiClientOptions, 'onEvent'>): OpenAiClient => {
    const client = new OpenAiClient({ onEvent, ...opts });
    clients.push(client);
    return client;
  };

  beforeAll(() => {
    setLogSink({ info() {}, warn() {}, error() {}, debug() {} });
  });

  afterEach(async () => {
    // Cancel first so closing the server can't make a still-live client of
    // this test report a session-failed into the next test.
    await Promise.all(clients.map((c) => c.cancel()));
    clients = [];
    events = [];
    await server?.close();
    server = null;
  });

  /** start() through session.updated. */
  const startedClient = async (
    params: OpenAiStartParams = PARAMS
  ): Promise<{ client: OpenAiClient; conn: FakeConn }> => {
    server = await startServer();
    const client = makeClient({ endpoint: server.url, timings: TIMINGS });
    const started = client.start(params);
    const conn = await server.nextConnection();
    await conn.waitFor('session.update');
    conn.send({ type: 'session.created' });
    conn.send({ type: 'session.updated' });
    await started;
    return { client, conn };
  };

  describe('start()', () => {
    it('authenticates with a Bearer header and configures target + source transcription', async () => {
      const { conn } = await startedClient();

      expect(conn.request.headers.authorization).toBe('Bearer sk-test');
      expect(conn.request.headers['openai-beta']).toBeUndefined();
      const update = conn.received.find((m) => m.type === 'session.update')!;
      expect(update.session).toEqual({
        audio: {
          input: { transcription: { model: 'gpt-realtime-whisper' } },
          output: { language: 'zh' }
        }
      });
      expect(types()).toEqual(['session-started']);
    });

    it('rejects on an error event before session.updated and closes the socket', async () => {
      server = await startServer();
      const client = makeClient({ endpoint: server.url, timings: TIMINGS });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitFor('session.update');

      conn.send({
        type: 'error',
        error: { type: 'invalid_request_error', code: 'invalid_value', message: 'bad language' }
      });

      const err = await started.catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/OpenAI handshake failed \(code=invalid_value\).*bad language/);
      expect(err).toMatchObject({ kind: 'protocol', provider: 'openai' });
      await conn.closed;
      expect(events).toEqual([]);
    });

    it('classifies an error event by its code before the message', async () => {
      server = await startServer();
      const client = makeClient({ endpoint: server.url, timings: TIMINGS });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitFor('session.update');
      conn.send({
        type: 'error',
        error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota.' }
      });
      await expect(started).rejects.toMatchObject({ kind: 'quota' });
    });

    it('includes the HTTP status and body of a rejected upgrade', async () => {
      server = await startServer({
        verifyClient: (_info, cb) => cb(false, 401, '{"error":"invalid_api_key"}')
      });
      const client = makeClient({ endpoint: server.url, timings: TIMINGS });

      const err = await client.start(PARAMS).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/HTTP 401.*invalid_api_key/);
      expect(err).toMatchObject({ kind: 'auth', httpStatus: 401, provider: 'openai' });
      expect((err as Error).message).not.toMatch(/sk-test/);
    });

    it('cancel() during CONNECTING rejects start() without an unhandled rejection', async () => {
      let release: ((ok: boolean) => void) | undefined;
      server = await startServer({
        verifyClient: (_info, cb) => {
          release = cb;
        }
      });
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const client = makeClient({ endpoint: server.url, timings: TIMINGS });
        const started = client.start(PARAMS);
        await vi.waitFor(() => expect(release).toBeDefined(), { interval: 5 });

        await client.cancel();
        await expect(started).rejects.toThrow(/canceled before session.updated/);
        release!(true);
        await sleep(30);
        expect(unhandled).not.toHaveBeenCalled();
        expect(events).toEqual([]);
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });
  });

  describe('unified lifecycle (GatedWsSession)', () => {
    it('cancel() before start() makes start() reject without connecting', async () => {
      server = await startServer();
      const client = makeClient({ endpoint: server.url, timings: TIMINGS });
      await client.cancel();
      await expect(client.start(PARAMS)).rejects.toThrow(/canceled before session.updated/);
      await sleep(20);
      expect(server.connectionCount()).toBe(0);
      expect(events).toEqual([]);
    });

    it("a second start() rejects without touching the live session's state", async () => {
      const { client, conn } = await startedClient();
      // s2t would make the live s2s session drop its TTS if it leaked in.
      await expect(client.start({ ...PARAMS, mode: 's2t' })).rejects.toThrow(
        'OpenAI session already started'
      );
      conn.send({ type: 'session.output_audio.delta', delta: outputAudio(true) });
      await vi.waitFor(() => expect(types()).toContain('tts-audio'), { interval: 5 });

      conn.send({ type: 'session.closed' });
      await conn.closed;
      await expect(client.start(PARAMS)).rejects.toThrow('OpenAI session already started');
      expect(server!.connectionCount()).toBe(1);
    });
  });

  describe('proxy and handshake bounds (B4)', () => {
    it('rejects start() when the proxy never answers CONNECT', async () => {
      const proxy = await startBlackHoleProxy();
      try {
        const client = makeClient({
          endpoint: 'ws://127.0.0.1:9/never',
          resolveAgent: async () => new HttpsProxyAgent(proxy.url),
          timings: { ...TIMINGS, handshakeTimeoutMs: 80 }
        });
        const err = await client.start(PARAMS).catch((e: unknown) => e);
        expect((err as Error).message).toMatch(/handshake timed out after 80ms/);
        expect(err).toMatchObject({ kind: 'timeout' });
        expect(events).toEqual([]);
      } finally {
        await proxy.close();
      }
    });

    it('connects directly when the proxy lookup never answers', async () => {
      server = await startServer();
      const client = makeClient({
        endpoint: server.url,
        resolveAgent: () => new Promise(() => undefined),
        timings: { ...TIMINGS, proxyResolveTimeoutMs: 30 }
      });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitFor('session.update');
      conn.send({ type: 'session.updated' });
      await started;
      expect(types()).toEqual(['session-started']);
    });

    it('cancel() during a hung proxy lookup rejects start() right away', async () => {
      const client = makeClient({
        endpoint: 'ws://127.0.0.1:9/never',
        resolveAgent: () => new Promise(() => undefined),
        timings: TIMINGS
      });
      const started = client.start(PARAMS);
      await sleep(10);
      await client.cancel();
      await expect(started).rejects.toThrow(/canceled before session.updated/);
    });
  });

  describe('audio in', () => {
    it('takes 24 kHz capture as-is and sends it in 200 ms frames', async () => {
      const { client, conn } = await startedClient();
      expect(client.inputSampleRate).toBe(24_000);
      // 500 ms of capture → two 200 ms frames now, the 100 ms tail on finish().
      const chunks = Array.from({ length: 25 }, (_, i) => capture(i));
      for (const chunk of chunks) await client.sendAudio(chunk);
      await conn.waitFor('session.input_audio_buffer.append');
      await client.finish();
      await conn.waitFor('session.close');

      const frames = conn.received
        .filter((m) => m.type === 'session.input_audio_buffer.append')
        .map((m) => Buffer.from(m.audio!, 'base64'));
      expect(frames.map((f) => f.byteLength)).toEqual([9_600, 9_600, 4_800]);
      // Byte-for-byte what capture delivered, in order — no resampling.
      expect(Buffer.concat(frames).equals(Buffer.concat(chunks))).toBe(true);
      // session.close goes out after the buffered tail.
      expect(conn.received.at(-1)!.type).toBe('session.close');
    });
  });

  describe('sendAudio outside the live window (F14)', () => {
    it('drops audio quietly after finish() and cancel()', async () => {
      const { client } = await startedClient();
      await client.finish();
      await expect(client.sendAudio(capture(0))).resolves.toBeUndefined();
      await client.cancel();
      await expect(client.sendAudio(capture(1))).resolves.toBeUndefined();
    });

    it('drops audio while the socket is closing, warning once', async () => {
      const warn = vi.fn();
      setLogSink({ info() {}, warn, error() {}, debug() {} });
      try {
        const { client } = await startedClient();
        const ws = (client as unknown as { session: { socket: WebSocket } }).session.socket;
        Object.defineProperty(ws, 'readyState', { get: () => WebSocket.CLOSING });
        for (let i = 0; i < 5; i++) {
          await expect(client.sendAudio(capture(i))).resolves.toBeUndefined();
        }
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        setLogSink({ info() {}, warn() {}, error() {}, debug() {} });
      }
    });

    it('still rejects audio before start()', async () => {
      const client = makeClient({ endpoint: 'ws://127.0.0.1:9', timings: TIMINGS });
      await expect(client.sendAudio(capture(0))).rejects.toThrow(/not connected/);
    });
  });

  describe('transcripts', () => {
    it('pairs source and translation fragments into subtitle lines', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'session.input_transcript.delta', delta: 'Good morning ' });
      conn.send({ type: 'session.input_transcript.delta', delta: 'everyone. How' });
      conn.send({ type: 'session.output_transcript.delta', delta: '大家' });
      conn.send({ type: 'session.output_transcript.delta', delta: '早上好。' });

      await vi.waitFor(() => expect(types()).toContain('translation-subtitle-final'), {
        interval: 5
      });
      expect(textsOf('source-subtitle-final')).toEqual(['Good morning everyone.']);
      expect(textsOf('translation-subtitle-final')).toEqual(['大家早上好。']);

      // The unfinished "How" closes once the stream goes quiet.
      await vi.waitFor(
        () => expect(textsOf('source-subtitle-final')).toEqual(['Good morning everyone.', 'How']),
        { interval: 5 }
      );
    });
  });

  describe('TTS out', () => {
    it('opens a sentence on audible audio, drops silence between sentences, and closes when quiet', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'session.output_audio.delta', delta: outputAudio(false) });
      conn.send({ type: 'session.output_audio.delta', delta: outputAudio(true) });
      conn.send({ type: 'session.output_audio.delta', delta: outputAudio(false) });

      await vi.waitFor(() => expect(types()).toContain('tts-sentence-end'), { interval: 5 });
      expect(types().slice(1)).toEqual([
        'tts-sentence-start',
        'tts-audio',
        // A pause inside the sentence is kept for natural timing.
        'tts-audio',
        'tts-sentence-end'
      ]);
      const audio = events.find((e) => e.type === 'tts-audio') as { data: ArrayBuffer };
      expect(audio.data).toBeInstanceOf(ArrayBuffer);
      expect(audio.data.byteLength).toBe(960);
    });

    it('keeps TTS chunks on whole samples when the server splits one', async () => {
      const { conn } = await startedClient();
      const speech = speechBytes(1_920);
      conn.send({ type: 'session.output_audio.delta', delta: speech.subarray(0, 961).toString('base64') });
      conn.send({ type: 'session.output_audio.delta', delta: speech.subarray(961).toString('base64') });

      await vi.waitFor(
        () => expect(events.filter((e) => e.type === 'tts-audio')).toHaveLength(2),
        { interval: 5 }
      );
      const chunks = events.flatMap((e) => (e.type === 'tts-audio' ? [Buffer.from(e.data)] : []));
      expect(chunks.map((c) => c.byteLength)).toEqual([960, 960]);
      expect(Buffer.concat(chunks).equals(speech)).toBe(true);
    });

    it('drops output audio entirely in s2t mode', async () => {
      const decode = vi.spyOn(Pcm16Carry.prototype, 'fromBase64');
      const { conn } = await startedClient({ ...PARAMS, mode: 's2t' });
      conn.send({ type: 'session.output_audio.delta', delta: outputAudio(true) });
      conn.send({ type: 'session.output_transcript.delta', delta: '你好。' });

      await vi.waitFor(() => expect(types()).toContain('translation-subtitle-delta'), {
        interval: 5
      });
      await sleep(50);
      expect(types().some((t) => t.startsWith('tts-'))).toBe(false);
      // Not even decoded.
      expect(decode).not.toHaveBeenCalled();
    });
  });

  describe('finish()', () => {
    it('flushes open lines and ends with session-finished on session.closed', async () => {
      const { client, conn } = await startedClient();
      conn.send({ type: 'session.input_transcript.delta', delta: 'Trailing words' });
      await vi.waitFor(() => expect(types()).toContain('source-subtitle-delta'), { interval: 5 });

      await client.finish();
      await client.finish(); // idempotent
      await conn.waitFor('session.close');
      expect(conn.count('session.close')).toBe(1);

      conn.send({ type: 'session.output_transcript.delta', delta: '结尾的话' });
      conn.send({ type: 'session.closed' });
      await conn.closed;

      expect(textsOf('source-subtitle-final')).toEqual(['Trailing words']);
      expect(textsOf('translation-subtitle-final')).toEqual(['结尾的话']);
      expect(types().at(-1)).toBe('session-finished');
    });

    it('gives up waiting for session.closed after finishMaxMs', async () => {
      server = await startServer();
      const client = makeClient({
        endpoint: server.url,
        timings: { ...TIMINGS, finishMaxMs: 60 }
      });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitFor('session.update');
      conn.send({ type: 'session.updated' });
      await started;

      await client.finish();
      await conn.closed;
      expect(types()).toEqual(['session-started', 'session-finished']);
    });
  });

  describe('failures and contract', () => {
    it('keeps the session alive on a mid-session error event', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'error', error: { type: 'invalid_request_error', message: 'oops' } });
      conn.send({ type: 'session.output_transcript.delta', delta: '还在' });

      await vi.waitFor(() => expect(types()).toContain('translation-subtitle-delta'), {
        interval: 5
      });
      expect(types()).not.toContain('session-failed');
    });

    it('replaces a connection the server drops mid-session, closing its open line', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'session.input_transcript.delta', delta: 'Half a sent' });
      await vi.waitFor(() => expect(types()).toContain('source-subtitle-delta'), { interval: 5 });
      conn.socket.close(1011, 'server_error');

      const next = await server!.nextConnection();
      await next.waitFor('session.update');
      // The old line can't be finished by a connection that's gone.
      expect(textsOf('source-subtitle-final')).toEqual(['Half a sent']);
      expect(textsOf('translation-subtitle-final')).toEqual(['']);

      next.send({ type: 'session.updated' });
      next.send({ type: 'session.output_transcript.delta', delta: '接着说' });
      await vi.waitFor(() => expect(types()).toContain('translation-subtitle-delta'), {
        interval: 5
      });
      expect(types().filter((t) => t === 'session-started')).toHaveLength(1);
      expect(types()).not.toContain('session-failed');
    });

    it('still fails on a drop a new connection cannot fix', async () => {
      const { conn } = await startedClient();
      conn.socket.close(1008, 'policy_violation');

      await vi.waitFor(() => expect(types()).toContain('session-failed'), { interval: 5 });
      expect(events.at(-1)).toEqual({
        type: 'session-failed',
        kind: 'protocol',
        code: 1008,
        message: expect.stringContaining('policy_violation')
      });
      await sleep(30);
      expect(server!.connectionCount()).toBe(1);
    });

    it('emits nothing after cancel()', async () => {
      const { client, conn } = await startedClient();
      await client.cancel();
      conn.send({ type: 'session.output_transcript.delta', delta: '不该出现' });
      conn.send({ type: 'session.closed' });
      await conn.closed;
      await sleep(80);
      expect(types()).toEqual(['session-started']);
      await client.cancel(); // idempotent
    });
  });
});
