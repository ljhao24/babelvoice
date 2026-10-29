/**
 * 16-bit little-endian mono PCM helpers shared by the TranslationClients.
 */

/** RMS below this (~-44 dBFS) is a provider's silence padding, not speech. */
const SILENCE_RMS = 200;

/** Int16Array reads in platform byte order; PCM16 here is little-endian. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export const isSilentPcm16 = (pcm: Uint8Array): boolean => {
  const samples = pcm.byteLength >> 1;
  if (samples === 0) return true;
  let sumSquares = 0;
  if (LITTLE_ENDIAN && pcm.byteOffset % 2 === 0) {
    // Zero-copy view; runs on every output chunk of the streaming engines.
    const view = new Int16Array(pcm.buffer, pcm.byteOffset, samples);
    for (let i = 0; i < samples; i++) sumSquares += view[i]! * view[i]!;
  } else {
    // Misaligned slice (or a big-endian host): read sample by sample.
    const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
    for (let i = 0; i < samples; i++) {
      const v = view.getInt16(i * 2, true);
      sumSquares += v * v;
    }
  }
  return Math.sqrt(sumSquares / samples) < SILENCE_RMS;
};

/**
 * Keeps one provider audio stream on whole 16-bit samples. Nothing promises
 * that a TTS chunk is even-length (a base64 delta can split a sample), but
 * the native sink rejects an odd chunk — failing the session — and the
 * renderer's Int16Array view throws on one. The dangling byte is held back
 * and prefixed to the next chunk instead.
 *
 * Every chunk handed out is a fresh, exactly-sized ArrayBuffer — never a
 * slice of Node's shared Buffer pool — so it can go straight to IPC.
 */
export class Pcm16Carry {
  /** The held-back odd byte, or -1. */
  private carry = -1;

  /** Decode base64 PCM straight into the outgoing buffer: one copy. */
  fromBase64(b64: string): ArrayBuffer | null {
    const lead = this.carry >= 0 ? 1 : 0;
    const ab = new ArrayBuffer(lead + Buffer.byteLength(b64, 'base64'));
    if (lead) new Uint8Array(ab)[0] = this.carry;
    // byteLength is an upper bound if the payload had junk characters.
    const written = Buffer.from(ab).write(b64, lead, 'base64');
    return this.take(ab, lead + written);
  }

  /**
   * Align a chunk the caller already owns (e.g. a decoded Doubao frame).
   * Passed through untouched in the common case: no carry, even length.
   */
  align(ab: ArrayBuffer): ArrayBuffer | null {
    if (this.carry < 0 && ab.byteLength % 2 === 0) {
      return ab.byteLength > 0 ? ab : null;
    }
    const lead = this.carry >= 0 ? 1 : 0;
    const out = new ArrayBuffer(lead + ab.byteLength);
    const bytes = new Uint8Array(out);
    if (lead) bytes[0] = this.carry;
    bytes.set(new Uint8Array(ab), lead);
    return this.take(out, out.byteLength);
  }

  /** Drop a held byte: the stream it belonged to ended (sentence/response). */
  reset(): void {
    this.carry = -1;
  }

  private take(ab: ArrayBuffer, length: number): ArrayBuffer | null {
    this.carry = -1;
    let whole = length;
    if (whole % 2 === 1) {
      whole -= 1;
      this.carry = new Uint8Array(ab)[whole]!;
    }
    if (whole === 0) return null;
    return whole === ab.byteLength ? ab : ab.slice(0, whole);
  }
}
