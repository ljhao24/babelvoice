import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Direction, TranslationEvent } from '../../shared/ipc-types.js';
import {
  DirectionProbeController,
  probePhase,
  type DirectionProbeSpec,
  type ProbeResult
} from './useDirectionProbe.js';

const speakSpec: DirectionProbeSpec = {
  params: { direction: 'speak', sourceLanguage: 'zh', targetLanguage: 'en', mode: 's2s' },
  doneOn: 'tts-sentence-end',
  timeoutMs: 30_000,
  messages: { failed: 'speak failed', timeout: 'speak timeout' }
};

interface Harness {
  probe: DirectionProbeController;
  emit: (event: TranslationEvent) => void;
  subscribed: () => boolean;
  startSession: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  stopSession: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

const setup = (spec: DirectionProbeSpec, opened = true): Harness => {
  let listener: ((e: TranslationEvent) => void) | null = null;
  const startSession = vi.fn(async () => opened);
  const stopSession = vi.fn(async () => undefined);
  const probe = new DirectionProbeController({
    spec: () => spec,
    startSession,
    stopSession,
    subscribe: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    }
  });
  return {
    probe,
    emit: (e) => listener?.(e),
    subscribed: () => listener !== null,
    startSession,
    stopSession
  };
};

const text = (
  direction: Direction,
  type:
    | 'source-subtitle-delta'
    | 'source-subtitle-final'
    | 'translation-subtitle-delta'
    | 'translation-subtitle-final',
  value: string
): TranslationEvent =>
  type.endsWith('final')
    ? ({ direction, type, text: value, startMs: 0, endMs: 1 } as TranslationEvent)
    : ({ direction, type, text: value } as TranslationEvent);

const ttsEnd = (direction: Direction): TranslationEvent => ({
  direction,
  type: 'tts-sentence-end',
  endMs: 1
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('probePhase', () => {
  const result = (patch: Partial<ProbeResult>): ProbeResult => ({
    done: false,
    error: null,
    partials: { src: '', tgt: '' },
    ...patch
  });

  it('puts the probe verdict ahead of the live status', () => {
    expect(probePhase(result({ done: true }), 'failed')).toBe('done');
    expect(probePhase(result({ error: 'x' }), 'running')).toBe('failed');
  });

  it('maps the session status otherwise', () => {
    expect(probePhase(result({}), 'idle')).toBe('idle');
    expect(probePhase(result({}), 'connecting')).toBe('connecting');
    expect(probePhase(result({}), 'running')).toBe('running');
    expect(probePhase(result({}), 'finishing')).toBe('finishing');
    expect(probePhase(result({}), 'cancelling')).toBe('finishing');
    // A failure the probe didn't attribute to itself (not started yet).
    expect(probePhase(result({}), 'failed')).toBe('idle');
  });
});

describe('DirectionProbeController — speak', () => {
  it('captures the text and finishes on the round-trip event, stopping the session', async () => {
    const h = setup(speakSpec);
    await h.probe.start();
    h.emit(text('speak', 'source-subtitle-delta', '你'));
    h.emit(text('speak', 'source-subtitle-final', '你好'));
    h.emit(text('speak', 'translation-subtitle-delta', 'Hel'));
    h.emit(text('speak', 'translation-subtitle-final', 'Hello'));
    expect(h.probe.getResult()).toMatchObject({
      done: false,
      partials: { src: '你好', tgt: 'Hello' }
    });
    expect(h.stopSession).not.toHaveBeenCalled();

    h.emit(ttsEnd('speak'));
    expect(h.probe.getResult()).toMatchObject({ done: true, error: null });
    expect(h.stopSession).toHaveBeenCalledTimes(1);

    // The timeout is disarmed and unmounting has nothing left to stop.
    vi.advanceTimersByTime(60_000);
    h.probe.dispose();
    expect(h.probe.getResult().error).toBeNull();
    expect(h.stopSession).toHaveBeenCalledTimes(1);
  });

  it("ignores the other direction's events", async () => {
    const h = setup(speakSpec);
    await h.probe.start();
    h.emit(text('listen', 'translation-subtitle-final', 'meeting audio'));
    h.emit(ttsEnd('listen'));
    expect(h.probe.getResult()).toMatchObject({ done: false, partials: { src: '', tgt: '' } });
  });

  it('times out from start, however many events arrive, and stops the session', async () => {
    const h = setup(speakSpec);
    await h.probe.start();
    vi.advanceTimersByTime(20_000);
    h.emit(text('speak', 'source-subtitle-delta', '你'));
    vi.advanceTimersByTime(9_999);
    expect(h.probe.getResult().error).toBeNull();
    vi.advanceTimersByTime(1);
    expect(h.probe.getResult().error).toBe('speak timeout');
    expect(h.stopSession).toHaveBeenCalledTimes(1);
  });

  it('reports a session failure with its message, else the fallback', async () => {
    const h = setup(speakSpec);
    await h.probe.start();
    h.probe.sessionFailed('45000003: bad key');
    expect(h.probe.getResult().error).toBe('45000003: bad key');
    // Main already tore the failed session down; nothing to stop.
    expect(h.stopSession).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(h.probe.getResult().error).toBe('45000003: bad key');

    const g = setup(speakSpec);
    await g.probe.start();
    g.probe.sessionFailed(null);
    expect(g.probe.getResult().error).toBe('speak failed');
  });

  it('ignores session failures while not listening (before start, after stop)', async () => {
    const h = setup(speakSpec);
    h.probe.sessionFailed('stale failure');
    expect(h.probe.getResult().error).toBeNull();

    await h.probe.start();
    await h.probe.stop();
    h.probe.sessionFailed('late failure');
    expect(h.probe.getResult().error).toBeNull();
    expect(h.subscribed()).toBe(false);
  });

  it('a restart clears the previous verdict', async () => {
    const h = setup(speakSpec);
    await h.probe.start();
    h.emit(text('speak', 'source-subtitle-final', '你好'));
    vi.advanceTimersByTime(30_000);
    expect(h.probe.getResult().error).toBe('speak timeout');

    await h.probe.start();
    expect(h.probe.getResult()).toEqual({
      done: false,
      error: null,
      partials: { src: '', tgt: '' }
    });
    expect(h.startSession).toHaveBeenCalledTimes(2);
  });

  it('unmounting mid-test stops the session it owns; idle unmounts are no-ops', async () => {
    const idle = setup(speakSpec);
    idle.probe.dispose(); // StrictMode's simulated unmount
    expect(idle.stopSession).not.toHaveBeenCalled();

    const h = setup(speakSpec);
    await h.probe.start();
    h.probe.dispose();
    expect(h.stopSession).toHaveBeenCalledTimes(1);
    expect(h.subscribed()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(h.probe.getResult().error).toBeNull();
  });

  it('does not stop a session it failed to open', async () => {
    const h = setup(speakSpec, false);
    await h.probe.start();
    h.probe.dispose();
    expect(h.stopSession).not.toHaveBeenCalled();
  });

  it('notifies subscribers on every change', async () => {
    const h = setup(speakSpec);
    const listener = vi.fn();
    const unsubscribe = h.probe.subscribeResult(listener);
    await h.probe.start();
    h.emit(text('speak', 'source-subtitle-delta', '你'));
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    h.emit(ttsEnd('speak'));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('DirectionProbeController — listen stimulus', () => {
  const playing: { stop: ReturnType<typeof vi.fn>; fail: (m: string) => void }[] = [];
  const listenSpec: DirectionProbeSpec = {
    params: { direction: 'listen', sourceLanguage: 'en', targetLanguage: 'zh', mode: 's2t' },
    doneOn: 'translation-subtitle-final',
    timeoutMs: 15_000,
    messages: { failed: 'listen failed', timeout: 'listen timeout' },
    stimulus: {
      delayMs: 400,
      play: (fail) => {
        const stop = vi.fn();
        playing.push({ stop, fail });
        return stop;
      }
    }
  };

  beforeEach(() => {
    playing.length = 0;
  });

  /** Start and let the settle delay elapse. */
  const startAndSettle = async (h: Harness): Promise<void> => {
    const started = h.probe.start();
    await vi.advanceTimersByTimeAsync(400);
    await started;
  };

  it('plays the stimulus only after the session opened and settled', async () => {
    const h = setup(listenSpec);
    const started = h.probe.start();
    await vi.advanceTimersByTimeAsync(399);
    expect(playing).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await started;
    expect(playing).toHaveLength(1);
  });

  it('never plays into a session that did not open', async () => {
    const h = setup(listenSpec, false);
    await startAndSettle(h);
    expect(playing).toHaveLength(0);
  });

  it('never plays when stopped or unmounted during the settle delay', async () => {
    const h = setup(listenSpec);
    const started = h.probe.start();
    await vi.advanceTimersByTimeAsync(100);
    await h.probe.stop();
    await vi.advanceTimersByTimeAsync(400);
    await started;
    expect(playing).toHaveLength(0);

    const g = setup(listenSpec);
    const startedG = g.probe.start();
    await vi.advanceTimersByTimeAsync(100);
    g.probe.dispose();
    await vi.advanceTimersByTimeAsync(400);
    await startedG;
    expect(playing).toHaveLength(0);
    expect(g.stopSession).toHaveBeenCalledTimes(1);
  });

  it('finishes on the final translation and stops session and stimulus', async () => {
    const h = setup(listenSpec);
    await startAndSettle(h);
    h.emit(text('listen', 'source-subtitle-final', 'It is illegal'));
    h.emit(text('listen', 'translation-subtitle-final', '这是违法的'));
    expect(h.probe.getResult()).toMatchObject({
      done: true,
      partials: { src: 'It is illegal', tgt: '这是违法的' }
    });
    expect(h.stopSession).toHaveBeenCalledTimes(1);
    expect(playing[0].stop).toHaveBeenCalledTimes(1);
  });

  it('stops the stimulus on timeout, stop and unmount', async () => {
    const timedOut = setup(listenSpec);
    await startAndSettle(timedOut);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(timedOut.probe.getResult().error).toBe('listen timeout');
    expect(playing[0].stop).toHaveBeenCalledTimes(1);
    expect(timedOut.stopSession).toHaveBeenCalledTimes(1);

    const stopped = setup(listenSpec);
    await startAndSettle(stopped);
    await stopped.probe.stop();
    expect(playing[1].stop).toHaveBeenCalledTimes(1);

    const unmounted = setup(listenSpec);
    await startAndSettle(unmounted);
    unmounted.probe.dispose();
    expect(playing[2].stop).toHaveBeenCalledTimes(1);
    expect(unmounted.stopSession).toHaveBeenCalledTimes(1);
  });

  it('a stimulus error fails the probe and releases the session', async () => {
    const h = setup(listenSpec);
    await startAndSettle(h);
    playing[0].fail('clip failed to load');
    expect(h.probe.getResult().error).toBe('clip failed to load');
    expect(h.stopSession).toHaveBeenCalledTimes(1);
    expect(playing[0].stop).toHaveBeenCalledTimes(1);
  });

  it('ignores a stimulus error reported after the probe let go', async () => {
    const h = setup(listenSpec);
    await startAndSettle(h);
    await h.probe.stop();
    // e.g. play() rejecting because stop paused it
    playing[0].fail('interrupted');
    expect(h.probe.getResult().error).toBeNull();

    const g = setup(listenSpec);
    await startAndSettle(g);
    g.emit(text('listen', 'translation-subtitle-final', '好'));
    playing[1].fail('interrupted');
    expect(g.probe.getResult()).toMatchObject({ done: true, error: null });
  });
});
