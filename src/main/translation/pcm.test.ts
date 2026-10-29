import { describe, expect, it } from 'vitest';
import { isSilentPcm16, Pcm16Carry } from './pcm.js';

const pcm = (...samples: number[]): Uint8Array => {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

const bytes = (ab: ArrayBuffer | null): number[] | null => (ab ? [...new Uint8Array(ab)] : null);

describe('isSilentPcm16', () => {
  it('treats low-level noise as silence and speech-level audio as audible', () => {
    expect(isSilentPcm16(Buffer.from(pcm(10, -12, 8, -5)))).toBe(true);
    expect(isSilentPcm16(Buffer.from(pcm(4000, -4000, 3000, -3000)))).toBe(false);
    expect(isSilentPcm16(Buffer.alloc(0))).toBe(true);
  });

  it('reads little-endian samples from a misaligned slice too', () => {
    const backing = new Uint8Array(9);
    backing.set(pcm(4000, -4000, 3000, -3000), 1); // byteOffset 1: no Int16Array view
    expect(isSilentPcm16(backing.subarray(1))).toBe(false);
    const quiet = new Uint8Array(9);
    quiet.set(pcm(10, -12, 8, -5), 1);
    expect(isSilentPcm16(quiet.subarray(1))).toBe(true);
  });
});

describe('Pcm16Carry', () => {
  it('decodes base64 into a fresh, exactly-sized ArrayBuffer', () => {
    const carry = new Pcm16Carry();
    const ab = carry.fromBase64(Buffer.from([1, 2, 3, 4]).toString('base64'));
    expect(ab).toBeInstanceOf(ArrayBuffer);
    expect(ab!.byteLength).toBe(4);
    expect(bytes(ab)).toEqual([1, 2, 3, 4]);
  });

  it('holds back an odd byte and prefixes it to the next chunk', () => {
    const carry = new Pcm16Carry();
    expect(bytes(carry.fromBase64(Buffer.from([1, 2, 3]).toString('base64')))).toEqual([1, 2]);
    expect(bytes(carry.fromBase64(Buffer.from([4, 5, 6]).toString('base64')))).toEqual([
      3, 4, 5, 6
    ]);
    // A lone byte yields nothing until its partner arrives.
    expect(carry.fromBase64(Buffer.from([7]).toString('base64'))).toBeNull();
    expect(bytes(carry.align(new Uint8Array([8, 9, 10]).buffer))).toEqual([7, 8, 9, 10]);
    expect(carry.align(new Uint8Array([11]).buffer)).toBeNull();
    expect(bytes(carry.align(new Uint8Array([12, 13, 14]).buffer))).toEqual([11, 12, 13, 14]);
  });

  it('passes an even chunk through untouched when nothing is held', () => {
    const carry = new Pcm16Carry();
    const ab = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(carry.align(ab)).toBe(ab);
    expect(carry.align(new ArrayBuffer(0))).toBeNull();
  });

  it('reset() drops a held byte when its stream ends', () => {
    const carry = new Pcm16Carry();
    carry.align(new Uint8Array([1, 2, 3]).buffer);
    carry.reset();
    expect(bytes(carry.align(new Uint8Array([4, 5]).buffer))).toEqual([4, 5]);
  });
});
