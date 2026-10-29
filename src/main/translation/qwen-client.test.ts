import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  WebSocket,
  WebSocketServer,
  type ServerOptions,
  type WebSocket as ServerSocket
} from 'ws';

vi.mock('./credential-vault.js', () => ({
  getQwenCredentials: () => ({ apiKey: 'sk-test' }),
  MissingCredentialsError: class MissingCredentialsError extends Error {}
}));

import { setLogSink } from '@core/utils/logger.js';
import { QWEN_PRESET_VOICES } from '@shared/engine-types.js';
import {
  QwenClient,
  qwenEndpoint,
  qwenUsageTokens,
  type QwenClientOptions
} from './qwen-client.js';
import type {
  ClientTelemetry,
  QwenStartParams,
  TranslationEventBody
} from './translation-client.js';

const PARAMS: QwenStartParams = {
  engineId: 'qwen',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  mode: 's2s',
  voice: 'Tina'
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface ClientMessage {
  type: string;
  event_id?: string;
  audio?: string;
  session?: Record<string, unknown>;
}

/** Server side of one client connection, speaking just enough protocol. */
interface FakeConn {
  socket: ServerSocket;
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

const wrapConnection = (socket: ServerSocket): FakeConn => {
  const received: ClientMessage[] = [];
  socket.on('message', (data) => {
    received.push(JSON.parse(data.toString()) as ClientMessage);
  });
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  const count = (type: string): number => received.filter((m) => m.type === type).length;
  return {
    socket,
    received,
    closed,
    count,
    send: (event) => socket.send(JSON.stringify(event)),
    waitFor: (type) =>
      vi.waitFor(() => expect(count(type)).toBeGreaterThan(0), {
        timeout: 2000,
        interval: 5
      })
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

describe('QwenClient', () => {
  let server: FakeServer | null = null;
  let events: TranslationEventBody[] = [];
  const onEvent = (e: TranslationEventBody): void => {
    events.push(e);
  };
  const types = (): string[] => events.map((e) => e.type);
  const finalTexts = (type: 'source-subtitle-final' | 'translation-subtitle-final'): string[] =>
    events.flatMap((e) => (e.type === type ? [e.text] : []));
  /** Rows as the renderer builds them: source and translation finals zipped FIFO. */
  const rows = (): [string, string][] => {
    const src = finalTexts('source-subtitle-final');
    const tgt = finalTexts('translation-subtitle-final');
    return src.map((s, i) => [s, tgt[i] ?? '<missing>']);
  };
  const balanced = (): boolean =>
    finalTexts('source-subtitle-final').length ===
    finalTexts('translation-subtitle-final').length;
  let clients: QwenClient[] = [];
  const makeClient = (opts: Omit<QwenClientOptions, 'onEvent'>): QwenClient => {
    const client = new QwenClient({ onEvent, ...opts });
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
    timing?: ConstructorParameters<typeof QwenClient>[0]['timing'],
    params: QwenStartParams = PARAMS
  ): Promise<{ client: QwenClient; conn: FakeConn }> => {
    server = await startServer();
    const client = makeClient({ endpoint: server.url, timing });
    const started = client.start(params);
    const conn = await server.nextConnection();
    await conn.waitFor('session.update');
    conn.send({ type: 'session.created' });
    conn.send({ type: 'session.updated' });
    await started;
    return { client, conn };
  };

  describe('start() failures (items 1, 2, 6)', () => {
    it('rejects on an error event before session.updated and closes the socket', async () => {
      server = await startServer();
      const client = makeClient({ endpoint: server.url });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitFor('session.update');

      conn.send({
        type: 'error',
        error: { code: 'invalid_request_error', message: 'unsupported language' }
      });

      const err = await started.catch((e: unknown) => e);
      expect((err as Error).message).toBe(
        'Qwen handshake failed (code=invalid_request_error): unsupported language'
      );
      expect(err).toMatchObject({ kind: 'protocol', provider: 'qwen' });
      // A string code has no numeric form to put on a session-failed.
      expect((err as { code?: number }).code).toBeUndefined();
      // The socket is closed, not merely forgotten (a leaked socket would
      // keep holding a DashScope concurrency slot).
      await conn.closed;
      expect(events).toEqual([]);
    });

    it('classifies a quota error event before session.updated', async () => {
      server = await startServer();
      const client = makeClient({ endpoint: server.url });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitFor('session.update');
      // DashScope's real wording: the code, not the "Access denied", decides.
      conn.send({
        type: 'error',
        error: {
          code: 'Arrearage',
          message: 'Access denied, please make sure your account is in good standing.'
        }
      });
      await expect(started).rejects.toMatchObject({ kind: 'quota' });
    });

    it('rejects when session.updated never arrives (ready timeout)', async () => {
      server = await startServer();
      const client = makeClient({
        endpoint: server.url,
        timing: { sessionReadyTimeoutMs: 50 }
      });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();

      await expect(started).rejects.toThrow(/timed out after 50ms waiting for session.updated/);
      await conn.closed;
    });

    it('includes the HTTP status and body of a rejected upgrade', async () => {
      server = await startServer({
        verifyClient: (_info, cb) => cb(false, 401, '{"code":"InvalidApiKey"}')
      });
      const client = makeClient({ endpoint: server.url });

      const err = await client.start(PARAMS).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/HTTP 401.*InvalidApiKey/);
      expect(err).toMatchObject({ kind: 'auth', httpStatus: 401, provider: 'qwen' });
      // The bearer key never ends up in the message.
      expect((err as Error).message).not.toMatch(/sk-test/);
    });
  });

  it('cancel() during CONNECTING rejects start() without an unhandled rejection (item 3)', async () => {
    let release: ((ok: boolean) => void) | undefined;
    server = await startServer({
      verifyClient: (_info, cb) => {
        release = cb;
      }
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const client = makeClient({ endpoint: server.url });
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

  describe('finish() (item 5)', () => {
    it('falls back to session.finish when response.done never comes, and sends it once', async () => {
      const { client, conn } = await startedClient({ finishFallbackMs: 60 });
      conn.send({ type: 'response.created' });
      await vi.waitFor(() => expect(types()).toContain('translation-subtitle-start'), {
        interval: 5
      });

      await client.finish();
      await client.finish();
      // Deferred while the response is active…
      await sleep(20);
      expect(conn.count('session.finish')).toBe(0);
      // …but not forever.
      await conn.waitFor('session.finish');

      // A late response.done must not send a second session.finish.
      conn.send({ type: 'response.done' });
      await sleep(30);
      expect(conn.count('session.finish')).toBe(1);

      conn.send({ type: 'session.finished' });
      await conn.closed;
      expect(types().at(-1)).toBe('session-finished');
    });

    it('sends session.finish on response.done when it comes first, once', async () => {
      const { client, conn } = await startedClient({ finishFallbackMs: 60 });
      conn.send({ type: 'response.created' });
      await vi.waitFor(() => expect(types()).toContain('translation-subtitle-start'), {
        interval: 5
      });

      await client.finish();
      conn.send({ type: 'response.done' });
      await conn.waitFor('session.finish');
      await sleep(100); // past the fallback
      expect(conn.count('session.finish')).toBe(1);
    });
  });

  describe('unified lifecycle (GatedWsSession)', () => {
    it('cancel() before start() makes start() reject without connecting', async () => {
      server = await startServer();
      const client = makeClient({ endpoint: server.url });
      await client.cancel();
      await expect(client.start(PARAMS)).rejects.toThrow(/canceled before session.updated/);
      await sleep(20);
      expect(server.connectionCount()).toBe(0);
      expect(events).toEqual([]);
    });

    it('a second start() rejects, while live and after the session ended', async () => {
      const { client, conn } = await startedClient();
      await expect(client.start({ ...PARAMS, mode: 's2t' })).rejects.toThrow(
        'Qwen session already started'
      );
      await client.finish();
      await conn.waitFor('session.finish');
      conn.send({ type: 'session.finished' });
      await conn.closed;
      await expect(client.start(PARAMS)).rejects.toThrow('Qwen session already started');
      expect(server!.connectionCount()).toBe(1);
      expect(types()).toEqual(['session-started', 'session-finished']);
    });
  });

  describe('contract (item 8)', () => {
    it('emits nothing after cancel()', async () => {
      const { client, conn } = await startedClient();
      await client.cancel();
      conn.send({ type: 'response.created' });
      conn.send({ type: 'session.finished' });
      await conn.closed;
      expect(types()).toEqual(['session-started']);
      await client.cancel(); // idempotent
    });
  });

  describe('event mapping (items 7, 10)', () => {
    it('never emits an empty translation final', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'response.created' });
      conn.send({ type: 'response.audio_transcript.delta', delta: 'Hello' });
      conn.send({ type: 'response.audio_transcript.delta', delta: ' world' });
      conn.send({ type: 'response.audio_transcript.done' }); // no transcript
      conn.send({ type: 'response.created' });
      conn.send({ type: 'response.audio_transcript.done', text: 'From text field' });

      await vi.waitFor(
        () =>
          expect(events.filter((e) => e.type === 'translation-subtitle-final')).toHaveLength(2),
        { interval: 5 }
      );
      const finals = events.filter((e) => e.type === 'translation-subtitle-final');
      expect(finals.map((e) => (e as { text: string }).text)).toEqual([
        'Hello world',
        'From text field'
      ]);
    });

    it('closes the translation line and TTS sentence on response.done (3.8 sends no *.done transcript)', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'response.created', response: { id: 'resp_1' } });
      conn.send({ type: 'response.audio_transcript.delta', response_id: 'resp_1', delta: 'Good ' });
      conn.send({ type: 'response.audio.delta', delta: Buffer.from([1, 2]).toString('base64') });
      conn.send({ type: 'response.audio_transcript.delta', response_id: 'resp_1', delta: 'morning' });
      conn.send({ type: 'response.done', response: { id: 'resp_1', status: 'completed' } });

      await vi.waitFor(() => expect(types()).toContain('tts-sentence-end'), { interval: 5 });
      expect(types().slice(1)).toEqual([
        'translation-subtitle-start',
        'translation-subtitle-delta',
        // TTS opens on the first audio chunk, not on response.created.
        'tts-sentence-start',
        'tts-audio',
        'translation-subtitle-delta',
        'translation-subtitle-final',
        'tts-sentence-end'
      ]);
      const final = events.find((e) => e.type === 'translation-subtitle-final');
      expect(final).toMatchObject({ text: 'Good morning' });
    });

    it('ignores a late *.done for a response whose line was already replaced', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'response.audio_transcript.delta', response_id: 'resp_1', delta: 'One' });
      conn.send({ type: 'response.audio_transcript.delta', response_id: 'resp_2', delta: 'Two' });
      conn.send({ type: 'response.audio_transcript.done', response_id: 'resp_1', transcript: 'One' });
      conn.send({ type: 'response.done', response: { id: 'resp_2' } });

      await vi.waitFor(
        () =>
          expect(events.filter((e) => e.type === 'translation-subtitle-final')).toHaveLength(2),
        { interval: 5 }
      );
      await sleep(20);
      const finals = events.filter((e) => e.type === 'translation-subtitle-final');
      expect(finals.map((e) => (e as { text: string }).text)).toEqual(['One', 'Two']);
    });

    it('accumulates append-only source deltas per item and finalizes on completed', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: '你好' });
      conn.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: '世界' });
      conn.send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'a',
        transcript: '你好，世界。'
      });

      await vi.waitFor(() => expect(types()).toContain('source-subtitle-final'), { interval: 5 });
      expect(events.slice(1)).toMatchObject([
        { type: 'source-subtitle-start' },
        { type: 'source-subtitle-delta', text: '你好' },
        { type: 'source-subtitle-delta', text: '你好世界' },
        { type: 'source-subtitle-final', text: '你好，世界。' }
      ]);
    });

    it("closes a source item when the next one starts, and drops its late completed", async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'First' });
      conn.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: 'Second' });
      conn.send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'a',
        transcript: 'First.'
      });
      conn.send({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'b',
        transcript: 'Second.'
      });

      await vi.waitFor(
        () => expect(events.filter((e) => e.type === 'source-subtitle-final')).toHaveLength(2),
        { interval: 5 }
      );
      await sleep(20);
      const finals = events.filter((e) => e.type === 'source-subtitle-final');
      expect(finals.map((e) => (e as { text: string }).text)).toEqual(['First', 'Second.']);
    });

    it('numbers speakers from speech_started in order of first appearance', async () => {
      const { conn } = await startedClient();
      const line = (item: string, speaker: number | null, text: string): void => {
        if (speaker !== null) {
          conn.send({ type: 'input_audio_buffer.speech_started', item_id: item, speaker_id: speaker });
        }
        conn.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: item, delta: text });
        conn.send({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: item,
          transcript: text
        });
      };
      line('a', 7, 'One.');
      line('b', 3, 'Two.');
      line('c', 7, 'Three.');
      line('d', null, 'Four.');

      await vi.waitFor(
        () => expect(events.filter((e) => e.type === 'source-subtitle-final')).toHaveLength(4),
        { interval: 5 }
      );
      const starts = events.flatMap((e) =>
        e.type === 'source-subtitle-start' ? [[e.speaker, e.speakerChanged]] : []
      );
      expect(starts).toEqual([
        [1, false],
        [2, true],
        [1, true],
        [undefined, false]
      ]);
      const finals = events.flatMap((e) => (e.type === 'source-subtitle-final' ? [e] : []));
      expect(finals.map((e) => [e.text, e.speaker])).toEqual([
        ['One.', 1],
        ['Two.', 2],
        ['Three.', 1],
        ['Four.', undefined]
      ]);
      expect(finals[3]).not.toHaveProperty('speaker');
    });

    it('accumulates incremental *.delta translation text per response', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'response.created' });
      conn.send({ type: 'response.audio_transcript.delta', delta: 'Hel' });
      conn.send({ type: 'response.audio_transcript.delta', delta: 'lo' });
      conn.send({ type: 'response.audio_transcript.done', transcript: 'Hello' });
      conn.send({ type: 'response.created' });
      conn.send({ type: 'response.audio_transcript.delta', delta: 'Bye' });

      await vi.waitFor(
        () => expect(events.filter((e) => e.type === 'translation-subtitle-delta')).toHaveLength(3),
        { interval: 5 }
      );
      const deltas = events
        .filter((e) => e.type === 'translation-subtitle-delta')
        .map((e) => (e as { text: string }).text);
      expect(deltas).toEqual(['Hel', 'Hello', 'Bye']);
    });

    it('decodes TTS audio into an exactly-sized ArrayBuffer', async () => {
      const { conn } = await startedClient();
      const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
      conn.send({ type: 'response.audio.delta', delta: pcm.toString('base64') });

      await vi.waitFor(() => expect(types()).toContain('tts-audio'), { interval: 5 });
      const tts = events.find((e) => e.type === 'tts-audio') as { data: ArrayBuffer };
      expect(tts.data).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(tts.data)]).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('sends well-formed input_audio_buffer.append frames with unique event ids', async () => {
      const { client, conn } = await startedClient();
      await client.sendAudio(new Uint8Array([0, 1, 2, 3]));
      await client.sendAudio(new Uint8Array([4, 5]));

      await vi.waitFor(() => expect(conn.count('input_audio_buffer.append')).toBe(2), {
        interval: 5
      });
      const appends = conn.received.filter((m) => m.type === 'input_audio_buffer.append');
      expect(appends.map((m) => [...Buffer.from(m.audio!, 'base64')])).toEqual([
        [0, 1, 2, 3],
        [4, 5]
      ]);
      const ids = conn.received.map((m) => m.event_id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('source/translation finals stay paired', () => {
    const asrDelta = (item: string, delta: string) => ({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: item,
      delta
    });
    const asrCompleted = (item: string, transcript: string) => ({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: item,
      transcript
    });
    const response = (conn: FakeConn, id: string, text: string): void => {
      conn.send({ type: 'response.created', response: { id } });
      conn.send({ type: 'response.audio_transcript.delta', response_id: id, delta: text });
      conn.send({ type: 'response.done', response: { id, status: 'completed' } });
    };

    it('leaves the normal item → response flow untouched', async () => {
      const { conn } = await startedClient();
      conn.send(asrDelta('a', '你好'));
      conn.send(asrCompleted('a', '你好。'));
      response(conn, 'r1', 'Hello.');
      conn.send(asrDelta('b', '再见'));
      conn.send(asrCompleted('b', '再见。'));
      response(conn, 'r2', 'Bye.');

      await vi.waitFor(() => expect(finalTexts('translation-subtitle-final')).toHaveLength(2), {
        interval: 5
      });
      expect(rows()).toEqual([
        ['你好。', 'Hello.'],
        ['再见。', 'Bye.']
      ]);
    });

    it('waits for a source line that is just behind its translation', async () => {
      const { conn } = await startedClient();
      conn.send(asrDelta('a', '你好'));
      response(conn, 'r1', 'Hello.');
      await vi.waitFor(() => expect(types()).toContain('translation-subtitle-final'), {
        interval: 5
      });
      conn.send(asrCompleted('a', '你好。'));
      await vi.waitFor(() => expect(types()).toContain('source-subtitle-final'), { interval: 5 });
      expect(rows()).toEqual([['你好。', 'Hello.']]);
    });

    it('drops a wordless response when no source line waits for it', async () => {
      // Seen in a real meeting: noise on the meeting audio (while the user
      // spoke) made an ASR item with no transcript — no source line — and an
      // empty response. Its '' final shifted every translation after it.
      const { conn } = await startedClient();
      conn.send(asrDelta('a', 'Okay.'));
      conn.send(asrCompleted('a', 'Okay.'));
      response(conn, 'r1', '好的。');
      conn.send({ type: 'input_audio_buffer.speech_started', item_id: 'noise', speaker_id: 0 });
      conn.send(asrCompleted('noise', ''));
      conn.send({ type: 'response.created', response: { id: 'r2' } });
      conn.send({ type: 'response.done', response: { id: 'r2', status: 'completed' } });
      conn.send(asrDelta('b', 'Yeah, good question.'));
      conn.send(asrCompleted('b', 'Yeah, good question.'));
      response(conn, 'r3', '是的，这个问题很好。');

      await vi.waitFor(() => expect(finalTexts('translation-subtitle-final')).toHaveLength(2), {
        interval: 5
      });
      await sleep(20);
      expect(rows()).toEqual([
        ['Okay.', '好的。'],
        ['Yeah, good question.', '是的，这个问题很好。']
      ]);
      expect(balanced()).toBe(true);
    });

    it('still gives a waiting source line its empty translation', async () => {
      const { conn } = await startedClient();
      conn.send(asrDelta('a', 'Hmm.'));
      conn.send(asrCompleted('a', 'Hmm.'));
      conn.send({ type: 'response.created', response: { id: 'r1' } });
      conn.send({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
      conn.send(asrDelta('b', 'Thanks.'));
      conn.send(asrCompleted('b', 'Thanks.'));
      response(conn, 'r2', '谢谢。');

      await vi.waitFor(() => expect(finalTexts('translation-subtitle-final')).toHaveLength(2), {
        interval: 5
      });
      expect(rows()).toEqual([
        ['Hmm.', ''],
        ['Thanks.', '谢谢。']
      ]);
    });

    it('session.finished leaves both sides even', async () => {
      const { client, conn } = await startedClient();
      conn.send(asrDelta('a', '最后'));
      conn.send(asrCompleted('a', '最后一句。'));
      conn.send(asrDelta('b', '还有'));
      await client.finish();
      await conn.waitFor('session.finish');
      conn.send({ type: 'session.finished' });
      await conn.closed;
      expect(balanced()).toBe(true);
      expect(rows()).toEqual([
        ['最后一句。', ''],
        ['还有', '']
      ]);
      expect(types().at(-1)).toBe('session-finished');
    });
  });

  describe('server closes after finish() (B42)', () => {
    it('treats a clean 1000 close after session.finish as finished', async () => {
      const { client, conn } = await startedClient();
      conn.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: '收尾' });
      await vi.waitFor(() => expect(types()).toContain('source-subtitle-delta'), { interval: 5 });
      await client.finish();
      await conn.waitFor('session.finish');
      conn.socket.close(1000, 'bye');

      await vi.waitFor(() => expect(types()).toContain('session-finished'), { interval: 5 });
      expect(types()).not.toContain('session-failed');
      expect(rows()).toEqual([['收尾', '']]);
    });

    it('still fails on an abnormal close after session.finish', async () => {
      const { client, conn } = await startedClient();
      await client.finish();
      await conn.waitFor('session.finish');
      conn.socket.close(1011, 'internal');
      await vi.waitFor(() => expect(types()).toContain('session-failed'), { interval: 5 });
      expect(types()).not.toContain('session-finished');
    });

    it('a mid-session error event fails with its kind, without reconnecting', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'error', error: { code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' } });
      await vi.waitFor(() => expect(types()).toContain('session-failed'), { interval: 5 });
      expect(events.at(-1)).toEqual({
        type: 'session-failed',
        kind: 'quota',
        message: 'Requests rate limit exceeded'
      });
      await sleep(30);
      expect(server!.connectionCount()).toBe(1);
    });
  });

  describe('reconnect', () => {
    it('replaces a connection closed without finish(), closing its open lines', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'input_audio_buffer.speech_started', item_id: 'a', speaker_id: 0 });
      conn.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: '你好' });
      conn.send({ type: 'response.created', response: { id: 'r1' } });
      conn.send({ type: 'response.audio_transcript.delta', response_id: 'r1', delta: 'Hel' });
      await vi.waitFor(() => expect(types()).toContain('translation-subtitle-delta'), { interval: 5 });
      conn.socket.close(1000, 'idle');

      const next = await server!.nextConnection();
      await next.waitFor('session.update');
      expect(rows()).toEqual([['你好', 'Hel']]);

      next.send({ type: 'session.updated' });
      // The new server session numbers its speakers from 0 again: a new
      // voice, not speaker 1 back.
      next.send({ type: 'input_audio_buffer.speech_started', item_id: 'b', speaker_id: 0 });
      next.send({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: '再见' });
      await vi.waitFor(
        () => expect(events.filter((e) => e.type === 'source-subtitle-start')).toHaveLength(2),
        { interval: 5 }
      );
      const speakers = events.flatMap((e) =>
        e.type === 'source-subtitle-start' ? [e.speaker] : []
      );
      expect(speakers).toEqual([1, 2]);
      expect(types().filter((t) => t === 'session-started')).toHaveLength(1);
      expect(types()).not.toContain('session-failed');
    });
  });

  describe('sendAudio outside the live window (F14)', () => {
    it('drops audio quietly after finish() and cancel()', async () => {
      const { client, conn } = await startedClient();
      await client.finish();
      await expect(client.sendAudio(new Uint8Array(4))).resolves.toBeUndefined();
      await client.cancel();
      await expect(client.sendAudio(new Uint8Array(4))).resolves.toBeUndefined();
      expect(conn.count('input_audio_buffer.append')).toBe(0);
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
  });

  describe('usage telemetry', () => {
    it('reports each response.done usage, plus the link phases', async () => {
      const telemetry: ClientTelemetry[] = [];
      server = await startServer();
      const client = makeClient({
        endpoint: server.url,
        onTelemetry: (s) => telemetry.push(s)
      });
      const started = client.start(PARAMS);
      const conn = await server.nextConnection();
      await conn.waitFor('session.update');
      conn.send({ type: 'session.updated' });
      await started;
      expect(
        telemetry.map((s) => (s.type === 'link' ? s.phase : s.type))
      ).toEqual(['connecting', 'open', 'ready']);

      conn.send({
        type: 'response.done',
        response: {
          status: 'completed',
          usage: {
            total_tokens: 56,
            input_tokens: 47,
            output_tokens: 9,
            input_tokens_details: { text_tokens: 20, audio_tokens: 27 },
            output_tokens_details: { text_tokens: 2, audio_tokens: 7 }
          }
        }
      });
      conn.send({ type: 'response.done', response: { status: 'completed' } });
      await vi.waitFor(() =>
        expect(telemetry.filter((s) => s.type === 'usage')).toEqual([
          {
            type: 'usage',
            tokens: { inputAudio: 27, inputText: 20, outputText: 2, outputAudio: 7 }
          }
        ])
      );
    });
  });

  describe('TTS audio stays on whole samples', () => {
    it('carries an odd byte into the next delta and drops it at the end of the response', async () => {
      const { conn } = await startedClient();
      conn.send({ type: 'response.created', response: { id: 'r1' } });
      conn.send({ type: 'response.audio.delta', delta: Buffer.from([1, 2, 3]).toString('base64') });
      conn.send({ type: 'response.audio.delta', delta: Buffer.from([4, 5, 6]).toString('base64') });
      conn.send({ type: 'response.audio.delta', delta: Buffer.from([7]).toString('base64') });
      conn.send({ type: 'response.done', response: { id: 'r1' } });
      conn.send({ type: 'response.created', response: { id: 'r2' } });
      conn.send({ type: 'response.audio.delta', delta: Buffer.from([8, 9]).toString('base64') });

      await vi.waitFor(
        () => expect(events.filter((e) => e.type === 'tts-audio')).toHaveLength(3),
        { interval: 5 }
      );
      const chunks = events.flatMap((e) => (e.type === 'tts-audio' ? [[...new Uint8Array(e.data)]] : []));
      // r1's dangling 7 is dropped, not glued onto r2's first sample.
      expect(chunks).toEqual([[1, 2], [3, 4, 5, 6], [8, 9]]);
    });
  });

  describe('session.update (qwen3.8 shape)', () => {
    it('sends output_modalities + target + preset voice, and no 3.5-only fields', async () => {
      const { conn } = await startedClient();
      const update = conn.received.find((m) => m.type === 'session.update')!;
      expect(update.session).toEqual({
        output_modalities: ['text', 'audio'],
        translation: { language: 'en' },
        turn_detection: { type: 'speaker_detection', threshold: 0.5 },
        voice: 'Tina'
      });
    });

    it('enables voice cloning with voice "default"', async () => {
      const { conn } = await startedClient(undefined, {
        ...PARAMS,
        voice: undefined,
        voiceClone: 'always'
      });
      const update = conn.received.find((m) => m.type === 'session.update')!;
      expect(update.session).toMatchObject({
        voice: 'default',
        enable_voice_clone: true,
        voice_clone_options: { frequency: 'always' }
      });
    });

    it('s2t asks for text only, still naming a 3.8 voice', async () => {
      const { conn } = await startedClient(undefined, { ...PARAMS, mode: 's2t' });
      const update = conn.received.find((m) => m.type === 'session.update')!;
      expect(update.session).toEqual({
        output_modalities: ['text'],
        translation: { language: 'en' },
        turn_detection: { type: 'speaker_detection', threshold: 0.5 },
        voice: 'Tina'
      });
    });

    it('never leaves the voice to the server, whose default (Chelsie) 3.8 rejects', async () => {
      // Listen with a cloned voice: s2t, so no cloning, and no preset either.
      const { conn } = await startedClient(undefined, {
        ...PARAMS,
        mode: 's2t',
        voice: undefined,
        voiceClone: 'always'
      });
      const update = conn.received.find((m) => m.type === 'session.update')!;
      expect(update.session).toMatchObject({ voice: QWEN_PRESET_VOICES[0] });
      expect(update.session).not.toHaveProperty('enable_voice_clone');
    });
  });
});

describe('qwenEndpoint', () => {
  it('uses the workspace-dedicated Beijing host when a workspace ID is set', () => {
    expect(qwenEndpoint('llm-abc123')).toBe(
      'wss://llm-abc123.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime'
    );
  });

  it('falls back to the shared DashScope host', () => {
    expect(qwenEndpoint()).toBe(
      'wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime'
    );
  });
});

describe('qwenUsageTokens', () => {
  it('maps the per-modality breakdown', () => {
    expect(
      qwenUsageTokens({
        input_tokens: 47,
        output_tokens: 9,
        input_tokens_details: { text_tokens: 20, audio_tokens: 27 },
        output_tokens_details: { text_tokens: 2, audio_tokens: 7 }
      })
    ).toEqual({ inputAudio: 27, inputText: 20, outputText: 2, outputAudio: 7 });
  });

  it('gives totals without a breakdown to input audio / output text', () => {
    expect(qwenUsageTokens({ input_tokens: 30, output_tokens: 4 })).toEqual({
      inputAudio: 30,
      outputText: 4
    });
  });

  it('ignores missing or malformed usage', () => {
    expect(qwenUsageTokens(undefined)).toBeNull();
    expect(qwenUsageTokens('x')).toBeNull();
    expect(qwenUsageTokens({ input_tokens: -3, output_tokens: 'n' })).toBeNull();
  });
});
