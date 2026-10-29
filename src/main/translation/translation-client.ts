/**
 * Provider-agnostic transport contract for one in-flight translation
 * session. See ADR-0002 for the rationale (no orchestrator; the seam
 * lives at the client itself; DirectionSession is engine-blind).
 *
 * Implementations: DoubaoClient, QwenClient, GeminiClient, OpenAiClient,
 * MockTranslationClient.
 */
import type { ProtocolLanguage, TranslationEvent } from '@shared/ipc-types.js';
import type { EngineId, QwenPresetVoice } from '@shared/engine-types.js';
import type { TokenCounts } from '@shared/meeting-metrics-types.js';
import type { CorpusInput } from './doubao-codec.js';

// Distributive Omit so each variant of the union loses the listed keys it has.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * What a TranslationClient emits: a TranslationEvent without the fields the
 * owning DirectionSession fills in — `direction` on every event, and
 * `sampleRate` (the client's `outputSampleRate`) on 'tts-audio' (ADR-0002).
 */
export type TranslationEventBody = DistributiveOmit<
  TranslationEvent,
  'direction' | 'sampleRate'
>;

/**
 * Out-of-band measurements, kept off the event stream: they are not part
 * of the session's lifecycle contract, and only the MeetingMonitor wants
 * them. Nothing is reported after cancel().
 */
export type ClientTelemetry =
  /**
   * Tokens used since the previous report (a delta; a negative count
   * corrects an earlier over-report). `estimated`: derived from audio
   * duration, not reported by the provider.
   */
  | { type: 'usage'; tokens: TokenCounts; estimated?: boolean }
  | {
      type: 'link';
      /**
       * `connecting`: a connection attempt started (`reconnect`: it replaces
       * a dropped one); `open`: the WebSocket upgrade completed; `ready`:
       * the provider's ready event; `rtt`: a keepalive round trip.
       */
      phase: 'connecting' | 'open' | 'ready' | 'rtt';
      reconnect?: boolean;
      /** open: upgrade duration; ready: open → ready; rtt: ping → pong. */
      ms?: number;
    };

export interface TranslationClientOptions {
  /** Receives undirected event bodies; the owning session adds direction. */
  onEvent: (event: TranslationEventBody) => void;
  /** Usage and link measurements (see ClientTelemetry). */
  onTelemetry?: (sample: ClientTelemetry) => void;
  /** Optional log scope (typically the Direction string). */
  tag?: string;
}

interface BaseClientStartParams {
  sourceLanguage: ProtocolLanguage;
  targetLanguage: ProtocolLanguage;
  /** s2t: subtitles only. s2s: subtitles + TTS audio. */
  mode: 's2t' | 's2s';
}

export interface DoubaoStartParams extends BaseClientStartParams {
  engineId: 'doubao';
  /** Undefined = clone the speaker's voice. */
  speakerId?: string;
  /** [-50, 100]; 0 = native rate. */
  speechRate?: number;
  /** Server-side denoise on input audio. */
  denoise?: boolean;
  /** Hot words / glossary / replacement tables. */
  corpus?: CorpusInput;
}

/**
 * qwen3.8 auto-detects the source language, so `sourceLanguage` is carried
 * for symmetry but not sent on the wire.
 */
export interface QwenStartParams extends BaseClientStartParams {
  engineId: 'qwen';
  /** Preset TTS voice; s2s only. Ignored when `voiceClone` is set. */
  voice?: QwenPresetVoice;
  /**
   * Clone the input speaker's voice instead of using a preset: `once` per
   * session (one speaker), or `always` before every output (follows
   * speaker changes). s2s only.
   */
  voiceClone?: 'once' | 'always';
}

/**
 * Gemini auto-detects the source language and always replicates the
 * speaker's voice, so there are no per-engine knobs; `sourceLanguage` is
 * carried for symmetry but not sent on the wire.
 */
export interface GeminiStartParams extends BaseClientStartParams {
  engineId: 'gemini';
}

/**
 * OpenAI auto-detects the source language and its output voice follows
 * the speaker, so there are no per-engine knobs either.
 */
export interface OpenAiStartParams extends BaseClientStartParams {
  engineId: 'openai';
}

export interface MockStartParams extends BaseClientStartParams {
  engineId: 'mock';
}

/**
 * Discriminated by `engineId`. Each TranslationClient implementation
 * narrows to its own variant at the top of `start()` and throws
 * otherwise — see ADR-0002 ("each adapter's `start(params)` reads
 * exactly its own variant").
 */
export type ClientStartParams =
  | DoubaoStartParams
  | QwenStartParams
  | GeminiStartParams
  | OpenAiStartParams
  | MockStartParams;

export interface TranslationClient {
  readonly engineId: EngineId;

  /**
   * Sample rate of the PCM `sendAudio()` takes (16000 or 24000 — what the
   * native captures support). The owning DirectionSession has the capture
   * deliver exactly this rate, so no client resamples.
   */
  readonly inputSampleRate: number;

  /**
   * Sample rate of the TTS PCM this client emits. The owning
   * DirectionSession passes it to the TtsSink; declaring it on the
   * interface keeps "engine knowledge" out of the session.
   */
  readonly outputSampleRate: number;

  /**
   * Packet duration this client frames its uplink at, when it re-batches
   * audio itself. DirectionSession then batches capture to the same size so
   * audio isn't buffered twice (80 ms + the client's frame). Omit to take
   * the session default.
   */
  readonly uplinkChunkMs?: number;

  /**
   * Open the connection and resolve only after the provider is ready
   * to receive audio. cancel() racing in MUST cause this promise to
   * reject (so DirectionSession's start checkpoint can distinguish
   * cancel-during-connect from a genuine failure).
   *
   * A client is single use: a second start() rejects whether the first is
   * in flight, live or over, and a start() after cancel() rejects without
   * connecting. A DirectionSession mints a fresh client per session.
   */
  start(params: ClientStartParams): Promise<void>;

  /**
   * `inputSampleRate` / 16-bit / mono / LE PCM. Valid only between start()
   * resolving and finish()/cancel(); chunks arriving after those are
   * dropped silently. The chunk is handed over: a client may hold it until
   * its next frame goes out, so the caller must not reuse the buffer.
   */
  sendAudio(pcm: Uint8Array): Promise<void>;

  /** Graceful end-of-stream. Provider emits trailing TTS, then 'session-finished'. Idempotent. */
  finish(): Promise<void>;

  /**
   * Drop the session. Safe at any state — before start(), mid-start(), live
   * or over. Idempotent, and a permanent latch: nothing is emitted after it.
   */
  cancel(): Promise<void>;
}
