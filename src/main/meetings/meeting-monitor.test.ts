import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingMetricsSnapshot, MeetingUsageLine, PriceSheet } from '@shared/meeting-metrics-types.js';
import type { EngineId } from '@shared/engine-types.js';
import { MeetingMonitor } from './meeting-monitor.js';

vi.mock('@core/utils/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const QWEN: PriceSheet = {
  currency: 'CNY',
  perMillionTokens: { inputAudio: 10, outputText: 20 }
};

const harness = (opts: { meetingId?: string | null; stored?: MeetingUsageLine[] } = {}) => {
  let meetingId: string | null = opts.meetingId === undefined ? 'm1' : opts.meetingId;
  let now = 1_000;
  const published: (MeetingMetricsSnapshot | null)[] = [];
  const saved: { meetingId: string; lines: MeetingUsageLine[] }[] = [];
  const prices: Partial<Record<EngineId, PriceSheet>> = { qwen: QWEN };
  const monitor = new MeetingMonitor({
    currentMeetingId: () => meetingId,
    priceSheet: (id) => prices[id] ?? null,
    loadUsage: () => opts.stored ?? [],
    saveUsage: (id, lines) => saved.push({ meetingId: id, lines }),
    publish: (s) => published.push(s),
    now: () => now
  });
  return {
    monitor,
    published,
    saved,
    prices,
    last: () => published.at(-1) ?? null,
    setMeeting: (id: string | null) => {
      meetingId = id;
    },
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    }
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('MeetingMonitor — link state', () => {
  it('follows a session through connect, ready, reconnect and the end', () => {
    const h = harness();
    h.monitor.sessionCreated('speak', 'qwen');
    h.monitor.telemetry('speak', 'qwen', { type: 'link', phase: 'connecting' });
    h.monitor.telemetry('speak', 'qwen', { type: 'link', phase: 'open', ms: 120 });
    h.monitor.telemetry('speak', 'qwen', { type: 'link', phase: 'ready', ms: 300 });
    h.monitor.status({ direction: 'speak', status: 'running' });
    h.monitor.telemetry('speak', 'qwen', { type: 'link', phase: 'rtt', ms: 42 });
    let link = h.monitor.snapshot()!.links.speak!;
    expect(link).toMatchObject({ state: 'live', handshakeMs: 120, readyMs: 300, rttMs: 42 });

    h.advance(500);
    h.monitor.telemetry('speak', 'qwen', { type: 'link', phase: 'connecting', reconnect: true });
    link = h.monitor.snapshot()!.links.speak!;
    expect(link.state).toBe('reconnecting');
    expect(link.since).toBe(1_500);
    h.monitor.telemetry('speak', 'qwen', { type: 'link', phase: 'ready', ms: 200 });
    expect(h.monitor.snapshot()!.links.speak!.state).toBe('live');

    h.monitor.status({ direction: 'speak', status: 'finishing' });
    h.monitor.status({ direction: 'speak', status: 'idle' });
    expect(h.monitor.snapshot()!.links.speak!.state).toBe('idle');
    expect(h.monitor.snapshot()!.usage[0]).toMatchObject({ sessions: 1, reconnects: 1 });
  });

  it('stamps provider output as last received, but not our own failures', () => {
    const h = harness();
    h.monitor.sessionCreated('listen', 'qwen');
    h.advance(200);
    h.monitor.event({ direction: 'listen', type: 'source-subtitle-delta', text: 'hi' });
    expect(h.monitor.snapshot()!.links.listen!.lastRxAt).toBe(1_200);
    h.advance(200);
    h.monitor.event({ direction: 'listen', type: 'session-failed', kind: 'audio-device', message: 'x' });
    h.monitor.status({ direction: 'listen', status: 'failed', errorKind: 'audio-device' });
    const snap = h.monitor.snapshot()!;
    expect(snap.links.listen).toMatchObject({ lastRxAt: 1_200, state: 'failed' });
    expect(snap.usage[0].failures).toBe(1);
  });

  it('ignores link reports from a session the direction has moved on from', () => {
    const h = harness();
    h.monitor.sessionCreated('speak', 'qwen');
    h.monitor.sessionCreated('speak', 'gemini');
    h.monitor.telemetry('speak', 'qwen', { type: 'link', phase: 'rtt', ms: 999 });
    expect(h.monitor.snapshot()!.links.speak).toMatchObject({ engineId: 'gemini', rttMs: null });
  });
});

describe('MeetingMonitor — usage and cost', () => {
  it('sums token deltas, audio both ways and prices them per engine', () => {
    const h = harness();
    h.monitor.sessionCreated('speak', 'qwen');
    h.monitor.telemetry('speak', 'qwen', { type: 'usage', tokens: { inputAudio: 400_000, outputText: 50_000 } });
    h.monitor.telemetry('speak', 'qwen', { type: 'usage', tokens: { inputAudio: 600_000 } });
    // 1 s of 16 kHz PCM up, 0.5 s of 24 kHz TTS down.
    h.monitor.audioSent('speak', 'qwen', 32_000, 16_000);
    h.monitor.event({ direction: 'speak', type: 'tts-audio', data: new ArrayBuffer(24_000), sampleRate: 24_000 });

    const snap = h.monitor.snapshot()!;
    expect(snap.usage).toEqual([
      {
        engineId: 'qwen',
        direction: 'speak',
        tokens: { inputAudio: 1_000_000, outputText: 50_000 },
        estimated: false,
        audioInMs: 1_000,
        audioOutMs: 500,
        sessions: 1,
        reconnects: 0,
        failures: 0,
        cost: { amount: 11, currency: 'CNY', complete: true }
      }
    ]);
    expect(snap.costTotals).toEqual({ CNY: 11 });
    expect(snap.costIncomplete).toBe(false);
  });

  it('flags a cost that misses an unpriced category, and leaves unpriced engines out', () => {
    const h = harness();
    h.monitor.sessionCreated('speak', 'qwen');
    h.monitor.telemetry('speak', 'qwen', { type: 'usage', tokens: { inputAudio: 1_000_000, outputAudio: 5 } });
    h.monitor.sessionCreated('listen', 'gemini');
    h.monitor.telemetry('listen', 'gemini', { type: 'usage', tokens: { inputAudio: 10 } });
    const snap = h.monitor.snapshot()!;
    expect(snap.costTotals).toEqual({ CNY: 10 });
    expect(snap.costIncomplete).toBe(true);
    expect(snap.usage.find((l) => l.engineId === 'gemini')!.cost).toBeNull();
  });

  it('marks a line estimated once any of its tokens were', () => {
    const h = harness();
    h.monitor.sessionCreated('listen', 'gemini');
    h.monitor.telemetry('listen', 'gemini', { type: 'usage', tokens: { inputAudio: 25 }, estimated: true });
    h.monitor.telemetry('listen', 'gemini', { type: 'usage', tokens: { inputAudio: 25 } });
    expect(h.monitor.snapshot()!.usage[0]).toMatchObject({ estimated: true, tokens: { inputAudio: 50 } });
  });

  it('counts nothing outside a meeting but still tracks the link', () => {
    const h = harness({ meetingId: null });
    h.monitor.sessionCreated('speak', 'qwen');
    h.monitor.telemetry('speak', 'qwen', { type: 'usage', tokens: { inputAudio: 5 } });
    h.monitor.audioSent('speak', 'qwen', 3_200, 16_000);
    expect(h.monitor.snapshot()).toBeNull();
    h.monitor.flush();
    expect(h.saved).toEqual([]);
  });
});

describe('MeetingMonitor — publishing and persistence', () => {
  it('publishes at most once per tick, and only when something changed', () => {
    const h = harness();
    h.monitor.sync();
    const initial = h.published.length;
    h.monitor.sessionCreated('speak', 'qwen');
    for (let i = 0; i < 20; i++) {
      h.monitor.event({ direction: 'speak', type: 'source-subtitle-delta', text: String(i) });
    }
    expect(h.published.length).toBe(initial);
    h.advance(1_000);
    expect(h.published.length).toBe(initial + 1);
    h.advance(3_000);
    expect(h.published.length).toBe(initial + 1);
  });

  it('writes totals every few ticks and when the meeting ends', () => {
    const h = harness();
    h.monitor.sessionCreated('speak', 'qwen');
    h.monitor.telemetry('speak', 'qwen', { type: 'usage', tokens: { inputAudio: 100 } });
    h.advance(4_000);
    expect(h.saved).toEqual([]);
    h.advance(1_000);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].lines[0].tokens).toEqual({ inputAudio: 100 });
    // Nothing new: no write.
    h.advance(5_000);
    expect(h.saved).toHaveLength(1);

    h.monitor.telemetry('speak', 'qwen', { type: 'usage', tokens: { inputAudio: 1 } });
    h.setMeeting(null);
    h.monitor.sync();
    expect(h.saved).toHaveLength(2);
    expect(h.saved[1]).toMatchObject({ meetingId: 'm1' });
    expect(h.last()).toBeNull();
  });

  it('keeps counting on top of what a reopened meeting already stored', () => {
    const h = harness({
      stored: [
        {
          engineId: 'qwen',
          direction: 'listen',
          tokens: { inputAudio: 7 },
          estimated: false,
          audioInMs: 1_000,
          audioOutMs: 0,
          sessions: 2,
          reconnects: 0,
          failures: 0,
          cost: null
        }
      ]
    });
    h.monitor.sessionCreated('listen', 'qwen');
    h.monitor.telemetry('listen', 'qwen', { type: 'usage', tokens: { inputAudio: 3 } });
    expect(h.monitor.snapshot()!.usage[0]).toMatchObject({ tokens: { inputAudio: 10 }, sessions: 3 });
  });
});
