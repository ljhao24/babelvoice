import type { BrowserWindow } from 'electron';
import { log } from '@core/utils/logger.js';
import type {
  AudioCapableApplication,
  NativeAudioDevice,
  NativeAudioDiagnostics,
  NativeCapabilities,
  NativePermissionSnapshot
} from '@shared/ipc-types.js';

/**
 * Handle of one consumer of the shared microphone capture, from
 * `startMicrophoneCapture`. Ids are never reused, so stopping a stale one is
 * a harmless no-op that can't detach somebody else's consumer.
 */
export type MicrophoneConsumerId = number;

/** Snapshot of the shared microphone capture (diagnostics / tests). */
export interface MicrophoneCaptureState {
  /** The AudioQueue is recording. */
  running: boolean;
  /** Rate the queue records at (24000) while running, else 0. */
  sampleRate: number;
  /** Device UID the queue is pinned to; empty = system default. */
  deviceUid: string;
  /** The running capture died; its consumers got onError. */
  failed: boolean;
  consumers: number;
  /** Consumers that receive PCM in JS. */
  pcmConsumers: number;
  /** AudioQueues created since the addon loaded. */
  queueStarts: number;
  /** The passthrough tee is on. */
  passthrough: boolean;
}

/**
 * The TS shape of what each platform's compiled `.node` addon exports. Both
 * the macOS (CoreAudio + ScreenCaptureKit) and future Windows (WASAPI +
 * Win32 hooks) addons must implement this surface; the generic
 * `NativeBridge` consumes it without knowing which platform it's on.
 */
export interface NativeAddon {
  getCapabilities(): Omit<NativeCapabilities, 'platform'> & {
    platform: string;
  };
  getPermissions(): NativePermissionSnapshot;
  listAudioDevices(): NativeAudioDevice[];
  getAudioDiagnostics(): NativeAudioDiagnostics;
  /**
   * Attaches one consumer to the shared microphone capture and returns its
   * id. One AudioQueue (24 kHz) serves every consumer: it starts with the
   * first, stops with the last, and is rebuilt only for another device or
   * after it failed — never just because consumers come and go.
   * `onError` fires (at most once, on the JS thread) when the capture dies on
   * its own — device unplugged, queue stopped, loopback detected — for every
   * consumer attached; the native side has already switched the passthrough
   * tee off by then, and the consumer receives no more PCM.
   * `sampleRate` (16000 default, or 24000) is the rate of the PCM this
   * consumer gets; 16 kHz is resampled natively. A null `onPcm` delivers no
   * PCM to JS at all — the consumer just holds the capture open (passthrough).
   */
  startMicrophoneCapture(
    onPcm: ((pcm: Buffer) => void) | null,
    deviceUid?: string,
    onError?: (message: string) => void,
    sampleRate?: number
  ): MicrophoneConsumerId;
  /** Detaches one consumer; without an id, every consumer and the queue. */
  stopMicrophoneCapture(consumerId?: MicrophoneConsumerId): true;
  getMicrophoneCaptureState?(): MicrophoneCaptureState;
  /** Resolves once ScreenCaptureKit is actually capturing (or rejects). */
  startSystemAudioCapture(
    onPcm: (pcm: Buffer) => void,
    onError?: (message: string) => void,
    sampleRate?: number
  ): Promise<void>;
  /** Callbacks stop immediately; resolves once SCK confirmed the stop. */
  stopSystemAudioCapture(): Promise<void>;
  listAudioCapableApplications?(): AudioCapableApplication[];
  /**
   * Resolves once the tap is capturing (or rejects). Tap / aggregate-device
   * creation runs off the JS thread, like ScreenCaptureKit's start.
   */
  startProcessAudioCapture?(
    bundleId: string,
    onPcm: (pcm: Buffer) => void,
    onError?: (message: string) => void,
    sampleRate?: number
  ): Promise<void>;
  /** Callbacks stop immediately; resolves once the tap is torn down. */
  stopProcessAudioCapture?(): Promise<void>;
  /** `sampleRate` must be 16000 or 24000. */
  prepareTtsOutput(sampleRate: number, devicePattern: string): true;
  /** `pcm` must hold whole Int16 samples (even byte length). */
  playPcm(pcm: Buffer, sampleRate: number, devicePattern: string): true;
  flushTtsOutput(): true;
  closeTtsOutput(): true;
  /** ms of TTS audio queued or in the ring but not yet rendered. */
  getTtsPendingMs?(): number;
  setMicPassthroughEnabled?(enabled: boolean): true;
  configureSubtitleWindow(handle: Buffer): true;
}

const emptyDiagnostics = (): NativeAudioDiagnostics => ({
  mic: {
    level: 0,
    lastPcmAt: 0,
    silenceMs: 0,
    queuedSamples: 0,
    ringSamples: 0,
    droppedSamples: 0,
    routeStatus: 'unsupported',
    lastError: ''
  },
  listen: {
    level: 0,
    lastPcmAt: 0,
    silenceMs: 0,
    queuedSamples: 0,
    ringSamples: 0,
    droppedSamples: 0,
    routeStatus: 'unsupported',
    lastError: ''
  },
  tts: {
    level: 0,
    lastPcmAt: 0,
    silenceMs: 0,
    queuedSamples: 0,
    ringSamples: 0,
    droppedSamples: 0,
    routeStatus: 'unsupported',
    lastError: ''
  }
});

export interface PlatformNativeBridge {
  getCapabilities(): NativeCapabilities;
  getPermissions(): NativePermissionSnapshot;
  listAudioDevices(): NativeAudioDevice[];
  getAudioDiagnostics(): NativeAudioDiagnostics;
  /**
   * Every capture start takes an optional `onError(message)`, fired at most
   * once when the capture stops on its own (device unplugged, permission
   * revoked, target app quit, …) and never after the matching stop call,
   * and an optional `sampleRate` for the 16-bit mono PCM it delivers
   * (16000 by default; 24000 for engines that take it).
   *
   * The microphone is shared: each start attaches a consumer to one native
   * capture and resolves to its id, which the matching
   * `stopMicrophoneCapture(id)` detaches. Consumers come and go without
   * restarting the AudioQueue (a speak session joining the capture mic
   * passthrough keeps open costs nothing), each at its own `sampleRate`. A
   * null `onPcm` attaches a consumer that only holds the capture open — mic
   * passthrough — and no PCM crosses into JS. Starting fails with a clear
   * error when microphone access was denied, or when the input (the system
   * default or `deviceUid`) is the virtual loopback device.
   */
  startMicrophoneCapture(
    onPcm: ((pcm: Uint8Array) => void) | null,
    deviceUid?: string,
    onError?: (message: string) => void,
    sampleRate?: number
  ): Promise<MicrophoneConsumerId>;
  /** Detaches one consumer; the last one out stops the capture. */
  stopMicrophoneCapture(consumerId: MicrophoneConsumerId): Promise<void>;
  /** Every consumer and the capture (bulk teardown only). */
  stopAllMicrophoneCapture(): Promise<void>;
  /** null when the addon can't report it. */
  getMicrophoneCaptureState(): MicrophoneCaptureState | null;
  startSystemAudioCapture(
    onPcm: (pcm: Uint8Array) => void,
    onError?: (message: string) => void,
    sampleRate?: number
  ): Promise<void>;
  stopSystemAudioCapture(): Promise<void>;
  listAudioCapableApplications(): AudioCapableApplication[];
  startProcessAudioCapture(
    bundleId: string,
    onPcm: (pcm: Uint8Array) => void,
    onError?: (message: string) => void,
    sampleRate?: number
  ): Promise<void>;
  stopProcessAudioCapture(): Promise<void>;
  prepareTtsOutput(sampleRate: number): Promise<void>;
  playTtsPcm(pcm: ArrayBuffer, sampleRate: number): Promise<void>;
  flushTtsOutput(): Promise<void>;
  closeTtsOutput(): Promise<void>;
  /**
   * Milliseconds of TTS audio handed to the native output that hasn't been
   * rendered yet (queue + ring). 0 when the addon is unavailable.
   */
  getTtsPendingMs(): number;
  /**
   * Tee mic capture into the virtual loopback output device. When true, the
   * native mic callback writes raw PCM into the same TTS pipeline that
   * translated audio uses, so meeting peers hear the speaker untranslated.
   * Caller must ensure a mic consumer is attached and the virtual output is
   * prepared at 24 kHz before enabling. Mutually exclusive with translated
   * TTS playing — the tee is independent of which consumers are attached,
   * so turning it off is all a speak session needs.
   */
  setMicPassthroughEnabled(enabled: boolean): Promise<void>;
  configureSubtitleWindow(window: BrowserWindow): Promise<void>;
}

class UnsupportedNativeBridge implements PlatformNativeBridge {
  constructor(private readonly reason: string) {}

  getCapabilities(): NativeCapabilities {
    return {
      platform: process.platform,
      systemAudioCapture: false,
      nativeTtsPlayback: false,
      microphoneCapture: false,
      audioDevices: false,
      permissions: false,
      windowBehavior: false,
      hasVirtualOutput: false,
      reason: this.reason
    };
  }

  getPermissions(): NativePermissionSnapshot {
    return {
      screen: 'unknown',
      microphone: 'unknown',
      inputMonitoring: 'unknown',
      accessibility: 'unknown'
    };
  }

  listAudioDevices(): NativeAudioDevice[] {
    return [];
  }

  getAudioDiagnostics(): NativeAudioDiagnostics {
    return emptyDiagnostics();
  }

  async startMicrophoneCapture(
    _onPcm: ((pcm: Uint8Array) => void) | null,
    _deviceUid?: string
  ): Promise<MicrophoneConsumerId> {
    throw new Error(this.reason);
  }

  async stopMicrophoneCapture(_consumerId: MicrophoneConsumerId): Promise<void> {
    // no-op
  }

  async stopAllMicrophoneCapture(): Promise<void> {
    // no-op
  }

  getMicrophoneCaptureState(): MicrophoneCaptureState | null {
    return null;
  }

  async startSystemAudioCapture(): Promise<void> {
    throw new Error(this.reason);
  }

  async stopSystemAudioCapture(): Promise<void> {
    // no-op
  }

  listAudioCapableApplications(): AudioCapableApplication[] {
    return [];
  }

  async startProcessAudioCapture(): Promise<void> {
    throw new Error(this.reason);
  }

  async stopProcessAudioCapture(): Promise<void> {
    // no-op
  }

  async prepareTtsOutput(): Promise<void> {
    throw new Error(this.reason);
  }

  async playTtsPcm(): Promise<void> {
    throw new Error(this.reason);
  }

  async flushTtsOutput(): Promise<void> {
    // no-op
  }

  async closeTtsOutput(): Promise<void> {
    // no-op
  }

  getTtsPendingMs(): number {
    return 0;
  }

  async setMicPassthroughEnabled(): Promise<void> {
    // no-op
  }

  async configureSubtitleWindow(): Promise<void> {
    // no-op
  }
}

export interface NativeBridgeConfig {
  platform: NodeJS.Platform;
  addon: NativeAddon;
  /** Regex matching the platform's virtual loopback output device names. */
  virtualOutputPattern: string;
}

/**
 * Capability answers barely change, but `getCapabilities()` sits on every
 * capture start / TTS prepare and used to walk every CoreAudio device. The
 * native side already caches the device walk behind a device-list listener;
 * this short TTL also skips the N-API round trip on bursts of calls.
 */
const CAPABILITIES_TTL_MS = 1000;

const toUint8Array = (pcm: Buffer): Uint8Array =>
  new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);

/**
 * Native callbacks run from a TSFN; a throw there surfaces as an uncaught
 * exception in the main process, so contain it.
 */
const wrapPcm =
  (label: string, onPcm: (pcm: Uint8Array) => void) =>
  (pcm: Buffer): void => {
    try {
      onPcm(toUint8Array(pcm));
    } catch (err) {
      log.warn(`${label} PCM handler threw:`, err);
    }
  };

const wrapError =
  (label: string, onError?: (message: string) => void) =>
  (message: string): void => {
    log.warn(`${label} capture stopped unexpectedly: ${message}`);
    if (!onError) return;
    try {
      onError(message);
    } catch (err) {
      log.warn(`${label} error handler threw:`, err);
    }
  };

/**
 * Generic, platform-agnostic wrapper around a `NativeAddon`. The methods
 * here are the same shape on macOS or Windows; only the underlying addon
 * binding and the virtual-output device pattern differ. Platform-specific
 * loaders (`mac-bridge.ts`, `windows-bridge.ts`) construct this with the
 * right config.
 */
export class NativeBridge implements PlatformNativeBridge {
  private readonly addon: NativeAddon;
  private readonly platform: NodeJS.Platform;
  private readonly virtualOutputPattern: string;
  private capabilitiesCache: { value: NativeCapabilities; at: number } | null = null;

  constructor(config: NativeBridgeConfig) {
    this.addon = config.addon;
    this.platform = config.platform;
    this.virtualOutputPattern = config.virtualOutputPattern;
  }

  getCapabilities(): NativeCapabilities {
    const now = Date.now();
    const cached = this.capabilitiesCache;
    if (cached && now - cached.at < CAPABILITIES_TTL_MS) return { ...cached.value };
    const caps = this.addon.getCapabilities();
    const value: NativeCapabilities = {
      platform: this.platform,
      minimumMacOS: caps.minimumMacOS,
      systemAudioCapture: caps.systemAudioCapture,
      nativeTtsPlayback: caps.nativeTtsPlayback,
      processAudioCapture: caps.processAudioCapture,
      microphoneCapture: caps.microphoneCapture,
      audioDevices: caps.audioDevices,
      permissions: caps.permissions,
      windowBehavior: caps.windowBehavior,
      hasVirtualOutput: caps.hasVirtualOutput,
      reason: caps.reason
    };
    this.capabilitiesCache = { value, at: now };
    return { ...value };
  }

  getPermissions(): NativePermissionSnapshot {
    return this.addon.getPermissions();
  }

  listAudioDevices(): NativeAudioDevice[] {
    return this.addon.listAudioDevices();
  }

  getAudioDiagnostics(): NativeAudioDiagnostics {
    return this.addon.getAudioDiagnostics();
  }

  async startMicrophoneCapture(
    onPcm: ((pcm: Uint8Array) => void) | null,
    deviceUid?: string,
    onError?: (message: string) => void,
    sampleRate?: number
  ): Promise<MicrophoneConsumerId> {
    const caps = this.getCapabilities();
    if (!caps.microphoneCapture) {
      throw new Error(caps.reason ?? 'native microphone capture is unavailable');
    }
    return this.addon.startMicrophoneCapture(
      onPcm ? wrapPcm('microphone', onPcm) : null,
      deviceUid,
      wrapError('microphone', onError),
      sampleRate
    );
  }

  async stopMicrophoneCapture(consumerId: MicrophoneConsumerId): Promise<void> {
    this.addon.stopMicrophoneCapture(consumerId);
  }

  async stopAllMicrophoneCapture(): Promise<void> {
    this.addon.stopMicrophoneCapture();
  }

  getMicrophoneCaptureState(): MicrophoneCaptureState | null {
    if (!this.addon.getMicrophoneCaptureState) return null;
    try {
      return this.addon.getMicrophoneCaptureState();
    } catch (err) {
      log.warn('getMicrophoneCaptureState failed:', err);
      return null;
    }
  }

  async startSystemAudioCapture(
    onPcm: (pcm: Uint8Array) => void,
    onError?: (message: string) => void,
    sampleRate?: number
  ): Promise<void> {
    const caps = this.getCapabilities();
    if (!caps.systemAudioCapture) {
      throw new Error(caps.reason ?? 'native system audio capture is unavailable');
    }
    // Async in native: SCK start completes off the main thread.
    await this.addon.startSystemAudioCapture(
      wrapPcm('system audio', onPcm),
      wrapError('system audio', onError),
      sampleRate
    );
  }

  async stopSystemAudioCapture(): Promise<void> {
    await this.addon.stopSystemAudioCapture();
  }

  listAudioCapableApplications(): AudioCapableApplication[] {
    if (!this.addon.listAudioCapableApplications) return [];
    try {
      return this.addon.listAudioCapableApplications();
    } catch (err) {
      log.warn('listAudioCapableApplications failed:', err);
      return [];
    }
  }

  async startProcessAudioCapture(
    bundleId: string,
    onPcm: (pcm: Uint8Array) => void,
    onError?: (message: string) => void,
    sampleRate?: number
  ): Promise<void> {
    const caps = this.getCapabilities();
    if (!caps.processAudioCapture || !this.addon.startProcessAudioCapture) {
      throw new Error(
        caps.reason ??
          'Process audio capture requires macOS 14.4 or newer (Core Audio Process Tap).'
      );
    }
    // Async in native: the tap is built off the main thread.
    await this.addon.startProcessAudioCapture(
      bundleId,
      wrapPcm('process audio', onPcm),
      wrapError('process audio', onError),
      sampleRate
    );
  }

  async stopProcessAudioCapture(): Promise<void> {
    if (this.addon.stopProcessAudioCapture) {
      await this.addon.stopProcessAudioCapture();
    }
  }

  async prepareTtsOutput(sampleRate: number): Promise<void> {
    const caps = this.getCapabilities();
    if (!caps.nativeTtsPlayback) {
      throw new Error(caps.reason ?? 'native TTS playback is unavailable');
    }
    if (!caps.hasVirtualOutput) {
      // Don't let a stale cached "absent" outlive the user installing the driver.
      this.capabilitiesCache = null;
      throw new Error('virtual loopback output device not found');
    }
    this.addon.prepareTtsOutput(sampleRate, this.virtualOutputPattern);
  }

  async playTtsPcm(pcm: ArrayBuffer, sampleRate: number): Promise<void> {
    this.addon.playPcm(Buffer.from(pcm), sampleRate, this.virtualOutputPattern);
  }

  async flushTtsOutput(): Promise<void> {
    this.addon.flushTtsOutput();
  }

  async closeTtsOutput(): Promise<void> {
    this.addon.closeTtsOutput();
  }

  getTtsPendingMs(): number {
    if (!this.addon.getTtsPendingMs) return 0;
    try {
      const pending = this.addon.getTtsPendingMs();
      return Number.isFinite(pending) && pending > 0 ? pending : 0;
    } catch (err) {
      log.warn('getTtsPendingMs failed:', err);
      return 0;
    }
  }

  async setMicPassthroughEnabled(enabled: boolean): Promise<void> {
    if (!this.addon.setMicPassthroughEnabled) return;
    this.addon.setMicPassthroughEnabled(enabled);
  }

  async configureSubtitleWindow(window: BrowserWindow): Promise<void> {
    if (!this.getCapabilities().windowBehavior) return;
    this.addon.configureSubtitleWindow(window.getNativeWindowHandle());
  }
}

// Per-platform factories. Both modules are tiny — keeping static imports
// is simpler than lazy `require()` and lets the bundler tree-shake.
import { createMacBridge } from './mac-bridge.js';
import { createWindowsBridge } from './windows-bridge.js';

const createBridge = (): PlatformNativeBridge => {
  if (process.platform === 'darwin') {
    return (
      createMacBridge() ??
      new UnsupportedNativeBridge(
        'macOS native bridge is not built or could not be loaded'
      )
    );
  }
  if (process.platform === 'win32') {
    return (
      createWindowsBridge() ??
      new UnsupportedNativeBridge(
        'Windows native bridge is not implemented yet'
      )
    );
  }
  return new UnsupportedNativeBridge(
    `Native bridge is not implemented for platform=${process.platform}`
  );
};

export const platformNativeBridge = createBridge();

export const stopAllNativeAudioServices = async (): Promise<void> => {
  await Promise.allSettled([
    platformNativeBridge.stopAllMicrophoneCapture(),
    platformNativeBridge.stopSystemAudioCapture(),
    platformNativeBridge.stopProcessAudioCapture(),
    platformNativeBridge.closeTtsOutput()
  ]).then((results) => {
    results.forEach((result) => {
      if (result.status === 'rejected') {
        log.warn('native service cleanup failed:', result.reason);
      }
    });
  });
};
