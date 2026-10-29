/**
 * Pure protobuf encode/decode for the Volcengine LiveInterpret 2.0 wire
 * protocol. No I/O, no socket state — given a session id and parameters,
 * produces request frames; given a server frame, produces a structured
 * `DecodedFrame`. The transport layer (DoubaoClient) wraps this with WS
 * lifecycle and event dispatch.
 *
 * Splitting this out lets the wire-format details be exercised as pure
 * functions: the `decodeFrame` interface *is* the test surface for the
 * server's response taxonomy.
 *
 * Encode/decode are synchronous: they run once per 80 ms uplink chunk and
 * once per server frame, so they use the Types cached by the one-time
 * `initDoubaoCodec()` instead of awaiting the proto loader every call.
 */
import type { TokenCategory, TokenCounts } from '@shared/meeting-metrics-types.js';
import { ProtoEvent } from '@shared/proto-events.js';
import { ensureProtoTypes, getLoadedProtoTypes } from './proto-loader.js';
import type {
  DoubaoStartParams,
  TranslationEventBody
} from './translation-client.js';

/** UsageResponse: the tokens billed for `durationMs` of audio. */
export interface DoubaoUsageBody {
  type: 'usage';
  tokens: TokenCounts;
  durationMs: number;
}

/** A decoded business frame: an event, or a usage report (telemetry). */
export type DoubaoFrameBody = TranslationEventBody | DoubaoUsageBody;

const SUCCESS_STATUS = new Set([0, 20_000_000]);

/**
 * Mirror of `data.speech.understanding.Corpus` (see
 * `protos/products/.../au_base.proto`). Field names are kept snake_case so
 * they line up with the protobuf encoder (`keepCase: true`); also matches
 * the API doc verbatim. Doubao-only — lives here because it follows the
 * wire format, not the seam.
 */
export interface CorpusInput {
  hot_words_list?: string[];
  boosting_table_id?: string;
  boosting_table_name?: string;
  /** JSON-string map per the API doc, e.g. '{"接受":"接收"}'. */
  correct_words?: string;
  regex_correct_table_id?: string;
  regex_correct_table_name?: string;
  glossary_list?: Record<string, string>;
  glossary_table_id?: string;
  glossary_table_name?: string;
}

/**
 * ResponseMeta fields are PascalCase in the .proto (`SessionID`, `StatusCode`,
 * `Billing`) — read both casings defensively because protobufjs `keepCase`
 * behavior with `[json_name=...]` annotations can vary between versions.
 */
const pickField = <T = unknown>(
  src: Record<string, unknown> | undefined | null,
  ...keys: string[]
): T | undefined => {
  if (!src) return undefined;
  for (const k of keys) {
    if (src[k] !== undefined && src[k] !== null) return src[k] as T;
  }
  return undefined;
};

const EVENT_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(ProtoEvent).map(([k, v]) => [v, k])
);

export const eventName = (n: number): string =>
  EVENT_NAME[n] ?? `Event(${n})`;

const buildReqParams = (
  params: DoubaoStartParams
): Record<string, unknown> => {
  const req: Record<string, unknown> = {
    mode: params.mode,
    source_language: params.sourceLanguage,
    target_language: params.targetLanguage
  };
  if (params.speakerId) req.speaker_id = params.speakerId;
  // `params.speechRate` is deliberately not sent. The API doc lists
  // `request.speech_rate`, but `ReqParams` in the vendored
  // ast_service.proto has no such field, so protobufjs would silently drop
  // it from the encoded frame. Wire it up only once an official proto that
  // defines the field (and its number) is vendored — don't guess a number.
  if (params.corpus && Object.keys(params.corpus).length > 0) {
    req.corpus = params.corpus;
  }
  return req;
};

export interface DoubaoTargetAudio {
  format: 'pcm' | 'ogg_opus';
  rate: number;
}

/**
 * One-time async init (loads + resolves the protobuf Types). Must resolve
 * before any encodeXxx / decodeFrame call; DoubaoClient.start() awaits it
 * alongside the WS handshake. Safe to call repeatedly.
 */
export const initDoubaoCodec = async (): Promise<void> => {
  await ensureProtoTypes();
};

// Encoders pass plain objects straight to `encode()`: `Type.create()` only
// copies properties onto a Message instance, which the reflection encoder
// doesn't need — skipping it saves an allocation per 80 ms audio chunk.
const encodeRequest = (msg: Record<string, unknown>): Uint8Array =>
  getLoadedProtoTypes().TranslateRequest.encode(msg).finish();

export const encodeStartSession = (
  sessionId: string,
  connectId: string,
  params: DoubaoStartParams,
  targetAudio: DoubaoTargetAudio
): Uint8Array =>
  encodeRequest({
    request_meta: { SessionID: sessionId },
    event: ProtoEvent.StartSession,
    user: { uid: 'translator-electron', did: connectId },
    source_audio: {
      format: 'wav',
      codec: 'raw',
      rate: 16_000,
      bits: 16,
      channel: 1
    },
    target_audio: targetAudio,
    request: buildReqParams(params),
    ...(params.denoise !== undefined ? { denoise: params.denoise } : {})
  });

export const encodeTaskRequest = (
  sessionId: string,
  pcm: Uint8Array
): Uint8Array =>
  encodeRequest({
    request_meta: { SessionID: sessionId },
    event: ProtoEvent.TaskRequest,
    source_audio: { binary_data: pcm }
  });

export const encodeFinishSession = (sessionId: string): Uint8Array =>
  encodeRequest({
    request_meta: { SessionID: sessionId },
    event: ProtoEvent.FinishSession
  });

export const encodeCancelSession = (sessionId: string): Uint8Array =>
  encodeRequest({
    request_meta: { SessionID: sessionId },
    event: ProtoEvent.CancelSession
  });

export const encodeUpdateConfig = (
  sessionId: string,
  corpus: CorpusInput
): Uint8Array =>
  encodeRequest({
    request_meta: { SessionID: sessionId },
    event: ProtoEvent.UpdateConfig,
    request: { corpus }
  });

export interface DecodedFrame {
  /** Numeric event id from the protocol. */
  event: number;
  /** Human-readable event name for logs. */
  eventLabel: string;
  /** Server-reported status code; non-success implies a failure (except on
   *  terminal Session* events, which carry their own semantics). */
  statusCode: number;
  /** Optional human-readable status message from response_meta. */
  message: string;
  /** True when statusCode is success-shaped (0 or 20_000_000). */
  isSuccessStatus: boolean;
  /**
   * Mapped business event body — null for lifecycle events (Started /
   * Finished / Canceled / Failed) which the transport handles itself, and
   * for events with no current consumer.
   */
  body: DoubaoFrameBody | null;
}

/**
 * Shape of a decoded `TranslateResponse` Message (keepCase field names).
 * Unset proto3 scalars read their default from the Message prototype.
 */
interface RawTranslateResponse {
  response_meta?: Record<string, unknown> | null;
  event?: number;
  data?: Uint8Array;
  text?: string;
  start_time?: number;
  end_time?: number;
  spk_chg?: boolean;
  muted_duration_ms?: number;
}

export const decodeFrame = (data: Uint8Array): DecodedFrame => {
  const { TranslateResponse } = getLoadedProtoTypes();
  const decoded = TranslateResponse.decode(data);
  // Read fields straight off the decoded Message instead of
  // `toObject({ defaults: true })`, which allocates a full copy (including
  // the TTS bytes) for every frame. Only the rare UsageResponse needs
  // `toObject`, to turn Billing's int64 `DurationMsec` (a Long) into a number.
  const response = decoded as unknown as RawTranslateResponse;
  const event = response.event ?? 0;

  const meta: Record<string, unknown> =
    event === ProtoEvent.UsageResponse
      ? ((TranslateResponse.toObject(decoded, { defaults: true, longs: Number })
          .response_meta ?? {}) as Record<string, unknown>)
      : (response.response_meta ?? {});
  const statusCode = pickField<number>(meta, 'StatusCode', 'status_code') ?? 0;
  const message = pickField<string>(meta, 'Message', 'message') ?? '';
  const isSuccessStatus = SUCCESS_STATUS.has(statusCode);

  const text = response.text ?? '';
  const startMs = response.start_time ?? 0;
  const endMs = response.end_time ?? 0;
  const speakerChanged = Boolean(response.spk_chg);
  const mutedDurationMs = response.muted_duration_ms ?? 0;
  const tts = response.data;

  const body = mapEventToBody(event, {
    text,
    startMs,
    endMs,
    speakerChanged,
    mutedDurationMs,
    tts,
    meta
  });

  return {
    event,
    eventLabel: eventName(event),
    statusCode,
    message,
    isSuccessStatus,
    body
  };
};

/** `billing.items[].unit` → our token category (unknown units are skipped). */
const DOUBAO_BILLING_UNITS: Record<string, TokenCategory | undefined> = {
  input_audio_tokens: 'inputAudio',
  input_text_tokens: 'inputText',
  output_text_tokens: 'outputText',
  output_audio_tokens: 'outputAudio'
};

const mapEventToBody = (
  event: number,
  fields: {
    text: string;
    startMs: number;
    endMs: number;
    speakerChanged: boolean;
    mutedDurationMs: number;
    tts: Uint8Array | undefined;
    meta: Record<string, unknown>;
  }
): DoubaoFrameBody | null => {
  switch (event) {
    case ProtoEvent.SourceSubtitleStart:
      return {
        type: 'source-subtitle-start',
        startMs: fields.startMs,
        speakerChanged: fields.speakerChanged
      };
    case ProtoEvent.SourceSubtitleResponse:
      return { type: 'source-subtitle-delta', text: fields.text };
    case ProtoEvent.SourceSubtitleEnd:
      return {
        type: 'source-subtitle-final',
        text: fields.text,
        startMs: fields.startMs,
        endMs: fields.endMs
      };
    case ProtoEvent.TranslationSubtitleStart:
      return {
        type: 'translation-subtitle-start',
        startMs: fields.startMs,
        speakerChanged: fields.speakerChanged
      };
    case ProtoEvent.TranslationSubtitleResponse:
      return { type: 'translation-subtitle-delta', text: fields.text };
    case ProtoEvent.TranslationSubtitleEnd:
      return {
        type: 'translation-subtitle-final',
        text: fields.text,
        startMs: fields.startMs,
        endMs: fields.endMs
      };
    case ProtoEvent.TTSSentenceStart:
      return { type: 'tts-sentence-start', startMs: fields.startMs };
    case ProtoEvent.TTSResponse: {
      if (!fields.tts || fields.tts.byteLength === 0) return null;
      // Copy into a fresh ArrayBuffer — the one copy on this path. The
      // decoded bytes are a view into the incoming WS frame (protobufjs
      // slices the input Buffer), which may itself sit in a Node pool
      // slab; neither is something we want to hand to the renderer.
      const ab = new ArrayBuffer(fields.tts.byteLength);
      new Uint8Array(ab).set(fields.tts);
      return { type: 'tts-audio', data: ab };
    }
    case ProtoEvent.TTSSentenceEnd:
      return { type: 'tts-sentence-end', endMs: fields.endMs };
    case ProtoEvent.AudioMuted:
      return { type: 'audio-muted', durationMs: fields.mutedDurationMs };
    case ProtoEvent.UsageResponse: {
      const billing = pickField<Record<string, unknown>>(
        fields.meta,
        'Billing',
        'billing'
      );
      const tokens: TokenCounts = {};
      for (const it of pickField<Array<Record<string, unknown>>>(
        billing,
        'Items',
        'items'
      ) ?? []) {
        const cat = DOUBAO_BILLING_UNITS[pickField<string>(it, 'Unit', 'unit') ?? ''];
        const quantity = pickField<number>(it, 'Quantity', 'quantity') ?? 0;
        if (cat && quantity > 0) tokens[cat] = (tokens[cat] ?? 0) + quantity;
      }
      const durationMs =
        pickField<number>(billing, 'DurationMsec', 'duration_msec') ?? 0;
      return { type: 'usage', tokens, durationMs };
    }
    default:
      return null;
  }
};
