import { describe, expect, it } from 'vitest';
import type { TranslationEvent } from '@shared/ipc-types.js';
import { ListenTtsGate, pcm16ToFloat32, pickMonitorSinkId } from './useTtsMonitor.js';

describe('pcm16ToFloat32', () => {
  it('decodes little-endian PCM16 to [-1, 1) floats', () => {
    const pcm = new Int16Array([0, 16384, -32768]);
    expect(Array.from(pcm16ToFloat32(pcm.buffer))).toEqual([0, 0.5, -1]);
  });

  it('drops a dangling byte instead of throwing on odd-length chunks', () => {
    const bytes = new Uint8Array([0x00, 0x40, 0x7f]);
    expect(Array.from(pcm16ToFloat32(bytes.buffer))).toEqual([0.5]);
    expect(pcm16ToFloat32(new ArrayBuffer(1))).toHaveLength(0);
  });
});

const out = (deviceId: string, label: string): MediaDeviceInfo =>
  ({ kind: 'audiooutput', deviceId, label, groupId: '' }) as MediaDeviceInfo;

const mic = out('mic', 'MacBook Pro麦克风');
(mic as { kind: string }).kind = 'audioinput';

const speakers = out('spk', 'MacBook Pro扬声器 (Built-in)');
const babelVoice = out('bv', 'BabelVoice (Virtual)');
const realDefault = out('default', 'Default - AirPods (Bluetooth)');
const virtualDefault = out('default', 'Default - BabelVoice (Virtual)');

describe('pickMonitorSinkId', () => {
  it('uses the preferred device when it is a real output', () => {
    expect(pickMonitorSinkId([realDefault, speakers, babelVoice], 'spk')).toBe('spk');
  });

  it('falls back to the system default when BabelVoice is preferred', () => {
    expect(pickMonitorSinkId([realDefault, speakers, babelVoice], 'bv')).toBe('default');
  });

  it('falls back when the preference is unset or unplugged', () => {
    expect(pickMonitorSinkId([realDefault, speakers], '')).toBe('default');
    expect(pickMonitorSinkId([realDefault, speakers], 'gone')).toBe('default');
  });

  it('skips a system default that is itself the virtual device', () => {
    expect(pickMonitorSinkId([virtualDefault, babelVoice, mic, speakers], 'bv')).toBe('spk');
  });

  it('returns null when only virtual outputs exist', () => {
    expect(pickMonitorSinkId([virtualDefault, babelVoice, mic], 'bv')).toBeNull();
  });
});

const listenAudio = { direction: 'listen', type: 'tts-audio', data: new ArrayBuffer(2) } as TranslationEvent;
const listenSentence = { direction: 'listen', type: 'tts-sentence-start', startMs: 0 } as TranslationEvent;
const speakAudio = { direction: 'speak', type: 'tts-audio', data: new ArrayBuffer(2) } as TranslationEvent;

describe('ListenTtsGate', () => {
  it('passes listen audio while no speak session holds the mic', () => {
    expect(new ListenTtsGate().admits(listenAudio)).toBe(true);
  });

  it('holds listen audio while speaking and reports closing once', () => {
    const gate = new ListenTtsGate();
    expect(gate.setSpeakBusy(true)).toBe(true);
    expect(gate.setSpeakBusy(true)).toBe(false);
    expect(gate.admits(listenAudio)).toBe(false);
    expect(gate.admits(listenSentence)).toBe(false);
    expect(gate.admits(listenAudio)).toBe(false);
  });

  it('resumes at the next sentence after speaking ends, not mid-sentence', () => {
    const gate = new ListenTtsGate();
    gate.setSpeakBusy(true);
    expect(gate.setSpeakBusy(false)).toBe(false);
    expect(gate.admits(listenAudio)).toBe(false);
    expect(gate.admits(listenSentence)).toBe(true);
    expect(gate.admits(listenAudio)).toBe(true);
  });

  it('never holds speak-direction audio', () => {
    const gate = new ListenTtsGate();
    gate.setSpeakBusy(true);
    expect(gate.admits(speakAudio)).toBe(true);
  });
});
