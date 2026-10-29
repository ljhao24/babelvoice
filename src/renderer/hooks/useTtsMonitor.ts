import { useEffect, useRef } from 'react';
import { usePreferences } from './usePreferences.js';
import { isVirtualAudioDevice } from '../audio/virtual-device.js';
import { useAppStore } from '../store/app-store.js';
import type { SessionStatus, TranslationEvent } from '../../shared/ipc-types.js';

interface TtsMonitorOptions {
  /** The onboarding speak probe intentionally plays translated TTS locally. */
  allowSpeak?: boolean;
  /** Listen-mode local playback is an explicit user preference. */
  allowListen?: boolean;
}

export const shouldMonitorTtsEvent = (
  event: TranslationEvent,
  { allowSpeak = false, allowListen = false }: TtsMonitorOptions
): event is Extract<TranslationEvent, { type: 'tts-audio' }> => {
  if (event.type !== 'tts-audio') return false;
  if (event.direction === 'speak') return allowSpeak;
  return allowListen;
};

/**
 * Decode a PCM16LE chunk for Web Audio. Providers don't guarantee even-length
 * chunks; `new Int16Array(buf)` throws a RangeError on an odd byte count, so
 * the dangling byte is dropped instead of killing the monitor.
 */
export const pcm16ToFloat32 = (data: ArrayBuffer): Float32Array<ArrayBuffer> => {
  const i16 = new Int16Array(data, 0, data.byteLength >> 1);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  return f32;
};

/** Speak states in which the mic may still be live (held, or wrapping up). */
const SPEAK_HOLDS_MIC: ReadonlySet<SessionStatus> = new Set([
  'connecting',
  'running',
  'finishing'
]);

/**
 * Holds back listen-direction TTS while a speak session may have the mic
 * live: speaker playback of the other side's translation would otherwise be
 * re-captured and translated into the meeting as if the user said it. Once
 * the speak session ends, playback resumes at the next TTS sentence rather
 * than mid-sentence. Speak-direction events always pass.
 */
export class ListenTtsGate {
  private speakBusy = false;
  private awaitingSentence = false;

  /** Returns true when this call closed the gate (drop queued listen audio). */
  setSpeakBusy(busy: boolean): boolean {
    const closing = busy && !this.speakBusy;
    this.speakBusy = busy;
    if (closing) this.awaitingSentence = true;
    return closing;
  }

  admits(event: TranslationEvent): boolean {
    if (event.direction !== 'listen') return true;
    if (event.type === 'tts-sentence-start' && !this.speakBusy) {
      this.awaitingSentence = false;
    }
    return !this.speakBusy && !this.awaitingSentence;
  }
}

/**
 * Chromium output deviceId to monitor through, or null when there is no real
 * output at all. Prefers `preferredId`, but the Audio settings page
 * recommends (and auto-selects) BabelVoice for that same preference — playing
 * into the virtual loopback would only reach the meeting, never the user's
 * ears. So a virtual, unplugged or unset pick falls back to the system
 * default output (`'default'`) if that is real, else the first real output.
 */
export const pickMonitorSinkId = (
  devices: readonly MediaDeviceInfo[],
  preferredId: string
): string | null => {
  const outputs = devices.filter(
    (d) => d.kind === 'audiooutput' && !isVirtualAudioDevice(d)
  );
  if (preferredId && outputs.some((d) => d.deviceId === preferredId)) {
    return preferredId;
  }
  if (outputs.some((d) => d.deviceId === 'default')) return 'default';
  return outputs[0]?.deviceId ?? null;
};

/**
 * Local-monitor playback for translated TTS.
 *
 * The native side always feeds BabelVoice (so meeting software still hears
 * the speak-direction translation). On top of that, this hook can play TTS
 * PCM through a real Chromium output device via Web Audio +
 * `AudioContext.setSinkId` — `preferredOutputDeviceId` when it is a real
 * device, otherwise the system default (see `pickMonitorSinkId`).
 *
 * Normal meetings must not locally monitor `speak` TTS: that audio belongs in
 * BabelVoice/the virtual microphone only. The onboarding probe opts in so the
 * user can hear the setup test through local speakers.
 *
 * Listen TTS pauses while a speak session holds the mic (`ListenTtsGate`).
 *
 * Each chunk is played at the `sampleRate` main stamped on it (ADR-0002:
 * the renderer's prefs.engineId is display-only and may be stale).
 *
 * Skips when:
 *   - no direction has opted into local monitoring;
 *   - no real (non-virtual) output device enumerates.
 */
export const useTtsMonitor = (options: TtsMonitorOptions = {}): void => {
  const { preferences } = usePreferences();
  const deviceId = preferences.preferredOutputDeviceId ?? '';
  const allowSpeak = options.allowSpeak ?? false;
  const allowListen = options.allowListen ?? false;
  const ctxRef = useRef<AudioContext | null>(null);
  const nextStartRef = useRef<number>(0);
  const speakHoldsMic = useAppStore((s) => SPEAK_HOLDS_MIC.has(s.speak.status));
  const gateRef = useRef(new ListenTtsGate());
  // Listen chunks already handed to Web Audio, so closing the gate can cut
  // them off instead of letting the queued tail play over the user's speech.
  const listenSourcesRef = useRef(new Set<AudioBufferSourceNode>());

  useEffect(() => {
    if (!gateRef.current.setSpeakBusy(speakHoldsMic)) return;
    for (const src of listenSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // already ended
      }
    }
    listenSourcesRef.current.clear();
    nextStartRef.current = 0;
  }, [speakHoldsMic]);

  useEffect(() => {
    if (!allowSpeak && !allowListen) return;

    let cancelled = false;
    let unsub: (() => void) | null = null;

    const init = async (): Promise<void> => {
      let devices: MediaDeviceInfo[];
      try {
        devices = await navigator.mediaDevices.enumerateDevices();
      } catch {
        return;
      }
      if (cancelled) return;
      const sinkId = pickMonitorSinkId(devices, deviceId);
      if (sinkId === null) {
        console.warn('[tts-monitor] no real output device; local playback disabled');
        return;
      }

      // The context runs at the device rate; each buffer is created at its
      // chunk's own rate and Web Audio resamples it on playback.
      type CtxWithSink = AudioContext & {
        setSinkId?: (id: string) => Promise<void>;
      };
      let ctx: CtxWithSink;
      try {
        ctx = new (AudioContext as unknown as {
          new (opts: { sinkId?: string }): CtxWithSink;
        })({ sinkId });
      } catch {
        // Older Chromium without sinkId option — fall back to setSinkId.
        ctx = new AudioContext() as CtxWithSink;
        if (typeof ctx.setSinkId === 'function') {
          try {
            await ctx.setSinkId(sinkId);
          } catch {
            await ctx.close().catch(() => undefined);
            return;
          }
        }
      }
      if (cancelled) {
        await ctx.close().catch(() => undefined);
        return;
      }
      ctxRef.current = ctx;
      nextStartRef.current = 0;

      unsub = window.babelVoiceBridge.onTranslationEvent((event) => {
        if (!gateRef.current.admits(event)) return;
        if (!shouldMonitorTtsEvent(event, { allowSpeak, allowListen })) return;
        const cur = ctxRef.current;
        if (!cur) return;
        const f32 = pcm16ToFloat32(event.data);
        if (f32.length === 0) return;
        const buf = cur.createBuffer(1, f32.length, event.sampleRate);
        buf.copyToChannel(f32, 0);
        const src = cur.createBufferSource();
        src.buffer = buf;
        src.connect(cur.destination);
        // Schedule chunks back-to-back; if we've fallen behind real time,
        // jump forward to `currentTime` to avoid a snowballing backlog.
        const t = Math.max(cur.currentTime, nextStartRef.current);
        src.start(t);
        nextStartRef.current = t + buf.duration;
        if (event.direction === 'listen') {
          const sources = listenSourcesRef.current;
          sources.add(src);
          src.onended = () => sources.delete(src);
        }
      });
    };

    void init();

    return () => {
      cancelled = true;
      unsub?.();
      const ctx = ctxRef.current;
      ctxRef.current = null;
      nextStartRef.current = 0;
      listenSourcesRef.current.clear();
      if (ctx) void ctx.close().catch(() => undefined);
    };
  }, [allowListen, allowSpeak, deviceId]);
};
