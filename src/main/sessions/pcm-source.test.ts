import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPcmSource } from './pcm-source.js';

type OnPcm = (pcm: Uint8Array) => void;
type OnError = (message: string) => void;

// Captures the callbacks pcm-source hands to the native bridge so tests can
// play the native side (PCM arriving, capture dying, start racing an error).
const native = vi.hoisted(() => ({
  onPcm: null as OnPcm | null,
  onError: null as OnError | null,
  startImpl: null as (() => Promise<void>) | null,
  stopImpl: null as (() => Promise<void>) | null,
  calls: [] as string[],
  args: [] as unknown[][],
  stopArgs: [] as unknown[][],
  /** Last consumer id the fake shared mic capture handed out. */
  lastMicId: 0
}));

vi.mock('../native/platform-native-bridge.js', () => {
  // The mic start resolves to a consumer id; the other captures to nothing.
  const start = (name: string, returnsId = false) => async (...args: unknown[]) => {
    native.calls.push(name);
    native.args.push(args);
    const fns = args.filter((arg): arg is (...a: never[]) => void => typeof arg === 'function');
    native.onPcm = fns[0] as OnPcm;
    native.onError = (fns[1] as OnError | undefined) ?? null;
    if (native.startImpl) await native.startImpl();
    return returnsId ? ++native.lastMicId : undefined;
  };
  const stop = (name: string) => async (...args: unknown[]) => {
    native.calls.push(name);
    native.stopArgs.push(args);
    if (native.stopImpl) await native.stopImpl();
  };
  return {
    platformNativeBridge: {
      startMicrophoneCapture: start('startMic', true),
      stopMicrophoneCapture: stop('stopMic'),
      startSystemAudioCapture: start('startSystem'),
      stopSystemAudioCapture: stop('stopSystem'),
      startProcessAudioCapture: start('startProcess'),
      stopProcessAudioCapture: stop('stopProcess')
    }
  };
});

const flushImmediates = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('PcmSource', () => {
  beforeEach(() => {
    native.onPcm = null;
    native.onError = null;
    native.startImpl = null;
    native.stopImpl = null;
    native.calls = [];
    native.args = [];
    native.stopArgs = [];
  });

  it('routes each direction to the matching native capture', async () => {
    await createPcmSource('speak', { microphoneDeviceUid: 'uid' }).start(vi.fn(), vi.fn());
    await createPcmSource('listen').start(vi.fn(), vi.fn());
    await createPcmSource('listen', { listenSourceAppBundleId: 'com.google.Chrome' }).start(
      vi.fn(),
      vi.fn()
    );
    expect(native.calls).toEqual(['startMic', 'startSystem', 'startProcess']);
  });

  it('asks every native capture for the requested sample rate', async () => {
    const sampleRate = 24000;
    await createPcmSource('speak', { microphoneDeviceUid: 'uid', sampleRate }).start(
      vi.fn(),
      vi.fn()
    );
    await createPcmSource('listen', { sampleRate }).start(vi.fn(), vi.fn());
    await createPcmSource('listen', {
      listenSourceAppBundleId: 'com.google.Chrome',
      sampleRate
    }).start(vi.fn(), vi.fn());
    // The rate is each start's trailing argument.
    expect(native.args.map((args) => args.at(-1))).toEqual([24000, 24000, 24000]);
    expect(native.args[0]![1]).toBe('uid');
    expect(native.args[2]![0]).toBe('com.google.Chrome');
  });

  it('fires onFailure at most once per start', async () => {
    const onFailure = vi.fn();
    const source = createPcmSource('listen');
    await source.start(vi.fn(), onFailure);
    native.onError?.('device gone');
    native.onError?.('again');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith('device gone');
  });

  it('never fires onFailure or onPcm after stop()', async () => {
    const onPcm = vi.fn();
    const onFailure = vi.fn();
    const source = createPcmSource('speak');
    await source.start(onPcm, onFailure);
    const lateError = native.onError;
    const latePcm = native.onPcm;
    await source.stop();
    lateError?.('late');
    latePcm?.(new Uint8Array(2));
    expect(onFailure).not.toHaveBeenCalled();
    expect(onPcm).not.toHaveBeenCalled();
  });

  it('defers a failure that races start() until after start resolved', async () => {
    const order: string[] = [];
    native.startImpl = async () => {
      native.onError?.('stopped while starting');
    };
    const source = createPcmSource('listen');
    await source.start(vi.fn(), (message) => order.push(`failure:${message}`));
    order.push('started');
    await flushImmediates();
    expect(order).toEqual(['started', 'failure:stopped while starting']);
  });

  it('drops a deferred failure if stop() runs first', async () => {
    const onFailure = vi.fn();
    native.startImpl = async () => {
      native.onError?.('boom');
    };
    const source = createPcmSource('listen');
    await source.start(vi.fn(), onFailure);
    await source.stop();
    await flushImmediates();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('reports a failed start through the rejection only', async () => {
    const onFailure = vi.fn();
    native.startImpl = async () => {
      native.onError?.('denied');
      throw new Error('permission denied');
    };
    const source = createPcmSource('listen');
    await expect(source.start(vi.fn(), onFailure)).rejects.toThrow('permission denied');
    native.onError?.('denied again');
    await flushImmediates();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('waits for the asynchronous process-tap start and teardown', async () => {
    // The tap is built and destroyed off the main thread now; start/stop must
    // not resolve before native says it is done.
    let finishStart!: () => void;
    let finishStop!: () => void;
    native.startImpl = () => new Promise<void>((resolve) => (finishStart = resolve));
    native.stopImpl = () => new Promise<void>((resolve) => (finishStop = resolve));
    const source = createPcmSource('listen', { listenSourceAppBundleId: 'us.zoom.xos' });
    const order: string[] = [];

    const started = source.start(vi.fn(), vi.fn()).then(() => order.push('started'));
    await flushImmediates();
    expect(order).toEqual([]);
    finishStart();
    await started;

    const stopped = source.stop().then(() => order.push('stopped'));
    await flushImmediates();
    expect(order).toEqual(['started']);
    finishStop();
    await stopped;
    expect(order).toEqual(['started', 'stopped']);
    expect(native.calls).toEqual(['startProcess', 'stopProcess']);
  });

  it('a restarted source only reports failures of the current run', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const source = createPcmSource('speak');
    await source.start(vi.fn(), first);
    const staleError = native.onError;
    await source.stop();
    await source.start(vi.fn(), second);
    staleError?.('old run');
    native.onError?.('new run');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('new run');
  });

  describe('speak (shared microphone capture)', () => {
    it('detaches exactly the consumer it attached', async () => {
      const source = createPcmSource('speak', { microphoneDeviceUid: 'uid', sampleRate: 16000 });
      await source.start(vi.fn(), vi.fn());
      const id = native.lastMicId;
      await source.stop();
      expect(native.calls).toEqual(['startMic', 'stopMic']);
      expect(native.stopArgs).toEqual([[id]]);
    });

    it('never touches the shared capture when it holds no consumer', async () => {
      const source = createPcmSource('speak');
      await source.stop();
      await source.start(vi.fn(), vi.fn());
      await source.stop();
      await source.stop();
      // One detach for the one consumer; the stray stops are no-ops instead
      // of tearing down a capture mic passthrough still holds.
      expect(native.calls).toEqual(['startMic', 'stopMic']);
    });

    it('releases a consumer whose start resolved after stop()', async () => {
      let finishStart!: () => void;
      native.startImpl = () => new Promise<void>((resolve) => (finishStart = resolve));
      const onPcm = vi.fn();
      const onFailure = vi.fn();
      const source = createPcmSource('speak');
      const started = source.start(onPcm, onFailure);
      await flushImmediates();
      await source.stop(); // before native handed out the id
      expect(native.calls).toEqual(['startMic']);

      finishStart();
      await started;
      expect(native.calls).toEqual(['startMic', 'stopMic']);
      expect(native.stopArgs).toEqual([[native.lastMicId]]);
      native.onPcm?.(new Uint8Array(2));
      native.onError?.('late');
      await flushImmediates();
      expect(onPcm).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('still aborts a pending system-audio start on stop (no handle needed)', async () => {
      native.startImpl = () => new Promise<void>(() => undefined);
      const source = createPcmSource('listen');
      void source.start(vi.fn(), vi.fn());
      await flushImmediates();
      await source.stop();
      expect(native.calls).toEqual(['startSystem', 'stopSystem']);
    });
  });
});
