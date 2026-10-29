import type { TranslationEventBody } from './translation-client.js';

/**
 * Keeps an engine's source and translation finals pairable, for clients
 * that get the two sides as separate server streams (Doubao, Qwen). The
 * renderer zips them FIFO (`pushFinal` in transcript-assembler.ts), so one
 * final too many on either side shifts every row after it, for the rest of
 * the session.
 *
 * Counting and dropping live together, in the client: it pads the shorter
 * side from these counts when a link dies or the stream flushes, so a final
 * dropped by a layer above would still be counted and later "evened" with
 * a stray empty line — the very shift this prevents. Clients whose lines
 * close in pairs (`TranscriptSegmenter`) can't drift and don't need it.
 */
export class FinalPairing {
  private sources = 0;
  private translations = 0;

  /**
   * Count `event` if it is a final. False: drop it — an empty translation
   * with no source line waiting for it. Engines answer an ASR item that
   * never got a transcript (noise on the line) this way; that item made no
   * source line, so its empty final would pair with the next one.
   */
  pass(event: TranslationEventBody): boolean {
    if (event.type === 'source-subtitle-final') {
      this.sources++;
      return true;
    }
    if (event.type !== 'translation-subtitle-final') return true;
    if (!event.text && this.translations >= this.sources) return false;
    this.translations++;
    return true;
  }

  /** Finals `side` lacks to even up with the other: what a flush pads. */
  behind(side: 'source' | 'translation'): number {
    const lead = this.sources - this.translations;
    return Math.max(0, side === 'source' ? -lead : lead);
  }
}
