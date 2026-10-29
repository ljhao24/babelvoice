/**
 * WebSocket transport for OpenAI realtime translation
 * (`gpt-realtime-translate`, the dedicated `/v1/realtime/translations`
 * endpoint — not the voice-agent `/v1/realtime` one).
 *
 * Wire format:
 *   - JSON-over-WebSocket, `type`-discriminated. Auth lives in the WS
 *     handshake header `Authorization: Bearer <OPENAI_API_KEY>`.
 *   - Endpoint:
 *     wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate
 *
 * Lifecycle:
 *   client → session.update      { audio: { input: { transcription }, output: { language } } }
 *   client ← session.created
 *   client ← session.updated                         ← MUST WAIT before sending audio
 *   client → session.input_audio_buffer.append * N   (base64 PCM16 24k mono LE, ~200 ms each)
 *   client ← session.input_transcript.delta          (source, append-only fragment)
 *   client ← session.output_transcript.delta         (translation, append-only fragment)
 *   client ← session.output_audio.delta              (base64 PCM16 24k mono LE)
 *   client → session.close                           (flush pending input + output)
 *   client ← session.closed                          (safe to close)
 *   client ← error                                   (usually recoverable; the session lives on)
 *
 * What this adapter absorbs so DirectionSession stays engine-blind:
 *   - Input must be 24 kHz: `inputSampleRate` has the capture deliver it
 *     natively (no resampling here); it's sent in 200 ms frames, the
 *     engine's own frame size.
 *   - No utterance boundaries, finals or response lifecycle — translation
 *     streams continuously. `TranscriptSegmenter` pairs the source and
 *     translation fragments into subtitle lines on sentence terminals; the
 *     client flushes them when the stream goes quiet.
 *   - No TTS sentence events: a sentence opens on the first audible chunk
 *     and closes after a quiet gap; silence between sentences is dropped.
 *   - Output audio can't be disabled; in s2t mode it's dropped here.
 *   - The source language is auto-detected and there is no voice choice
 *     (the output voice follows the speaker), so only the target goes out.
 *   - The endpoint is overseas, so the socket goes through the system
 *     proxy (`proxy-agent.ts`).
 *
 * Lives in main for the same reasons as QwenClient: Node `ws` (custom
 * auth header), events out via the constructor-supplied `onEvent` — see
 * ADR-0002. The two-phase start, keepalive, failure convergence and cancel
 * live in `GatedWsSession`; transcript/TTS shaping in
 * `StreamingOutputShaper` (both shared).
 */
import type { WebSocket } from 'ws';
import type { Agent } from 'node:http';
import type { EngineId } from '@shared/engine-types.js';
import type { ProtocolLanguage } from '@shared/ipc-types.js';
import { log } from '@core/utils/logger.js';
import { getOpenAiCredentials } from './credential-vault.js';
import {
  kindFromProviderError,
  MissingCredentialsError,
  type TranslationError
} from './translation-error.js';
import { resolveProxyAgent } from './proxy-agent.js';
import { StreamingOutputShaper } from './streaming-output-shaper.js';
import { GatedWsSession } from './gated-ws-session.js';
import { LIVE_RECONNECT_BUDGET, ReconnectPolicy } from './reconnect-policy.js';
import {
  DEFAULT_WS_TIMING,
  PROXY_RESOLVE_TIMEOUT_MS,
  type WsTiming
} from './ws-transport.js';
import type {
  ClientStartParams,
  OpenAiStartParams,
  TranslationClient,
  TranslationClientOptions
} from './translation-client.js';

export const OPENAI_MODEL = 'gpt-realtime-translate';

/** Source-language transcription model; without it no input transcript. */
const TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';

const DEFAULT_ENDPOINT = `wss://api.openai.com/v1/realtime/translations?model=${OPENAI_MODEL}`;

/** Both directions of the translation endpoint are 24 kHz PCM16 mono. */
const OPENAI_SAMPLE_RATE = 24_000;

/** 200 ms — the engine's processing frame. */
const SEND_CHUNK_MS = 200;
/** SEND_CHUNK_MS of 24 kHz / 16-bit mono. */
const SEND_CHUNK_BYTES = ((OPENAI_SAMPLE_RATE * SEND_CHUNK_MS) / 1000) * 2;

/**
 * finish() upper bound on waiting for `session.closed`. Must stay well under
 * DirectionSession's FINISH_DEADLINE_MS (10 s), which starts at the same
 * moment: if the session deadline fired first it would cancel us and drop
 * the flushed trailing lines + 'session-finished' this fallback delivers.
 */
export const OPENAI_FINISH_MAX_MS = 8_000;

/**
 * Silence-driven heuristics (the stream has no utterance boundaries) plus
 * transport timeouts. Overridable for tests.
 */
export interface OpenAiTimings extends WsTiming {
  /** No transcript/audio for this long → close the current line pair. */
  lineIdleMs: number;
  /** …but wait longer while source text still has no translation. */
  lineAwaitTranslationMs: number;
  /** No audible TTS for this long → the spoken sentence ended. */
  ttsIdleMs: number;
  /** finish(): upper bound on waiting for `session.closed`. */
  finishMaxMs: number;
  /** Proxy lookup bound; past it the socket connects directly. */
  proxyResolveTimeoutMs: number;
}

const DEFAULT_TIMINGS: OpenAiTimings = {
  ...DEFAULT_WS_TIMING,
  lineIdleMs: 1_200,
  lineAwaitTranslationMs: 2_500,
  ttsIdleMs: 800,
  finishMaxMs: OPENAI_FINISH_MAX_MS,
  proxyResolveTimeoutMs: PROXY_RESOLVE_TIMEOUT_MS
};

/**
 * Set `OPENAI_VERBOSE=1` (or `=2`) to dump protocol traffic to the main
 * process log. Level 1 prints non-audio events + per-N audio summaries;
 * level 2 also prints every transcript fragment and audio chunk.
 */
const VERBOSE = (() => {
  const raw = process.env.OPENAI_VERBOSE;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 1;
})();

const AUDIO_SUMMARY_INTERVAL = 50;

interface OpenAiServerEvent {
  type?: string;
  event_id?: string;
  session?: unknown;
  error?: { type?: string; code?: string | number; message?: string };
  /** Transcript fragment, or base64 PCM on `session.output_audio.delta`. */
  delta?: string;
}

export interface OpenAiClientOptions extends TranslationClientOptions {
  /** Override the WS endpoint; defaults to the production OpenAI URL. */
  endpoint?: string;
  /** Override proxy resolution; defaults to the system proxy via Chromium. */
  resolveAgent?: (url: string) => Promise<Agent | undefined>;
  timings?: Partial<OpenAiTimings>;
}

export class OpenAiClient implements TranslationClient {
  readonly engineId: EngineId = 'openai';
  readonly inputSampleRate = OPENAI_SAMPLE_RATE;
  readonly outputSampleRate = OPENAI_SAMPLE_RATE;
  readonly uplinkChunkMs = SEND_CHUNK_MS;

  private readonly session: GatedWsSession;
  private readonly output: StreamingOutputShaper;
  private params: OpenAiStartParams | null = null;
  private startedAt = 0;

  private sendBuffer: Uint8Array[] = [];
  private sendBufferBytes = 0;

  private finishTimer: NodeJS.Timeout | null = null;

  // Verbose-mode counters.
  private audioSendCount = 0;
  private audioSendBytes = 0;
  private audioDroppedBytes = 0;

  private readonly logTag: string;
  private readonly endpoint: string;
  private readonly resolveAgent: (url: string) => Promise<Agent | undefined>;
  private readonly timings: OpenAiTimings;

  constructor(opts: OpenAiClientOptions) {
    this.logTag = opts.tag ?? '';
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.resolveAgent = opts.resolveAgent ?? resolveProxyAgent;
    this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
    this.session = new GatedWsSession({
      provider: 'openai',
      label: 'OpenAI',
      readyEvent: 'session.updated',
      configureFrame: 'session.update',
      timing: this.timings,
      tag: () => this.tag(),
      onEvent: opts.onEvent,
      onTelemetry: opts.onTelemetry,
      // Also for the 60-min session cap (a `session_expired` error, then the
      // close): translation keeps no history, so a fresh session carries on.
      reconnect: new ReconnectPolicy(LIVE_RECONNECT_BUDGET),
      hooks: {
        configure: (ws) => this.sendSessionUpdate(ws),
        onMessage: (data) => this.handleFrame(data),
        // The server hung up after session.close — nothing more is coming,
        // whatever the close code.
        closeEndsFinish: () => true,
        flush: () => this.output.flush(),
        onEnd: () => {
          this.output.stop();
          this.clearFinishTimer();
        },
        // Whatever the old connection had open will never be closed by it.
        onLinkLost: () => this.output.flush()
      }
    });
    this.output = new StreamingOutputShaper({
      emit: (event) => this.session.emit(event),
      now: () => this.now(),
      timings: this.timings,
      outputSampleRate: OPENAI_SAMPLE_RATE,
      tag: () => this.tag(),
      verbose: VERBOSE > 0
    });
  }

  /**
   * Open the WS, send `session.update`, and resolve only after
   * `session.updated` — the point where the target language is in effect
   * and audio may flow. cancel() racing in rejects this promise.
   */
  async start(params: ClientStartParams): Promise<void> {
    if (params.engineId !== 'openai') {
      throw new Error(
        `OpenAiClient received non-openai params (engineId=${params.engineId})`
      );
    }
    this.session.claim();
    const creds = getOpenAiCredentials();
    if (!creds) throw new MissingCredentialsError('openai');
    this.params = params;
    this.startedAt = Date.now();
    this.output.setMode(params.mode);
    await this.session.open({
      url: this.endpoint,
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      traceHeader: 'x-request-id',
      resolveAgent: this.resolveAgent,
      proxyResolveTimeoutMs: this.timings.proxyResolveTimeoutMs
    });
  }

  /**
   * Queue 24 kHz / 16-bit / mono / LE PCM; sent in 200 ms frames. The
   * engine expects an unbroken stream, silence included — capture provides
   * that.
   */
  async sendAudio(pcm: Uint8Array): Promise<void> {
    // Audio appended after `session.close` would race the server's flush:
    // the session stops admitting it once finish() ran.
    if (!this.session.admitAudio()) return;
    // Held by reference: the caller hands the chunk over (see
    // TranslationClient.sendAudio); flushAudio's concat is the one copy.
    this.sendBuffer.push(pcm);
    this.sendBufferBytes += pcm.byteLength;
    if (this.sendBufferBytes >= SEND_CHUNK_BYTES) this.flushAudio();
  }

  /**
   * Graceful end-of-stream: send the buffered tail, then `session.close`.
   * The server flushes pending input and output and answers
   * `session.closed`; until then trailing subtitles/TTS are still accepted.
   */
  async finish(): Promise<void> {
    if (!this.session.beginFinish()) return;
    this.flushAudio();
    this.session.sendControl(JSON.stringify({ type: 'session.close' }), 'session.close');
    if (VERBOSE) {
      log.info(
        `${this.tag()} → session.close (sent ${this.audioSendCount} audio chunks, ${this.audioSendBytes}B; dropped ${this.audioDroppedBytes}B)`
      );
    }
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null;
      log.warn(
        `${this.tag()} no session.closed within ${this.timings.finishMaxMs}ms of finish(); closing anyway`
      );
      this.session.complete('session closed');
    }, this.timings.finishMaxMs);
  }

  /**
   * Drop the session. Safe at any state, including mid-start (rejects the
   * pending start()); idempotent; emits nothing.
   */
  async cancel(): Promise<void> {
    this.session.cancel();
  }

  // -------------------------------------------------------------------------

  private tag(): string {
    return `OpenAI[${this.logTag}]`;
  }

  private now(): number {
    return Date.now() - this.startedAt;
  }

  /** `configure` hook: the target language and source transcription. */
  private sendSessionUpdate(ws: WebSocket): void {
    const params = this.params;
    if (!params) throw new Error('no start params');
    ws.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          audio: {
            // Without a transcription model there is no source transcript.
            input: { transcription: { model: TRANSCRIPTION_MODEL } },
            output: { language: this.toOpenAiLang(params.targetLanguage) }
          }
        }
      })
    );
    if (VERBOSE) {
      log.info(
        `${this.tag()} → session.update`,
        JSON.stringify({ mode: params.mode, tgt: params.targetLanguage })
      );
    }
  }

  /**
   * Pass-through today: ProtocolLanguage's 8 codes are all among the 13
   * ISO 639-1 output languages the model supports. Kept as a method so a
   * future code gets a single mapping site.
   */
  private toOpenAiLang(lang: ProtocolLanguage): string {
    return lang;
  }

  private handleFrame(data: Buffer): void {
    let event: OpenAiServerEvent;
    try {
      event = JSON.parse(data.toString('utf8')) as OpenAiServerEvent;
    } catch (err) {
      log.error('Failed to parse OpenAI JSON frame:', err);
      return;
    }
    const type = event.type ?? '';
    if (VERBOSE) this.logIncomingEvent(type, event);

    switch (type) {
      case 'session.created':
        // Informational only: wait for session.updated so the target
        // language is definitely in effect.
        break;
      case 'session.updated':
        this.session.markReady();
        break;
      case 'session.closed':
        this.session.complete('session closed');
        break;
      case 'error': {
        if (!this.session.isReady) {
          this.session.fail(this.serverError(event));
          break;
        }
        // Mid-session errors are recoverable per the API reference; a fatal
        // one is followed by the server closing the socket (a close-code
        // failure in GatedWsSession).
        log.warn(
          `${this.tag()} server error (type=${event.error?.type ?? '?'}, code=${event.error?.code ?? '?'}): ${event.error?.message ?? 'openai error'}`
        );
        break;
      }

      case 'session.input_transcript.delta':
        if (!event.delta) break;
        this.output.appendSource(event.delta);
        this.output.noteProgress();
        break;
      case 'session.output_transcript.delta':
        if (!event.delta) break;
        this.output.appendTranslation(event.delta);
        this.output.noteProgress();
        break;
      case 'session.output_audio.delta':
        // Only audible speech counts as progress; silence never moves the
        // line-close deadline.
        if (event.delta && this.output.pushAudio(event.delta)) {
          this.output.noteProgress();
        }
        break;

      default:
        // Unknown event type: ignore. Future events surface here for log
        // triage rather than crashing.
        break;
    }
  }

  private clearFinishTimer(): void {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
  }

  private flushAudio(): void {
    if (this.sendBufferBytes === 0) return;
    const chunk = Buffer.concat(this.sendBuffer, this.sendBufferBytes);
    this.sendBuffer = [];
    this.sendBufferBytes = 0;
    // Null when the socket is gone or backed up (see audioSocket).
    const ws = this.session.audioSocket();
    if (!ws) {
      this.audioDroppedBytes += chunk.byteLength;
      return;
    }
    // Hand-built JSON: base64 contains no characters that need escaping.
    ws.send(
      `{"type":"session.input_audio_buffer.append","audio":"${chunk.toString('base64')}"}`
    );

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


  private logIncomingEvent(type: string, event: OpenAiServerEvent): void {
    const tag = this.tag();
    switch (type) {
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta':
        if (VERBOSE >= 2) log.info(`${tag} ← ${type} delta="${event.delta ?? ''}"`);
        return;
      case 'session.output_audio.delta':
        if (VERBOSE >= 2) {
          const len = event.delta ? Buffer.byteLength(event.delta, 'base64') : 0;
          log.info(`${tag} ← ${type} (${len}B)`);
        }
        return;
      case 'error':
        log.info(
          `${tag} ← error type=${event.error?.type ?? '?'} code=${event.error?.code ?? '?'} message="${event.error?.message ?? ''}"`
        );
        return;
      default:
        log.info(`${tag} ← ${type}`);
    }
  }

  /**
   * An `error` event. Codes are strings ("invalid_api_key",
   * "insufficient_quota", "rate_limit_exceeded"); they, the error type
   * ("server_error") and the message decide the kind, else it is a request
   * the server refused.
   */
  private serverError(event: OpenAiServerEvent): TranslationError {
    const message = event.error?.message ?? 'openai error';
    const code = event.error?.code;
    return this.session.error(
      kindFromProviderError(code, `${event.error?.type ?? ''} ${message}`, 'protocol'),
      message,
      { providerCode: code }
    );
  }
}
