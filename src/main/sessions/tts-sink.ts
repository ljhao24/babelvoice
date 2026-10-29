import type { Direction } from '@shared/ipc-types.js';
import { platformNativeBridge } from '../native/platform-native-bridge.js';

/**
 * Output stage for translated TTS audio. The speak direction routes PCM
 * through the native AudioUnit (which feeds BabelVoice/BlackHole); the
 * listen direction has no TTS output and uses a no-op sink so callers
 * don't need a `direction === 'speak'` branch.
 *
 * `close` is idempotent — every call site that triggers cleanup is allowed
 * to invoke it without coordinating with other call sites.
 */
export interface TtsSink {
  prepare(sampleRate: number): Promise<void>;
  play(pcm: ArrayBuffer, sampleRate: number): Promise<void>;
  close(): Promise<void>;
}

class NativeTtsSink implements TtsSink {
  /**
   * Odd trailing byte of the last chunk. Clients don't promise chunks of
   * whole Int16 samples (a provider frame can split one), and the native
   * output rejects an odd length — which used to fail the whole session. The
   * byte is held and prefixed to the next chunk; prepare / close drop it.
   */
  private carry: number | null = null;

  async prepare(sampleRate: number): Promise<void> {
    this.carry = null;
    await platformNativeBridge.prepareTtsOutput(sampleRate);
    // Drop any audio left in the AudioUnit ring buffer from a prior PTT —
    // otherwise stale samples leak into the new utterance.
    await platformNativeBridge.flushTtsOutput();
  }

  async play(pcm: ArrayBuffer, sampleRate: number): Promise<void> {
    // Before any await: callers fire plays without awaiting them, so the
    // carry has to be consumed in call order.
    const aligned = this.align(pcm);
    if (aligned.byteLength === 0) return;
    await platformNativeBridge.playTtsPcm(aligned, sampleRate);
  }

  async close(): Promise<void> {
    this.carry = null;
    await platformNativeBridge.closeTtsOutput();
  }

  /** `pcm` with the held byte in front, cut to an even length. */
  private align(pcm: ArrayBuffer): ArrayBuffer {
    const carry = this.carry;
    this.carry = null;
    if (carry === null && pcm.byteLength % 2 === 0) return pcm;
    const joined = new Uint8Array(pcm.byteLength + (carry === null ? 0 : 1));
    if (carry !== null) joined[0] = carry;
    joined.set(new Uint8Array(pcm), carry === null ? 0 : 1);
    if (joined.byteLength % 2 === 0) return joined.buffer;
    this.carry = joined[joined.byteLength - 1] ?? null;
    return joined.buffer.slice(0, joined.byteLength - 1);
  }
}

class NoopTtsSink implements TtsSink {
  async prepare(): Promise<void> {}
  async play(): Promise<void> {}
  async close(): Promise<void> {}
}

export const createTtsSink = (direction: Direction): TtsSink =>
  direction === 'speak' ? new NativeTtsSink() : new NoopTtsSink();
