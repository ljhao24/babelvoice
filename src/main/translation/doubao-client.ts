/**
 * WebSocket transport for Volcengine LiveInterpret 2.0 (豆包同传).
 *
 * Wire format (verified against the official `ast_python_client` /
 * `ast_java_client` demos and the API doc):
 *   - Each WS binary frame **is** one serialized
 *     `data.speech.ast.TranslateRequest` or `TranslateResponse` protobuf.
 *     There is no custom framing, no header magic, no length prefix.
 *   - Auth lives in the WebSocket handshake HTTP headers
 *     (X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id / X-Api-Connect-Id).
 *   - SessionID lives inside the protobuf at `request_meta.SessionID`
 *     (PascalCase preserved — proto-loader uses `keepCase: true`).
 *
 * Lifecycle (per the doc):
 *   client → StartSession (event 100)
 *   client ← SessionStarted (event 150)   ← MUST WAIT before sending audio
 *   client → TaskRequest * N (event 200)
 *   client → FinishSession (102) or CancelSession (101)
 *   client ← SourceSubtitle* / TranslationSubtitle* / TTS* / AudioMuted / UsageResponse
 *   client ← SessionFinished (152) or SessionCanceled (151) or SessionFailed (153)
 *
 * Why this lives in the main process: the browser `WebSocket` API does not
 * allow setting custom HTTP headers on the upgrade request, so the renderer
 * cannot do this directly. We use Node's `ws` package here and forward audio
 * in / events out via IPC.
 *
 * Wire-format encode/decode lives in `doubao-codec.ts`; the two-phase start,
 * keepalive, failure convergence and cancel live in `GatedWsSession` (shared
 * with QwenClient and OpenAiClient, and the source of the terminal-state
 * rules — ADR-0002). This file is the protocol: the StartSession /
 * SessionStarted gate, the CancelSession handshake, and routing of decoded
 * frames into undirected `TranslationEventBody`s; the owning
 * DirectionSession adds `direction`.
 */
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { ProtoEvent } from '@shared/proto-events.js';
import type { EngineId } from '@shared/engine-types.js';
import type { TranslationErrorKind } from '@shared/translation-error-types.js';
import { log } from '@core/utils/logger.js';
import { getDoubaoCredentials } from './credential-vault.js';
import {
  hintedKind,
  MissingCredentialsError,
  type TranslationError
} from './translation-error.js';
import type {
  ClientStartParams,
  DoubaoStartParams,
  TranslationClient,
  TranslationClientOptions,
  TranslationEventBody
} from './translation-client.js';
import {
  decodeFrame,
  encodeCancelSession,
  encodeFinishSession,
  encodeStartSession,
  encodeTaskRequest,
  encodeUpdateConfig,
  initDoubaoCodec,
  type CorpusInput,
  type DecodedFrame,
  type DoubaoFrameBody,
  type DoubaoTargetAudio
} from './doubao-codec.js';
import { closeSocket, DEFAULT_WS_TIMING, type WsTiming } from './ws-transport.js';
import { FinalPairing } from './final-pairing.js';
import { GatedWsSession } from './gated-ws-session.js';
import { LIVE_RECONNECT_BUDGET, ReconnectPolicy } from './reconnect-policy.js';
import { Pcm16Carry } from './pcm.js';
import { DoubaoUsageTracker } from './doubao-usage.js';

const DEFAULT_ENDPOINT =
  'wss://openspeech.bytedance.com/api/v4/ast/v2/translate';

const CANCEL_GRACE_MS = 1500;

/**
 * Doubao server's TTS output. Not user-tunable.
 *
 * Do NOT bump `rate` to 24 kHz on its own: per the API doc (target_audio),
 * `pcm` is 16-bit int at 16 kHz but **32-bit float** at 24 kHz. The native
 * TTS sink and the renderer both parse this stream as int16 LE, so 24 kHz
 * would play as noise until every consumer learns float32 (or we convert
 * here). `outputSampleRate` below follows this constant.
 */
const DOUBAO_TARGET_AUDIO: DoubaoTargetAudio = { format: 'pcm', rate: 16_000 };

/**
 * Set `DOUBAO_VERBOSE=1` (or `=2`) to dump every protocol event to the main
 * process log. Level 1 prints all non-audio events + per-N audio summaries.
 * Level 2 also prints every TaskRequest send and TTSResponse byte count.
 */
const VERBOSE = (() => {
  const raw = process.env.DOUBAO_VERBOSE;
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 1;
})();

const TASK_REQUEST_SUMMARY_INTERVAL = 50;

/**
 * Kind of a Doubao business status code (API doc 错误码): 45000081 等包超时
 * is a timeout, 550xxxxx (55000031 服务器繁忙 included) the service's own
 * failure, any other 4500xxxx a request it refused (45000001 bad params,
 * 45000002 empty audio, 45000151 bad audio format). Auth and quota are
 * normally refused at the upgrade (HTTP 401/403/429); the message text
 * catches them when they come as a frame.
 */
export const doubaoErrorKind = (
  statusCode: number,
  message: string
): TranslationErrorKind => {
  if (statusCode === 45_000_081) return 'timeout';
  if (statusCode >= 55_000_000 && statusCode < 56_000_000) return 'server';
  const hinted = hintedKind(message);
  if (hinted) return hinted;
  return statusCode >= 45_000_000 && statusCode < 46_000_000 ? 'protocol' : 'unknown';
};

/** A subtitle line the server opened and hasn't closed yet. */
interface OpenLine {
  startMs: number;
  /** The latest delta: what the renderer shows for the line. */
  text: string;
}

export interface DoubaoClientOptions extends TranslationClientOptions {
  /** Override the WS endpoint; defaults to the production Volcengine URL. */
  endpoint?: string;
  /** Override transport timeouts (tests use short ones). */
  timing?: Partial<WsTiming>;
}

export class DoubaoClient implements TranslationClient {
  readonly engineId: EngineId = 'doubao';
  /** Matches `source_audio.rate` in the StartSession frame (doubao-codec). */
  readonly inputSampleRate = 16_000;
  readonly outputSampleRate = DOUBAO_TARGET_AUDIO.rate;

  private readonly session: GatedWsSession;
  private params: DoubaoStartParams | null = null;
  private sessionId = '';
  private connectId = '';
  /** StartSession went out: there is a server-side session to cancel. */
  private startSent = false;

  /** The current TTS sentence's audio, kept on whole samples. */
  private readonly pcm = new Pcm16Carry();
  /** Per server-side session: a reconnect starts a new one. */
  private usage = new DoubaoUsageTracker();
  /** PCM handed to the server, for the usage tracker's sanity check. */
  private audioSentBytes = 0;

  /**
   * What the server left open, and finals emitted per side (pads included).
   * A dropped connection never closes its lines, and the renderer pairs
   * finals FIFO (`pushFinal` in transcript-assembler.ts), so `closeOpenLines`
   * closes them and evens the sides before the replacement speaks.
   */
  private openSource: OpenLine | null = null;
  private openTranslation: OpenLine | null = null;
  private readonly pairing = new FinalPairing();
  private ttsOpen = false;
  /** Latest server timestamp seen, for the frames closeOpenLines makes up. */
  private lastServerMs = 0;
  private cancelGraceTimer: NodeJS.Timeout | null = null;

  // Verbose-mode counters.
  private taskReqCount = 0;
  private taskReqBytes = 0;
  private ttsBytes = 0;

  private readonly logTag: string;
  private readonly endpoint: string;

  constructor(opts: DoubaoClientOptions) {
    this.logTag = opts.tag ?? '';
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.session = new GatedWsSession({
      provider: 'doubao',
      label: 'Doubao',
      readyEvent: 'SessionStarted',
      configureFrame: 'StartSession',
      timing: { ...DEFAULT_WS_TIMING, ...opts.timing },
      tag: () => this.tag(),
      onEvent: opts.onEvent,
      onTelemetry: opts.onTelemetry,
      // X-Tt-Logid is what Volcengine support asks for.
      traceLabel: 'logid',
      reconnect: new ReconnectPolicy(LIVE_RECONNECT_BUDGET),
      hooks: {
        configure: (ws, { reconnect }) => this.sendStartSession(ws, reconnect),
        onMessage: (data) => this.handleFrame(data),
        onMessageAfterEnd: (data, ws) => this.handleFrameAfterEnd(data, ws),
        // Closed during the cancel grace window: nothing left to wait for.
        onClosedAfterEnd: () => this.clearCancelGrace(),
        onEnd: () => this.clearCancelGrace(),
        closeOnCancel: (ws) => this.cancelServerSession(ws),
        onLinkLost: () => this.closeOpenLines()
      }
    });
  }

  /**
   * Open the WS, send StartSession, and **resolve only after the server
   * replies with SessionStarted**. The doc explicitly requires this gating —
   * sending audio before SessionStarted is undefined behavior.
   */
  async start(params: ClientStartParams): Promise<void> {
    if (params.engineId !== 'doubao') {
      throw new Error(
        `DoubaoClient received non-doubao params (engineId=${params.engineId})`
      );
    }
    this.session.claim();
    const creds = getDoubaoCredentials();
    if (!creds) throw new MissingCredentialsError('doubao');

    this.params = params;
    this.sessionId = randomUUID();
    this.connectId = randomUUID();
    await this.session.open({
      url: this.endpoint,
      headers: {
        'X-Api-App-Key': creds.appKey,
        'X-Api-Access-Key': creds.accessKey,
        'X-Api-Resource-Id': creds.resourceId,
        'X-Api-Connect-Id': this.connectId
      },
      // X-Tt-Logid comes back on the upgrade (or the rejection).
      traceHeader: 'x-tt-logid',
      // Proto load runs concurrently with the handshake; after it resolves
      // the codec is synchronous for the rest of the session.
      alongside: initDoubaoCodec()
    });
  }

  /** Send a chunk of 16 kHz / 16-bit / mono / little-endian PCM audio. */
  async sendAudio(pcm: Uint8Array): Promise<void> {
    // Audio after FinishSession is a protocol error (45000001): the session
    // stops admitting it once finish() ran.
    if (!this.session.admitAudio()) return;
    const ws = this.session.audioSocket();
    if (!ws) return;
    ws.send(encodeTaskRequest(this.sessionId, pcm));
    this.audioSentBytes += pcm.byteLength;

    if (VERBOSE) {
      this.taskReqCount++;
      this.taskReqBytes += pcm.byteLength;
      if (VERBOSE >= 2) {
        log.info(
          `${this.tag()} → TaskRequest (#${this.taskReqCount}, ${pcm.byteLength}B)`
        );
      } else if (this.taskReqCount % TASK_REQUEST_SUMMARY_INTERVAL === 0) {
        log.info(
          `${this.tag()} → TaskRequest x${this.taskReqCount} so far (${this.taskReqBytes}B total)`
        );
      }
    }
  }

  /**
   * Mid-session corpus update (event 201). Not currently wired through IPC,
   * but kept on the class so a future product surface can call it directly.
   * The API doesn't allow switching mode/language mid-session.
   */
  async updateConfig(corpus: CorpusInput): Promise<void> {
    const ws = this.session.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Doubao session not connected');
    }
    ws.send(encodeUpdateConfig(this.sessionId, corpus));
    if (VERBOSE) {
      log.info(`${this.tag()} → UpdateConfig`, JSON.stringify(corpus));
    }
  }

  /**
   * Graceful end-of-stream. Server emits trailing TTS, then SessionFinished.
   * Idempotent: a second FinishSession is a "repeated request" (45000001)
   * that would turn a clean stop into a session-failed.
   */
  async finish(): Promise<void> {
    if (!this.session.beginFinish()) return;
    if (this.session.sendControl(encodeFinishSession(this.sessionId), 'FinishSession') && VERBOSE) {
      log.info(
        `${this.tag()} → FinishSession (sent ${this.taskReqCount} TaskRequests, ${this.taskReqBytes}B audio)`
      );
    }
  }

  /**
   * Drop the session. Safe at any state, including mid-start(); idempotent.
   * Emits nothing (the caller initiated it). If the session is live, send
   * CancelSession (event 101) and give the server a short window to ack with
   * SessionCanceled before closing — the doc's clean-shutdown path.
   */
  async cancel(): Promise<void> {
    this.session.cancel();
  }

  // -------------------------------------------------------------------------

  private tag(): string {
    const head = this.logTag ? `Doubao[${this.logTag}` : 'Doubao[';
    return `${head}/${this.sessionId.slice(0, 8)}]`;
  }

  /**
   * `configure` hook: the session's first frame. A replacement connection
   * starts a new server-side session — its own SessionID, and usage reports
   * that count from zero again.
   */
  private sendStartSession(ws: WebSocket, reconnect: boolean): void {
    const params = this.params;
    if (!params) throw new Error('no start params');
    if (reconnect) {
      this.sessionId = randomUUID();
      this.usage = new DoubaoUsageTracker();
      this.audioSentBytes = 0;
    }
    ws.send(
      encodeStartSession(this.sessionId, this.connectId, params, DOUBAO_TARGET_AUDIO)
    );
    this.startSent = true;

    if (VERBOSE) {
      log.info(
        `${this.tag()} → StartSession`,
        JSON.stringify({
          mode: params.mode,
          src: params.sourceLanguage,
          tgt: params.targetLanguage,
          speaker: params.speakerId,
          // Not on the wire — see buildReqParams in doubao-codec.ts.
          speech_rate_unsent: params.speechRate,
          denoise: params.denoise,
          out: DOUBAO_TARGET_AUDIO,
          corpus: params.corpus
        })
      );
    }
  }

  /**
   * `closeOnCancel` hook: with a server-side session open, send
   * CancelSession and hold the socket briefly for SessionCanceled.
   */
  private cancelServerSession(ws: WebSocket): boolean {
    // No server-side session yet, nothing to cancel.
    if (!this.startSent) return false;
    try {
      ws.send(encodeCancelSession(this.sessionId));
      if (VERBOSE) log.info(`${this.tag()} → CancelSession`);
    } catch (err) {
      log.warn('Failed to send CancelSession:', err);
    }
    // Closed early by handleFrameAfterEnd if SessionCanceled arrives first.
    this.cancelGraceTimer = setTimeout(() => {
      this.cancelGraceTimer = null;
      closeSocket(ws, 1000, 'client cancel');
    }, CANCEL_GRACE_MS);
    return true;
  }

  private clearCancelGrace(): void {
    if (this.cancelGraceTimer) {
      clearTimeout(this.cancelGraceTimer);
      this.cancelGraceTimer = null;
    }
  }

  private decode(data: Buffer): DecodedFrame | null {
    try {
      return decodeFrame(data);
    } catch (err) {
      log.error('Failed to decode TranslateResponse:', err);
      return null;
    }
  }

  private handleFrame(data: Buffer): void {
    const frame = this.decode(data);
    if (!frame) return;
    const session = this.session;

    // Treat non-success status as a failure — except for terminal session
    // events, which may carry a non-zero code with their own semantics.
    // Before SessionStarted this rejects start() (with code + logid) instead
    // of emitting an event nobody is listening for yet.
    if (
      !frame.isSuccessStatus &&
      frame.event !== ProtoEvent.SessionFailed &&
      frame.event !== ProtoEvent.SessionCanceled
    ) {
      session.fail(this.frameError(frame, 'unknown error'));
      return;
    }

    if (VERBOSE) this.logIncomingFrame(frame);

    switch (frame.event) {
      case ProtoEvent.SessionStarted:
        session.markReady();
        break;
      case ProtoEvent.SessionFinished:
        session.complete('server finished');
        break;
      case ProtoEvent.SessionCanceled:
        // Server-side cancel the client didn't ask for (frames after a
        // client cancel go to handleFrameAfterEnd) — surface as a clean
        // finish so the UI doesn't show an error toast.
        if (!session.isReady) {
          session.fail(this.frameError(frame, 'session canceled by server'));
          break;
        }
        session.complete('server canceled');
        break;
      case ProtoEvent.SessionFailed:
        session.fail(this.frameError(frame, 'session failed'));
        break;
      default:
        if (frame.body) this.dispatchBody(frame.body);
    }
  }

  /** A failure a server frame reported, classified by its status code. */
  private frameError(frame: DecodedFrame, fallbackMessage: string): TranslationError {
    const message = frame.message || fallbackMessage;
    return this.session.error(doubaoErrorKind(frame.statusCode, message), message, {
      providerCode: frame.statusCode
    });
  }

  /**
   * Terminal already. After a client cancel the socket is held open only to
   * receive the ack; once it (or any terminal frame) arrives there's nothing
   * left to wait for. Never dispatches.
   */
  private handleFrameAfterEnd(data: Buffer, ws: WebSocket): void {
    if (!this.session.isCancelled) return;
    const frame = this.decode(data);
    if (
      frame &&
      (frame.event === ProtoEvent.SessionCanceled ||
        frame.event === ProtoEvent.SessionFinished ||
        frame.event === ProtoEvent.SessionFailed)
    ) {
      if (VERBOSE) log.info(`${this.tag()} ← ${frame.eventLabel} (after cancel)`);
      // `ws` is the socket that delivered the ack: the session let go of it.
      this.clearCancelGrace();
      closeSocket(ws, 1000, 'client cancel');
    }
  }

  /** Business events; TTS audio is kept on whole samples (see Pcm16Carry). */
  private dispatchBody(body: DoubaoFrameBody): void {
    if (body.type === 'usage') {
      const wasCumulative = this.usage.cumulative;
      const tokens = this.usage.report(
        body.tokens,
        body.durationMs,
        (this.audioSentBytes / 2 / this.inputSampleRate) * 1000
      );
      if (this.usage.cumulative && !wasCumulative) {
        log.warn(`${this.tag()} UsageResponse reports running totals; differencing from now on`);
      }
      if (tokens) this.session.telemetry({ type: 'usage', tokens });
      return;
    }
    if (body.type === 'tts-audio') {
      const data = this.pcm.align(body.data);
      if (data) this.session.emit({ type: 'tts-audio', data });
      return;
    }
    // A stray byte dies with its sentence's audio stream.
    if (body.type === 'tts-sentence-end') this.pcm.reset();
    this.noteOpen(body);
    if (this.pairing.pass(body)) this.session.emit(body);
  }

  /** Follow which lines and TTS sentence the server has open. */
  private noteOpen(body: DoubaoFrameBody): void {
    switch (body.type) {
      case 'source-subtitle-start':
        this.openSource = { startMs: body.startMs, text: '' };
        break;
      case 'source-subtitle-delta':
        if (this.openSource) this.openSource.text = body.text;
        break;
      case 'source-subtitle-final':
        this.openSource = null;
        break;
      case 'translation-subtitle-start':
        this.openTranslation = { startMs: body.startMs, text: '' };
        break;
      case 'translation-subtitle-delta':
        if (this.openTranslation) this.openTranslation.text = body.text;
        break;
      case 'translation-subtitle-final':
        this.openTranslation = null;
        break;
      case 'tts-sentence-start':
        this.ttsOpen = true;
        break;
      case 'tts-sentence-end':
        this.ttsOpen = false;
        break;
      default:
        return;
    }
    if ('endMs' in body) this.lastServerMs = Math.max(this.lastServerMs, body.endMs);
    else if ('startMs' in body) this.lastServerMs = Math.max(this.lastServerMs, body.startMs);
  }

  /**
   * `onLinkLost` hook: the connection died with lines open. Close them on
   * what the renderer already shows, pad the shorter side so FIFO pairing
   * stays aligned, and end the TTS sentence — the new server-side session
   * opens its own.
   */
  private closeOpenLines(): void {
    const at = this.lastServerMs;
    if (this.openSource) {
      const { text, startMs } = this.openSource;
      this.dispatchBody({ type: 'source-subtitle-final', text, startMs, endMs: at });
    }
    if (this.openTranslation) {
      const { text, startMs } = this.openTranslation;
      this.dispatchBody({ type: 'translation-subtitle-final', text, startMs, endMs: at });
    }
    while (this.pairing.behind('source') > 0) this.padFinal('source', at);
    while (this.pairing.behind('translation') > 0) this.padFinal('translation', at);
    if (this.ttsOpen) this.dispatchBody({ type: 'tts-sentence-end', endMs: at });
    // Even without a sentence open: a stray byte dies with its connection.
    this.pcm.reset();
  }

  /** An empty line on one side, so the renderer's FIFO pairing stays aligned. */
  private padFinal(kind: 'source' | 'translation', at: number): void {
    if (kind === 'source') {
      this.dispatchBody({ type: 'source-subtitle-start', startMs: at, speakerChanged: false });
      this.dispatchBody({ type: 'source-subtitle-final', text: '', startMs: at, endMs: at });
    } else {
      this.dispatchBody({ type: 'translation-subtitle-start', startMs: at, speakerChanged: false });
      this.dispatchBody({ type: 'translation-subtitle-final', text: '', startMs: at, endMs: at });
    }
  }

  private logIncomingFrame(frame: DecodedFrame): void {
    const tag = this.tag();
    const label = frame.eventLabel;
    const body = frame.body;
    switch (frame.event) {
      case ProtoEvent.SessionStarted:
      case ProtoEvent.SessionFinished:
      case ProtoEvent.SessionCanceled:
      case ProtoEvent.SessionFailed:
        log.info(`${tag} ← ${label}`);
        return;
      case ProtoEvent.TTSSentenceStart:
        this.ttsBytes = 0;
        if (body && body.type === 'tts-sentence-start') {
          log.info(`${tag} ← ${label} startMs=${body.startMs}`);
        }
        return;
      case ProtoEvent.TTSResponse: {
        const len =
          body && body.type === 'tts-audio' ? body.data.byteLength : 0;
        this.ttsBytes += len;
        if (VERBOSE >= 2) log.info(`${tag} ← ${label} (${len}B)`);
        return;
      }
      case ProtoEvent.TTSSentenceEnd:
        if (body && body.type === 'tts-sentence-end') {
          log.info(
            `${tag} ← ${label} endMs=${body.endMs} (sentence audio: ${this.ttsBytes}B)`
          );
        }
        return;
    }

    if (!body) {
      log.info(`${tag} ← ${label}`);
      return;
    }
    switch (body.type) {
      case 'source-subtitle-start':
      case 'translation-subtitle-start':
        log.info(
          `${tag} ← ${label} startMs=${body.startMs}${body.speakerChanged ? ' [speaker-changed]' : ''}`
        );
        return;
      case 'source-subtitle-delta':
      case 'translation-subtitle-delta':
        log.info(`${tag} ← ${label} text="${body.text}"`);
        return;
      case 'source-subtitle-final':
      case 'translation-subtitle-final':
        log.info(
          `${tag} ← ${label} [${body.startMs}-${body.endMs}ms] text="${body.text}"`
        );
        return;
      case 'audio-muted':
        log.info(`${tag} ← ${label} mutedMs=${body.durationMs}`);
        return;
      case 'usage':
        log.info(
          `${tag} ← ${label} ${JSON.stringify(body.tokens)}`
        );
        return;
      default:
        log.info(`${tag} ← ${label}`);
    }
  }
}
