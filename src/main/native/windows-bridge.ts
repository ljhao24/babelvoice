/**
 * Windows-side wiring for the cross-platform NativeBridge.
 *
 * TODO(v2-windows): build out a `windows_audio_bridge.cpp` (WASAPI capture
 * + WASAPI playback to VB-Cable + Win32 keyboard hooks) exposing the
 * `NativeAddon` surface, ship the compiled `.node` next to the macOS one,
 * and have `loadWindowsAddon()` find it. The bridge logic is the same
 * generic `NativeBridge` — only the addon binding and device pattern differ.
 */
import type { PlatformNativeBridge } from './platform-native-bridge.js';

export const createWindowsBridge = (): PlatformNativeBridge | null => {
  // Returning null lets `createBridge` fall through to UnsupportedNativeBridge
  // with a Windows-specific reason.
  return null;
};
