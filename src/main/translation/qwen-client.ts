/**
 * WebSocket transport for 通义千问 qwen3.8-livetranslate-flash-realtime
 * (阿里百炼 / DashScope).
 *
 * Wire format:
 *   - JSON-over-WebSocket. Each message is a JSON-encoded object with a
 *     `type` discriminator (`session.update`, `input_audio_buffer.append`,
 *     `response.audio.delta`, …). Auth lives in the WS handshake header
 *     `Authorization: Bearer <DASHSCOPE_API_KEY>`.
 *   - Endpoint (北京 region — the API key must belong to it):
 *     wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3.8-livetranslate-flash-realtime
 *     when the user configured a 业务空间 ID (the host the 3.8 docs give);
 *     otherwise the legacy shared host wss://dashscope.aliyuncs.com/….
 *
 * Lifecycle:
 *   client → session.update                    (configure: target language + voice)
 *   client ← session.created                   (socket session exists)
 *   client ← session.updated                   ← MUST WAIT before sending audio
 *   client → input_audio_buffer.append * N     (base64 PCM 16k mono LE)
 *   client ← input_audio_buffer.speech_started  (item_id + speaker_id: who is talking)
 *   client ← conversation.item.input_audio_transcription.delta      (source, incremental per item_id)
 *   client ← conversation.item.input_audio_transcription.completed  (source final via `transcript`)
 *   client ← response.created
 *   client ← response.audio_transcript.delta   (translation, incremental; `response.text.delta` when text-only)
 *   client ← response.audio.delta              (base64 PCM 24k mono LE)
 *   client ← response.done                     (one translation finished)
 *   client → session.finish                    (flush trailing utterance)
 *   client ← session.finished                  (safe to close)
 *   client ← error                             (terminal failure)
 *
 * What changed from qwen3 / qwen3.5: the source language is auto-detected
 * and always transcribed (no `input_audio_transcription`), modalities moved
 * to `output_modalities`, audio formats are fixed (16k in / 24k out), every
 * streaming text event is an append-only `.delta`, and the 3.8 flow lists
 * no `*.done` transcript events — `response.done` closes the line.
 *
 * Why this lives in the main process: the browser `WebSocket` API does not
 * allow setting custom HTTP headers on the upgrade request (we need the
 * Bearer header). We use Node's `ws` package here and forward audio in /
 * events out via IPC, the same as DoubaoClient.
 *
 * The two-phase start, keepalive, failure convergence and cancel live in
 * `GatedWsSession`, shared with DoubaoClient and OpenAiClient (start gate,
 * cancel-during-start rejection, nothing emitted after cancel(), one
 * terminal event). The owning DirectionSession adds `direction` before
 * forwarding upstream — engine-blind by ADR-0002.
 */
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { QWEN_PRESET_VOICES, type EngineId } from '@shared/engine-types.js';
import type { ProtocolLanguage } from '@shared/ipc-types.js';
import type { TokenCounts } from '@shared/meeting-metrics-types.js';
import { log } from '@core/utils/logger.js';
import { getQwenCredentials } from './credential-vault.js';
import {
  kindFromProviderError,
  MissingCredentialsError,
  type TranslationError
} from './translation-error.js';
import type {
  ClientStartParams,
  QwenStartParams,
  TranslationClient,
  TranslationClientOptions,
  TranslationEventBody
} from './translation-client.js';
import { DEFAULT_WS_TIMING, type WsTiming } from './ws-transport.js';
import { FinalPairing } from './final-pairing.js';
import { GatedWsSession } from './gated-ws-session.js';
import { LIVE_RECONNECT_BUDGET, ReconnectPolicy } from './reconnect-policy.js';
import { Pcm16Carry } from './pcm.js';

export const QWEN_MODEL = 'qwen3.8-livetranslate-flash-realtime';

const positive = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;

/**
 * Token usage of one `response.done` (DashScope reports each response's
 * own, so these are deltas). Breakdowns live under `input_tokens_details` /
 * `output_tokens_details` — plural "tokens", unlike OpenAI. Totals the
 * breakdown doesn't cover go to the dominant modality: input audio, output
 * text.
 */
export const qwenUsageTokens = (usage: unknown): TokenCounts | null => {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const detail = (key: string): Record<string, unknown> => {
    const d = u[key];
    return d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
  };
  const input = detail('input_tokens_details');
  const output = detail('output_tokens_details');
  const inputText = positive(input.text_tokens);
  const outputAudio = positive(output.audio_tokens);
  const inputAudio = positive(input.audio_tokens);
  const outputText = positive(output.text_tokens);
  const tokens: TokenCounts = {};
  const set = (cat: keyof TokenCounts, n: number): void => {
    if (n > 0) tokens[cat] = n;
  };
  set('inputAudio', inputAudio + Math.max(0, positive(u.input_tokens) - inputAudio - inputText));
  set('inputText', inputText);
  set('outputText', outputText + Math.max(0, positive(u.output_tokens) - outputText - outputAudio));
  set('outputAudio', outputAudio);
  return Object.keys(tokens).length > 0 ? tokens : null;
};

/** WS endpoint for the 北京 region: workspace-dedicated host when known. */
export const qwenEndpoint = (workspaceId?: string): string => {
  const host = workspaceId
    ? `${workspaceId}.cn-beijing.maas.aliyuncs.com`
    : 'dashscope.aliyuncs.com';
  return `wss://${host}/api-ws/v1/realtime?model=${QWEN_MODEL}`;
};

/** Fixed by qwen3.8: 16 kHz PCM in, 24 kHz PCM out. */
const QWEN_INPUT_SAMPLE_RATE = 16_000;
const QWEN_OUTPUT_SAMPLE_RATE = 24_000;

/**
 * finish() defers `session.finish` while a response is in flight (sending it
 * mid-response would cut that translation short). Capture has already
 * stopped by then, so if the server never ends the response we must not
 * wait forever: after this long, send `session.finish` anyway. Well under
 * DirectionSession's FINISH_DEADLINE_MS, so the server still gets time to
 * flush before the session gives up on it.
 */
export const QWEN_FINISH_FALLBACK_MS = 3_000;

/** ASR items whose speaker we hold before their transcript arrives. */
const MAX_SPEAKER_ITEMS = 32;

/**
 * Set `QWEN_VERBOSE=1` (or `=2`) to dump every protocol event to the main
 * process log. Level 1 prints non-audio events + per-N audio summaries;
 * level 2 also prints every audio chunk send and audio-delta byte count.
 */
const VERBOSE = (() => {
  const raw = process.env.QWEN_VERBOSE;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 1;
})();

const AUDIO_SUMMARY_INTERVAL = 50;

interface QwenResponseContent {
  transcript?: string;
  text?: string;
}

interface QwenServerEvent {
  type?: string;
  event_id?: string;
  // session.* events
  session?: unknown;
  // error event
  error?: { code?: string | number; message?: string };
  code?: string | number;
  message?: string;
  // conversation.item.input_audio_transcription.* (source item)
  item_id?: string;
  // input_audio_buffer.speech_started, with `speaker_detection` (3.8)
  speaker_id?: number;
  audio_start_ms?: number;
  // conversation.item.created: a translation item links its source item
  item?: { id?: string; role?: string };
  previous_item_id?: string;
  // response.* streaming events
  response_id?: string;
  // *.completed / response.audio_transcript.done
  transcript?: string;
  // response.text.done
  text?: string;
  // *.delta: text fragment (append-only) or base64 audio
  delta?: string;
  // response.created / response.done
  response?: {
    id?: string;
    status?: string;
    output?: { content?: QwenResponseContent[] }[];
    usage?: unknown;
  };
}

export interface QwenClientOptions extends TranslationClientOptions {
  /** Override the WS endpoint; defaults to `qwenEndpoint(workspaceId)`. */
  endpoint?: string;
  /** Override transport timeouts (tests use short ones). */
  timing?: Partial<WsTiming> & { finishFallbackMs?: number };
}

export class QwenClient implements TranslationClient {
  readonly engineId: EngineId = 'qwen';
  readonly inputSampleRate = QWEN_INPUT_SAMPLE_RATE;
  readonly outputSampleRate = QWEN_OUTPUT_SAMPLE_RATE;

  private readonly session: GatedWsSession;
  private params: QwenStartParams | null = null;
  private startedAt = 0;

  /** True between source-subtitle-start and the matching final. */
  private sourceUtteranceOpen = false;
  private sourceStartMs = 0;
  /** ASR item the open source line belongs to. */
  private sourceItemId = '';
  /** Item whose line was last closed — its late `completed` is dropped. */
  private closedSourceItemId = '';
  private sourceText = '';
  /**
   * Speaker of each ASR item, from `speech_started` (3.8's default
   * `speaker_detection`). An entry goes once its line closes; capped so
   * items that never get a transcript can't pile up.
   */
  private readonly speakerByItem = new Map<string, number>();
  /**
   * Raw `speaker_id` → 1, 2, … in order of first appearance. Raw ids are
   * per connection; numbers aren't, so a reconnect never reuses one.
   */
  private readonly speakerNumbers = new Map<number, number>();
  private speakersNumbered = 0;
  /** Speaker of the last source line opened, for `speakerChanged`. */
  private lastSourceSpeaker: number | undefined;

  /** True between translation-subtitle-start and the matching final. */
  private translationUtteranceOpen = false;
  private translationStartMs = 0;
  /** Response the open translation line belongs to ('' if unknown). */
  private translationResponseId = '';
  private translationText = '';
  /**
   * Finals emitted per side, pads included; every event goes out through it
   * (`dispatch`). The session ends with both sides even (`closeOpenLines`).
   */
  private readonly pairing = new FinalPairing();
  /** True between tts-sentence-start and tts-sentence-end. */
  private ttsOpen = false;
  /** The current response's audio, kept on whole samples. */
  private readonly pcm = new Pcm16Carry();
  private finishSent = false;
  private responseActive = false;

  private finishFallbackTimer: NodeJS.Timeout | null = null;

  /**
   * Client event ids: a per-session random prefix + counter. Cheaper than a
   * randomUUID() per audio chunk while staying unique for server-side log
   * correlation (the DashScope client-event doc doesn't list `event_id` as a
   * field at all, only shows it in examples).
   */
  private eventIdPrefix = '';
  private eventSeq = 0;

  // Verbose-mode counters.
  private audioSendCount = 0;
  private audioSendBytes = 0;
  private audioDeltaBytes = 0;

  private readonly logTag: string;
  private readonly endpointOverride: string | undefined;
  private readonly finishFallbackMs: number;

  constructor(opts: QwenClientOptions) {
    this.logTag = opts.tag ?? '';
    this.endpointOverride = opts.endpoint;
    const { finishFallbackMs, ...timing } = opts.timing ?? {};
    this.finishFallbackMs = finishFallbackMs ?? QWEN_FINISH_FALLBACK_MS;
    this.session = new GatedWsSession({
      provider: 'qwen',
      label: 'Qwen',
      readyEvent: 'session.updated',
      configureFrame: 'session.update',
      timing: { ...DEFAULT_WS_TIMING, ...timing },
      tag: () => this.tag(),
      onEvent: opts.onEvent,
      onTelemetry: opts.onTelemetry,
      reconnect: new ReconnectPolicy(LIVE_RECONNECT_BUDGET),
      hooks: {
        configure: (ws) => this.sendSessionUpdate(ws),
        onMessage: (data) => this.handleFrame(data),
        flush: () => this.closeOpenLines(),
        onEnd: () => this.clearFinishFallback(),
        onLinkLost: () => {
          this.closeOpenLines();
          // The new server session numbers its speakers afresh: an old raw
          // id would pin a new voice on someone already numbered.
          this.speakerByItem.clear();
          this.speakerNumbers.clear();
        }
      }
    });
  }

  /**
   * Open the WS, send `session.update`, and resolve only after the server
   * acks with `session.updated`. `session.created` only proves that the
   * socket session exists; `session.updated` proves our translation/voice
   * config has been accepted.
   */
  async start(params: ClientStartParams): Promise<void> {
    if (params.engineId !== 'qwen') {
      throw new Error(
        `QwenClient received non-qwen params (engineId=${params.engineId})`
      );
    }
    this.session.claim();
    const creds = getQwenCredentials();
    if (!creds) throw new MissingCredentialsError('qwen');

    this.params = params;
    this.startedAt = Date.now();
    this.eventIdPrefix = `event_${randomUUID().slice(0, 8)}_`;
    await this.session.open({
      url: this.endpointOverride ?? qwenEndpoint(creds.workspaceId),
      headers: { Authorization: `Bearer ${creds.apiKey}` }
    });
  }

  /** Send a chunk of 16 kHz / 16-bit / mono / little-endian PCM audio. */
  async sendAudio(pcm: Uint8Array): Promise<void> {
    // Audio appended after finish() would race the server's flush: the
    // session stops admitting it once finish() ran.
    if (!this.session.admitAudio()) return;
    const ws = this.session.audioSocket();
    if (!ws) return;
    const audioB64 = Buffer.from(
      pcm.buffer,
      pcm.byteOffset,
      pcm.byteLength
    ).toString('base64');
    // Hand-built JSON: base64 and our event id contain no characters that
    // need escaping, so JSON.stringify would only re-scan ~3.4 KB per chunk.
    ws.send(
      `{"event_id":"${this.nextEventId()}","type":"input_audio_buffer.append","audio":"${audioB64}"}`
    );

    if (VERBOSE) {
      this.audioSendCount++;
      this.audioSendBytes += pcm.byteLength;
      if (VERBOSE >= 2) {
        log.info(
          `${this.tag()} → input_audio_buffer.append (#${this.audioSendCount}, ${pcm.byteLength}B)`
        );
      } else if (this.audioSendCount % AUDIO_SUMMARY_INTERVAL === 0) {
        log.info(
          `${this.tag()} → input_audio x${this.audioSendCount} so far (${this.audioSendBytes}B total)`
        );
      }
    }
  }

  /**
   * Graceful end-of-stream. `session.finish` asks Qwen to flush any detected
   * speech; the server sends final ASR/translation events and then
   * `session.finished`. Only that server terminal event moves DirectionSession
   * back to idle, so trailing subtitles/TTS are still accepted.
   */
  async finish(): Promise<void> {
    if (!this.session.beginFinish()) return;
    if (this.responseActive) {
      if (VERBOSE) {
        log.info(
          `${this.tag()} → finish requested; deferring session.finish until current response.done (≤${this.finishFallbackMs}ms)`
        );
      }
      this.finishFallbackTimer = setTimeout(() => {
        this.finishFallbackTimer = null;
        if (this.finishSent || this.session.isEnded) return;
        log.warn(
          `${this.tag()} no response.done within ${this.finishFallbackMs}ms of finish(); sending session.finish anyway`
        );
        this.sendSessionFinish();
      }, this.finishFallbackMs);
      return;
    }
    this.sendSessionFinish();
  }

  /** Sends `session.finish` at most once per session. */
  private sendSessionFinish(): void {
    this.clearFinishFallback();
    if (this.finishSent || !this.session.isOpen) return;
    this.finishSent = true;
    if (VERBOSE) {
      log.info(
        `${this.tag()} → session.finish (waiting for trailing response/session.finished; sent ${this.audioSendCount} audio chunks, ${this.audioSendBytes}B)`
      );
    }
    if (!this.session.sendControl(this.clientEvent('session.finish'), 'session.finish')) {
      this.session.fail(this.session.error('network', 'failed to send session.finish'));
    }
  }

  /**
   * Drop the session. Safe at any state, including mid-start; idempotent;
   * emits nothing. If start() is still awaiting the session-ready gate, it
   * rejects so the caller's start checkpoint can run its
   * cancel-during-connect branch. Qwen has no cancel event (integration doc
   * D9), so this is a plain close.
   */
  async cancel(): Promise<void> {
    this.session.cancel();
  }

  // -------------------------------------------------------------------------

  private tag(): string {
    return this.logTag ? `Qwen[${this.logTag}]` : 'Qwen[]';
  }

  private nextEventId(): string {
    this.eventSeq += 1;
    return `${this.eventIdPrefix}${this.eventSeq}`;
  }

  private clientEvent(type: string): string {
    return JSON.stringify({ event_id: this.nextEventId(), type });
  }

  private clearFinishFallback(): void {
    if (this.finishFallbackTimer) {
      clearTimeout(this.finishFallbackTimer);
      this.finishFallbackTimer = null;
    }
  }

  /** `configure` hook: session.update with the target language and voice. */
  private sendSessionUpdate(ws: WebSocket): void {
    const params = this.params;
    if (!params) throw new Error('no start params');
    ws.send(JSON.stringify(this.buildSessionUpdate(params)));

    if (VERBOSE) {
      log.info(
        `${this.tag()} → session.update`,
        JSON.stringify({
          mode: params.mode,
          tgt: params.targetLanguage,
          voice: params.voiceClone ? `clone:${params.voiceClone}` : params.voice
        })
      );
    }
  }

  /**
   * qwen3.8 shape. No source language (auto-detected) and no
   * `input_audio_transcription` (source ASR is always on). Turn detection
   * is set explicitly: the docs call `speaker_detection` the default, but
   * the server starts sessions on `server_vad`, which sends no speaker ids.
   */
  private buildSessionUpdate(params: QwenStartParams): unknown {
    const s2s = params.mode === 's2s';
    const session: Record<string, unknown> = {
      output_modalities: s2s ? ['text', 'audio'] : ['text'],
      translation: {
        language: this.toQwenLang(params.targetLanguage)
      },
      // The threshold is fixed at 0.5 for this type; sent as the docs show it.
      turn_detection: { type: 'speaker_detection', threshold: 0.5 }
    };
    if (s2s && params.voiceClone) {
      // With once/always the server rejects any voice but "default", which
      // is also what it speaks with until the clone is ready.
      session.voice = 'default';
      session.enable_voice_clone = true;
      session.voice_clone_options = { frequency: params.voiceClone };
    } else {
      // Named even when nothing is spoken (s2t): left out, the server fills
      // in its own default, Chelsie — a qwen3 voice 3.8 rejects — and fails
      // the first response on it ("Voice 'Chelsie' is not supported").
      session.voice = params.voice ?? QWEN_PRESET_VOICES[0];
    }
    return {
      event_id: this.nextEventId(),
      type: 'session.update',
      session
    };
  }

  /**
   * Pass-through today: ProtocolLanguage's 8 codes (zh/en/ja/id/es/pt/de/fr)
   * are all valid Qwen language codes per the API doc. Kept as a method so
   * future codepoints (yue / ko / ru / …) get a single mapping site.
   */
  private toQwenLang(lang: ProtocolLanguage): string {
    return lang;
  }

  private handleFrame(data: Buffer): void {
    let event: QwenServerEvent;
    try {
      event = JSON.parse(data.toString('utf8')) as QwenServerEvent;
    } catch (err) {
      log.error('Failed to parse Qwen JSON frame:', err);
      return;
    }

    const type = event.type ?? '';

    if (VERBOSE) this.logIncomingEvent(type, event);

    switch (type) {
      // -- lifecycle -------------------------------------------------------
      case 'session.created':
        // Informational only: wait for session.updated before sending audio
        // so our translation/voice config is definitely active.
        break;
      case 'session.updated':
        this.session.markReady();
        break;
      case 'session.finished':
        this.session.complete('server finished');
        break;
      case 'error':
        this.session.fail(this.serverError(event));
        break;

      // -- source language transcription ----------------------------------
      case 'input_audio_buffer.speech_started':
        // Comes before the item's first transcript delta.
        if (event.item_id && typeof event.speaker_id === 'number') {
          this.noteSpeaker(event.item_id, event.speaker_id);
        }
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        if (!event.delta) break;
        const itemId = event.item_id ?? '';
        if (this.sourceUtteranceOpen && itemId !== this.sourceItemId) {
          // The previous item's `completed` hasn't come yet. Deltas are
          // append-only, so what we hold already is its transcript.
          this.emitSourceFinal(this.sourceText);
        }
        if (!this.sourceUtteranceOpen) {
          this.sourceUtteranceOpen = true;
          this.sourceItemId = itemId;
          this.sourceText = '';
          this.sourceStartMs = this.now();
          this.dispatch(this.sourceStart(this.sourceStartMs));
        }
        this.sourceText += event.delta;
        this.dispatch({ type: 'source-subtitle-delta', text: this.sourceText });
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const itemId = event.item_id ?? '';
        // Already closed early by the next item's first delta.
        if (itemId && itemId === this.closedSourceItemId) break;
        if (this.sourceUtteranceOpen && itemId && itemId !== this.sourceItemId) {
          break;
        }
        // Fall back to the accumulated deltas so a final never blanks the line.
        const text = event.transcript || this.sourceText;
        if (!text && !this.sourceUtteranceOpen) break;
        this.sourceItemId = itemId;
        this.emitSourceFinal(text);
        break;
      }
      case 'conversation.item.input_audio_transcription.failed':
        if (
          this.sourceUtteranceOpen &&
          (event.item_id ?? '') === this.sourceItemId
        ) {
          this.emitSourceFinal(this.sourceText);
        }
        break;

      // -- translation -----------------------------------------------------
      case 'response.created':
        this.responseActive = true;
        this.beginTranslation(event.response?.id ?? '');
        break;
      case 'response.audio_transcript.delta':
      case 'response.text.delta': {
        if (!event.delta) break;
        this.responseActive = true;
        const responseId = event.response_id ?? this.translationResponseId;
        if (
          !this.translationUtteranceOpen ||
          (responseId && responseId !== this.translationResponseId)
        ) {
          this.beginTranslation(responseId);
        }
        this.translationText += event.delta;
        this.dispatch({
          type: 'translation-subtitle-delta',
          text: this.translationText
        });
        break;
      }
      // Not in the 3.8 interaction flow but still in the event reference;
      // if they come, they carry the authoritative text. Audio mode puts it
      // in `transcript`, text-only mode in `text`.
      case 'response.audio_transcript.done':
      case 'response.text.done': {
        // A late `.done` for a response whose line was already replaced.
        if (
          event.response_id &&
          this.translationResponseId &&
          event.response_id !== this.translationResponseId
        ) {
          break;
        }
        const text =
          event.transcript || event.text || this.translationText;
        if (this.translationUtteranceOpen || text) {
          this.emitTranslationFinal(text);
        }
        break;
      }

      // -- TTS audio -------------------------------------------------------
      case 'response.audio.delta': {
        const data = this.decodeAudioDelta(event.delta);
        if (!data) break;
        this.responseActive = true;
        if (!this.ttsOpen) {
          this.ttsOpen = true;
          this.dispatch({ type: 'tts-sentence-start', startMs: this.now() });
        }
        this.audioDeltaBytes += data.byteLength;
        this.dispatch({ type: 'tts-audio', data });
        break;
      }
      case 'response.audio.done':
        this.closeTts();
        break;

      case 'response.done': {
        const tokens = qwenUsageTokens(event.response?.usage);
        if (tokens) this.session.telemetry({ type: 'usage', tokens });
        if (this.translationUtteranceOpen) {
          this.emitTranslationFinal(
            this.translationText || this.responseOutputText(event)
          );
        }
        this.closeTts();
        this.responseActive = false;
        const status = event.response?.status;
        if (status && status !== 'completed') {
          log.warn(`${this.tag()} response ended with status=${status}`);
        }
        if (this.session.isFinishing && !this.finishSent) {
          this.sendSessionFinish();
        }
        break;
      }

      default:
        // Unknown event type (speech_stopped, conversation.item.*,
        // response.output_item.*, …): ignore. Future Qwen events surface
        // here for log triage rather than crashing.
        break;
    }
  }

  /**
   * `flush` hook: the server flushed (session.finished, or a clean close
   * after finish()). Close anything it left open so the renderer never keeps
   * a dangling line, and leave both final queues even.
   */
  private closeOpenLines(): void {
    if (this.sourceUtteranceOpen) this.emitSourceFinal(this.sourceText);
    if (this.translationUtteranceOpen) {
      this.emitTranslationFinal(this.translationText);
    }
    while (this.pairing.behind('source') > 0) this.padFinal('source');
    while (this.pairing.behind('translation') > 0) this.padFinal('translation');
    this.closeTts();
    this.responseActive = false;
  }

  /**
   * An empty final on one side, so the renderer's FIFO pairing stays
   * aligned (TranscriptSegmenter does the same). Leaves the open line, if
   * any, untouched: it belongs to a later row.
   */
  private padFinal(kind: 'source' | 'translation'): void {
    const at = this.now();
    if (kind === 'source') {
      this.dispatch({ type: 'source-subtitle-start', startMs: at, speakerChanged: false });
      this.dispatch({ type: 'source-subtitle-final', text: '', startMs: at, endMs: at });
    } else {
      this.dispatch({ type: 'translation-subtitle-start', startMs: at, speakerChanged: false });
      this.dispatch({ type: 'translation-subtitle-final', text: '', startMs: at, endMs: at });
    }
  }

  private emitSourceFinal(text: string): void {
    const startMs = this.sourceUtteranceOpen ? this.sourceStartMs : this.now();
    if (!this.sourceUtteranceOpen) {
      // Server skipped emitting any delta — synthesize a start so the
      // renderer's state machine sees a consistent open/close.
      this.dispatch(this.sourceStart(startMs));
    }
    const speaker = this.speakerByItem.get(this.sourceItemId);
    this.dispatch({
      type: 'source-subtitle-final',
      text,
      startMs,
      endMs: this.now(),
      ...(speaker === undefined ? {} : { speaker })
    });
    this.speakerByItem.delete(this.sourceItemId);
    this.closedSourceItemId = this.sourceItemId;
    this.sourceUtteranceOpen = false;
    this.sourceItemId = '';
    this.sourceText = '';
  }

  /** `source-subtitle-start` for the item in `sourceItemId`, with its speaker. */
  private sourceStart(startMs: number): TranslationEventBody {
    const speaker = this.speakerByItem.get(this.sourceItemId);
    const previous = this.lastSourceSpeaker;
    if (speaker !== undefined) this.lastSourceSpeaker = speaker;
    return {
      type: 'source-subtitle-start',
      startMs,
      speakerChanged: speaker !== undefined && previous !== undefined && speaker !== previous,
      ...(speaker === undefined ? {} : { speaker })
    };
  }

  private noteSpeaker(itemId: string, rawId: number): void {
    let speaker = this.speakerNumbers.get(rawId);
    if (speaker === undefined) {
      speaker = ++this.speakersNumbered;
      this.speakerNumbers.set(rawId, speaker);
    }
    this.speakerByItem.set(itemId, speaker);
    if (this.speakerByItem.size > MAX_SPEAKER_ITEMS) {
      // Maps iterate in insertion order: this is the oldest item.
      this.speakerByItem.delete(this.speakerByItem.keys().next().value!);
    }
  }

  /** Open the translation line for `responseId`, closing any other first. */
  private beginTranslation(responseId: string): void {
    if (this.translationUtteranceOpen) {
      if (responseId === this.translationResponseId) return;
      this.emitTranslationFinal(this.translationText);
    }
    this.translationUtteranceOpen = true;
    this.translationResponseId = responseId;
    this.translationText = '';
    this.translationStartMs = this.now();
    this.dispatch({
      type: 'translation-subtitle-start',
      startMs: this.translationStartMs,
      speakerChanged: false
    });
  }

  private emitTranslationFinal(text: string): void {
    const startMs = this.translationUtteranceOpen
      ? this.translationStartMs
      : this.now();
    if (!this.translationUtteranceOpen) {
      this.dispatch({
        type: 'translation-subtitle-start',
        startMs,
        speakerChanged: false
      });
    }
    this.dispatch({
      type: 'translation-subtitle-final',
      text,
      startMs,
      endMs: this.now()
    });
    this.translationUtteranceOpen = false;
    this.translationResponseId = '';
    this.translationText = '';
  }

  private closeTts(): void {
    // A stray byte dies with its response's audio stream.
    this.pcm.reset();
    if (!this.ttsOpen) return;
    this.ttsOpen = false;
    this.dispatch({ type: 'tts-sentence-end', endMs: this.now() });
    this.audioDeltaBytes = 0;
  }

  /** Translation text carried in `response.done`'s output items, if any. */
  private responseOutputText(event: QwenServerEvent): string {
    return (event.response?.output ?? [])
      .flatMap((item) => item.content ?? [])
      .map((c) => c.transcript ?? c.text ?? '')
      .join('');
  }

  /**
   * Decode base64 PCM straight into a fresh, exactly-sized ArrayBuffer — one
   * copy instead of `Buffer.from(b64)` + copy-out, and never a slice of
   * Node's shared pool slab. Kept on whole samples: an odd byte waits for
   * the next delta (see Pcm16Carry).
   */
  private decodeAudioDelta(b64: string | undefined): ArrayBuffer | null {
    if (!b64) return null;
    return this.pcm.fromBase64(b64);
  }


  private logIncomingEvent(type: string, event: QwenServerEvent): void {
    const tag = this.tag();
    switch (type) {
      case 'session.created':
      case 'session.updated':
        log.info(`${tag} ← ${type} ${JSON.stringify(event.session ?? {})}`);
        return;
      case 'session.finished':
      case 'response.created':
        log.info(`${tag} ← ${type}`);
        return;
      case 'response.done':
        log.info(
          `${tag} ← ${type} status=${event.response?.status ?? '?'} audio=${this.audioDeltaBytes}B (~${Math.round((this.audioDeltaBytes / 2 / QWEN_OUTPUT_SAMPLE_RATE) * 1000)}ms)`
        );
        return;
      case 'conversation.item.input_audio_transcription.completed':
        log.info(`${tag} ← ${type} transcript="${event.transcript ?? ''}"`);
        return;
      case 'response.audio_transcript.done':
      case 'response.text.done':
        log.info(
          `${tag} ← ${type} transcript="${event.transcript ?? event.text ?? ''}"`
        );
        return;
      case 'conversation.item.input_audio_transcription.delta':
      case 'response.audio_transcript.delta':
      case 'response.text.delta':
        if (VERBOSE >= 2) {
          log.info(`${tag} ← ${type} delta="${event.delta ?? ''}"`);
        }
        return;
      case 'response.audio.delta':
        if (VERBOSE >= 2) {
          const len = event.delta ? Buffer.byteLength(event.delta, 'base64') : 0;
          log.info(`${tag} ← ${type} (${len}B)`);
        }
        return;
      case 'error':
        log.info(
          `${tag} ← error code=${event.error?.code ?? event.code ?? '?'} message="${event.error?.message ?? event.message ?? ''}"`
        );
        return;
      case 'input_audio_buffer.speech_started':
        // Whole event: small, and where the speaker field would show up.
        log.info(`${tag} ← ${type} ${JSON.stringify(event)}`);
        return;
      case 'conversation.item.created':
        log.info(
          `${tag} ← ${type} item=${event.item?.id ?? '?'} role=${event.item?.role ?? '?'} previous=${event.previous_item_id ?? '-'}`
        );
        return;
      default:
        log.info(`${tag} ← ${type}`);
    }
  }

  private dispatch(event: TranslationEventBody): void {
    if (this.pairing.pass(event)) this.session.emit(event);
  }

  private now(): number {
    return Date.now() - this.startedAt;
  }

  /**
   * An `error` event. DashScope codes are mostly strings
   * ("invalid_request_error", "InvalidApiKey", "Arrearage", "Throttling…"):
   * they and the message decide the kind; anything unrecognised is a
   * request the server refused. A numeric code also becomes the
   * session-failed `code`.
   */
  private serverError(event: QwenServerEvent): TranslationError {
    const code = event.code ?? event.error?.code;
    const message = event.error?.message ?? event.message ?? 'qwen error';
    return this.session.error(kindFromProviderError(code, message, 'protocol'), message, {
      providerCode: code
    });
  }
}
