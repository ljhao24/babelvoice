import type { SupportedLanguage } from '@shared/config-types.js';
import enFaradayCandleUrl from './en-faraday-candle.m4a';
import enDickensEnglandUrl from './en-dickens-england.m4a';

/**
 * Catalogue of audio clips bundled for the "测试听" panel on the home screen.
 *
 * Each clip is played out the system speakers and captured by the listen
 * pipeline via the same screen-recording path a real meeting uses, so the
 * end-to-end flow is exercised exactly like a live call. Vite resolves the
 * `src` to a hashed URL in both dev and packaged builds.
 *
 * To add a clip:
 *   1. drop the file under `src/renderer/assets/test-audio/`
 *   2. `import url from './<file>.m4a'`
 *   3. push an entry into `TEST_AUDIO_CLIPS`
 *
 * Clips ship inside the app, so their audio must be free to redistribute
 * commercially. macOS `say` output is not (the system voices are licensed
 * for personal, non-commercial use only). Both current clips are excerpts
 * of public-domain LibriVox recordings of public-domain texts:
 *   - en-faraday-candle: Michael Faraday, "The Chemical History of a
 *     Candle", Lecture I, read by Availle —
 *     https://librivox.org/the-chemical-history-of-a-candle-by-michael-faraday/
 *   - en-dickens-england: Charles Dickens, "A Child's History of England",
 *     Chapter I, read by Lizzie Driver —
 *     https://librivox.org/a-childs-history-of-england-by-charles-dickens/
 *
 * `language` is informational only — it tells the user which clip pairs
 * with which "对方使用的语言" setting; the listen pipeline uses the user's
 * current preferences regardless.
 */
export interface TestAudioClip {
  id: string;
  /** Key in the `control` namespace for the clip's display label. */
  labelKey: string;
  hint?: string;
  language: SupportedLanguage;
  /** Bundled URL produced by Vite's `import` of an `.m4a` / `.mp3` file. */
  src: string;
  /** Optional human label like "0:14" — purely cosmetic. */
  durationLabel?: string;
}

export const TEST_AUDIO_CLIPS: TestAudioClip[] = [
  {
    id: 'en-faraday-candle',
    labelKey: 'testPanel.clips.faradayCandle',
    hint: '“There is no better, there is no more open door by which you can enter into the study of natural philosophy…”',
    language: 'en',
    src: enFaradayCandleUrl,
    durationLabel: '0:11'
  },
  {
    id: 'en-dickens-england',
    labelKey: 'testPanel.clips.dickensEngland',
    hint: '“If you look at a Map of the World, you will see… two Islands lying in the sea.”',
    language: 'en',
    src: enDickensEnglandUrl,
    durationLabel: '0:13'
  }
];
