/**
 * Offline TranslationClient for development. Emits a scripted event
 * sequence that exercises the renderer's subtitle path (deltas →
 * final → finished) without making any network calls.
 *
 * Lives in main rather than renderer (see ADR-0002): the seam is
 * provider-agnostic, so the mock plugs in like any other adapter.
 */
import type { EngineId } from '@shared/engine-types.js';
import type {
  ClientStartParams,
  ClientTelemetry,
  TranslationClient,
  TranslationClientOptions,
  TranslationEventBody
} from './translation-client.js';

const DELTA_INTERVAL_MS = 200;

const SAMPLE_PHRASES: ReadonlyArray<{ src: string; tgt: string }> = [
  { src: '你好，欢迎使用同声传译。', tgt: 'Hello, welcome to live translation.' },
  { src: '这是一段离线模拟数据。', tgt: 'This is an offline mock sequence.' }
];

export class MockTranslationClient implements TranslationClient {
  readonly engineId: EngineId = 'mock';
  /** Match Doubao's rate so the speak-side TtsSink path stays exercised. */
  readonly inputSampleRate = 16_000;
  readonly outputSampleRate = 16_000;

  private readonly onEvent: (event: TranslationEventBody) => void;
  private readonly onTelemetry: ((sample: ClientTelemetry) => void) | undefined;
  private startedAt = 0;
  private timers: NodeJS.Timeout[] = [];
  private started = false;
  private cancelled = false;
  private finished = false;

  constructor(opts: TranslationClientOptions) {
    this.onEvent = opts.onEvent;
    this.onTelemetry = opts.onTelemetry;
  }

  /** Single use, like the real clients: no restart, none after cancel(). */
  async start(params: ClientStartParams): Promise<void> {
    if (params.engineId !== 'mock') {
      throw new Error(
        `MockTranslationClient received non-mock params (engineId=${params.engineId})`
      );
    }
    if (this.started) throw new Error('Mock session already started');
    if (this.cancelled) throw new Error('Mock session canceled before start');
    this.started = true;
    this.startedAt = Date.now();
    // Plausible link telemetry so the meeting monitor has something to show.
    this.onTelemetry?.({ type: 'link', phase: 'connecting' });
    this.onTelemetry?.({ type: 'link', phase: 'open', ms: 1 });
    this.onTelemetry?.({ type: 'link', phase: 'ready', ms: 1 });
    this.onEvent({ type: 'session-started' });
  }

  async sendAudio(_pcm: Uint8Array): Promise<void> {
    if (this.cancelled || this.finished) return;
    if (this.timers.length > 0) return; // one scripted utterance at a time
    this.scriptUtterance(SAMPLE_PHRASES[0]);
  }

  /** Idempotent; a no-op after cancel() (one terminal event per session). */
  async finish(): Promise<void> {
    if (this.finished || this.cancelled) return;
    this.finished = true;
    this.clearTimers();
    this.onEvent({ type: 'session-finished' });
  }

  /**
   * Idempotent and silent, like the real clients: the caller initiated the
   * cancel, so no terminal event is emitted (ADR-0002 contract).
   */
  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.clearTimers();
  }

  private scriptUtterance(phrase: { src: string; tgt: string }): void {
    const startMs = Date.now() - this.startedAt;
    this.onEvent({ type: 'source-subtitle-start', startMs, speakerChanged: false });

    let i = 1;
    const tick = (): void => {
      if (this.cancelled || this.finished) return;
      if (i > phrase.src.length) {
        const endMs = Date.now() - this.startedAt;
        this.onEvent({
          type: 'source-subtitle-final',
          text: phrase.src,
          startMs,
          endMs
        });
        this.onEvent({
          type: 'translation-subtitle-final',
          text: phrase.tgt,
          startMs,
          endMs
        });
        // Made-up but shaped like a real report: ~25 audio tokens per second.
        this.onTelemetry?.({
          type: 'usage',
          estimated: true,
          tokens: {
            inputAudio: Math.round(((endMs - startMs) / 1000) * 25),
            outputText: phrase.tgt.length
          }
        });
        // Drop expired handles so the next sendAudio() can script the
        // next utterance — otherwise length>0 stays true forever and
        // listen / repeated-PTT mock sessions go silent after phrase #1.
        this.timers = [];
        return;
      }
      this.onEvent({
        type: 'source-subtitle-delta',
        text: phrase.src.slice(0, i)
      });
      this.onEvent({
        type: 'translation-subtitle-delta',
        text: phrase.tgt.slice(0, Math.min(phrase.tgt.length, i * 2))
      });
      i += 1;
      this.timers.push(setTimeout(tick, DELTA_INTERVAL_MS));
    };
    this.timers.push(setTimeout(tick, DELTA_INTERVAL_MS));
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
