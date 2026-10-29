import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranslationStatusPayload } from '@shared/ipc-types.js';
import type {
  TranslationClient,
  TranslationEventBody
} from '../translation/translation-client.js';
import {
  MissingCredentialsError,
  TranslationError
} from '../translation/translation-error.js';

// Shared timeline so tests can assert *ordering* across collaborators —
// the bugs these guard against were all about who ran first.
const timeline: string[] = [];

interface FakeSource {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onPcm: ((pcm: Uint8Array) => void) | null;
  onFailure: ((message: string) => void) | null;
  startGate: Promise<void>;
  releaseStart: () => void;
}

let source: FakeSource;

const makeSource = (): FakeSource => {
  let releaseStart = (): void => undefined;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const s: FakeSource = {
    onPcm: null,
    onFailure: null,
    startGate,
    releaseStart,
    start: vi.fn(async (onPcm, onFailure) => {
      s.onPcm = onPcm;
      s.onFailure = onFailure;
      await s.startGate;
      timeline.push('source.start');
    }),
    stop: vi.fn(async () => {
      timeline.push('source.stop');
    })
  };
  return s;
};

const sink = {
  prepare: vi.fn(async () => undefined),
  play: vi.fn(async () => undefined),
  close: vi.fn(async () => {
    timeline.push('sink.close');
  })
};

vi.mock('../window-manager.js', () => ({
  ensureSubtitleOverlayReady: vi.fn(async () => undefined)
}));
const createPcmSource = vi.fn(() => source);
vi.mock('./pcm-source.js', () => ({
  createPcmSource: (...args: unknown[]) => createPcmSource(...(args as []))
}));
vi.mock('./tts-sink.js', () => ({
  createTtsSink: () => sink
}));

const { DirectionSession, FINISH_DEADLINE_MS, uplinkChunkBytes } =
  await import('./direction-session.js');

class FakeClient implements TranslationClient {
  readonly engineId = 'mock' as const;
  readonly outputSampleRate = 16000;
  constructor(
    readonly inputSampleRate = 16000,
    readonly uplinkChunkMs?: number
  ) {}
  emit: (body: TranslationEventBody) => void = () => undefined;
  private rejectStart: ((err: Error) => void) | null = null;
  private resolveStart: (() => void) | null = null;
  sent: Uint8Array[] = [];
  start = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        this.resolveStart = resolve;
        this.rejectStart = reject;
      })
  );
  sendAudio = vi.fn(async (pcm: Uint8Array) => {
    this.sent.push(pcm);
  });
  finish = vi.fn(async () => undefined);
  cancel = vi.fn(async () => {
    timeline.push('client.cancel');
    this.rejectStart?.(new Error('cancelled'));
    this.rejectStart = null;
  });
  succeedStart(): void {
    this.resolveStart?.();
  }
  failStart(err: Error): void {
    this.rejectStart?.(err);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const makeSession = (inputSampleRate?: number, uplinkChunkMs?: number) => {
  const client = new FakeClient(inputSampleRate, uplinkChunkMs);
  const statuses: string[] = [];
  const payloads: TranslationStatusPayload[] = [];
  const events: Array<{ type: string }> = [];
  const onTerminated = vi.fn(() => {
    timeline.push('terminated');
  });
  const session = new DirectionSession(
    'speak',
    (onEvent) => {
      client.emit = onEvent;
      return client;
    },
    {
      onEvent: (e) => events.push(e),
      onStatus: (p) => {
        statuses.push(p.status);
        payloads.push(p);
      },
      onTerminated
    }
  );
  return { session, client, statuses, payloads, events, onTerminated };
};

const openRunning = async (inputSampleRate?: number, uplinkChunkMs?: number) => {
  const ctx = makeSession(inputSampleRate, uplinkChunkMs);
  const opened = ctx.session.open({} as never);
  await flush();
  ctx.client.succeedStart();
  await flush();
  source.releaseStart();
  await opened;
  return ctx;
};

beforeEach(() => {
  timeline.length = 0;
  source = makeSource();
  createPcmSource.mockClear();
  sink.prepare.mockClear();
  sink.play.mockClear();
  sink.close.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DirectionSession', () => {
  it('normal finish keeps the TTS unit alive and terminates once', async () => {
    const { session, client, statuses, onTerminated } = await openRunning();
    expect(statuses).toEqual(['connecting', 'running']);

    await session.finish();
    client.emit({ type: 'session-finished' });
    await flush();

    expect(statuses).toEqual(['connecting', 'running', 'finishing', 'idle']);
    expect(sink.close).not.toHaveBeenCalled();
    expect(onTerminated).toHaveBeenCalledTimes(1);
  });

  it('cancel during the handshake tears down once, before going idle', async () => {
    const { session, statuses, onTerminated } = makeSession();
    const opened = session.open({} as never);
    await flush();

    await session.cancel();
    await expect(opened).rejects.toThrow('cancelled');
    await flush();

    expect(statuses).toEqual(['connecting', 'cancelling', 'idle']);
    expect(sink.close).toHaveBeenCalledTimes(1);
    expect(onTerminated).toHaveBeenCalledTimes(1);
    // Passthrough re-engages from onTerminated: the unit must already be
    // closed, and nothing may close it afterwards.
    expect(timeline.indexOf('sink.close')).toBeLessThan(
      timeline.indexOf('terminated')
    );
    expect(timeline.lastIndexOf('sink.close')).toBe(
      timeline.indexOf('sink.close')
    );
  });

  it('cancel while capture is starting stops the capture open() started', async () => {
    const { session, client, statuses } = makeSession();
    const opened = session.open({} as never);
    await flush();
    client.succeedStart();
    await flush();
    expect(source.start).toHaveBeenCalled();

    const cancelled = session.cancel();
    await flush();
    // Capture comes up only after cancel() already ran its first stop.
    source.releaseStart();
    await cancelled;
    await expect(opened).rejects.toThrow('cancelled');

    expect(timeline.lastIndexOf('source.stop')).toBeGreaterThan(
      timeline.indexOf('source.start')
    );
    expect(statuses.at(-1)).toBe('idle');
    expect(sink.close).toHaveBeenCalledTimes(1);
  });

  it('a mid-session failure releases native resources before reporting failed', async () => {
    const { client, statuses, onTerminated } = await openRunning();
    client.emit({ type: 'session-failed', kind: 'server', code: 1, message: 'boom' });
    await flush();

    expect(statuses.at(-1)).toBe('failed');
    expect(onTerminated).toHaveBeenCalledTimes(1);
    expect(timeline.indexOf('sink.close')).toBeLessThan(
      timeline.indexOf('terminated')
    );
    expect(timeline.indexOf('source.stop')).toBeLessThan(
      timeline.indexOf('terminated')
    );
  });

  it('a session-failed while capture is starting ends failed, never running', async () => {
    const { session, client, statuses, onTerminated } = makeSession();
    const opened = session.open({} as never);
    await flush();
    client.succeedStart();
    await flush();
    expect(source.start).toHaveBeenCalled();

    // Socket drops while ScreenCaptureKit / the mic is still coming up.
    client.emit({ type: 'session-failed', kind: 'network', code: 1006, message: 'ws closed' });
    await flush();
    source.releaseStart();
    await expect(opened).rejects.toThrow('cancelled');
    await flush();

    expect(statuses).toEqual(['connecting', 'failed']);
    expect(session.getStatus()).toBe('failed');
    expect(onTerminated).toHaveBeenCalledTimes(1);
    // The late capture is stopped before passthrough may re-engage.
    expect(timeline.lastIndexOf('source.stop')).toBeGreaterThan(
      timeline.indexOf('source.start')
    );
    expect(timeline.lastIndexOf('source.stop')).toBeLessThan(
      timeline.indexOf('terminated')
    );
  });

  it('a session-failed during the handshake unblocks start() and ends failed', async () => {
    const { session, client, statuses, onTerminated } = makeSession();
    const opened = session.open({} as never);
    await flush();

    // FakeClient.start only settles on cancel — terminate must not wait on
    // open() before cancelling the client.
    client.emit({ type: 'session-failed', kind: 'protocol', code: 1, message: 'boom' });
    await expect(opened).rejects.toThrow('cancelled');
    await flush();

    expect(statuses).toEqual(['connecting', 'failed']);
    expect(onTerminated).toHaveBeenCalledTimes(1);
    expect(createPcmSource).not.toHaveBeenCalled();
  });

  it('cancel during beforeStart stops open() before the handshake', async () => {
    const { session, client, statuses, onTerminated } = makeSession();
    let release = (): void => undefined;
    const beforeStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const opened = session.open({} as never, undefined, { beforeStart });
    await flush();
    expect(statuses).toEqual(['connecting']);

    const cancelled = session.cancel();
    release();
    await cancelled;
    await expect(opened).rejects.toThrow('cancelled');

    expect(client.start).not.toHaveBeenCalled();
    expect(statuses).toEqual(['connecting', 'cancelling', 'idle']);
    expect(onTerminated).toHaveBeenCalledTimes(1);
  });

  it('a start failure reports failed with the error message', async () => {
    const { session, client, statuses, onTerminated } = makeSession();
    const opened = session.open({} as never);
    await flush();
    client.failStart(new Error('handshake failed (code=45000001)'));
    await expect(opened).rejects.toThrow('handshake failed');

    expect(statuses).toEqual(['connecting', 'failed']);
    expect(onTerminated).toHaveBeenCalledTimes(1);
  });

  it('gives up on a finish the server never acknowledges', async () => {
    const { session, client, statuses } = await openRunning();
    vi.useFakeTimers();
    await session.finish();
    expect(statuses.at(-1)).toBe('finishing');

    await vi.advanceTimersByTimeAsync(FINISH_DEADLINE_MS + 1);

    expect(client.cancel).toHaveBeenCalled();
    expect(statuses.at(-1)).toBe('idle');
  });

  it('surfaces a capture failure as a failed session', async () => {
    const { events, statuses, payloads } = await openRunning();
    source.onFailure?.('device unplugged');
    await flush();

    expect(events.at(-1)).toEqual({
      direction: 'speak',
      type: 'session-failed',
      kind: 'audio-device',
      message: 'speak capture stopped: device unplugged'
    });
    expect(statuses.at(-1)).toBe('failed');
    expect(payloads.at(-1)).toMatchObject({ status: 'failed', errorKind: 'audio-device' });
  });

  it("stamps TTS chunks with the client's output rate (main-authoritative, ADR-0002)", async () => {
    const { client, events } = await openRunning();
    const data = new ArrayBuffer(4);
    client.emit({ type: 'tts-audio', data });
    await flush();

    expect(events.at(-1)).toEqual({ direction: 'speak', type: 'tts-audio', data, sampleRate: 16000 });
    expect(sink.play).toHaveBeenCalledWith(data, 16000);
  });

  describe('errorKind on the failed status', () => {
    it("carries a client session-failed's kind and raw message", async () => {
      const { client, payloads } = await openRunning();
      client.emit({ type: 'session-failed', kind: 'quota', code: 1008, message: 'Quota exceeded' });
      await flush();
      expect(payloads.at(-1)).toEqual({
        direction: 'speak',
        status: 'failed',
        errorKind: 'quota',
        errorMessage: 'Quota exceeded'
      });
    });

    it.each([
      [
        'a TranslationError keeps its kind',
        new TranslationError('auth', 'Qwen handshake rejected (HTTP 401): {"code":"InvalidApiKey"}'),
        'auth'
      ],
      ['missing credentials cross IPC as credentials-missing', new MissingCredentialsError('qwen'), 'credentials-missing'],
      ['a plain Error from client.start() is unknown', new Error('boom'), 'unknown']
    ] as const)('start failure: %s', async (_name, err, kind) => {
      const { session, client, payloads } = makeSession();
      const opened = session.open({} as never);
      await flush();
      client.failStart(err);
      await expect(opened).rejects.toThrow();
      expect(payloads.at(-1)).toEqual({
        direction: 'speak',
        status: 'failed',
        errorKind: kind,
        errorMessage: err.message
      });
    });

    it('a TTS unit that fails to prepare is an audio-device failure', async () => {
      sink.prepare.mockRejectedValueOnce(new Error('AudioUnit init failed'));
      const { session, payloads } = makeSession();
      await expect(session.open({} as never)).rejects.toThrow('AudioUnit init failed');
      expect(payloads.at(-1)).toMatchObject({ status: 'failed', errorKind: 'audio-device' });
    });

    it('a capture that fails to start is an audio-device failure', async () => {
      source.start.mockRejectedValueOnce(new Error('mic permission denied'));
      const { session, client, payloads } = makeSession();
      const opened = session.open({} as never);
      await flush();
      client.succeedStart();
      await expect(opened).rejects.toThrow('mic permission denied');
      expect(payloads.at(-1)).toMatchObject({ status: 'failed', errorKind: 'audio-device' });
    });

    it('non-failed statuses carry no error fields', async () => {
      const { session, client, payloads } = await openRunning();
      await session.finish();
      client.emit({ type: 'session-finished' });
      await flush();
      for (const p of payloads) {
        expect(p).not.toHaveProperty('errorKind');
        expect(p.errorMessage).toBeUndefined();
      }
    });
  });

  it('batches small capture chunks into uplink packets and flushes the tail on finish', async () => {
    const { session, client } = await openRunning();
    const packet = uplinkChunkBytes(16000);
    expect(packet).toBe(2560); // 80 ms of 16 kHz / 16-bit mono
    const quarter = packet / 4;
    for (let i = 0; i < 5; i++) source.onPcm?.(new Uint8Array(quarter));
    expect(client.sent.map((c) => c.byteLength)).toEqual([packet]);

    await session.finish();
    expect(client.sent.map((c) => c.byteLength)).toEqual([packet, quarter]);
  });

  it("captures at the client's input rate and sizes uplink packets for it", async () => {
    const { client } = await openRunning(24000);
    expect(createPcmSource).toHaveBeenCalledWith(
      'speak',
      expect.objectContaining({ sampleRate: 24000 })
    );

    const packet = uplinkChunkBytes(24000);
    expect(packet).toBe(3840); // still 80 ms
    for (let i = 0; i < 3; i++) source.onPcm?.(new Uint8Array(packet / 2));
    expect(client.sent.map((c) => c.byteLength)).toEqual([packet]);
  });

  it('batches to the packet size the client frames at, so audio is not buffered twice', async () => {
    const { client } = await openRunning(16000, 100);
    const packet = uplinkChunkBytes(16000, 100);
    expect(packet).toBe(3200);
    // 40 ms mic buffers: 3 of them (120 ms) cross the 100 ms frame.
    const mic = uplinkChunkBytes(16000, 40);
    for (let i = 0; i < 2; i++) source.onPcm?.(new Uint8Array(mic));
    expect(client.sent).toEqual([]);
    source.onPcm?.(new Uint8Array(mic));
    expect(client.sent.map((c) => c.byteLength)).toEqual([3 * mic]);
  });
});
