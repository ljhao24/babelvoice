import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import http from 'node:http';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { setLogSink } from '@core/utils/logger.js';
import { Pcm16Carry } from './pcm.js';
import type {
  ClientTelemetry,
  GeminiStartParams,
  TranslationEventBody
} from './translation-client.js';

vi.mock('./credential-vault.js', () => ({
  getGeminiCredentials: () => ({ apiKey: 'test-key' }),
  MissingCredentialsError: class MissingCredentialsError extends Error {}
}));
vi.mock('./proxy-agent.js', () => ({
  resolveProxyAgent: async () => undefined
}));

const { GeminiClient, GEMINI_MODEL } = await import('./gemini-client.js');

setLogSink({ info() {}, warn() {}, error() {}, debug() {} });

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

/** Audible 16-bit PCM (alternating ±4000), `bytes` long. */
const speechBytes = (bytes: number): Buffer => {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i + 1 < bytes; i += 2) buf.writeInt16LE((i / 2) % 2 ? 4000 : -4000, i);
  return buf;
};

// Short silence heuristics so the tests run in milliseconds.
const TIMINGS = {
  lineIdleMs: 40,
  lineAwaitTranslationMs: 60,
  lineTurnCompleteMs: 10,
  ttsIdleMs: 30,
  finishQuietMs: 40,
  finishAwaitTranslationMs: 60,
  finishAwaitResponseMs: 50,
  finishIdleMs: 20,
  finishMaxMs: 2_000,
  rotateAfterMs: 60_000,
  rotateRetryMs: 50,
  retireQuietMs: 50
};

const PARAMS: GeminiStartParams = {
  engineId: 'gemini',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  mode: 's2s'
};

/* eslint-disable @typescript-eslint/no-explicit-any */
interface FakeConn {
  socket: ServerSocket;
  url: string;
  messages: any[];
  closed: boolean;
  send: (msg: unknown) => void;
}

const waitFor = async (pred: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let wss: WebSocketServer;
let endpoint: string;
let conns: FakeConn[];
/** When true, the fake server answers every `setup` with `setupComplete`. */
let autoSetup: boolean;

beforeEach(async () => {
  conns = [];
  autoSetup = true;
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  endpoint = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  wss.on('connection', (socket, req) => {
    const conn: FakeConn = {
      socket,
      url: req.url ?? '',
      messages: [],
      closed: false,
      send: (msg) => socket.send(JSON.stringify(msg))
    };
    conns.push(conn);
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      conn.messages.push(msg);
      if (msg.setup && autoSetup) conn.send({ setupComplete: {} });
    });
    socket.on('close', () => {
      conn.closed = true;
    });
  });
});

afterEach(async () => {
  for (const c of conns) c.socket.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
});

const makeClient = (
  params: GeminiStartParams = PARAMS,
  overrides: Partial<ConstructorParameters<typeof GeminiClient>[0]> = {}
) => {
  const events: TranslationEventBody[] = [];
  const client = new GeminiClient({
    onEvent: (e) => events.push(e),
    tag: 'test',
    endpoint,
    timings: TIMINGS,
    ...overrides
  });
  const types = () => events.map((e) => e.type);
  const finals = (type: 'source-subtitle-final' | 'translation-subtitle-final') =>
    events.flatMap((e) => (e.type === type ? [e.text] : []));
  return { client, events, types, finals, params };
};

const audioFrames = (conn: FakeConn) =>
  conn.messages.filter((m) => m.realtimeInput?.audio);

describe('GeminiClient', () => {
  it('sends the translation setup and resolves only after setupComplete', async () => {
    autoSetup = false;
    const { client, types } = makeClient();
    let resolved = false;
    const started = client.start(PARAMS).then(() => {
      resolved = true;
    });

    await waitFor(() => conns[0]?.messages.length === 1);
    const conn = conns[0]!;
    expect(conn.url).toBe('/ws?key=test-key');
    expect(conn.messages[0]).toEqual({
      setup: {
        model: GEMINI_MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: { targetLanguageCode: 'zh-Hans', echoTargetLanguage: false }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    conn.send({ setupComplete: {} });
    await started;
    expect(types()).toEqual(['session-started']);
    await client.cancel();
  });

  it('rejects start() with the server close reason when setup is refused', async () => {
    autoSetup = false;
    wss.on('connection', (socket) => {
      socket.once('message', () => socket.close(1008, 'API key not valid.'));
    });
    const { client } = makeClient();
    const err = await client.start(PARAMS).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/code=1008.*API key not valid/);
    expect(err).toMatchObject({ kind: 'auth', closeCode: 1008, provider: 'gemini' });
    // The key rides in the URL query; it must not leak into the message.
    expect((err as Error).message).not.toMatch(/test-key/);
  });

  it('rejects a pending start() when cancelled mid-setup', async () => {
    autoSetup = false;
    const { client, events } = makeClient();
    const started = client.start(PARAMS);
    await waitFor(() => conns[0]?.messages.length === 1);
    await client.cancel();
    await expect(started).rejects.toThrow(/canceled/);
    await waitFor(() => conns[0]!.closed);
    expect(events).toEqual([]);
  });

  it('cancel() before start() makes start() reject without connecting', async () => {
    const { client, events } = makeClient();
    await client.cancel();
    await expect(client.start(PARAMS)).rejects.toThrow(/canceled before setupComplete/);
    await new Promise((r) => setTimeout(r, 20));
    expect(conns).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it('a second start() rejects, while live and after the session ended', async () => {
    const { client, types } = makeClient();
    await client.start(PARAMS);
    await expect(client.start(PARAMS)).rejects.toThrow('Gemini session already started');
    await client.finish();
    await waitFor(() => types().includes('session-finished'));
    await expect(client.start(PARAMS)).rejects.toThrow('Gemini session already started');
    expect(conns).toHaveLength(1);
  });

  it('coalesces PCM into 100 ms realtimeInput frames', async () => {
    const { client } = makeClient();
    await client.start(PARAMS);
    for (let i = 0; i < 10; i++) await client.sendAudio(new Uint8Array(320).fill(i));

    await waitFor(() => audioFrames(conns[0]!).length === 1);
    // The hand-built frame is exactly the realtimeInput JSON shape.
    expect(audioFrames(conns[0]!)[0]).toEqual({
      realtimeInput: { audio: { data: expect.any(String), mimeType: 'audio/pcm;rate=16000' } }
    });
    const { audio } = audioFrames(conns[0]!)[0].realtimeInput;
    expect(audio.mimeType).toBe('audio/pcm;rate=16000');
    const pcm = Buffer.from(audio.data, 'base64');
    expect(pcm.byteLength).toBe(3_200);
    expect(pcm[0]).toBe(0);
    expect(pcm[3_199]).toBe(9);
    await client.cancel();
  });

  it('maps transcripts and audio to subtitle and TTS events', async () => {
    const { client, types, finals, events } = makeClient();
    await client.start(PARAMS);
    const conn = conns[0]!;
    conn.send({ serverContent: { inputTranscription: { text: ' Good morning.' } } });
    conn.send({ serverContent: { outputTranscription: { text: '早上好。' } } });
    conn.send({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AQIDBA==' } }] }
      }
    });

    // " Good morning." ends in a still-pending "." — the line timer closes it.
    await waitFor(
      () => types().includes('tts-sentence-end') && types().includes('source-subtitle-final')
    );
    expect(finals('source-subtitle-final')).toEqual(['Good morning.']);
    expect(finals('translation-subtitle-final')).toEqual(['早上好。']);
    const audio = events.find((e) => e.type === 'tts-audio');
    expect(audio?.type === 'tts-audio' && new Uint8Array(audio.data)).toEqual(
      new Uint8Array([1, 2, 3, 4])
    );
    expect(types().indexOf('tts-sentence-start')).toBeLessThan(types().indexOf('tts-audio'));
    expect(client.outputSampleRate).toBe(24_000);
    await client.cancel();
  });

  it('drops output audio in subtitles-only (s2t) mode', async () => {
    const params: GeminiStartParams = { ...PARAMS, mode: 's2t' };
    const { client, types } = makeClient(params);
    await client.start(params);
    conns[0]!.send({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQIDBA==' } }] } }
    });
    conns[0]!.send({ serverContent: { outputTranscription: { text: '你好。' } } });
    await waitFor(() => types().includes('translation-subtitle-final'));
    expect(types()).not.toContain('tts-audio');
    expect(types()).not.toContain('tts-sentence-start');
    await client.cancel();
  });

  it('ignores the silence padding Gemini streams between and after speech', async () => {
    const { client, events, types } = makeClient();
    await client.start(PARAMS);
    const conn = conns[0]!;
    const speech = Buffer.alloc(480);
    for (let i = 0; i < 240; i++) speech.writeInt16LE(i % 2 ? 4000 : -4000, i * 2);
    conn.send({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: speech.toString('base64') } }] } }
    });
    // The real server keeps sending zeros for as long as the socket is open.
    const silence = Buffer.alloc(480).toString('base64');
    const padding = setInterval(
      () => conn.send({ serverContent: { modelTurn: { parts: [{ inlineData: { data: silence } }] } } }),
      5
    );
    try {
      await waitFor(() => types().includes('tts-sentence-end'));
      const audioAfterEnd = () =>
        events.slice(types().indexOf('tts-sentence-end')).filter((e) => e.type === 'tts-audio');
      await new Promise((r) => setTimeout(r, 40));
      expect(audioAfterEnd()).toHaveLength(0);

      const finishAt = Date.now();
      await client.finish();
      await waitFor(() => types().includes('session-finished'));
      // Finished on the quiet timer, not the finishMaxMs (2 s) cap.
      expect(Date.now() - finishAt).toBeLessThan(500);
    } finally {
      clearInterval(padding);
    }
  });

  it('closes the line pair after silence', async () => {
    const { client, finals } = makeClient();
    await client.start(PARAMS);
    conns[0]!.send({ serverContent: { inputTranscription: { text: ' so anyway' } } });
    conns[0]!.send({ serverContent: { outputTranscription: { text: '总之' } } });
    await waitFor(() => finals('translation-subtitle-final').length === 1);
    expect(finals('source-subtitle-final')).toEqual(['so anyway']);
    expect(finals('translation-subtitle-final')).toEqual(['总之']);
    await client.cancel();
  });

  it('finish() sends audioStreamEnd, keeps trailing output, then finishes', async () => {
    const { client, types, finals } = makeClient();
    await client.start(PARAMS);
    const conn = conns[0]!;
    await client.sendAudio(new Uint8Array(640));
    conn.send({ serverContent: { inputTranscription: { text: ' See you' } } });
    await waitFor(() => types().includes('source-subtitle-delta'));

    await client.finish();
    await waitFor(() => conn.messages.some((m) => m.realtimeInput?.audioStreamEnd));
    // The half-filled audio frame was flushed before the end-of-stream marker.
    const endIdx = conn.messages.findIndex((m) => m.realtimeInput?.audioStreamEnd);
    expect(conn.messages.findIndex((m) => m.realtimeInput?.audio)).toBeLessThan(endIdx);

    conn.send({ serverContent: { outputTranscription: { text: '回头见' } } });
    await waitFor(() => types().includes('session-finished'));
    expect(finals('source-subtitle-final')).toEqual(['See you']);
    expect(finals('translation-subtitle-final')).toEqual(['回头见']);
    expect(types().at(-1)).toBe('session-finished');
    await waitFor(() => conn.closed);
  });

  it('rotates to a fresh connection on goAway without dropping output', async () => {
    const { client, types, finals } = makeClient();
    await client.start(PARAMS);
    const first = conns[0]!;
    first.send({ goAway: { timeLeft: '10s' } });

    await waitFor(() => conns.length === 2 && conns[1]!.messages.some((m) => m.setup));
    const second = conns[1]!;
    await waitFor(() => first.messages.some((m) => m.realtimeInput?.audioStreamEnd));

    await client.sendAudio(new Uint8Array(3_200));
    await waitFor(() => audioFrames(second).length === 1);
    expect(audioFrames(first)).toHaveLength(0);

    // The retired connection's trailing output still reaches the UI.
    first.send({ serverContent: { outputTranscription: { text: '最后一句。' } } });
    await waitFor(() => finals('translation-subtitle-final').length === 1);
    await waitFor(() => first.closed);
    expect(types()).not.toContain('session-failed');
    await client.cancel();
  });

  it('reconnects after an unexpected close but fails on a fatal close code', async () => {
    const { client, events, types } = makeClient();
    await client.start(PARAMS);
    conns[0]!.socket.close(1011, 'Internal error');
    await waitFor(() => conns.length === 2 && conns[1]!.messages.some((m) => m.setup));
    await new Promise((r) => setTimeout(r, 20));
    expect(types()).not.toContain('session-failed');

    conns[1]!.socket.close(1008, 'Quota exceeded');
    await waitFor(() => types().includes('session-failed'));
    expect(events.find((e) => e.type === 'session-failed')).toEqual({
      type: 'session-failed',
      kind: 'quota',
      code: 1008,
      message: 'Quota exceeded'
    });
  });

  it('reports link phases and estimates audio tokens both ways, until cancel', async () => {
    const telemetry: ClientTelemetry[] = [];
    const params: GeminiStartParams = { ...PARAMS, mode: 's2t' };
    const { client } = makeClient(params, { onTelemetry: (s) => telemetry.push(s) });
    await client.start(params);
    expect(telemetry.map((s) => (s.type === 'link' ? s.phase : s.type))).toEqual([
      'connecting',
      'open',
      'ready'
    ]);
    expect(telemetry[0]).toEqual({ type: 'link', phase: 'connecting', reconnect: false });

    const usage = () =>
      telemetry.flatMap((s) => (s.type === 'usage' ? [s] : []));
    // 100 ms of 16 kHz audio out = 2.5 tokens.
    await client.sendAudio(new Uint8Array(3_200));
    await waitFor(() => usage().length === 1);
    expect(usage()[0]).toEqual({ type: 'usage', estimated: true, tokens: { inputAudio: 2.5 } });
    // 0.5 s of 24 kHz audio back = 12.5 tokens — billed even in s2t, where
    // nothing is played.
    conns[0]!.send({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(24_000).toString('base64') } }] }
      }
    });
    await waitFor(() => usage().length === 2);
    expect(usage()[1].tokens).toEqual({ outputAudio: 12.5 });

    conns[0]!.socket.close(1011, 'Internal error');
    await waitFor(() =>
      telemetry.some((s) => s.type === 'link' && s.phase === 'connecting' && s.reconnect)
    );
    await waitFor(() => conns.length === 2 && conns[1]!.messages.some((m) => m.setup));

    await client.cancel();
    const count = telemetry.length;
    conns[1]!.send({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AQIDBA==' } }] } }
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(telemetry).toHaveLength(count);
  });

  it('rejects start() when the server never answers setup', async () => {
    autoSetup = false;
    const { client, events } = makeClient(PARAMS, {
      timings: { ...TIMINGS, setupTimeoutMs: 50 }
    });
    const err = await client.start(PARAMS).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/setup timed out/);
    expect(err).toMatchObject({ kind: 'timeout' });
    await waitFor(() => conns[0]!.closed);
    expect(events).toEqual([]);
  });

  it('reports the HTTP status and body when the upgrade is refused', async () => {
    const refusing = new WebSocketServer({
      port: 0,
      verifyClient: (_info, cb) => cb(false, 403, 'API key not valid')
    });
    await new Promise<void>((r) => refusing.once('listening', () => r()));
    try {
      const { client } = makeClient(PARAMS, {
        endpoint: `ws://127.0.0.1:${(refusing.address() as AddressInfo).port}/ws`
      });
      const err = await client.start(PARAMS).catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/HTTP 403.*API key not valid/);
      expect(err).toMatchObject({ kind: 'auth', httpStatus: 403 });
    } finally {
      await new Promise<void>((r) => refusing.close(() => r()));
    }
  });

  it('drops a connection that stops answering and reconnects', async () => {
    const { client, types } = makeClient(PARAMS, {
      timings: { ...TIMINGS, keepaliveIntervalMs: 20, keepaliveTimeoutMs: 80 }
    });
    await client.start(PARAMS);
    // Half-open: the server stops reading, so pings go unanswered and no
    // frame arrives — nothing ever errors or closes on its own.
    conns[0]!.socket.pause();

    await waitFor(() => conns.length === 2 && conns[1]!.messages.some((m) => m.setup));
    // The paused server only notices the client hung up once it reads again.
    conns[0]!.socket.resume();
    await waitFor(() => conns[0]!.closed);
    expect(types()).not.toContain('session-failed');
    await client.cancel();
  });

  it('drops uplink audio while the socket send buffer is backed up', async () => {
    const { client } = makeClient();
    await client.start(PARAMS);
    const ws = (client as any).current.ws;
    let buffered = 10 * 1024 * 1024;
    Object.defineProperty(ws, 'bufferedAmount', { get: () => buffered });

    await client.sendAudio(new Uint8Array(3_200));
    await new Promise((r) => setTimeout(r, 30));
    expect(audioFrames(conns[0]!)).toHaveLength(0);

    buffered = 0;
    await client.sendAudio(new Uint8Array(3_200));
    await waitFor(() => audioFrames(conns[0]!).length === 1);
    await client.cancel();
  });

  it('keeps TTS chunks on whole samples when the server splits one', async () => {
    const { client, events } = makeClient();
    await client.start(PARAMS);
    const speech = speechBytes(960);
    conns[0]!.send({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: speech.subarray(0, 481).toString('base64') } }] } }
    });
    conns[0]!.send({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: speech.subarray(481).toString('base64') } }] } }
    });
    await waitFor(() => events.filter((e) => e.type === 'tts-audio').length === 2);
    const chunks = events.flatMap((e) => (e.type === 'tts-audio' ? [Buffer.from(e.data)] : []));
    expect(chunks.map((c) => c.byteLength)).toEqual([480, 480]);
    expect(Buffer.concat(chunks).equals(speech)).toBe(true);
    await client.cancel();
  });

  it('does not decode output audio in subtitles-only (s2t) mode', async () => {
    const decode = vi.spyOn(Pcm16Carry.prototype, 'fromBase64');
    const params: GeminiStartParams = { ...PARAMS, mode: 's2t' };
    const { client, types } = makeClient(params);
    await client.start(params);
    conns[0]!.send({
      serverContent: { modelTurn: { parts: [{ inlineData: { data: speechBytes(480).toString('base64') } }] } }
    });
    conns[0]!.send({ serverContent: { outputTranscription: { text: '你好。' } } });
    await waitFor(() => types().includes('translation-subtitle-final'));
    expect(decode).not.toHaveBeenCalled();
    await client.cancel();
  });

  it('rejects start() when the proxy never answers CONNECT (B4)', async () => {
    const proxy = await startBlackHoleProxy();
    try {
      const { client, events } = makeClient(PARAMS, {
        resolveAgent: async () => new HttpsProxyAgent(proxy.url),
        timings: { ...TIMINGS, handshakeTimeoutMs: 80 }
      });
      await expect(client.start(PARAMS)).rejects.toThrow(/handshake timed out after 80ms/);
      expect(conns).toHaveLength(0);
      expect(events).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  it('connects directly when the proxy lookup never answers (B4)', async () => {
    const { client, types } = makeClient(PARAMS, {
      resolveAgent: () => new Promise(() => undefined),
      timings: { ...TIMINGS, proxyResolveTimeoutMs: 30 }
    });
    await client.start(PARAMS);
    expect(types()).toEqual(['session-started']);
    await client.cancel();
  });

  it('a rotation stuck on a dead proxy times out and retries instead of blocking (B4)', async () => {
    const proxy = await startBlackHoleProxy();
    let viaProxy = false;
    try {
      const { client, types } = makeClient(PARAMS, {
        resolveAgent: async () => (viaProxy ? new HttpsProxyAgent(proxy.url) : undefined),
        timings: { ...TIMINGS, handshakeTimeoutMs: 60 }
      });
      await client.start(PARAMS);
      viaProxy = true;
      conns[0]!.send({ goAway: { timeLeft: '10s' } });
      // Let the first rotation hit the dead proxy and time out…
      await new Promise((r) => setTimeout(r, 90));
      expect(conns).toHaveLength(1);
      // …then the retry gets through once the network is back.
      viaProxy = false;
      await waitFor(() => conns.length === 2 && conns[1]!.messages.some((m) => m.setup));
      await waitFor(() => conns[0]!.messages.some((m) => m.realtimeInput?.audioStreamEnd));
      expect(types()).not.toContain('session-failed');
      await client.cancel();
    } finally {
      await proxy.close();
    }
  });

  it('runs one rotation at a time even while the proxy lookup is slow (B42)', async () => {
    let release: () => void = () => undefined;
    let slow: Promise<void> | null = null;
    const { client, types } = makeClient(PARAMS, {
      resolveAgent: async () => {
        if (slow) await slow;
        return undefined;
      }
    });
    await client.start(PARAMS);
    slow = new Promise<void>((r) => {
      release = r;
    });
    conns[0]!.send({ goAway: { timeLeft: '10s' } });
    conns[0]!.send({ goAway: { timeLeft: '9s' } });
    await new Promise((r) => setTimeout(r, 30));
    release();
    await waitFor(() => conns.length >= 2 && conns[1]!.messages.some((m) => m.setup));
    await new Promise((r) => setTimeout(r, 50));
    expect(conns).toHaveLength(2);
    expect(types()).not.toContain('session-failed');
    await client.cancel();
  });

  it('only real output refills the reconnect budget (B42)', async () => {
    // Every connection accepts setup, streams nothing but silence padding,
    // then drops. Before, that first serverContent reset the budget and the
    // session reconnected forever.
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        if (!JSON.parse(data.toString()).setup) return;
        // After the client has made this the current connection.
        setTimeout(() => {
          const silence = Buffer.alloc(480).toString('base64');
          socket.send(
            JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { data: silence } }] } } })
          );
          socket.send(JSON.stringify({ serverContent: { turnComplete: true } }));
          setTimeout(() => socket.close(1011, 'Internal error'), 10);
        }, 10);
      });
    });
    const { client, types, events } = makeClient();
    await client.start(PARAMS);
    await waitFor(() => types().includes('session-failed'));
    // The initial connection plus LIVE_RECONNECT_BUDGET.maxAttempts (3) attempts.
    expect(conns).toHaveLength(4);
    expect(events.at(-1)).toEqual({
      type: 'session-failed',
      kind: 'server',
      code: 1011,
      message: 'Internal error'
    });
  });

  it('a connection that stayed up a while refills the budget without any output', async () => {
    // A quiet meeting: no transcript ever arrives, but each connection
    // lived past LIVE_RECONNECT_BUDGET.stableAfterMs before an occasional drop.
    let offset = 0;
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        if (!JSON.parse(data.toString()).setup) return;
        setTimeout(() => {
          offset += 61_000;
          socket.close(1011, 'Internal error');
        }, 20);
      });
    });
    const { client, types } = makeClient();
    await client.start(PARAMS);
    // waitFor's deadline runs on the mocked Date.now; poll on a real clock.
    const deadline = performance.now() + 3_000;
    while (conns.length < 6 && !types().includes('session-failed')) {
      if (performance.now() > deadline) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(types()).not.toContain('session-failed');
    await client.cancel();
  });

  it('a transcript proves a reconnect worked and refills the budget (B42)', async () => {
    wss.on('connection', (socket) => {
      socket.on('message', (data) => {
        if (!JSON.parse(data.toString()).setup) return;
        // After the client has made this the current connection.
        setTimeout(() => {
          socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: ' hello' } } }));
          setTimeout(() => socket.close(1011, 'Internal error'), 10);
        }, 10);
      });
    });
    const { client, types } = makeClient();
    await client.start(PARAMS);
    await waitFor(() => conns.length >= 6, 3_000);
    expect(types()).not.toContain('session-failed');
    await client.cancel();
  });

  it('opens the socket through the resolved proxy agent', async () => {
    const agent = new http.Agent();
    const created = vi.spyOn(agent, 'createConnection');
    const { client } = makeClient(PARAMS, { resolveAgent: async () => agent });
    await client.start(PARAMS);
    expect(created).toHaveBeenCalled();
    await client.cancel();
    agent.destroy();
  });
});
