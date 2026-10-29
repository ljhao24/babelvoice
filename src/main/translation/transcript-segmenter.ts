/**
 * Turns streaming transcription fragments without utterance boundaries
 * (Gemini Live, OpenAI realtime translation) into the line-oriented
 * subtitle events the rest of the app speaks.
 *
 * Gemini streams `inputTranscription` / `outputTranscription`, OpenAI
 * `session.input_transcript.delta` / `session.output_transcript.delta`, as
 * bare text fragments — no utterance ids, no "final" marker. The renderer, however,
 * pairs one `source-subtitle-final` with the next `translation-subtitle-final`
 * (`pushFinal` in transcript-assembler.ts); two source finals in a row would
 * overwrite the first. So lines are always closed as a pair:
 *
 *   - as soon as BOTH sides hold at least one complete sentence, each side
 *     closes at its own last sentence terminal. Either side may lead —
 *     Gemini sometimes finishes a translated sentence before its source
 *     transcript gets the period — so neither side's count is trusted to
 *     index the other. Cutting both at their last terminal re-syncs the
 *     pair on every close, so a merged sentence makes one row coarser
 *     instead of shifting every later row by one;
 *   - when the translation finishes a sentence that no open source text
 *     can claim (Gemini split one source sentence in two): it closes on
 *     its own, with an empty source;
 *   - when the owning client decides the stream went quiet (`flush()`).
 *
 * Text past the cut opens the next line pair. Pure — no timers, no I/O —
 * so the pairing rules are unit-testable; the owning client keeps the clocks.
 */
import type { TranslationEventBody } from './translation-client.js';

type LineKind = 'source' | 'translation';

interface Line {
  text: string;
  open: boolean;
  startMs: number;
  /** Open sequence across both sides; decides which line came first. */
  order: number;
}

const TERMINALS = '。！？.!?…';
const CJK_TERMINALS = '。！？';
const CLOSERS = `'"’”)]）】」』`;

/**
 * Safety valve for speech that never produces a terminal (fast talkers,
 * languages the model doesn't punctuate): don't let one subtitle line grow
 * without bound between pauses.
 */
const MAX_LINE_CHARS = 240;

const emptyLine = (): Line => ({ text: '', open: false, startMs: 0, order: 0 });

/**
 * Offsets just past each sentence terminal in `text`, including trailing
 * closing quotes/brackets. A run of terminals ("?!", "...") counts once.
 * Latin terminals must be followed by whitespace, which keeps decimals
 * ("3.5") and dotted names ("node.js") intact — unless what follows clearly
 * starts a new sentence glued on without a space, as streamed fragments
 * often are ("Hello." + "Bye.", "你好吗?" + "我很好。"). One at the very end
 * of the text is still pending: fragments stream in, and "3" "." "5 yuan."
 * must not end a line at "3." — the next fragment decides, or the owning
 * client's line timer flushes it. CJK terminals end a sentence
 * unconditionally.
 */
export const sentenceBoundaries = (text: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!TERMINALS.includes(ch)) continue;
    let end = i + 1;
    while (end < text.length && CLOSERS.includes(text[end]!)) end++;
    const next = text[end];
    if (next !== undefined && TERMINALS.includes(next)) continue;
    if (!CJK_TERMINALS.includes(ch)) {
      if (next === undefined) continue;
      if (!/\s/.test(next) && !startsGluedSentence(text[i - 1], next)) continue;
    }
    out.push(end);
  }
  return out;
};

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff01-\uff5e]/;

/**
 * A Latin terminal with no space after it still ends the sentence when the
 * next character opens another one: CJK text, or a capital right after a
 * lowercase word ("Hello.Bye"). Digits and lowercase letters ("3.5",
 * "node.js") and initialisms ("U.S.A") keep it mid-sentence.
 */
const startsGluedSentence = (prev: string | undefined, next: string): boolean => {
  if (CJK_CHAR.test(next)) return true;
  return /\p{Lu}/u.test(next) && prev !== undefined && /\p{Ll}/u.test(prev);
};

/** `text` ends in a Latin terminal that is still pending (see above). */
const endsPending = (text: string): boolean => {
  let end = text.length;
  while (end > 0 && CLOSERS.includes(text[end - 1]!)) end--;
  const ch = text[end - 1];
  return ch !== undefined && TERMINALS.includes(ch) && !CJK_TERMINALS.includes(ch);
};

/**
 * Append a transcription fragment. Defensive against the server ever
 * switching to cumulative transcripts: a fragment that restates everything
 * we already hold replaces it instead of doubling it.
 */
export const appendFragment = (prev: string, fragment: string): string => {
  if (
    prev.length >= 4 &&
    fragment.length > prev.length &&
    fragment.startsWith(prev)
  ) {
    return fragment;
  }
  return prev + fragment;
};

export class TranscriptSegmenter {
  private source: Line = emptyLine();
  private translation: Line = emptyLine();
  private opened = 0;

  constructor(
    private readonly emit: (event: TranslationEventBody) => void,
    private readonly now: () => number
  ) {}

  appendSource(fragment: string): void {
    this.append('source', fragment);
    this.closeCompleteSentences('source');
  }

  appendTranslation(fragment: string): void {
    this.append('translation', fragment);
    this.closeCompleteSentences('translation');
  }

  /** Close whatever is open, e.g. after a pause or at end of stream. */
  flush(): void {
    this.closeAt(this.source.text.length, this.translation.text.length);
  }

  hasPending(): boolean {
    return (
      this.source.text.trim().length > 0 ||
      this.translation.text.trim().length > 0
    );
  }

  /** Source text is in but its translation hasn't started yet. */
  awaitingTranslation(): boolean {
    return (
      this.source.text.trim().length > 0 &&
      this.translation.text.trim().length === 0
    );
  }

  // -------------------------------------------------------------------------

  private closeCompleteSentences(trigger: LineKind): void {
    if (
      this.source.text.length > MAX_LINE_CHARS ||
      this.translation.text.length > MAX_LINE_CHARS
    ) {
      this.flush();
      return;
    }
    const srcBounds = sentenceBoundaries(this.source.text);
    const tgtBounds = sentenceBoundaries(this.translation.text);
    if (tgtBounds.length === 0) return;
    const tgtCut = tgtBounds[tgtBounds.length - 1]!;
    if (srcBounds.length > 0) {
      this.closeAt(srcBounds[srcBounds.length - 1]!, tgtCut, trigger);
      return;
    }
    // No complete source sentence yet. Normally the source transcript is
    // just behind (wait for its period, or for the character after a
    // pending one). But if the source line is empty, or opened after this
    // translation did and has no terminal yet, the sentence belongs to a row
    // that already closed — pairing it with the next source sentence would
    // shift every later row.
    if (
      !this.source.open ||
      (this.source.order > this.translation.order && !endsPending(this.source.text))
    ) {
      this.closeAt(0, tgtCut, trigger);
    }
  }

  private line(kind: LineKind): Line {
    return kind === 'source' ? this.source : this.translation;
  }

  private append(kind: LineKind, fragment: string): void {
    if (!fragment) return;
    const line = this.line(kind);
    line.text = appendFragment(line.text, fragment);
    const display = line.text.trim();
    if (!display) return;
    if (!line.open) {
      line.open = true;
      line.startMs = this.now();
      line.order = ++this.opened;
      this.emitStart(kind, line.startMs);
    }
    this.emitDelta(kind, display);
  }

  private closeAt(srcCut: number, tgtCut: number, trigger?: LineKind): void {
    const src = this.source.text;
    const tgt = this.translation.text;
    const srcHead = src.slice(0, srcCut).trim();
    const tgtHead = tgt.slice(0, tgtCut).trim();
    if (!srcHead && !tgtHead) return;

    // Always close both sides — an empty final on one side keeps the
    // renderer's src/tgt pairing aligned (e.g. same-language speech that
    // the model deliberately leaves untranslated).
    const endMs = this.now();
    this.finalize('source', srcHead, endMs);
    this.finalize('translation', tgtHead, endMs);

    this.source = emptyLine();
    this.translation = emptyLine();
    // Text past the cut opens the next pair. The side that didn't just get
    // a fragment held its rest first, so it reopens first: after a deferred
    // close (a pending Latin terminal) the two rests can date from different
    // fragments, and the split-translation check compares their order.
    const rest: [LineKind, string][] = [
      ['source', src.slice(srcCut)],
      ['translation', tgt.slice(tgtCut)]
    ];
    if (trigger === 'source') rest.reverse();
    for (const [kind, text] of rest) this.append(kind, text);
  }

  private finalize(kind: LineKind, text: string, endMs: number): void {
    const line = this.line(kind);
    const startMs = line.open ? line.startMs : endMs;
    if (!line.open) this.emitStart(kind, startMs);
    if (kind === 'source') {
      this.emit({ type: 'source-subtitle-final', text, startMs, endMs });
    } else {
      this.emit({ type: 'translation-subtitle-final', text, startMs, endMs });
    }
  }

  private emitStart(kind: LineKind, startMs: number): void {
    if (kind === 'source') {
      this.emit({ type: 'source-subtitle-start', startMs, speakerChanged: false });
    } else {
      this.emit({
        type: 'translation-subtitle-start',
        startMs,
        speakerChanged: false
      });
    }
  }

  private emitDelta(kind: LineKind, text: string): void {
    if (kind === 'source') {
      this.emit({ type: 'source-subtitle-delta', text });
    } else {
      this.emit({ type: 'translation-subtitle-delta', text });
    }
  }
}
