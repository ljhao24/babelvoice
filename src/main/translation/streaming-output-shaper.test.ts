import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setLogSink } from '@core/utils/logger.js';
import { Pcm16Carry } from './pcm.js';
import { StreamingOutputShaper } from './streaming-output-shaper.js';
import type { TranslationEventBody } from './translation-client.js';

const TIMINGS = { lineIdleMs: 100, lineAwaitTranslationMs: 300, ttsIdleMs: 50 };

/** Base64 PCM16: audible (alternating ±5000) or silence, `samples` long. */
const pcm = (audible: boolean, samples = 240): string => {
  const buf = Buffer.alloc(samples * 2);
  if (audible) {
    for (let i = 0; i < samples; i++) buf.writeInt16LE(i % 2 ? 5000 : -5000, i * 2);
  }
  return buf.toString('base64');
};

const makeShaper = (mode: 's2t' | 's2s' = 's2s') => {
  const events: TranslationEventBody[] = [];
  const shaper = new StreamingOutputShaper({
    emit: (e) => events.push(e),
    now: () => Date.now(),
    timings: TIMINGS,
    outputSampleRate: 24_000,
    tag: () => 'Test[]'
  });
  shaper.setMode(mode);
  const types = () => events.map((e) => e.type);
  const texts = (type: 'source-subtitle-final' | 'translation-subtitle-final') =>
    events.flatMap((e) => (e.type === type ? [e.text] : []));
  return { shaper, events, types, texts };
};

describe('StreamingOutputShaper', () => {
  beforeAll(() => setLogSink({ info() {}, warn() {}, error() {}, debug() {} }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens a TTS sentence on audible audio, keeps inner pauses, drops silence between sentences', () => {
    vi.useFakeTimers();
    const { shaper, types } = makeShaper();
    expect(shaper.pushAudio(pcm(false))).toBe(false);
    expect(shaper.pushAudio(pcm(true))).toBe(true);
    expect(shaper.pushAudio(pcm(false))).toBe(false);
    vi.advanceTimersByTime(TIMINGS.ttsIdleMs);
    shaper.pushAudio(pcm(false));

    expect(types()).toEqual([
      'tts-sentence-start',
      'tts-audio',
      'tts-audio', // the pause inside the sentence
      'tts-sentence-end'
    ]);
  });

  it('keeps chunks on whole samples through the carry it is given', () => {
    const { shaper, events } = makeShaper();
    const carry = new Pcm16Carry();
    const speech = Buffer.from(pcm(true, 4), 'base64');
    shaper.pushAudio(speech.subarray(0, 3).toString('base64'), carry);
    shaper.pushAudio(speech.subarray(3).toString('base64'), carry);
    const chunks = events.flatMap((e) => (e.type === 'tts-audio' ? [Buffer.from(e.data)] : []));
    expect(chunks.map((c) => c.byteLength)).toEqual([2, 6]);
    expect(Buffer.concat(chunks).equals(speech)).toBe(true);
  });

  it('drops output audio in s2t without decoding it', () => {
    const decode = vi.spyOn(Pcm16Carry.prototype, 'fromBase64');
    const { shaper, events } = makeShaper('s2t');
    expect(shaper.pushAudio(pcm(true))).toBe(false);
    expect(events).toEqual([]);
    expect(decode).not.toHaveBeenCalled();
  });

  it('closes the line pair after the idle window, waiting longer for a missing translation', () => {
    vi.useFakeTimers();
    const { shaper, texts } = makeShaper();
    shaper.appendSource(' so anyway');
    shaper.noteProgress();
    vi.advanceTimersByTime(TIMINGS.lineIdleMs);
    // Source only: the shaper waits for the translation.
    expect(texts('source-subtitle-final')).toEqual([]);

    shaper.appendTranslation('总之');
    shaper.noteProgress();
    vi.advanceTimersByTime(TIMINGS.lineIdleMs);
    expect(texts('source-subtitle-final')).toEqual(['so anyway']);
    expect(texts('translation-subtitle-final')).toEqual(['总之']);
  });

  it('armLineClose overrides the idle window (e.g. after turnComplete)', () => {
    vi.useFakeTimers();
    const { shaper, texts } = makeShaper();
    shaper.appendSource(' hi');
    shaper.appendTranslation('嗨');
    shaper.noteProgress();
    shaper.armLineClose(10);
    vi.advanceTimersByTime(10);
    expect(texts('translation-subtitle-final')).toEqual(['嗨']);
  });

  it('flush() closes the open lines and TTS sentence; stop() silences every timer', () => {
    vi.useFakeTimers();
    const { shaper, types } = makeShaper();
    shaper.appendSource(' trailing');
    shaper.noteProgress();
    shaper.pushAudio(pcm(true));
    shaper.flush();
    expect(types().slice(-4)).toEqual([
      'source-subtitle-final',
      // An empty translation closes with its source, so rows stay paired.
      'translation-subtitle-start',
      'translation-subtitle-final',
      'tts-sentence-end'
    ]);

    const before = types().length;
    shaper.appendSource(' more');
    shaper.noteProgress();
    shaper.pushAudio(pcm(true));
    shaper.stop();
    const afterStop = types().length;
    vi.advanceTimersByTime(10_000);
    expect(afterStop).toBeGreaterThan(before);
    expect(types()).toHaveLength(afterStop);
  });
});
