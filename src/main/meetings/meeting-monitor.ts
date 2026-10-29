import type {
  Direction,
  SessionStatus,
  TranslationEvent,
  TranslationStatusPayload
} from '@shared/ipc-types.js';
import type { EngineId } from '@shared/engine-types.js';
import {
  addTokens,
  estimateCost,
  type DirectionLinkSnapshot,
  type LinkState,
  type MeetingMetricsSnapshot,
  type MeetingUsageLine,
  type PriceCurrency,
  type PriceSheet
} from '@shared/meeting-metrics-types.js';
import { log } from '@core/utils/logger.js';
import type { ClientTelemetry } from '../translation/translation-client.js';

/** What SessionOrchestrator reports about the sessions it runs. */
export interface SessionObserver {
  sessionCreated(direction: Direction, engineId: EngineId): void;
  status(payload: TranslationStatusPayload): void;
  event(event: TranslationEvent): void;
  telemetry(direction: Direction, engineId: EngineId, sample: ClientTelemetry): void;
  /** 16-bit mono PCM handed to the client. */
  audioSent(direction: Direction, engineId: EngineId, bytes: number, sampleRate: number): void;
}

export interface MeetingMonitorDeps {
  currentMeetingId: () => string | null;
  /** The price in force for an engine (user override, else the default). */
  priceSheet: (engineId: EngineId) => PriceSheet | null;
  loadUsage: (meetingId: string) => MeetingUsageLine[];
  saveUsage: (meetingId: string, lines: MeetingUsageLine[]) => void;
  /** Hand a snapshot to the control window; null when no meeting is open. */
  publish: (snapshot: MeetingMetricsSnapshot | null) => void;
  now?: () => number;
}

/** Snapshots go out at most this often (subtitle deltas arrive far faster). */
const TICK_MS = 1_000;
/** Usage totals reach the DB every this many ticks, and on every meeting change. */
const FLUSH_EVERY_TICKS = 5;

const LINK_STATE: Record<SessionStatus, LinkState> = {
  idle: 'idle',
  connecting: 'connecting',
  running: 'live',
  finishing: 'finishing',
  cancelling: 'finishing',
  failed: 'failed'
};

type UsageTotals = Omit<MeetingUsageLine, 'cost'>;

const usageKey = (engineId: EngineId, direction: Direction): string =>
  `${engineId}|${direction}`;

const pcmMs = (bytes: number, sampleRate: number): number =>
  sampleRate > 0 ? (bytes / 2 / sampleRate) * 1000 : 0;

/**
 * Watches every translation session on behalf of the open meeting: each
 * Direction's link health and the usage it runs up, priced per engine.
 * Usage is attributed to the meeting open when it is reported; outside a
 * meeting (onboarding probes) only link state is kept.
 *
 * Holds no session state of its own beyond these counters — the orchestrator
 * tells it what happened (SessionObserver) and it never acts on sessions.
 */
export class MeetingMonitor implements SessionObserver {
  private meetingId: string | null = null;
  private readonly links = new Map<Direction, DirectionLinkSnapshot>();
  private readonly usage = new Map<string, UsageTotals>();
  /** Something a snapshot shows changed since the last publish. */
  private changed = false;
  /** Usage changed since the last DB write. */
  private unsaved = false;
  private ticks = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: MeetingMonitorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The open meeting's snapshot, or null outside one. */
  snapshot(): MeetingMetricsSnapshot | null {
    this.sync();
    return this.meetingId ? this.build(this.meetingId) : null;
  }

  /**
   * Follow the open meeting: persist the old one's totals and load the new
   * one's (a reopened meeting keeps counting). Cheap when nothing changed;
   * runs on every report and tick, and right away on meeting open / end.
   */
  sync(): void {
    const id = this.deps.currentMeetingId();
    if (id === this.meetingId) return;
    this.flush();
    this.meetingId = id;
    this.usage.clear();
    this.unsaved = false;
    if (id) {
      try {
        for (const line of this.deps.loadUsage(id)) {
          const { cost: _cost, ...totals } = line;
          this.usage.set(usageKey(line.engineId, line.direction), totals);
        }
      } catch (err) {
        log.warn('meeting monitor: loading usage failed:', err);
      }
      this.startTicking();
    } else {
      this.stopTicking();
    }
    this.publishNow();
  }

  /** Write pending usage totals of the open meeting. */
  flush(): void {
    if (!this.meetingId || !this.unsaved) return;
    this.unsaved = false;
    try {
      this.deps.saveUsage(this.meetingId, this.lines());
    } catch (err) {
      this.unsaved = true;
      log.warn('meeting monitor: saving usage failed:', err);
    }
  }

  /** App quit: last write, no more ticks. */
  dispose(): void {
    this.flush();
    this.stopTicking();
  }

  // -- SessionObserver ------------------------------------------------------

  sessionCreated(direction: Direction, engineId: EngineId): void {
    this.sync();
    this.links.set(direction, {
      direction,
      engineId,
      state: 'connecting',
      since: this.now(),
      handshakeMs: null,
      readyMs: null,
      rttMs: null,
      lastRxAt: null
    });
    const totals = this.totals(engineId, direction);
    if (totals) totals.sessions += 1;
    this.touch(totals !== null);
  }

  status({ direction, status }: TranslationStatusPayload): void {
    const link = this.links.get(direction);
    if (!link) return;
    const state = LINK_STATE[status];
    if (status === 'failed') {
      const totals = this.totals(link.engineId, direction);
      if (totals) totals.failures += 1;
      this.unsaved ||= totals !== null;
    }
    this.setState(link, state);
    this.changed = true;
  }

  event(event: TranslationEvent): void {
    const link = this.links.get(event.direction);
    if (!link) return;
    // A failure can be ours (capture, TTS sink): only provider output counts.
    if (event.type !== 'session-failed') link.lastRxAt = this.now();
    if (event.type === 'tts-audio') {
      const totals = this.totals(link.engineId, event.direction);
      if (totals) {
        totals.audioOutMs += pcmMs(event.data.byteLength, event.sampleRate);
        this.unsaved = true;
      }
    }
    this.changed = true;
  }

  telemetry(direction: Direction, engineId: EngineId, sample: ClientTelemetry): void {
    this.sync();
    if (sample.type === 'usage') {
      const totals = this.totals(engineId, direction);
      if (!totals) return;
      totals.tokens = addTokens(totals.tokens, sample.tokens);
      if (sample.estimated) totals.estimated = true;
      this.touch(true);
      return;
    }
    // A late report from a session this Direction has moved on from.
    const link = this.links.get(direction);
    if (!link || link.engineId !== engineId) return;
    switch (sample.phase) {
      case 'connecting':
        if (sample.reconnect) {
          this.setState(link, 'reconnecting');
          const totals = this.totals(engineId, direction);
          if (totals) totals.reconnects += 1;
          this.unsaved ||= totals !== null;
        }
        break;
      case 'open':
        link.handshakeMs = sample.ms ?? null;
        break;
      case 'ready':
        link.readyMs = sample.ms ?? null;
        if (link.state === 'reconnecting') this.setState(link, 'live');
        break;
      case 'rtt':
        link.rttMs = sample.ms ?? null;
        break;
    }
    this.changed = true;
  }

  audioSent(direction: Direction, engineId: EngineId, bytes: number, sampleRate: number): void {
    const totals = this.totals(engineId, direction);
    if (!totals) return;
    totals.audioInMs += pcmMs(bytes, sampleRate);
    this.touch(true);
  }

  // -- internals ------------------------------------------------------------

  private setState(link: DirectionLinkSnapshot, state: LinkState): void {
    if (link.state === state) return;
    link.state = state;
    link.since = this.now();
  }

  /** The open meeting's running totals for engine × direction; null outside a meeting. */
  private totals(engineId: EngineId, direction: Direction): UsageTotals | null {
    if (!this.meetingId) return null;
    const key = usageKey(engineId, direction);
    let totals = this.usage.get(key);
    if (!totals) {
      totals = {
        engineId,
        direction,
        tokens: {},
        estimated: false,
        audioInMs: 0,
        audioOutMs: 0,
        sessions: 0,
        reconnects: 0,
        failures: 0
      };
      this.usage.set(key, totals);
    }
    return totals;
  }

  private touch(usageChanged: boolean): void {
    this.changed = true;
    if (usageChanged) this.unsaved = true;
  }

  /** Totals priced with the sheets in force now. */
  private lines(): MeetingUsageLine[] {
    return [...this.usage.values()].map((t) => ({
      ...t,
      tokens: { ...t.tokens },
      cost: estimateCost(t.tokens, t.audioInMs, this.deps.priceSheet(t.engineId))
    }));
  }

  private build(meetingId: string): MeetingMetricsSnapshot {
    const usage = this.lines();
    const costTotals: Partial<Record<PriceCurrency, number>> = {};
    let costIncomplete = false;
    for (const line of usage) {
      if (!line.cost) continue;
      costTotals[line.cost.currency] = (costTotals[line.cost.currency] ?? 0) + line.cost.amount;
      if (!line.cost.complete) costIncomplete = true;
    }
    const links: MeetingMetricsSnapshot['links'] = {};
    for (const [direction, link] of this.links) links[direction] = { ...link };
    return { meetingId, links, usage, costTotals, costIncomplete, updatedAt: this.now() };
  }

  private publishNow(): void {
    this.changed = false;
    this.deps.publish(this.meetingId ? this.build(this.meetingId) : null);
  }

  private startTicking(): void {
    if (this.timer) return;
    this.ticks = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  private stopTicking(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.sync();
    if (!this.meetingId) return;
    if (this.changed) this.publishNow();
    this.ticks += 1;
    if (this.ticks % FLUSH_EVERY_TICKS === 0) this.flush();
  }
}
