/**
 * Dev-only provider soak test: a meeting-shaped load against the real
 * services, using the keys stored in the app's credential vault. Runs in
 * place of the app when `BABELVOICE_SOAK` is set on an unpackaged build:
 *
 *   npx electron-vite build
 *   BABELVOICE_SOAK=qwen,gemini,openai BABELVOICE_SOAK_MINUTES=30 npx electron .
 *
 * Env:
 *   BABELVOICE_SOAK              engines, comma-separated; all run at once
 *   BABELVOICE_SOAK_MINUTES      length of the listen session (default 30)
 *   BABELVOICE_SOAK_CLIP         audio to loop (default test-audio/en-weekly-sync.wav)
 *   BABELVOICE_SOAK_OUT          results directory (default: a temp dir)
 *   BABELVOICE_SOAK_KILLS        listen-socket kills, as fractions of the run
 *                                (default "0.27,0.67"; "" for none)
 *
 * Per engine, like a meeting:
 *   - listen (s2t) for the whole run, fed the clip on a loop in real time,
 *     with a quiet stretch (silence still flowing) in the middle;
 *   - speak (s2s) for 20 s every 3 minutes, alongside;
 *   - the live listen socket killed outright at the kill points, to exercise
 *     reconnect against the real server.
 * A listen session that fails is restarted after 5 s, as a user would, and
 * counted. Events go to `<engine>.jsonl`; the summary to `summary.json` and
 * stdout.
 */
import { execFileSync } from 'node:child_process';
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
  type WriteStream
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { WebSocket } from 'ws';
import type { Direction } from '@shared/ipc-types.js';
import { isEngineId, type EngineId } from '@shared/engine-types.js';
import { createTranslationClient } from '../translation/client-factory.js';
import { buildClientStartParams } from '../translation/engine-selection.js';
import {
  getDoubaoCredentials,
  getGeminiCredentials,
  getOpenAiCredentials,
  getQwenCredentials
} from '../translation/credential-vault.js';
import type {
  ClientTelemetry,
  TranslationClient,
  TranslationEventBody
} from '../translation/translation-client.js';

const SPEAK_EVERY_MS = 3 * 60_000;
const SPEAK_LENGTH_MS = 20_000;
const LOOP_GAP_MS = 3_000;
const QUIET_MS = 2 * 60_000;
const FINISH_WAIT_MS = 15_000;
const RESTART_AFTER_MS = 5_000;
const PROGRESS_EVERY_MS = 60_000;
/** A silence in the translation longer than this is reported. */
const GAP_REPORT_MS = 10_000;

const hasCredentials: Record<EngineId, () => boolean> = {
  doubao: () => getDoubaoCredentials() !== null,
  qwen: () => getQwenCredentials() !== null,
  gemini: () => getGeminiCredentials() !== null,
  openai: () => getOpenAiCredentials() !== null,
  mock: () => true
};

interface Plan {
  durationMs: number;
  quietFrom: number;
  quietTo: number;
  kills: number[];
  speakAt: number[];
}

const makePlan = (durationMs: number, killFractions: number[]): Plan => {
  const quietMs = Math.min(QUIET_MS, durationMs * 0.1);
  const quietFrom = durationMs * 0.4;
  const speakEvery = Math.min(SPEAK_EVERY_MS, durationMs / 3);
  const speakAt: number[] = [];
  for (let at = Math.min(60_000, durationMs / 4); at + SPEAK_LENGTH_MS < durationMs; at += speakEvery) {
    speakAt.push(at);
  }
  return {
    durationMs,
    quietFrom,
    quietTo: quietFrom + quietMs,
    kills: killFractions.map((f) => durationMs * f),
    speakAt
  };
};

/** Raw s16le mono PCM of `clip` at `rate`, converted with macOS afconvert. */
const loadPcm = (clip: string, rate: number, workDir: string): Buffer => {
  const out = join(workDir, `clip-${rate}.wav`);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${rate}`, '-c', '1', clip, out]);
  const wav = readFileSync(out);
  for (let off = 12; off + 8 <= wav.length; ) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'data') return wav.subarray(off + 8, off + 8 + size - (size % 2));
    off += 8 + size + (size % 2);
  }
  throw new Error(`${out}: no data chunk`);
};

/** Feeds a client real-time PCM: the clip on a loop, or silence while `quiet()`. */
class Feeder {
  private timer: NodeJS.Timeout | null = null;
  private pos: number;
  private gapLeft = 0;

  constructor(
    private readonly client: TranslationClient,
    private readonly pcm: Buffer,
    private readonly quiet: () => boolean,
    private readonly onError: (err: unknown) => void,
    startAt = 0
  ) {
    this.pos = Math.floor((startAt % pcm.length) / 2) * 2;
  }

  start(): void {
    const rate = this.client.inputSampleRate;
    const chunkMs = this.client.uplinkChunkMs ?? 80;
    const chunkBytes = Math.round((rate * chunkMs) / 1000) * 2;
    const t0 = Date.now();
    let sentMs = 0;
    const tick = (): void => {
      const due = Date.now() - t0;
      for (; sentMs + chunkMs <= due; sentMs += chunkMs) {
        this.client.sendAudio(this.next(chunkBytes, rate)).catch(this.onError);
      }
      this.timer = setTimeout(tick, 20);
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** A fresh buffer each time: the client may hold it (see sendAudio). */
  private next(bytes: number, rate: number): Uint8Array {
    const out = new Uint8Array(bytes);
    if (this.quiet()) return out;
    for (let filled = 0; filled < bytes; ) {
      if (this.gapLeft > 0) {
        const n = Math.min(this.gapLeft, bytes - filled);
        filled += n;
        this.gapLeft -= n;
        continue;
      }
      const n = Math.min(this.pcm.length - this.pos, bytes - filled);
      out.set(this.pcm.subarray(this.pos, this.pos + n), filled);
      filled += n;
      this.pos += n;
      if (this.pos >= this.pcm.length) {
        this.pos = 0;
        this.gapLeft = Math.round((rate * LOOP_GAP_MS) / 1000) * 2;
      }
    }
    return out;
  }
}

type SessionEnd = 'running' | 'finished' | 'failed' | 'start-failed' | 'finish-timeout';

interface SessionStats {
  direction: Direction;
  index: number;
  startAt: number;
  readyMs: number | null;
  firstTranslationMs: number | null;
  end: SessionEnd;
  endAt: number | null;
  failure: { kind: string; code?: number | string; message: string } | null;
  sourceFinals: number;
  translationFinals: number;
  ttsBytes: number;
  reconnects: number;
  rttMs: number[];
  tokens: Record<string, number>;
  /** Run-relative times of translation output, for the gap report. */
  outputAt: number[];
}

/** Everything one engine did during the run. */
class EngineRun {
  readonly sessions: SessionStats[] = [];
  readonly killedAt: number[] = [];
  listenRestarts = 0;
  private listen: { client: TranslationClient; feeder: Feeder; stats: SessionStats } | null = null;
  private speaking = false;
  private stopped = false;
  private readonly log: WriteStream;

  constructor(
    readonly engine: EngineId,
    private readonly pcm: Buffer,
    private readonly plan: Plan,
    private readonly now: () => number,
    outDir: string
  ) {
    this.log = createWriteStream(join(outDir, `${engine}.jsonl`));
  }

  record(entry: Record<string, unknown>): void {
    this.log.write(`${JSON.stringify({ t: +(this.now() / 1000).toFixed(1), ...entry })}\n`);
  }

  async startListen(): Promise<void> {
    if (this.stopped) return;
    const session = this.open('listen');
    if (!session) return;
    const feeder = new Feeder(
      session.client,
      this.pcm,
      () => {
        const t = this.now();
        return t >= this.plan.quietFrom && t < this.plan.quietTo;
      },
      (err) => this.record({ dir: 'listen', type: 'send-error', message: String(err) })
    );
    this.listen = { client: session.client, feeder, stats: session.stats };
    if (!(await this.begin(session.client, session.stats, 's2t'))) {
      this.listen = null;
      this.scheduleListenRestart();
      return;
    }
    feeder.start();
  }

  /** Kill the live listen socket outright, as a network drop would. */
  kill(): void {
    const client = this.listen?.client as unknown as {
      session?: { socket: WebSocket | null };
      current?: { ws: WebSocket } | null;
    };
    const ws = client?.session?.socket ?? client?.current?.ws ?? null;
    this.record({ dir: 'listen', type: 'kill', hadSocket: ws !== null });
    if (!ws) return;
    this.killedAt.push(this.now());
    ws.terminate();
  }

  async speak(index: number): Promise<void> {
    if (this.stopped || this.speaking) return;
    this.speaking = true;
    try {
      const session = this.open('speak', index);
      if (!session) return;
      if (!(await this.begin(session.client, session.stats, 's2s'))) return;
      const feeder = new Feeder(
        session.client,
        this.pcm,
        () => false,
        (err) => this.record({ dir: 'speak', idx: index, type: 'send-error', message: String(err) }),
        index * 7 * this.pcm.length / 13
      );
      feeder.start();
      await sleep(SPEAK_LENGTH_MS);
      feeder.stop();
      await this.finish(session.client, session.stats);
    } finally {
      this.speaking = false;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const listen = this.listen;
    if (listen) {
      listen.feeder.stop();
      await this.finish(listen.client, listen.stats);
    }
    while (this.speaking) await sleep(200);
    // The app exits right after: wait for the log to reach the disk.
    await new Promise<void>((r) => this.log.end(r));
  }

  /** Progress line for stdout. */
  progress(): string {
    const l = this.listen?.stats;
    const last = l?.outputAt.at(-1);
    const age = last === undefined ? '-' : `${Math.round((this.now() - last) / 1000)}s`;
    return `${this.engine}: listen ${l ? l.end : 'down'} finals=${l?.translationFinals ?? 0} reconnects=${l?.reconnects ?? 0} lastOutput=${age} restarts=${this.listenRestarts} speak=${this.sessions.filter((s) => s.direction === 'speak').length}`;
  }

  // -------------------------------------------------------------------------

  private open(direction: Direction, index = 0): { client: TranslationClient; stats: SessionStats } | null {
    const stats: SessionStats = {
      direction,
      index,
      startAt: this.now(),
      readyMs: null,
      firstTranslationMs: null,
      end: 'running',
      endAt: null,
      failure: null,
      sourceFinals: 0,
      translationFinals: 0,
      ttsBytes: 0,
      reconnects: 0,
      rttMs: [],
      tokens: {},
      outputAt: []
    };
    this.sessions.push(stats);
    const client = createTranslationClient(this.engine, {
      tag: direction,
      onEvent: (event) => this.onEvent(stats, event),
      onTelemetry: (sample) => this.onTelemetry(stats, sample)
    });
    return { client, stats };
  }

  private async begin(client: TranslationClient, stats: SessionStats, mode: 's2t' | 's2s'): Promise<boolean> {
    const params = buildClientStartParams(
      { direction: stats.direction, sourceLanguage: 'en', targetLanguage: 'zh', mode },
      this.engine
    );
    this.record({ dir: stats.direction, idx: stats.index, type: 'start' });
    try {
      await client.start(params);
      stats.readyMs = this.now() - stats.startAt;
      return true;
    } catch (err) {
      stats.end = 'start-failed';
      stats.endAt = this.now();
      stats.failure = { kind: 'start', message: err instanceof Error ? err.message : String(err) };
      this.record({ dir: stats.direction, idx: stats.index, type: 'start-failed', message: stats.failure.message });
      await client.cancel();
      return false;
    }
  }

  private async finish(client: TranslationClient, stats: SessionStats): Promise<void> {
    if (stats.end !== 'running') return;
    const finishedAt = this.now();
    await client.finish();
    for (const deadline = Date.now() + FINISH_WAIT_MS; stats.end === 'running' && Date.now() < deadline; ) {
      await sleep(100);
    }
    if (stats.end === 'running') {
      stats.end = 'finish-timeout';
      stats.endAt = this.now();
      await client.cancel();
    }
    this.record({ dir: stats.direction, idx: stats.index, type: 'finish', took: this.now() - finishedAt, end: stats.end });
  }

  private onEvent(stats: SessionStats, event: TranslationEventBody): void {
    const t = this.now();
    switch (event.type) {
      case 'translation-subtitle-delta':
      case 'translation-subtitle-final':
        stats.outputAt.push(t);
        stats.firstTranslationMs ??= t - stats.startAt;
        if (event.type === 'translation-subtitle-final') {
          stats.translationFinals++;
          this.record({ dir: stats.direction, idx: stats.index, type: event.type, text: event.text });
        }
        return;
      case 'source-subtitle-final':
        stats.sourceFinals++;
        this.record({ dir: stats.direction, idx: stats.index, type: event.type, text: event.text, speaker: event.speaker });
        return;
      case 'tts-audio':
        stats.ttsBytes += event.data.byteLength;
        return;
      case 'session-finished':
        stats.end = 'finished';
        stats.endAt = t;
        break;
      case 'session-failed':
        stats.end = 'failed';
        stats.endAt = t;
        stats.failure = { kind: event.kind, code: event.code, message: event.message };
        if (stats.direction === 'listen' && this.listen?.stats === stats) {
          this.listen.feeder.stop();
          this.listen = null;
          this.scheduleListenRestart();
        }
        break;
      case 'source-subtitle-delta':
      case 'source-subtitle-start':
      case 'translation-subtitle-start':
      case 'tts-sentence-start':
      case 'tts-sentence-end':
        return;
      default:
        break;
    }
    this.record({ dir: stats.direction, idx: stats.index, ...event });
  }

  private onTelemetry(stats: SessionStats, sample: ClientTelemetry): void {
    if (sample.type === 'usage') {
      for (const [cat, n] of Object.entries(sample.tokens)) {
        stats.tokens[cat] = (stats.tokens[cat] ?? 0) + (n ?? 0);
      }
      return;
    }
    if (sample.phase === 'rtt') {
      if (sample.ms !== undefined) stats.rttMs.push(sample.ms);
      return;
    }
    if (sample.phase === 'connecting' && sample.reconnect) stats.reconnects++;
    this.record({ dir: stats.direction, idx: stats.index, type: `link-${sample.phase}`, ms: sample.ms, reconnect: sample.reconnect });
  }

  private scheduleListenRestart(): void {
    if (this.stopped || this.now() + RESTART_AFTER_MS >= this.plan.durationMs) return;
    this.listenRestarts++;
    setTimeout(() => void this.startListen(), RESTART_AFTER_MS);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const sec = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`;

const near = (from: number, to: number, plan: Plan, kills: number[]): string => {
  if (from < plan.quietTo + 15_000 && to > plan.quietFrom - 5_000) return 'quiet';
  if (kills.some((k) => from < k + 30_000 && to > k - 5_000)) return 'kill';
  return '';
};

const summarize = (run: EngineRun, plan: Plan): Record<string, unknown> => {
  const listens = run.sessions.filter((s) => s.direction === 'listen');
  const speaks = run.sessions.filter((s) => s.direction === 'speak');
  const outputAt = listens.flatMap((s) => s.outputAt).sort((a, b) => a - b);
  const gaps: { from: string; to: string; length: string; near: string }[] = [];
  let prev = listens[0]?.readyMs != null ? listens[0].startAt + listens[0].readyMs : 0;
  for (const at of [...outputAt, plan.durationMs]) {
    if (at - prev > GAP_REPORT_MS) {
      gaps.push({ from: sec(prev), to: sec(at), length: sec(at - prev), near: near(prev, at, plan, run.killedAt) });
    }
    prev = at;
  }
  const rtt = listens.flatMap((s) => s.rttMs);
  const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const tokens: Record<string, number> = {};
  for (const s of run.sessions) {
    for (const [cat, n] of Object.entries(s.tokens)) tokens[cat] = (tokens[cat] ?? 0) + n;
  }
  return {
    engine: run.engine,
    listen: {
      sessions: listens.length,
      restarts: run.listenRestarts,
      ends: listens.map((s) => ({ end: s.end, at: sec(s.endAt), failure: s.failure })),
      readyMs: listens.map((s) => s.readyMs),
      sourceFinals: listens.reduce((n, s) => n + s.sourceFinals, 0),
      translationFinals: listens.reduce((n, s) => n + s.translationFinals, 0),
      reconnects: listens.reduce((n, s) => n + s.reconnects, 0),
      kills: run.killedAt.map(sec),
      rttMs: { avg: avg(rtt), max: rtt.length ? Math.max(...rtt) : null },
      gaps,
      unexplainedGaps: gaps.filter((g) => !g.near).length
    },
    speak: {
      sessions: speaks.length,
      ok: speaks.filter((s) => s.end === 'finished').length,
      ends: speaks.map((s) => s.end),
      failures: speaks.flatMap((s) => (s.failure ? [s.failure] : [])),
      avgReadyMs: avg(speaks.flatMap((s) => (s.readyMs === null ? [] : [s.readyMs]))),
      avgFirstTranslationMs: avg(speaks.flatMap((s) => (s.firstTranslationMs === null ? [] : [s.firstTranslationMs]))),
      ttsSeconds: speaks.reduce((n, s) => n + s.ttsBytes, 0) / 2 / 24_000
    },
    tokens
  };
};

export const runSoakTest = async (): Promise<void> => {
  const engines = (process.env.BABELVOICE_SOAK ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const minutes = Number(process.env.BABELVOICE_SOAK_MINUTES ?? '30');
  const killFractions = (process.env.BABELVOICE_SOAK_KILLS ?? '0.27,0.67')
    .split(',')
    .map(Number)
    .filter((f) => Number.isFinite(f) && f > 0 && f < 1);
  const clip = resolve(process.env.BABELVOICE_SOAK_CLIP ?? 'test-audio/en-weekly-sync.wav');
  const outDir =
    process.env.BABELVOICE_SOAK_OUT ??
    join(tmpdir(), 'babelvoice-soak', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(outDir, { recursive: true });

  const runnable: EngineId[] = [];
  for (const engine of engines) {
    if (!isEngineId(engine)) {
      console.log(`[soak] skip ${engine}: unknown engine`);
    } else if (!hasCredentials[engine]()) {
      console.log(`[soak] skip ${engine}: no key in the credential vault`);
    } else {
      runnable.push(engine);
    }
  }
  if (runnable.length === 0 || !(minutes > 0)) {
    console.log('[soak] nothing to run');
    return;
  }

  const plan = makePlan(minutes * 60_000, killFractions);
  const t0 = Date.now();
  const now = (): number => Date.now() - t0;
  const pcmByRate = new Map<number, Buffer>();
  const runs = runnable.map((engine) => {
    const rate = createTranslationClient(engine, { onEvent: () => undefined }).inputSampleRate;
    if (!pcmByRate.has(rate)) pcmByRate.set(rate, loadPcm(clip, rate, outDir));
    return new EngineRun(engine, pcmByRate.get(rate)!, plan, now, outDir);
  });
  console.log(
    `[soak] ${runnable.join(', ')} for ${minutes} min → ${outDir}\n` +
      `[soak] quiet ${sec(plan.quietFrom)}–${sec(plan.quietTo)}, kills at ${plan.kills.map(sec).join(', ') || 'none'}, speak at ${plan.speakAt.map(sec).join(', ')}`
  );

  const timers: NodeJS.Timeout[] = [];
  for (const run of runs) {
    void run.startListen();
    for (const at of plan.kills) timers.push(setTimeout(() => run.kill(), at));
    plan.speakAt.forEach((at, i) => timers.push(setTimeout(() => void run.speak(i + 1), at)));
  }
  const progress = setInterval(() => {
    console.log(`[soak] ${sec(now())}\n${runs.map((r) => `  ${r.progress()}`).join('\n')}`);
  }, PROGRESS_EVERY_MS);

  await sleep(plan.durationMs);
  clearInterval(progress);
  for (const timer of timers) clearTimeout(timer);
  await Promise.all(runs.map((r) => r.stop()));

  const summary = {
    minutes,
    clip,
    plan: { quiet: [sec(plan.quietFrom), sec(plan.quietTo)], kills: plan.kills.map(sec), speakAt: plan.speakAt.map(sec) },
    engines: runs.map((r) => summarize(r, plan))
  };
  const summaryJson = JSON.stringify(summary, null, 2);
  writeFileSync(join(outDir, 'summary.json'), summaryJson);
  console.log(`[soak] done → ${join(outDir, 'summary.json')}\n${summaryJson}`);
};
