/**
 * Output shaping for the streaming engines (GeminiClient, OpenAiClient):
 * providers that stream bare transcript fragments and continuous output
 * audio, with no utterance boundaries, finals or TTS sentence events.
 *
 *   - Transcripts go through a `TranscriptSegmenter` (line pairing); a
 *     silence timer closes the open line pair once the stream goes quiet,
 *     waiting longer while source text still has no translation.
 *   - A TTS sentence opens on the first audible chunk and closes after a
 *     quiet gap. Pauses inside a sentence are kept so speech timing stays
 *     natural; silence between sentences is dropped.
 *   - Subtitles-only (s2t) sessions drop output audio without decoding it —
 *     they never play it, and their line timers run on transcripts alone.
 *
 * The owning client still decides what counts as progress and when the
 * stream is over: it calls `noteProgress()` after real output, `flush()` at
 * end of stream and `stop()` on every terminal path.
 */
import { log } from '@core/utils/logger.js';
import { isSilentPcm16, Pcm16Carry } from './pcm.js';
import { TranscriptSegmenter } from './transcript-segmenter.js';
import type { TranslationEventBody } from './translation-client.js';

export interface StreamingOutputTimings {
  /** No transcript/audio for this long → close the current line pair. */
  lineIdleMs: number;
  /** …but wait longer while source text still has no translation. */
  lineAwaitTranslationMs: number;
  /** No audible TTS for this long → the spoken sentence ended. */
  ttsIdleMs: number;
}

export interface StreamingOutputShaperOptions {
  emit: (event: TranslationEventBody) => void;
  /** Session clock (ms since start) for subtitle/TTS timestamps. */
  now: () => number;
  timings: StreamingOutputTimings;
  /** Output PCM rate, for the verbose per-sentence duration. */
  outputSampleRate: number;
  tag: () => string;
  /** Log a summary line per TTS sentence. */
  verbose?: boolean;
}

export class StreamingOutputShaper {
  private readonly segmenter: TranscriptSegmenter;
  /** Default output audio stream; a multi-connection client passes its own. */
  private readonly pcm = new Pcm16Carry();
  private keepAudio = false;
  private ttsOpen = false;
  private lineTimer: NodeJS.Timeout | null = null;
  private ttsTimer: NodeJS.Timeout | null = null;
  /** Audio bytes in the current TTS sentence (verbose summary). */
  private sentenceBytes = 0;

  constructor(private readonly opts: StreamingOutputShaperOptions) {
    this.segmenter = new TranscriptSegmenter(opts.emit, opts.now);
  }

  /** s2s plays output audio; s2t drops it undecoded. */
  setMode(mode: 's2t' | 's2s'): void {
    this.keepAudio = mode === 's2s';
  }

  appendSource(fragment: string): void {
    this.segmenter.appendSource(fragment);
  }

  appendTranslation(fragment: string): void {
    this.segmenter.appendTranslation(fragment);
  }

  /** Source text is in but its translation hasn't started yet. */
  awaitingTranslation(): boolean {
    return this.segmenter.awaitingTranslation();
  }

  hasPending(): boolean {
    return this.segmenter.hasPending();
  }

  /**
   * One base64 output audio chunk. Returns true when it is audible speech
   * rather than silence; s2t sessions return false without decoding it.
   */
  pushAudio(audioB64: string, carry: Pcm16Carry = this.pcm): boolean {
    if (!this.keepAudio) return false;
    // Every chunk goes through the carry, kept or not, so a split sample
    // can't shift the rest of the stream.
    const ab = carry.fromBase64(audioB64);
    if (!ab) return false;
    const audible = !isSilentPcm16(new Uint8Array(ab));

    if (audible) {
      if (!this.ttsOpen) {
        this.ttsOpen = true;
        this.opts.emit({ type: 'tts-sentence-start', startMs: this.opts.now() });
      }
      this.clearTtsTimer();
      this.ttsTimer = setTimeout(() => this.closeTtsSentence(), this.opts.timings.ttsIdleMs);
    }
    // Pauses inside a sentence are kept so speech timing stays natural;
    // silence between sentences is dropped.
    if (!this.ttsOpen) return audible;
    this.sentenceBytes += ab.byteLength;
    this.opts.emit({ type: 'tts-audio', data: ab });
    return audible;
  }

  /** Transcript or audible speech arrived: push the line-close deadline out. */
  noteProgress(): void {
    const t = this.opts.timings;
    this.armLineClose(this.awaitingTranslation() ? t.lineAwaitTranslationMs : t.lineIdleMs);
  }

  /** Close the open line pair `ms` from now (re-arms any pending close). */
  armLineClose(ms: number): void {
    this.clearLineTimer();
    this.lineTimer = setTimeout(() => {
      this.lineTimer = null;
      this.segmenter.flush();
    }, ms);
  }

  /** End of stream: close the open line pair and TTS sentence. */
  flush(): void {
    this.clearLineTimer();
    this.segmenter.flush();
    this.closeTtsSentence();
    // A stray byte dies with its stream (a dropped connection's included).
    this.pcm.reset();
  }

  /** Stop every timer without emitting anything. Idempotent. */
  stop(): void {
    this.clearLineTimer();
    this.clearTtsTimer();
  }

  // -------------------------------------------------------------------------

  private closeTtsSentence(): void {
    this.clearTtsTimer();
    if (!this.ttsOpen) return;
    this.ttsOpen = false;
    if (this.opts.verbose) {
      const ms = Math.round((this.sentenceBytes / 2 / this.opts.outputSampleRate) * 1000);
      log.info(`${this.opts.tag()} tts sentence end audio=${this.sentenceBytes}B (~${ms}ms)`);
    }
    this.sentenceBytes = 0;
    this.opts.emit({ type: 'tts-sentence-end', endMs: this.opts.now() });
  }

  private clearLineTimer(): void {
    if (this.lineTimer) clearTimeout(this.lineTimer);
    this.lineTimer = null;
  }

  private clearTtsTimer(): void {
    if (this.ttsTimer) clearTimeout(this.ttsTimer);
    this.ttsTimer = null;
  }
}
