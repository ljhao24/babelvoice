import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTtsSink } from './tts-sink.js';

const played = vi.hoisted(() => [] as number[][]);

vi.mock('../native/platform-native-bridge.js', () => ({
  platformNativeBridge: {
    prepareTtsOutput: vi.fn(async () => undefined),
    flushTtsOutput: vi.fn(async () => undefined),
    closeTtsOutput: vi.fn(async () => undefined),
    playTtsPcm: vi.fn(async (pcm: ArrayBuffer) => {
      played.push([...new Uint8Array(pcm)]);
    })
  }
}));

const chunk = (...bytes: number[]): ArrayBuffer => new Uint8Array(bytes).buffer;

describe('NativeTtsSink', () => {
  beforeEach(() => {
    played.length = 0;
  });

  it('passes whole-sample chunks through untouched', async () => {
    const sink = createTtsSink('speak');
    const pcm = chunk(1, 2, 3, 4);
    await sink.play(pcm, 24000);
    expect(played).toEqual([[1, 2, 3, 4]]);
  });

  it('holds an odd trailing byte and prefixes it to the next chunk', async () => {
    const sink = createTtsSink('speak');
    // Fired without awaiting, as DirectionSession does.
    const plays = [
      sink.play(chunk(1, 2, 3), 24000),
      sink.play(chunk(4, 5, 6), 24000),
      sink.play(chunk(7), 24000),
      sink.play(chunk(8), 24000)
    ];
    await Promise.all(plays);
    expect(played).toEqual([[1, 2], [3, 4, 5, 6], [7, 8]]);
  });

  it('never hands the native output an odd length', async () => {
    const sink = createTtsSink('speak');
    for (const length of [1, 3, 5, 2, 7, 1]) {
      await sink.play(new Uint8Array(length).buffer, 16000);
    }
    expect(played.every((bytes) => bytes.length % 2 === 0)).toBe(true);
    // 19 bytes in: 18 played, the last one still held.
    expect(played.flat()).toHaveLength(18);
  });

  it('drops the held byte on close and on the next prepare', async () => {
    const sink = createTtsSink('speak');
    await sink.play(chunk(1, 2, 3), 16000);
    await sink.close();
    await sink.play(chunk(9, 9), 16000);

    await sink.play(chunk(4, 5, 6), 16000);
    await sink.prepare(16000);
    await sink.play(chunk(7, 8), 16000);
    expect(played).toEqual([[1, 2], [9, 9], [4, 5], [7, 8]]);
  });
});
