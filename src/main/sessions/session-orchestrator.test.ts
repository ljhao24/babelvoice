import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '@shared/ipc-types.js';
import type {
  Direction,
  StartTranslationParams,
  TranslationStatusPayload
} from '@shared/ipc-types.js';
import { MissingCredentialsError } from '../translation/translation-error.js';
import type {
  ClientTelemetry,
  TranslationClient,
  TranslationEventBody
} from '../translation/translation-client.js';
import type { DirectionSession } from './direction-session.js';

// Shared timeline so tests can assert *ordering* across collaborators.
const timeline: string[] = [];

vi.mock('../window-manager.js', () => ({
  ensureSubtitleOverlayReady: vi.fn(async () => undefined)
}));
// Options each PCM source was built with, for asserting the capture choice.
const pcmSourceOptions: unknown[] = [];
vi.mock('./pcm-source.js', () => ({
  createPcmSource: (_direction: Direction, options: unknown) => {
    pcmSourceOptions.push(options);
    return {
      start: vi.fn(async () => {
        timeline.push('source.start');
      }),
      stop: vi.fn(async () => undefined)
    };
  }
}));
vi.mock('./tts-sink.js', () => ({
  createTtsSink: () => ({
    prepare: vi.fn(async () => undefined),
    play: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  })
}));
vi.mock('../i18n.js', () => ({ t: (key: string) => key }));

const { SessionOrchestrator } = await import('./session-orchestrator.js');

class FakeClient implements TranslationClient {
  readonly engineId = 'mock' as const;
  readonly inputSampleRate = 16000;
  readonly outputSampleRate = 16000;
  constructor(readonly emit: (body: TranslationEventBody) => void) {}
  start = vi.fn(async () => {
    timeline.push('client.start');
  });
  sendAudio = vi.fn(async () => undefined);
  finish = vi.fn(async () => undefined);
  cancel = vi.fn(async () => {
    timeline.push('client.cancel');
  });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** A promise the test settles by hand. */
const gate = (): { promise: Promise<void>; release: () => void } => {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const speak: StartTranslationParams = {
  direction: 'speak',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  mode: 's2s'
};
const listen: StartTranslationParams = {
  direction: 'listen',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  mode: 's2t'
};

const makeRegistry = () => {
  const slots = new Map<Direction, DirectionSession>();
  return {
    get size() {
      return slots.size;
    },
    has: (d: Direction) => slots.has(d),
    get: (d: Direction) => slots.get(d),
    set: (d: Direction, s: DirectionSession) => {
      slots.set(d, s);
    },
    delete: (d: Direction) => slots.delete(d),
    values: () => Array.from(slots.values()),
    clear: () => slots.clear()
  };
};

const makeHarness = () => {
  const registry = makeRegistry();
  const clients: FakeClient[] = [];
  const createClient = vi.fn(
    (
      _engineId: unknown,
      opts: {
        onEvent: (b: TranslationEventBody) => void;
        onTelemetry?: (s: ClientTelemetry) => void;
      }
    ) => {
      const client = new FakeClient(opts.onEvent);
      clients.push(client);
      return client;
    }
  );
  const broadcast = vi.fn((_channel: string, _payload: unknown) => undefined);
  const sendToControlWindow = vi.fn(
    (_channel: string, _payload: unknown) => undefined
  );
  const showSubtitleOverlay = vi.fn();
  const micArbiter = {
    suspendForSession: vi.fn(async () => {
      timeline.push('mic.suspend');
    }),
    resumeAfterSession: vi.fn(async () => {
      timeline.push('mic.resume');
    }),
    settleAfterBulkStop: vi.fn(async (mode: 'resume' | 'halt') => {
      timeline.push(`mic.settle(${mode})`);
    })
  };
  const stopAllNativeAudio = vi.fn(async () => {
    timeline.push('native.stopAll');
  });
  const observer = {
    sessionCreated: vi.fn(),
    status: vi.fn(),
    event: vi.fn(),
    telemetry: vi.fn(),
    audioSent: vi.fn()
  };
  const prefs: {
    preferredMicrophoneUid?: string;
    listenSourceAppBundleId?: string;
  } = { preferredMicrophoneUid: 'mic-uid' };
  const orchestrator = new SessionOrchestrator({
    registry,
    createClient,
    getActiveEngineId: () => 'mock',
    buildClientStartParams: (params) => ({
      engineId: 'mock',
      sourceLanguage: params.sourceLanguage,
      targetLanguage: params.targetLanguage,
      mode: params.mode
    }),
    getPreferences: () => prefs,
    broadcast,
    sendToControlWindow,
    showSubtitleOverlay,
    micArbiter,
    stopAllNativeAudio,
    observer
  });
  /** Every status sent for `direction`, through either channel. */
  const statuses = (direction: Direction): string[] =>
    [...broadcast.mock.calls, ...sendToControlWindow.mock.calls]
      .filter(([channel]) => channel === IPC.TranslationStatus)
      .map(([, payload]) => payload as TranslationStatusPayload)
      .filter((p) => p.direction === direction)
      .map((p) => p.status);
  return {
    orchestrator,
    registry,
    clients,
    createClient,
    broadcast,
    sendToControlWindow,
    showSubtitleOverlay,
    micArbiter,
    stopAllNativeAudio,
    observer,
    prefs,
    statuses
  };
};

beforeEach(() => {
  timeline.length = 0;
  pcmSourceOptions.length = 0;
});

describe('SessionOrchestrator.start — refusals', () => {
  it('refuses a same-language pair and settles the renderer as failed', async () => {
    const h = makeHarness();
    await expect(
      h.orchestrator.start({ ...speak, targetLanguage: 'zh' })
    ).rejects.toThrow('errors:sameLanguagePair');

    expect(h.broadcast).toHaveBeenCalledWith(IPC.TranslationStatus, {
      direction: 'speak',
      status: 'failed',
      errorMessage: 'errors:sameLanguagePair',
      errorKind: 'unknown'
    });
    expect(h.createClient).not.toHaveBeenCalled();
    expect(h.registry.size).toBe(0);
  });

  it('refuses a start while a bulk cancel is stopping every capture', async () => {
    const h = makeHarness();
    await h.orchestrator.start(speak);
    const nativeStop = gate();
    h.stopAllNativeAudio.mockImplementationOnce(() => nativeStop.promise);

    const bulk = h.orchestrator.cancelAll('resume');
    await expect(h.orchestrator.start(listen)).rejects.toThrow(
      'errors:sessionsStopping'
    );
    expect(h.broadcast).toHaveBeenCalledWith(IPC.TranslationStatus, {
      direction: 'listen',
      status: 'failed',
      errorMessage: 'errors:sessionsStopping',
      errorKind: 'unknown'
    });
    expect(h.registry.has('listen')).toBe(false);

    nativeStop.release();
    await bulk;
    // Once the sweep is over, starts go through again.
    await h.orchestrator.start(listen);
    expect(h.registry.get('listen')?.getStatus()).toBe('running');
  });

  it('other refusals before the session exists broadcast failed with the message', async () => {
    const h = makeHarness();
    // Listen + TTS without a Process Tap source would re-translate our TTS.
    await expect(
      h.orchestrator.start({ ...listen, mode: 's2s' })
    ).rejects.toThrow('errors:listenLoopback');
    expect(h.statuses('listen')).toEqual(['failed']);

    h.createClient.mockImplementationOnce(() => {
      throw new Error('Unknown translation engine: deepl');
    });
    await expect(h.orchestrator.start(speak)).rejects.toThrow('deepl');
    expect(h.broadcast).toHaveBeenLastCalledWith(IPC.TranslationStatus, {
      direction: 'speak',
      status: 'failed',
      errorMessage: 'Unknown translation engine: deepl',
      errorKind: 'unknown'
    });
    expect(h.registry.size).toBe(0);
    expect(h.showSubtitleOverlay).not.toHaveBeenCalled();
  });

  it('a typed refusal carries its own error kind', async () => {
    const h = makeHarness();
    h.createClient.mockImplementationOnce(() => {
      throw new MissingCredentialsError('qwen');
    });
    await expect(h.orchestrator.start(speak)).rejects.toThrow();
    expect(h.broadcast).toHaveBeenLastCalledWith(
      IPC.TranslationStatus,
      expect.objectContaining({
        direction: 'speak',
        status: 'failed',
        errorKind: 'credentials-missing'
      })
    );
  });

  it('a second start in the same direction re-syncs the renderer and rejects', async () => {
    const h = makeHarness();
    await h.orchestrator.start(speak);
    h.broadcast.mockClear();

    await expect(h.orchestrator.start(speak)).rejects.toThrow(
      'A speak session is already running'
    );
    expect(h.broadcast).toHaveBeenCalledWith(IPC.TranslationStatus, {
      direction: 'speak',
      status: 'running'
    });
    expect(h.createClient).toHaveBeenCalledTimes(1);
  });
});

describe('SessionOrchestrator — listen capture source', () => {
  it('taps the configured source app', async () => {
    const h = makeHarness();
    h.prefs.listenSourceAppBundleId = 'us.zoom.xos';
    await h.orchestrator.start(listen);
    expect(pcmSourceOptions).toEqual([
      expect.objectContaining({ listenSourceAppBundleId: 'us.zoom.xos' })
    ]);
  });

  it('captures the whole system when the session asks for it', async () => {
    const h = makeHarness();
    h.prefs.listenSourceAppBundleId = 'us.zoom.xos';
    await h.orchestrator.start({ ...listen, captureSystemAudio: true });
    expect(pcmSourceOptions).toEqual([
      expect.objectContaining({ listenSourceAppBundleId: undefined })
    ]);
  });

  it('refuses TTS playback with whole-system capture, source app or not', async () => {
    const h = makeHarness();
    h.prefs.listenSourceAppBundleId = 'us.zoom.xos';
    await expect(
      h.orchestrator.start({ ...listen, mode: 's2s', captureSystemAudio: true })
    ).rejects.toThrow('errors:listenLoopback');
    expect(h.createClient).not.toHaveBeenCalled();
  });
});

describe('SessionOrchestrator — mic hand-over with passthrough', () => {
  it('speak suspends passthrough before the handshake and resumes it once it ends', async () => {
    const h = makeHarness();
    await h.orchestrator.start(speak);
    expect(timeline.indexOf('mic.suspend')).toBeLessThan(
      timeline.indexOf('client.start')
    );
    expect(h.micArbiter.resumeAfterSession).not.toHaveBeenCalled();

    await h.orchestrator.finish('speak');
    h.clients[0].emit({ type: 'session-finished' });
    await flush();

    expect(h.registry.has('speak')).toBe(false);
    expect(h.micArbiter.resumeAfterSession).toHaveBeenCalledTimes(1);
  });

  it('listen never touches passthrough', async () => {
    const h = makeHarness();
    await h.orchestrator.start(listen);
    expect(await h.orchestrator.cancel('listen')).toBe(true);

    expect(h.micArbiter.suspendForSession).not.toHaveBeenCalled();
    expect(h.micArbiter.resumeAfterSession).not.toHaveBeenCalled();
    expect(h.registry.size).toBe(0);
  });

  it('a cancel during the hand-over ends the session idle and resumes passthrough', async () => {
    const h = makeHarness();
    const handOver = gate();
    h.micArbiter.suspendForSession.mockImplementationOnce(() => handOver.promise);
    const started = h.orchestrator.start(speak);
    await flush();

    const cancelled = h.orchestrator.cancel('speak');
    handOver.release();
    expect(await cancelled).toBe(true);
    await expect(started).rejects.toThrow('cancelled');

    expect(h.clients[0].start).not.toHaveBeenCalled();
    expect(h.registry.size).toBe(0);
    expect(h.statuses('speak')).toEqual(['connecting', 'cancelling', 'idle']);
    expect(h.micArbiter.resumeAfterSession).toHaveBeenCalledTimes(1);
  });
});

describe('SessionOrchestrator — observer', () => {
  it('reports lifecycle, events, telemetry and metered uplink with the engine', async () => {
    const h = makeHarness();
    await h.orchestrator.start(speak);
    expect(h.observer.sessionCreated).toHaveBeenCalledWith('speak', 'mock');
    expect(h.observer.status.mock.calls.map(([p]) => p.status)).toEqual([
      'connecting',
      'running'
    ]);

    h.createClient.mock.calls[0][1].onTelemetry?.({
      type: 'usage',
      tokens: { inputAudio: 3 }
    });
    expect(h.observer.telemetry).toHaveBeenCalledWith('speak', 'mock', {
      type: 'usage',
      tokens: { inputAudio: 3 }
    });

    h.clients[0].emit({ type: 'source-subtitle-delta', text: 'hi' });
    expect(h.observer.event).toHaveBeenCalledWith({
      direction: 'speak',
      type: 'source-subtitle-delta',
      text: 'hi'
    });

    // The session talks to the metered wrapper, which forwards the chunk.
    const session = h.registry.get('speak') as unknown as {
      client: TranslationClient;
    };
    const pcm = new Uint8Array(640);
    await session.client.sendAudio(pcm);
    expect(h.observer.audioSent).toHaveBeenCalledWith('speak', 'mock', 640, 16000);
    expect(h.clients[0].sendAudio).toHaveBeenCalledWith(pcm);
  });

  it('a refused start reports nothing', async () => {
    const h = makeHarness();
    await expect(h.orchestrator.start({ ...speak, targetLanguage: 'zh' })).rejects.toThrow();
    expect(h.observer.sessionCreated).not.toHaveBeenCalled();
  });
});

describe('SessionOrchestrator — routing', () => {
  it('a suppressOverlay session reaches only the control window', async () => {
    const h = makeHarness();
    await h.orchestrator.start({ ...speak, suppressOverlay: true });
    h.clients[0].emit({ type: 'source-subtitle-delta', text: 'hi' });

    expect(h.showSubtitleOverlay).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.sendToControlWindow).toHaveBeenCalledWith(IPC.TranslationEvent, {
      direction: 'speak',
      type: 'source-subtitle-delta',
      text: 'hi'
    });
    expect(h.statuses('speak')).toEqual(['connecting', 'running']);
  });

  it('a normal session shows the overlay, broadcasts events, and keeps TTS in the control window', async () => {
    const h = makeHarness();
    await h.orchestrator.start(speak);
    expect(h.showSubtitleOverlay).toHaveBeenCalledTimes(1);

    h.clients[0].emit({ type: 'source-subtitle-delta', text: 'hi' });
    h.clients[0].emit({ type: 'tts-audio', data: new ArrayBuffer(4) });

    expect(h.broadcast).toHaveBeenCalledWith(IPC.TranslationEvent, {
      direction: 'speak',
      type: 'source-subtitle-delta',
      text: 'hi'
    });
    const ttsTo = (fn: typeof h.broadcast): unknown[] =>
      fn.mock.calls.filter(
        ([channel, e]) =>
          channel === IPC.TranslationEvent &&
          (e as { type: string }).type === 'tts-audio'
      );
    expect(ttsTo(h.sendToControlWindow)).toHaveLength(1);
    expect(ttsTo(h.broadcast)).toHaveLength(0);
    expect(
      h.broadcast.mock.calls
        .filter(([channel]) => channel === IPC.TranslationStatus)
        .map(([, p]) => (p as TranslationStatusPayload).status)
    ).toEqual(['connecting', 'running']);
  });

  it('reports idle for directions with no session', async () => {
    const h = makeHarness();
    await h.orchestrator.start(listen);
    expect(h.orchestrator.getStatuses()).toEqual([
      { direction: 'speak', status: 'idle' },
      { direction: 'listen', status: 'running' }
    ]);
    expect(h.orchestrator.hasActiveSessions()).toBe(true);
    expect(await h.orchestrator.finish('speak')).toBe(false);
    expect(await h.orchestrator.cancel('speak')).toBe(false);
  });

});

describe('SessionOrchestrator.cancelAll', () => {
  it('cancels every session, stops native audio, then settles passthrough once', async () => {
    const h = makeHarness();
    await h.orchestrator.start(speak);
    await h.orchestrator.start(listen);

    await h.orchestrator.cancelAll('halt');

    expect(h.clients.map((c) => c.cancel.mock.calls.length)).toEqual([1, 1]);
    expect(h.stopAllNativeAudio).toHaveBeenCalledTimes(1);
    expect(h.registry.size).toBe(0);
    expect(h.statuses('speak').at(-1)).toBe('idle');
    expect(h.statuses('listen').at(-1)).toBe('idle');
    // The per-session hook stays out of it; the bulk path decides once.
    expect(h.micArbiter.resumeAfterSession).not.toHaveBeenCalled();
    expect(h.micArbiter.settleAfterBulkStop).toHaveBeenCalledWith('halt');
    expect(timeline.at(-1)).toBe('mic.settle(halt)');
  });

  it('overlapping calls keep the sweep closed until the last one finishes, and halt wins', async () => {
    const h = makeHarness();
    await h.orchestrator.start(speak);
    // The meeting-end sweep is still tearing the session down when quit's
    // sweep (with nothing left to cancel) starts and finishes.
    const teardown = gate();
    h.clients[0].cancel.mockImplementationOnce(() => teardown.promise);
    const meetingEnd = h.orchestrator.cancelAll('resume');
    await h.orchestrator.cancelAll('halt');

    await expect(h.orchestrator.start(listen)).rejects.toThrow(
      'errors:sessionsStopping'
    );

    teardown.release();
    await meetingEnd;
    expect(h.statuses('speak').at(-1)).toBe('idle');
    // The session ending mid-sweep didn't re-engage passthrough on its own,
    // and the meeting end didn't resume it under the quit.
    expect(h.micArbiter.resumeAfterSession).not.toHaveBeenCalled();
    expect(h.micArbiter.settleAfterBulkStop.mock.calls).toEqual([
      ['halt'],
      ['halt']
    ]);

    // The window reopens, and the halt doesn't stick to the next sweep.
    await h.orchestrator.start(speak);
    await h.orchestrator.cancelAll('resume');
    expect(h.micArbiter.settleAfterBulkStop).toHaveBeenLastCalledWith('resume');
  });

  it('a session still in the hand-over is cancelled, not orphaned outside the registry', async () => {
    const h = makeHarness();
    const handOver = gate();
    h.micArbiter.suspendForSession.mockImplementationOnce(() => handOver.promise);
    const started = h.orchestrator.start(speak);
    await flush();
    expect(h.registry.get('speak')?.getStatus()).toBe('connecting');

    const bulk = h.orchestrator.cancelAll('resume');
    handOver.release();
    await bulk;
    await expect(started).rejects.toThrow('cancelled');

    // The session never reached the provider and is gone for good: not in
    // the registry, idle, and not left running on its own.
    expect(h.clients[0].start).not.toHaveBeenCalled();
    expect(h.registry.size).toBe(0);
    expect(h.statuses('speak')).toEqual(['connecting', 'cancelling', 'idle']);
    expect(h.orchestrator.getStatuses()).toEqual([
      { direction: 'speak', status: 'idle' },
      { direction: 'listen', status: 'idle' }
    ]);
    expect(h.micArbiter.resumeAfterSession).not.toHaveBeenCalled();
    expect(h.micArbiter.settleAfterBulkStop).toHaveBeenCalledTimes(1);
    expect(h.micArbiter.settleAfterBulkStop).toHaveBeenCalledWith('resume');

    // And the next start is a fresh session.
    await h.orchestrator.start(speak);
    expect(h.clients).toHaveLength(2);
    expect(h.registry.get('speak')?.getStatus()).toBe('running');
  });
});
