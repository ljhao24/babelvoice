/**
 * WebSocket transport for Google Gemini Live Translate
 * (`gemini-3.5-live-translate-preview`, Gemini API Live / BidiGenerateContent).
 *
 * Wire format:
 *   - JSON-over-WebSocket (protobuf-JSON, camelCase). Every server message
 *     carries exactly one of `setupComplete` / `serverContent` / `goAway` /
 *     `sessionResumptionUpdate`. Auth is the `?key=` query parameter.
 *   - Endpoint:
 *     wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
 *
 * Lifecycle:
 *   client → { setup: { model,
 *              generationConfig: { responseModalities: ['AUDIO'],
 *                translationConfig: { targetLanguageCode, echoTargetLanguage } },
 *              inputAudioTranscription: {}, outputAudioTranscription: {} } }
 *            (the transcription configs are `setup`-level; inside
 *            generationConfig the server rejects them with 1007)
 *   client ← { setupComplete: {} }                  ← MUST WAIT before sending audio
 *   client → { realtimeInput: { audio: { data, mimeType } } } * N   (base64 PCM 16k mono LE)
 *   client ← { serverContent: { inputTranscription: { text } } }    (source, incremental)
 *   client ← { serverContent: { outputTranscription: { text } } }   (translation, incremental)
 *   client ← { serverContent: { modelTurn: { parts: [{ inlineData }] } } }  (PCM 24k mono LE)
 *   client ← { serverContent: { turnComplete: true } }
 *   client → { realtimeInput: { audioStreamEnd: true } }            (flush trailing speech)
 *   client ← { goAway: { timeLeft } }               (this connection is about to be killed)
 *   Errors arrive as a WebSocket close with a code + human-readable reason.
 *
 * What this adapter absorbs so DirectionSession stays engine-blind:
 *   - No per-utterance finals: `TranscriptSegmenter` pairs source/translation
 *     lines on sentence boundaries; the client flushes them on silence.
 *   - No server-side "session finished": finish() sends `audioStreamEnd`
 *     and emits 'session-finished' once the trailing output goes quiet.
 *   - Output audio never stops: the server streams real-time PCM (speech,
 *     then silence padding) for as long as the socket is open, even after
 *     `audioStreamEnd`. Only audible chunks count as activity for the
 *     silence timers, and padding between TTS sentences is dropped.
 *   - Connections live ~10 min (audio sessions cap at 15 min). The client
 *     rotates to a fresh connection on `goAway` or a timer, overlapping the
 *     old one so its trailing output isn't cut. Translation needs no
 *     conversation history, so a fresh session (no resumption handle) is
 *     enough — and it also resets the 15-min session cap.
 *   - Output audio can't be disabled (AUDIO is the only modality); in s2t
 *     mode it's dropped here.
 *   - The source language is auto-detected; only the target goes out.
 *   - The endpoint is overseas, so sockets go through the system proxy
 *     (`proxy-agent.ts`).
 *
 * Lives in main for the same reasons as QwenClient: Node `ws`, events out
 * via the constructor-supplied `onEvent` — see ADR-0002. Transcript/TTS
 * shaping is `StreamingOutputShaper` (shared with OpenAiClient); when a
 * dropped connection may be replaced is `ReconnectPolicy`.
 */
import { WebSocket } from 'ws';
import type { Agent } from 'node:http';
import type { EngineId } from '@shared/engine-types.js';
import type { ProtocolLanguage } from '@shared/ipc-types.js';
import { log } from '@core/utils/logger.js';
import { getGeminiCredentials } from './credential-vault.js';
import {
  kindFromCloseCode,
  MissingCredentialsError,
  sessionFailedBody,
  toTranslationError,
  TranslationError
} from './translation-error.js';
import { resolveProxyAgent } from './proxy-agent.js';
import { StreamingOutputShaper } from './streaming-output-shaper.js';
import { LIVE_RECONNECT_BUDGET, ReconnectPolicy } from './reconnect-policy.js';
import { Pcm16Carry } from './pcm.js';
import {
  BackpressureGuard,
  closeSocket,
  DEFAULT_WS_TIMING,
  openSocket,
  PROXY_RESOLVE_TIMEOUT_MS,
  resolveAgentWithin,
  startKeepalive
} from './ws-transport.js';
import type {
  ClientStartParams,
  ClientTelemetry,
  GeminiStartParams,
  TranslationClient,
  TranslationClientOptions,
  TranslationEventBody
} from './translation-client.js';

const DEFAULT_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

export const GEMINI_MODEL = 'models/gemini-3.5-live-translate-preview';

const GEMINI_INPUT_SAMPLE_RATE = 16_000;
const GEMINI_OUTPUT_SAMPLE_RATE = 24_000;
const INPUT_MIME_TYPE = `audio/pcm;rate=${GEMINI_INPUT_SAMPLE_RATE}`;
/**
 * Live Translate bills audio only, at 25 tokens per second each way (the
 * pricing page's per-minute figures). Its `usageMetadata` mixes per-message
 * and running-context counts with no documented semantics, so usage is
 * estimated from the audio that actually crossed the wire instead.
 */
const AUDIO_TOKENS_PER_SECOND = 25;

/** Decoded size of a base64 string, without decoding it. */
const base64Bytes = (b64: string): number =>
  Math.floor((b64.length * 3) / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);

/** 100 ms — the chunk size Google recommends. */
const SEND_CHUNK_MS = 100;
/** SEND_CHUNK_MS of 16 kHz / 16-bit mono. */
const SEND_CHUNK_BYTES = ((GEMINI_INPUT_SAMPLE_RATE * SEND_CHUNK_MS) / 1000) * 2;

const CANCELED_MESSAGE = 'Gemini session canceled before setupComplete';

/** Close codes meaning "the request itself is wrong" (bad key, bad config). */
const FATAL_CLOSE_CODES = new Set([1007, 1008]);

/**
 * finish() hard cap. Must stay well under DirectionSession's
 * FINISH_DEADLINE_MS (10 s), which starts at the same moment: if the session
 * deadline fired first it would cancel us and drop the flushed trailing
 * lines + 'session-finished' this cap exists to deliver. The quiet-window
 * ladder below normally ends finish() within ~1–4 s anyway.
 */
export const GEMINI_FINISH_MAX_MS = 8_000;

/**
 * Silence-driven heuristics. Gemini sends no utterance boundaries, so these
 * decide when a subtitle line / TTS sentence / finish() is over. Overridable
 * for tests.
 */
export interface GeminiTimings {
  /** No transcript/audio for this long → close the current line pair. */
  lineIdleMs: number;
  /** …but wait longer while source text still has no translation. */
  lineAwaitTranslationMs: number;
  /** After `turnComplete` the line pair is almost certainly done. */
  lineTurnCompleteMs: number;
  /** No TTS audio for this long → the spoken sentence ended. */
  ttsIdleMs: number;
  /** finish(): quiet window after the last server message. */
  finishQuietMs: number;
  /** finish() while source text still has no translation. */
  finishAwaitTranslationMs: number;
  /** finish() with audio the server hasn't answered yet. */
  finishAwaitResponseMs: number;
  /** finish() with nothing outstanding. */
  finishIdleMs: number;
  /** finish() hard cap, however chatty the trailing output is. */
  finishMaxMs: number;
  /** Proxy lookup bound; past it the socket connects directly. */
  proxyResolveTimeoutMs: number;
  /** Whole opening handshake, proxy CONNECT included. */
  handshakeTimeoutMs: number;
  /** Rotate before the ~10 min connection lifetime even without goAway. */
  rotateAfterMs: number;
  /** Retry delay when a rotation attempt fails but the old socket lives. */
  rotateRetryMs: number;
  /** A retired connection is closed once it's quiet for this long. */
  retireQuietMs: number;
  /**
   * Upper bound on `setupComplete` once the socket is open — a server that
   * accepts the upgrade but never answers `setup` would otherwise hang
   * start() (and DirectionSession.cancel(), which waits for it) or a
   * rotation forever.
   */
  setupTimeoutMs: number;
  /** Keepalive ping cadence. */
  keepaliveIntervalMs: number;
  /** Nothing heard (pong or frame) for this long → the socket is dead. */
  keepaliveTimeoutMs: number;
}

const DEFAULT_TIMINGS: GeminiTimings = {
  lineIdleMs: 1_200,
  lineAwaitTranslationMs: 2_500,
  lineTurnCompleteMs: 300,
  ttsIdleMs: 800,
  finishQuietMs: 1_500,
  finishAwaitTranslationMs: 3_500,
  finishAwaitResponseMs: 2_500,
  finishIdleMs: 600,
  finishMaxMs: GEMINI_FINISH_MAX_MS,
  proxyResolveTimeoutMs: PROXY_RESOLVE_TIMEOUT_MS,
  handshakeTimeoutMs: DEFAULT_WS_TIMING.handshakeTimeoutMs,
  rotateAfterMs: 8.5 * 60_000,
  rotateRetryMs: 5_000,
  retireQuietMs: 4_000,
  setupTimeoutMs: DEFAULT_WS_TIMING.sessionReadyTimeoutMs,
  keepaliveIntervalMs: DEFAULT_WS_TIMING.keepaliveIntervalMs,
  keepaliveTimeoutMs: DEFAULT_WS_TIMING.keepaliveTimeoutMs
};

/** Gemini uses BCP-47 with script/region where the bare code is ambiguous. */
const GEMINI_LANGUAGE: Record<ProtocolLanguage, string> = {
  zh: 'zh-Hans',
  en: 'en',
  ja: 'ja',
  id: 'id',
  es: 'es',
  pt: 'pt-BR',
  de: 'de',
  fr: 'fr'
};

/**
 * Set `GEMINI_VERBOSE=1` (or `=2`) to dump protocol traffic to the main
 * process log. Level 1 prints non-audio events + per-N audio summaries;
 * level 2 also prints every transcript fragment and audio chunk.
 */
const VERBOSE = (() => {
  const raw = process.env.GEMINI_VERBOSE;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 1;
})();

const AUDIO_SUMMARY_INTERVAL = 50;

interface GeminiTranscription {
  text?: string;
  languageCode?: string;
}

interface GeminiServerContent {
  modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
  turnComplete?: boolean;
  generationComplete?: boolean;
  interrupted?: boolean;
  inputTranscription?: GeminiTranscription;
  outputTranscription?: GeminiTranscription;
}

interface GeminiServerMessage {
  setupComplete?: unknown;
  serverContent?: GeminiServerContent;
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: unknown;
  usageMetadata?: unknown;
}

/** One WebSocket + its setup handshake. A session may span several. */
interface Connection {
  readonly id: number;
  readonly ws: WebSocket;
  /** Settles the setup promise; null once settled. */
  settle: ((err?: Error) => void) | null;
  lastError: string | null;
  retireTimer: NodeJS.Timeout | null;
  /**
   * The WS handshake completed. Before that, `openSocket`'s promise reports
   * failures (with the HTTP status and body of a refused upgrade), so the
   * close handler leaves them alone.
   */
  opened: boolean;
  /** When the upgrade completed (for the setupComplete latency). */
  openedAt: number;
  stopKeepalive: (() => void) | null;
  /** This connection's output audio stream, kept on whole samples. */
  readonly pcm: Pcm16Carry;
}

export interface GeminiClientOptions extends TranslationClientOptions {
  /** Override the WS endpoint; defaults to the production Gemini API URL. */
  endpoint?: string;
  /** Override proxy resolution; defaults to the system proxy via Chromium. */
  resolveAgent?: (url: string) => Promise<Agent | undefined>;
  timings?: Partial<GeminiTimings>;
}

export class GeminiClient implements TranslationClient {
  readonly engineId: EngineId = 'gemini';
  readonly inputSampleRate = GEMINI_INPUT_SAMPLE_RATE;
  readonly outputSampleRate = GEMINI_OUTPUT_SAMPLE_RATE;
  readonly uplinkChunkMs = SEND_CHUNK_MS;

  private apiKey = '';
  private params: GeminiStartParams | null = null;
  private started = false;
  private startedAt = 0;
  /** Set once the session is over: finished, failed or cancelled. */
  private terminated = false;
  /** cancel() ran: not even telemetry goes out any more. */
  private cancelled = false;

  /** The connection audio is sent to. */
  private current: Connection | null = null;
  /** A connection whose setup is in flight (initial connect or rotation). */
  private pending: Connection | null = null;
  /** Rotated-out connections still delivering trailing output. */
  private readonly retired = new Set<Connection>();
  private nextConnectionId = 1;
  private readonly reconnects = new ReconnectPolicy({
    ...LIVE_RECONNECT_BUDGET,
    fatalCloseCodes: FATAL_CLOSE_CODES
  });
  private rotateTimer: NodeJS.Timeout | null = null;
  /**
   * Set synchronously on entering rotate(). `pending` is only assigned once
   * the proxy lookup inside connect() resolves, so it can't stop a second
   * rotation (goAway + timer, goAway + close) from starting meanwhile.
   */
  private rotating = false;

  private sendBuffer: Uint8Array[] = [];
  private sendBufferBytes = 0;
  private readonly backpressure = new BackpressureGuard(() => this.tag());
  private lastAudioSentAt = 0;
  private lastContentAt = 0;

  private readonly output: StreamingOutputShaper;

  private finishRequested = false;
  private finishQuietTimer: NodeJS.Timeout | null = null;
  private finishMaxTimer: NodeJS.Timeout | null = null;

  // Verbose-mode counters.
  private audioSendCount = 0;
  private audioSendBytes = 0;
  private audioDroppedBytes = 0;

  private readonly onEvent: (event: TranslationEventBody) => void;
  private readonly onTelemetry: ((sample: ClientTelemetry) => void) | undefined;
  private readonly logTag: string;
  private readonly endpoint: string;
  private readonly resolveAgent: (url: string) => Promise<Agent | undefined>;
  private readonly timings: GeminiTimings;

  constructor(opts: GeminiClientOptions) {
    this.onEvent = opts.onEvent;
    this.onTelemetry = opts.onTelemetry;
    this.logTag = opts.tag ?? '';
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.resolveAgent = opts.resolveAgent ?? resolveProxyAgent;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.output = new StreamingOutputShaper({
      emit: (event) => this.dispatch(event),
      now: () => this.now(),
      timings: this.timings,
      outputSampleRate: GEMINI_OUTPUT_SAMPLE_RATE,
      tag: () => this.tag(),
      verbose: VERBOSE > 0
    });
  }

  /**
   * Open the WS, send `setup`, and resolve only after `setupComplete` —
   * that's the point where the translation config has been accepted and
   * audio may flow. cancel() racing in rejects this promise.
   */
  async start(params: ClientStartParams): Promise<void> {
    if (params.engineId !== 'gemini') {
      throw new Error(
        `GeminiClient received non-gemini params (engineId=${params.engineId})`
      );
    }
    // Single use, like every client: a second start() rejects, and so does
    // one after cancel() — without opening anything.
    if (this.started) throw new Error('Gemini session already started');
    if (this.terminated) throw new Error(CANCELED_MESSAGE);
    this.started = true;
    const creds = getGeminiCredentials();
    if (!creds) throw new MissingCredentialsError('gemini');
    this.apiKey = creds.apiKey;
    this.params = params;
    this.startedAt = Date.now();
    this.output.setMode(params.mode);

    if (VERBOSE) {
      log.info(
        `${this.tag()} → setup`,
        JSON.stringify({
          mode: params.mode,
          tgt: GEMINI_LANGUAGE[params.targetLanguage]
        })
      );
    }

    const conn = await this.connect();
    if (this.terminated) {
      this.closeConnection(conn);
      throw new Error(CANCELED_MESSAGE);
    }
    this.current = conn;
    this.reconnects.connected();
    this.armRotateTimer();
    this.dispatch({ type: 'session-started' });
  }

  /**
   * Queue 16 kHz / 16-bit / mono / LE PCM; sent in ~100 ms frames. Audio
   * arriving during a reconnect gap is dropped — the live stream can't
   * wait for it.
   */
  async sendAudio(pcm: Uint8Array): Promise<void> {
    if (!this.started) throw new Error('Gemini session not started');
    if (this.terminated || this.finishRequested) return;
    // Held by reference: the caller hands the chunk over (see
    // TranslationClient.sendAudio); flushAudio's concat is the one copy.
    this.sendBuffer.push(pcm);
    this.sendBufferBytes += pcm.byteLength;
    if (this.sendBufferBytes >= SEND_CHUNK_BYTES) this.flushAudio();
  }

  /**
   * Graceful end-of-stream: flush buffered audio, send `audioStreamEnd`,
   * keep accepting trailing subtitles/TTS, and emit 'session-finished'
   * once the server goes quiet (or `finishMaxMs` passes).
   */
  async finish(): Promise<void> {
    if (!this.started || this.terminated || this.finishRequested) return;
    this.finishRequested = true;
    this.clearTimer('rotateTimer');
    if (this.pending) this.closeConnection(this.pending);

    const conn = this.current;
    if (!conn) {
      // Mid-reconnect: nothing in flight can still produce output.
      this.completeFinish();
      return;
    }
    this.flushAudio();
    this.sendJson(conn, { realtimeInput: { audioStreamEnd: true } });
    if (VERBOSE) {
      log.info(
        `${this.tag()} → audioStreamEnd (sent ${this.audioSendCount} audio chunks, ${this.audioSendBytes}B; dropped ${this.audioDroppedBytes}B)`
      );
    }

    const t = this.timings;
    this.finishMaxTimer = setTimeout(() => this.completeFinish(), t.finishMaxMs);
    this.armFinishQuiet(
      this.output.awaitingTranslation()
        ? t.finishAwaitTranslationMs
        : this.output.hasPending()
          ? t.finishQuietMs
          : this.lastAudioSentAt > this.lastContentAt
            ? t.finishAwaitResponseMs
            : t.finishIdleMs
    );
  }

  /**
   * Drop the session. Safe at any state, including mid-start (rejects the
   * pending start()). Emits nothing.
   */
  async cancel(): Promise<void> {
    this.cancelled = true;
    if (this.terminated) return;
    this.terminated = true;
    this.clearAllTimers();
    this.closeAllConnections(CANCELED_MESSAGE);
  }

  // -------------------------------------------------------------------------

  private tag(): string {
    return `Gemini[${this.logTag}]`;
  }

  private now(): number {
    return Date.now() - this.startedAt;
  }

  /** Measurements may trail the session's end (a last usage report), never cancel(). */
  private telemetry(sample: ClientTelemetry): void {
    if (!this.cancelled) this.onTelemetry?.(sample);
  }

  /** Estimated audio tokens for `bytes` of 16-bit mono PCM (see AUDIO_TOKENS_PER_SECOND). */
  private reportAudioTokens(
    category: 'inputAudio' | 'outputAudio',
    bytes: number,
    sampleRate: number
  ): void {
    this.telemetry({
      type: 'usage',
      estimated: true,
      tokens: { [category]: (bytes / 2 / sampleRate) * AUDIO_TOKENS_PER_SECOND }
    });
  }

  private dispatch(event: TranslationEventBody): void {
    this.onEvent(event);
  }

  private buildSetup(): unknown {
    const target = this.params ? GEMINI_LANGUAGE[this.params.targetLanguage] : 'en';
    return {
      setup: {
        model: GEMINI_MODEL,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: {
            targetLanguageCode: target,
            // Speech already in the target language stays silent instead of
            // being parroted back; its source subtitle still shows.
            echoTargetLanguage: false
          }
        },
        // Both transcripts drive the dual-line subtitles.
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    };
  }

  /**
   * Open one connection and wait for `setupComplete`. Tracked as `pending`
   * while in flight so cancel()/finish() can abort it.
   */
  private async connect(reconnect = false): Promise<Connection> {
    this.telemetry({ type: 'link', phase: 'connecting', reconnect });
    const agent = await resolveAgentWithin(
      this.resolveAgent,
      this.endpoint,
      this.timings.proxyResolveTimeoutMs,
      this.tag()
    ).catch((err: unknown) => {
      throw toTranslationError(err, 'network', { provider: 'gemini' });
    });
    if (this.terminated) {
      throw new Error(CANCELED_MESSAGE);
    }
    // The key rides in the query string: never log this URL.
    const url = `${this.endpoint}?key=${encodeURIComponent(this.apiKey)}`;
    const dialedAt = Date.now();
    const { ws, opened } = openSocket(url, {
      label: 'Gemini',
      provider: 'gemini',
      handshakeTimeoutMs: this.timings.handshakeTimeoutMs,
      agent
    });
    const conn: Connection = {
      id: this.nextConnectionId++,
      ws,
      settle: null,
      lastError: null,
      retireTimer: null,
      opened: false,
      openedAt: 0,
      stopKeepalive: null,
      pcm: new Pcm16Carry()
    };
    const ready = new Promise<void>((resolve, reject) => {
      conn.settle = (err) => {
        conn.settle = null;
        if (err) reject(err);
        else resolve();
      };
    });
    this.pending = conn;

    let setupTimer: NodeJS.Timeout | null = null;
    opened.then(
      () => {
        conn.opened = true;
        conn.openedAt = Date.now();
        this.telemetry({ type: 'link', phase: 'open', ms: conn.openedAt - dialedAt });
        if (!conn.settle) return; // cancelled while the upgrade completed
        this.sendJson(conn, this.buildSetup());
        setupTimer = setTimeout(() => {
          if (!conn.settle) return;
          this.closeConnection(
            conn,
            this.error(
              'timeout',
              `Gemini setup timed out: no setupComplete within ${this.timings.setupTimeoutMs}ms`
            )
          );
        }, this.timings.setupTimeoutMs);
      },
      (err: Error) => conn.settle?.(err)
    );
    ws.on('message', (data) => this.handleFrame(conn, data as Buffer));
    // 'close' always follows 'error' in ws; the close handler does the work.
    ws.on('error', (err) => {
      conn.lastError = err.message;
      if (VERBOSE) log.info(`${this.tag()} #${conn.id} ws error: ${err.message}`);
    });
    ws.on('close', (code, reason) =>
      this.handleClose(conn, code, reason.toString())
    );

    try {
      await ready;
    } finally {
      if (setupTimer) clearTimeout(setupTimer);
      if (this.pending === conn) this.pending = null;
    }
    // A half-open socket (sleep/wake, Wi-Fi switch) never errors or closes
    // by itself; the server's silence padding and pongs prove liveness.
    conn.stopKeepalive = startKeepalive(ws, {
      intervalMs: this.timings.keepaliveIntervalMs,
      timeoutMs: this.timings.keepaliveTimeoutMs,
      onRtt: (ms) => {
        if (conn === this.current) this.telemetry({ type: 'link', phase: 'rtt', ms });
      },
      onDead: () => this.onConnectionDead(conn)
    });
    return conn;
  }

  /**
   * Terminate a socket the keepalive declared dead. That routes through
   * handleClose like any unexpected close: a live session reconnects (within
   * LIVE_RECONNECT_BUDGET), a finishing one completes, a retired one is dropped.
   */
  private onConnectionDead(conn: Connection): void {
    conn.lastError = `no response from server for ${this.timings.keepaliveTimeoutMs}ms`;
    log.warn(`${this.tag()} #${conn.id} keepalive timeout; dropping connection`);
    try {
      conn.ws.terminate();
    } catch {
      // ignore
    }
  }

  private handleFrame(conn: Connection, data: Buffer): void {
    let msg: GeminiServerMessage;
    try {
      msg = JSON.parse(data.toString('utf8')) as GeminiServerMessage;
    } catch (err) {
      log.error('Failed to parse Gemini JSON frame:', err);
      return;
    }
    if (VERBOSE) this.logIncoming(conn, msg);

    if (msg.setupComplete !== undefined) {
      if (conn.settle) {
        this.telemetry({ type: 'link', phase: 'ready', ms: Date.now() - conn.openedAt });
      }
      conn.settle?.();
      return;
    }
    if (this.terminated) return;
    if (msg.goAway) {
      if (conn === this.current) {
        log.info(
          `${this.tag()} goAway (timeLeft=${msg.goAway.timeLeft ?? '?'}); rotating connection`
        );
        void this.rotate('goAway');
      }
      return;
    }
    if (msg.serverContent) this.handleServerContent(conn, msg.serverContent);
  }

  private handleServerContent(conn: Connection, sc: GeminiServerContent): void {
    const retired = this.retired.has(conn);
    if (conn !== this.current && !retired) return;

    // Transcripts or audible speech — silence padding doesn't count.
    let progressed = false;
    const sourceText = sc.inputTranscription?.text;
    if (sourceText) {
      this.output.appendSource(sourceText);
      progressed = true;
    }
    const translationText = sc.outputTranscription?.text;
    if (translationText) {
      this.output.appendTranslation(translationText);
      progressed = true;
    }
    for (const part of sc.modelTurn?.parts ?? []) {
      const audioB64 = part.inlineData?.data;
      if (!audioB64) continue;
      // Billed whether or not we play it (s2t drops the audio undecoded).
      this.reportAudioTokens('outputAudio', base64Bytes(audioB64), GEMINI_OUTPUT_SAMPLE_RATE);
      // Each connection's audio stream keeps its own carry.
      if (this.output.pushAudio(audioB64, conn.pcm)) progressed = true;
    }
    if (progressed) {
      this.lastContentAt = Date.now();
      // Only real output proves a reconnect worked: a connection that takes
      // `setup` and then streams nothing but padding (or empty serverContent)
      // must keep using up the budget, or a broken session reconnects forever.
      if (conn === this.current) this.reconnects.progressed();
    }

    const t = this.timings;
    if (sc.turnComplete || sc.generationComplete) {
      this.output.armLineClose(t.lineTurnCompleteMs);
    } else if (progressed) {
      this.output.noteProgress();
    }
    if (retired && progressed) this.armRetireTimer(conn);
    if (this.finishRequested && (progressed || sc.turnComplete)) {
      this.armFinishQuiet(
        sc.turnComplete ? t.lineTurnCompleteMs : t.finishQuietMs
      );
    }
  }


  private handleClose(conn: Connection, code: number, reason: string): void {
    if (conn.retireTimer) clearTimeout(conn.retireTimer);
    conn.stopKeepalive?.();
    conn.stopKeepalive = null;
    const detail = reason || conn.lastError || 'no reason';
    if (conn.settle) {
      // Closed before the upgrade finished: `opened` rejects with the
      // richer error (HTTP status + body) — openSocket's close listener ran
      // first, so its rejection is already queued.
      if (!conn.opened) return;
      conn.settle(
        this.error(kindFromCloseCode(code, detail), `Gemini setup failed (code=${code}): ${detail}`, code)
      );
      return;
    }
    if (this.retired.delete(conn)) return;
    if (conn !== this.current || this.terminated) return;

    this.current = null;
    if (this.finishRequested) {
      // The server hung up after audioStreamEnd — nothing more is coming.
      this.completeFinish();
      return;
    }
    const decision = this.reconnects.onDrop(code);
    if (!decision.retry) {
      this.emitFailure(this.error(kindFromCloseCode(code, detail), detail, code));
      return;
    }
    log.warn(
      `${this.tag()} connection closed mid-session (code=${code}): ${detail}; reconnecting (${decision.attempt}/${this.reconnects.maxAttempts})`
    );
    if (decision.delayMs > 0) {
      this.clearTimer('rotateTimer');
      this.rotateTimer = setTimeout(() => void this.rotate('reconnect'), decision.delayMs);
      return;
    }
    void this.rotate('reconnect');
  }

  /**
   * Move audio to a fresh connection. The old one (if still alive) gets
   * `audioStreamEnd` and keeps delivering its trailing output until quiet.
   */
  private async rotate(reason: string): Promise<void> {
    if (this.terminated || this.finishRequested || this.rotating || this.pending) {
      return;
    }
    this.rotating = true;
    this.clearTimer('rotateTimer');
    if (VERBOSE) log.info(`${this.tag()} rotating connection (${reason})`);

    let next: Connection;
    try {
      next = await this.connect(reason === 'reconnect');
    } catch (err) {
      if (this.terminated || this.finishRequested) return;
      const message = err instanceof Error ? err.message : String(err);
      if (this.current) {
        log.warn(`${this.tag()} rotation failed, keeping current connection: ${message}`);
        this.rotateTimer = setTimeout(
          () => void this.rotate('retry'),
          this.timings.rotateRetryMs
        );
        return;
      }
      this.emitFailure(toTranslationError(err, 'network', { provider: 'gemini' }));
      return;
    } finally {
      this.rotating = false;
    }
    if (this.terminated || this.finishRequested) {
      this.closeConnection(next);
      return;
    }

    const old = this.current;
    this.current = next;
    this.reconnects.connected();
    this.armRotateTimer();
    if (old) {
      // Hand any half-filled frame to the new connection, then let the old
      // one drain.
      this.retired.add(old);
      this.sendJson(old, { realtimeInput: { audioStreamEnd: true } });
      this.armRetireTimer(old);
    }
  }

  private armRotateTimer(): void {
    this.clearTimer('rotateTimer');
    this.rotateTimer = setTimeout(
      () => void this.rotate('timer'),
      this.timings.rotateAfterMs
    );
  }

  private armRetireTimer(conn: Connection): void {
    if (conn.retireTimer) clearTimeout(conn.retireTimer);
    conn.retireTimer = setTimeout(
      () => this.closeConnection(conn),
      this.timings.retireQuietMs
    );
  }


  private armFinishQuiet(ms: number): void {
    this.clearTimer('finishQuietTimer');
    this.finishQuietTimer = setTimeout(() => this.completeFinish(), ms);
  }

  private completeFinish(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.clearAllTimers();
    this.output.flush();
    this.dispatch({ type: 'session-finished' });
    this.closeAllConnections('Gemini session finished');
  }

  private emitFailure(err: TranslationError): void {
    if (this.terminated) return;
    this.terminated = true;
    this.clearAllTimers();
    this.dispatch(sessionFailedBody(err));
    this.closeAllConnections('Gemini session failed');
  }

  private error(
    kind: TranslationError['kind'],
    message: string,
    closeCode?: number
  ): TranslationError {
    return new TranslationError(kind, message, { provider: 'gemini', closeCode });
  }

  private flushAudio(): void {
    if (this.sendBufferBytes === 0) return;
    const chunk = Buffer.concat(this.sendBuffer, this.sendBufferBytes);
    this.sendBuffer = [];
    this.sendBufferBytes = 0;
    const conn = this.current;
    if (
      !conn ||
      conn.ws.readyState !== WebSocket.OPEN ||
      // A slow link would otherwise queue audio without bound, and every
      // queued second is a second of subtitle delay that never recovers.
      this.backpressure.shouldDrop(conn.ws.bufferedAmount)
    ) {
      this.audioDroppedBytes += chunk.byteLength;
      return;
    }
    // Hand-built JSON: base64 and the mime type contain no characters that
    // need escaping, so JSON.stringify would only re-scan ~4.3 KB per frame.
    this.sendRaw(
      conn,
      `{"realtimeInput":{"audio":{"data":"${chunk.toString('base64')}","mimeType":"${INPUT_MIME_TYPE}"}}}`
    );
    this.lastAudioSentAt = Date.now();
    this.reportAudioTokens('inputAudio', chunk.byteLength, GEMINI_INPUT_SAMPLE_RATE);

    if (VERBOSE) {
      this.audioSendCount++;
      this.audioSendBytes += chunk.byteLength;
      if (VERBOSE >= 2) {
        log.info(`${this.tag()} → audio (#${this.audioSendCount}, ${chunk.byteLength}B)`);
      } else if (this.audioSendCount % AUDIO_SUMMARY_INTERVAL === 0) {
        log.info(
          `${this.tag()} → audio x${this.audioSendCount} so far (${this.audioSendBytes}B total)`
        );
      }
    }
  }

  private sendJson(conn: Connection, msg: unknown): void {
    this.sendRaw(conn, JSON.stringify(msg));
  }

  private sendRaw(conn: Connection, text: string): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    try {
      conn.ws.send(text);
    } catch (err) {
      log.warn(`${this.tag()} send failed:`, err);
    }
  }

  private closeConnection(conn: Connection, reason: string | Error = 'client close'): void {
    if (conn.retireTimer) clearTimeout(conn.retireTimer);
    conn.retireTimer = null;
    conn.stopKeepalive?.();
    conn.stopKeepalive = null;
    this.retired.delete(conn);
    if (this.current === conn) this.current = null;
    // Reject a setup still in flight right away rather than waiting for
    // the socket's close event.
    conn.settle?.(typeof reason === 'string' ? new Error(reason) : reason);
    // OPEN gets a close frame; CONNECTING is aborted outright.
    closeSocket(conn.ws, 1000, 'client close');
  }

  private closeAllConnections(reason: string): void {
    const all = [this.pending, this.current, ...this.retired];
    this.pending = null;
    for (const conn of all) {
      if (conn) this.closeConnection(conn, reason);
    }
  }

  private clearTimer(
    key: 'rotateTimer' | 'finishQuietTimer' | 'finishMaxTimer'
  ): void {
    const timer = this[key];
    if (timer) clearTimeout(timer);
    this[key] = null;
  }

  private clearAllTimers(): void {
    this.clearTimer('rotateTimer');
    this.clearTimer('finishQuietTimer');
    this.clearTimer('finishMaxTimer');
    this.output.stop();
  }

  private logIncoming(conn: Connection, msg: GeminiServerMessage): void {
    const tag = `${this.tag()} #${conn.id}`;
    if (msg.setupComplete !== undefined) {
      log.info(`${tag} ← setupComplete`);
      return;
    }
    if (msg.goAway) {
      log.info(`${tag} ← goAway timeLeft=${msg.goAway.timeLeft ?? '?'}`);
      return;
    }
    if (msg.sessionResumptionUpdate) {
      // Sent every few seconds even though resumption isn't enabled.
      if (VERBOSE >= 2) log.info(`${tag} ← sessionResumptionUpdate`);
      return;
    }
    const sc = msg.serverContent;
    if (!sc) {
      if (msg.usageMetadata) log.info(`${tag} ← usageMetadata`, JSON.stringify(msg.usageMetadata));
      else log.info(`${tag} ← ${Object.keys(msg).join(',') || '(empty)'}`);
      return;
    }
    if (VERBOSE >= 2) {
      if (sc.inputTranscription?.text !== undefined) {
        log.info(
          `${tag} ← inputTranscription[${sc.inputTranscription.languageCode ?? '?'}] "${sc.inputTranscription.text}"`
        );
      }
      if (sc.outputTranscription?.text !== undefined) {
        log.info(
          `${tag} ← outputTranscription[${sc.outputTranscription.languageCode ?? '?'}] "${sc.outputTranscription.text}"`
        );
      }
      for (const part of sc.modelTurn?.parts ?? []) {
        if (part.inlineData?.data) {
          log.info(
            `${tag} ← audio (${Buffer.byteLength(part.inlineData.data, 'base64')}B ${part.inlineData.mimeType ?? ''})`
          );
        }
      }
    }
    const flags = (['turnComplete', 'generationComplete', 'interrupted'] as const).filter(
      (k) => sc[k]
    );
    if (flags.length > 0) log.info(`${tag} ← serverContent ${flags.join(',')}`);
  }
}
