import { describe, expect, it, vi } from 'vitest';

// The real loaders pull in electron; the module-level bridge then falls back
// to UnsupportedNativeBridge, which these tests don't touch.
vi.mock('./mac-bridge.js', () => ({ createMacBridge: () => null }));
vi.mock('./windows-bridge.js', () => ({ createWindowsBridge: () => null }));

const { NativeBridge } = await import('./platform-native-bridge.js');
type Addon = ConstructorParameters<typeof NativeBridge>[0]['addon'];

const deferred = () => {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const fakeAddon = (overrides: Partial<Addon> = {}): Addon => ({
  getCapabilities: () => ({
    platform: 'darwin',
    microphoneCapture: true,
    systemAudioCapture: true,
    processAudioCapture: true,
    nativeTtsPlayback: true,
    hasVirtualOutput: true
  }),
  getPermissions: () => ({
    screen: 'granted',
    microphone: 'granted',
    inputMonitoring: 'granted',
    accessibility: 'granted'
  }),
  listAudioDevices: () => [],
  getAudioDiagnostics: vi.fn(),
  startMicrophoneCapture: vi.fn(() => 7),
  stopMicrophoneCapture: vi.fn(() => true as const),
  startSystemAudioCapture: vi.fn(async () => undefined),
  stopSystemAudioCapture: vi.fn(async () => undefined),
  prepareTtsOutput: vi.fn(() => true as const),
  playPcm: vi.fn(() => true as const),
  flushTtsOutput: vi.fn(() => true as const),
  closeTtsOutput: vi.fn(() => true as const),
  configureSubtitleWindow: vi.fn(() => true as const),
  ...overrides
});

const bridgeFor = (addon: Addon) =>
  new NativeBridge({ platform: 'darwin', addon, virtualOutputPattern: 'babelvoice|blackhole' });

/** Let pending promise continuations run. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('NativeBridge microphone capture', () => {
  it('passes a null PCM callback through, so native delivers no PCM', async () => {
    const addon = fakeAddon();
    await bridgeFor(addon).startMicrophoneCapture(null, 'uid', undefined, 24000);
    const args = vi.mocked(addon.startMicrophoneCapture).mock.lastCall;
    expect(args?.[0]).toBeNull();
    expect(args?.slice(1, 2)).toEqual(['uid']);
    expect(args?.[3]).toBe(24000);
  });

  it('still wraps a real PCM callback (speak sessions keep receiving audio)', async () => {
    const addon = fakeAddon();
    const onPcm = vi.fn();
    await bridgeFor(addon).startMicrophoneCapture(onPcm);
    const wrapped = vi.mocked(addon.startMicrophoneCapture).mock.lastCall?.[0];
    expect(typeof wrapped).toBe('function');
    wrapped?.(Buffer.from([1, 2, 3, 4]));
    expect(onPcm).toHaveBeenCalledTimes(1);
    expect([...(onPcm.mock.calls[0]![0] as Uint8Array)]).toEqual([1, 2, 3, 4]);
  });

  it('resolves to the native consumer id and stops exactly that consumer', async () => {
    const addon = fakeAddon();
    const bridge = bridgeFor(addon);
    const id = await bridge.startMicrophoneCapture(null, 'uid');
    expect(id).toBe(7);
    await bridge.stopMicrophoneCapture(id);
    expect(vi.mocked(addon.stopMicrophoneCapture).mock.lastCall).toEqual([7]);
  });

  it('stops every consumer only on the explicit bulk call', async () => {
    const addon = fakeAddon();
    await bridgeFor(addon).stopAllMicrophoneCapture();
    // No id: native detaches every consumer and stops the queue.
    expect(vi.mocked(addon.stopMicrophoneCapture).mock.lastCall).toEqual([]);
  });

  it('reports the shared capture state when the addon can', () => {
    const state = {
      running: true,
      sampleRate: 24000,
      deviceUid: '',
      failed: false,
      consumers: 2,
      pcmConsumers: 1,
      queueStarts: 1,
      passthrough: true
    };
    expect(bridgeFor(fakeAddon()).getMicrophoneCaptureState()).toBeNull();
    expect(
      bridgeFor(fakeAddon({ getMicrophoneCaptureState: vi.fn(() => state) })).getMicrophoneCaptureState()
    ).toEqual(state);
  });

  it('surfaces a native start refusal (permission denied, virtual input)', async () => {
    const addon = fakeAddon({
      startMicrophoneCapture: vi.fn(() => {
        throw new Error('麦克风权限已被拒绝');
      })
    });
    await expect(bridgeFor(addon).startMicrophoneCapture(null)).rejects.toThrow('麦克风权限已被拒绝');
  });
});

describe('NativeBridge process audio capture', () => {
  it('resolves start only once the native (off-main-thread) start does', async () => {
    const start = deferred();
    const addon = fakeAddon({
      startProcessAudioCapture: vi.fn(() => start.promise),
      stopProcessAudioCapture: vi.fn(async () => undefined)
    });
    let started = false;
    const pending = bridgeFor(addon)
      .startProcessAudioCapture('com.google.Chrome', vi.fn())
      .then(() => {
        started = true;
      });
    await flush();
    expect(started).toBe(false);
    start.resolve();
    await pending;
    expect(started).toBe(true);
  });

  it('rejects start when the native build fails', async () => {
    const start = deferred();
    const addon = fakeAddon({
      startProcessAudioCapture: vi.fn(() => start.promise),
      stopProcessAudioCapture: vi.fn(async () => undefined)
    });
    const pending = bridgeFor(addon).startProcessAudioCapture('com.google.Chrome', vi.fn());
    start.reject(new Error('AudioHardwareCreateProcessTap failed'));
    await expect(pending).rejects.toThrow('AudioHardwareCreateProcessTap failed');
  });

  it('waits for the native teardown on stop', async () => {
    const stop = deferred();
    const addon = fakeAddon({
      startProcessAudioCapture: vi.fn(async () => undefined),
      stopProcessAudioCapture: vi.fn(() => stop.promise)
    });
    let stopped = false;
    const pending = bridgeFor(addon)
      .stopProcessAudioCapture()
      .then(() => {
        stopped = true;
      });
    await flush();
    expect(stopped).toBe(false);
    stop.resolve();
    await pending;
    expect(stopped).toBe(true);
  });
});

describe('NativeBridge surface', () => {
  it('no longer exposes the native global hotkey', () => {
    const bridge = bridgeFor(fakeAddon()) as unknown as Record<string, unknown>;
    expect(bridge.registerHotkey).toBeUndefined();
    expect(bridge.unregisterHotkey).toBeUndefined();
  });
});
