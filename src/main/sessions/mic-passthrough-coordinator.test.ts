import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let pendingMs = 0;

interface FakeConsumer {
  onError: ((message: string) => void) | null;
  /** A PCM consumer (a speak session), not the passthrough holder. */
  pcm: boolean;
  uid: string | undefined;
}

/**
 * What the fake native mic is doing: one shared capture, many consumers.
 * The queue runs while any consumer is attached.
 */
const mic = {
  consumers: new Map<number, FakeConsumer>(),
  nextId: 1,
  /** Times the AudioQueue would have been (re)built. */
  queueStarts: 0,
  /** Thrown by the next starts (device gone, permission denied, …). */
  startError: null as Error | null,
  /** Holds a start (mid-engage) until released; the queue runs after it. */
  startGate: null as Promise<void> | null,
  startFailures: 0,
  /** Native refuses the tee (the capture already failed). */
  teeRefusals: 0
};

const attach = (consumer: FakeConsumer): number => {
  if (mic.consumers.size === 0) mic.queueStarts++;
  const id = mic.nextId++;
  mic.consumers.set(id, consumer);
  return id;
};

const bridge = {
  getCapabilities: () => ({
    microphoneCapture: true,
    nativeTtsPlayback: true,
    hasVirtualOutput: true
  }),
  getTtsPendingMs: () => pendingMs,
  prepareTtsOutput: vi.fn(async () => {
    calls.push('prepare');
  }),
  flushTtsOutput: vi.fn(async () => {
    calls.push(`flush(pending=${pendingMs})`);
  }),
  startMicrophoneCapture: vi.fn(
    async (
      onPcm: unknown,
      uid?: string,
      onError?: (message: string) => void,
      _rate?: number
    ): Promise<number> => {
      calls.push('startMic');
      if (mic.startError) {
        mic.startFailures++;
        throw mic.startError;
      }
      if (mic.startGate) await mic.startGate;
      return attach({ onError: onError ?? null, pcm: onPcm !== null, uid });
    }
  ),
  stopMicrophoneCapture: vi.fn(async (id: number) => {
    calls.push(`stopMic(${id})`);
    mic.consumers.delete(id);
  }),
  stopAllMicrophoneCapture: vi.fn(async () => {
    calls.push('stopAllMic');
    mic.consumers.clear();
  }),
  setMicPassthroughEnabled: vi.fn(async (on: boolean) => {
    calls.push(`passthrough(${on})`);
    if (on && mic.teeRefusals > 0) {
      mic.teeRefusals--;
      throw new Error('microphone capture has failed');
    }
  })
};

vi.mock('../native/platform-native-bridge.js', () => ({
  platformNativeBridge: bridge
}));

/** A fresh coordinator; with a meeting open unless `meeting: false`. */
const load = async ({ meeting = true } = {}) => {
  vi.resetModules();
  const mod = await import('./mic-passthrough-coordinator.js');
  if (meeting) mod.micPassthroughCoordinator.setMeetingActive(true);
  return mod.micPassthroughCoordinator;
};

/** Let the coordinator's serialized task queue drain. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

/** What `stopAllNativeAudioServices` does to the mic + TTS behind our back. */
const bulkStopNativeAudio = async (): Promise<void> => {
  await bridge.stopAllMicrophoneCapture();
  pendingMs = 0;
};

/** The passthrough holder's consumers (no PCM). */
const holders = (): number[] =>
  [...mic.consumers].filter(([, c]) => !c.pcm).map(([id]) => id);

/** Fire onError on every consumer, as a native capture failure does. */
const failCapture = (message: string): void => {
  for (const consumer of [...mic.consumers.values()]) consumer.onError?.(message);
};

/** A speak session's PcmSource attaching to / leaving the shared capture. */
const sessionAttach = (): number => attach({ onError: null, pcm: true, uid: undefined });
const sessionDetach = (id: number): void => {
  mic.consumers.delete(id);
};

const lastPassthrough = (): string | undefined =>
  calls.filter((call) => call.startsWith('passthrough(')).at(-1);

const count = (call: string): number => calls.filter((c) => c === call).length;

beforeEach(() => {
  calls.length = 0;
  pendingMs = 0;
  mic.consumers.clear();
  mic.nextId = 1;
  mic.queueStarts = 0;
  mic.startError = null;
  mic.startGate = null;
  mic.startFailures = 0;
  mic.teeRefusals = 0;
  bridge.startMicrophoneCapture.mockClear();
  bridge.stopMicrophoneCapture.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('MicPassthroughCoordinator', () => {
  it('runs the mic capture and the TTS unit at the same 24 kHz rate', async () => {
    const c = await load();
    c.setDesired(true);
    await settle();
    expect(calls).toContain('passthrough(true)');

    expect(bridge.prepareTtsOutput).toHaveBeenLastCalledWith(24000);
    expect(bridge.startMicrophoneCapture.mock.lastCall?.at(-1)).toBe(24000);
  });

  it('asks the native capture for no PCM (the tee runs natively) but does pass onError', async () => {
    const c = await load();
    c.setDesired(true);
    await settle();
    const args = bridge.startMicrophoneCapture.mock.lastCall;
    expect(args?.[0]).toBeNull();
    expect(typeof args?.[2]).toBe('function');
  });

  it('stays off after a bulk halt but recovers when the user toggles the setting', async () => {
    const c = await load();
    c.setDesired(true);
    await settle();
    expect(calls).toContain('passthrough(true)');

    await c.halt();
    expect(holders()).toEqual([]);
    calls.length = 0;
    await settle();
    expect(calls).not.toContain('passthrough(true)');

    // Previously the bulk path reused `suspended`, which only a session end
    // could clear — toggling the switch did nothing.
    c.setDesired(false);
    c.setDesired(true);
    await settle();
    expect(calls).toContain('passthrough(true)');
  });

  describe('holds the mic only while a meeting is open', () => {
    it('stays off outside a meeting, engages when one opens, releases when it ends', async () => {
      const c = await load({ meeting: false });
      c.setDesired(true);
      await settle();
      expect(calls).not.toContain('startMic');
      expect(holders()).toEqual([]);

      c.setMeetingActive(true);
      await settle();
      expect(lastPassthrough()).toBe('passthrough(true)');
      const [holder] = holders();
      expect(holder).toBeDefined();

      c.setMeetingActive(false);
      await settle();
      expect(lastPassthrough()).toBe('passthrough(false)');
      expect(calls).toContain(`stopMic(${holder})`);
      expect(holders()).toEqual([]);
      expect(mic.consumers.size).toBe(0);
    });

    it('a meeting ending mid-session drops the parked consumer, and the session end does not re-engage', async () => {
      const c = await load();
      c.setDesired(true);
      await settle();
      const [holder] = holders();
      await c.suspend();
      const session = sessionAttach();

      c.setMeetingActive(false);
      await settle();
      expect(holders()).toEqual([]);
      expect(calls).toContain(`stopMic(${holder})`);
      // The session's own consumer keeps the shared capture running.
      expect([...mic.consumers.keys()]).toEqual([session]);

      sessionDetach(session);
      calls.length = 0;
      await c.resume();
      await settle();
      expect(calls).not.toContain('startMic');
      expect(mic.consumers.size).toBe(0);
    });

    it('opening a meeting lifts the halt the last one left behind', async () => {
      const c = await load();
      c.setDesired(true);
      await settle();
      // Idle timeout: bulk stop, then the meeting ends.
      await c.halt();
      c.setMeetingActive(false);
      await settle();
      calls.length = 0;

      c.setMeetingActive(true);
      await settle();
      expect(lastPassthrough()).toBe('passthrough(true)');
      expect(holders()).toHaveLength(1);
    });
  });

  describe('speak sessions share the capture (no AudioQueue restart)', () => {
    it('suspend only turns the tee off; the session joins the running capture', async () => {
      const c = await load();
      c.setDesired(true);
      await settle();
      const [holder] = holders();
      expect(mic.queueStarts).toBe(1);

      for (let round = 0; round < 3; round++) {
        calls.length = 0;
        await c.suspend();
        expect(calls).toEqual(['passthrough(false)', 'flush(pending=0)']);
        expect(holders()).toEqual([holder]);

        const session = sessionAttach();
        sessionDetach(session);

        await c.resume();
        expect(calls).not.toContain('startMic');
        expect(calls.some((call) => call.startsWith('stopMic'))).toBe(false);
        expect(lastPassthrough()).toBe('passthrough(true)');
      }
      expect(mic.queueStarts).toBe(1);
      expect(holders()).toEqual([holder]);
    });

    it('lets trailing TTS finish before re-engaging (engaging flushes the queue)', async () => {
      vi.useFakeTimers();
      const c = await load();
      c.setDesired(true);
      await vi.advanceTimersByTimeAsync(0);
      await c.suspend();
      calls.length = 0;

      pendingMs = 1500;
      const resumed = c.resume();
      await vi.advanceTimersByTimeAsync(300);
      expect(calls).toEqual([]);

      pendingMs = 0;
      await vi.advanceTimersByTimeAsync(200);
      await resumed;
      expect(calls[0]).toBe('prepare');
      expect(calls).toContain('flush(pending=0)');
      expect(calls).toContain('passthrough(true)');
      // The parked consumer is reused.
      expect(calls).not.toContain('startMic');
    });

    it('abandons the drain wait as soon as a new session suspends it', async () => {
      vi.useFakeTimers();
      const c = await load();
      c.setDesired(true);
      await vi.advanceTimersByTimeAsync(0);
      await c.suspend();
      calls.length = 0;

      pendingMs = 5000;
      void c.resume();
      await vi.advanceTimersByTimeAsync(150);
      const suspended = c.suspend();
      await vi.advanceTimersByTimeAsync(150);
      await suspended;
      expect(calls).not.toContain('passthrough(true)');
      expect(calls).not.toContain('startMic');
    });

    it('keeps a consumer an engage attached when a session suspends it mid-engage', async () => {
      const c = await load();
      let release!: () => void;
      mic.startGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      c.setDesired(true);
      await settle();
      expect(calls).toContain('startMic'); // inside the native start
      const suspended = c.suspend();
      release();
      await suspended;
      // Parked for the session to join: no tee, but the capture stays up.
      expect(holders()).toHaveLength(1);
      expect(lastPassthrough()).toBe('passthrough(false)');
      expect(calls).not.toContain('passthrough(true)');
    });

    it('releases the parked consumer when passthrough is turned off mid-session', async () => {
      const c = await load();
      c.setDesired(true);
      await settle();
      const [holder] = holders();
      await c.suspend();
      const session = sessionAttach();

      calls.length = 0;
      c.setDesired(false);
      await settle();
      expect(calls).toContain(`stopMic(${holder})`);
      // The session's consumer (and so the queue) is untouched, and its TTS
      // isn't flushed.
      expect([...mic.consumers.keys()]).toEqual([session]);
      expect(calls.some((call) => call.startsWith('flush'))).toBe(false);

      await c.resume();
      expect(calls).not.toContain('startMic');
    });

    it('moves to a newly selected microphone once the session ends', async () => {
      const c = await load();
      c.setMicrophoneDeviceUid('built-in');
      c.setDesired(true);
      await settle();
      const [holder] = holders();
      await c.suspend();

      calls.length = 0;
      c.setMicrophoneDeviceUid('usb-mic');
      await settle();
      expect(calls).toContain(`stopMic(${holder})`);
      expect(calls).not.toContain('startMic'); // not while the session runs

      await c.resume();
      expect(bridge.startMicrophoneCapture.mock.lastCall?.[1]).toBe('usb-mic');
      expect(lastPassthrough()).toBe('passthrough(true)');
    });

    it('only ever stops its own consumer', async () => {
      const c = await load();
      // A speak session already holds the capture (e.g. the bulk path
      // cleared `suspended` while one was still running).
      const session = sessionAttach();
      c.setDesired(true);
      await settle();
      expect(mic.startFailures).toBe(0);
      const [holder] = holders();

      c.setDesired(false);
      await settle();
      expect(calls.filter((call) => call.startsWith('stopMic'))).toEqual([`stopMic(${holder})`]);
      expect([...mic.consumers.keys()]).toEqual([session]);
    });
  });

  describe('bulk stop race (B13)', () => {
    it('releases the consumer of an engage that finished after the bulk stop, before halt', async () => {
      vi.useFakeTimers();
      const c = await load();
      // Passthrough is about to engage but waits for trailing TTS…
      pendingMs = 1000;
      c.setDesired(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(mic.consumers.size).toBe(0);

      // …when a bulk stop tears native audio down. Session cancels take a
      // while, during which the engage sees the drained TTS and completes.
      await bulkStopNativeAudio();
      await vi.advanceTimersByTimeAsync(200);
      expect(holders()).toHaveLength(1);

      c.forgetActiveState();
      await c.halt();
      await vi.advanceTimersByTimeAsync(0);
      expect(mic.consumers.size).toBe(0);
      expect(lastPassthrough()).toBe('passthrough(false)');
    });

    it('invalidates an engage that is still in flight when halt lands', async () => {
      const c = await load();
      let release!: () => void;
      mic.startGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      c.setDesired(true);
      await settle();
      expect(calls).toContain('startMic'); // the engage is inside the native start

      await bulkStopNativeAudio();
      c.forgetActiveState();
      const halted = c.halt();
      const before = calls.length;
      release(); // …which only completes after the bulk stop
      await halted;
      await settle();

      expect(mic.consumers.size).toBe(0);
      expect(calls.slice(before)).not.toContain('passthrough(true)');
    });

    it('resumes with exactly one consumer after a bulk stop', async () => {
      vi.useFakeTimers();
      const c = await load();
      pendingMs = 1000;
      c.setDesired(true);
      await vi.advanceTimersByTimeAsync(0);
      await bulkStopNativeAudio();
      await vi.advanceTimersByTimeAsync(200);
      const [late] = holders();
      expect(late).toBeDefined();

      c.forgetActiveState();
      await c.resume();
      await vi.advanceTimersByTimeAsync(0);
      // The consumer of unknown state is replaced, not leaked next to a new one.
      expect(calls).toContain(`stopMic(${late})`);
      expect(holders()).toHaveLength(1);
      expect(holders()).not.toContain(late);
      expect(lastPassthrough()).toBe('passthrough(true)');
    });

    it('never reuses a parked consumer a bulk stop detached', async () => {
      const c = await load();
      c.setDesired(true);
      await settle();
      await c.suspend();
      await bulkStopNativeAudio();
      c.forgetActiveState();
      await c.resume();
      await settle();
      // A fresh consumer: the tee isn't switched on with nothing behind it.
      expect(holders()).toHaveLength(1);
      expect(count('startMic')).toBe(2);
      expect(lastPassthrough()).toBe('passthrough(true)');
    });
  });

  describe('capture failure (B11)', () => {
    it('disengages, then re-engages after a backoff', async () => {
      vi.useFakeTimers();
      const c = await load();
      c.setDesired(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(holders()).toHaveLength(1);
      const startsBefore = bridge.startMicrophoneCapture.mock.calls.length;

      failCapture('麦克风设备已断开');
      await vi.advanceTimersByTimeAsync(0);
      expect(mic.consumers.size).toBe(0);
      expect(lastPassthrough()).toBe('passthrough(false)');
      expect(bridge.startMicrophoneCapture.mock.calls.length).toBe(startsBefore);

      await vi.advanceTimersByTimeAsync(1000);
      expect(bridge.startMicrophoneCapture.mock.calls.length).toBe(startsBefore + 1);
      expect(holders()).toHaveLength(1);
      expect(lastPassthrough()).toBe('passthrough(true)');
    });

    it('gives up after a bounded number of retries', async () => {
      vi.useFakeTimers();
      const c = await load();
      c.setDesired(true);
      await vi.advanceTimersByTimeAsync(0);
      const startsBefore = bridge.startMicrophoneCapture.mock.calls.length;

      mic.startError = new Error('device gone');
      failCapture('麦克风设备已断开');
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      const retries = bridge.startMicrophoneCapture.mock.calls.length - startsBefore;
      expect(retries).toBe(6);

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(bridge.startMicrophoneCapture.mock.calls.length - startsBefore).toBe(retries);

      // A user action earns a fresh attempt.
      mic.startError = null;
      c.setMicrophoneDeviceUid('another-mic');
      await vi.advanceTimersByTimeAsync(0);
      expect(holders()).toHaveLength(1);
    });

    it('also recovers when the capture dies while it is still engaging', async () => {
      vi.useFakeTimers();
      const c = await load();
      // The device went away between the consumer attaching and the tee
      // going on: native refuses the tee.
      mic.teeRefusals = 1;
      c.setDesired(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(mic.consumers.size).toBe(0);

      await vi.advanceTimersByTimeAsync(1000);
      expect(holders()).toHaveLength(1);
      expect(lastPassthrough()).toBe('passthrough(true)');
    });

    it('does not retry while a translation session holds the mic', async () => {
      vi.useFakeTimers();
      const c = await load();
      c.setDesired(true);
      await vi.advanceTimersByTimeAsync(0);
      failCapture('麦克风设备已断开');
      await vi.advanceTimersByTimeAsync(0);
      await c.suspend();
      const startsBefore = bridge.startMicrophoneCapture.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bridge.startMicrophoneCapture.mock.calls.length).toBe(startsBefore);
    });

    it('drops a parked consumer that failed mid-session, without touching the session TTS', async () => {
      vi.useFakeTimers();
      const c = await load();
      c.setDesired(true);
      await vi.advanceTimersByTimeAsync(0);
      const [holder] = holders();
      await c.suspend();

      calls.length = 0;
      failCapture('麦克风设备已断开');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toContain(`stopMic(${holder})`);
      expect(calls.some((call) => call.startsWith('flush'))).toBe(false);
      expect(calls).not.toContain('startMic');

      await c.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(holders()).toHaveLength(1);
      expect(holders()).not.toContain(holder);
      expect(lastPassthrough()).toBe('passthrough(true)');
    });

    it('ignores a late error from a capture it already replaced', async () => {
      const c = await load();
      c.setDesired(true);
      await settle();
      const [first] = holders();
      const staleOnError = mic.consumers.get(first!)?.onError;

      c.setMicrophoneDeviceUid('usb-mic');
      await settle();
      expect(holders()).toHaveLength(1);
      const stopsBefore = calls.filter((call) => call.startsWith('stopMic')).length;

      staleOnError?.('old capture died');
      await settle();
      expect(calls.filter((call) => call.startsWith('stopMic')).length).toBe(stopsBefore);
      expect(holders()).toHaveLength(1);
    });
  });
});
