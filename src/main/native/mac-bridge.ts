/**
 * macOS-side wiring for the cross-platform NativeBridge: locates and loads
 * the .node addon, then constructs a NativeBridge with the macOS device
 * pattern (see `platform/macos.ts`'s `VIRTUAL_OUTPUT_PATTERN`).
 *
 * The bridge logic itself is platform-agnostic — see
 * `platform-native-bridge.ts`. This file only owns the macOS-specific
 * concerns: where the `.node` lives and what device pattern to inject.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { log } from '@core/utils/logger.js';
import { VIRTUAL_OUTPUT_PATTERN } from '../platform/macos.js';
import {
  NativeBridge,
  type NativeAddon,
  type PlatformNativeBridge
} from './platform-native-bridge.js';

const require = createRequire(import.meta.url);
let cachedAddon: NativeAddon | null | undefined;

const loadMacAddon = (): NativeAddon | null => {
  if (cachedAddon !== undefined) return cachedAddon;
  cachedAddon = null;

  const archDir = `darwin-${process.arch}`;
  const candidates = [
    join(process.resourcesPath, 'native', archDir, 'babelvoice_native.node'),
    join(app.getAppPath(), 'resources', 'native', archDir, 'babelvoice_native.node'),
    join(app.getAppPath(), 'build', 'Release', 'babelvoice_native.node'),
    join(process.cwd(), 'resources', 'native', archDir, 'babelvoice_native.node'),
    join(process.cwd(), 'build', 'Release', 'babelvoice_native.node')
  ];

  const addonPath = candidates.find((path) => existsSync(path));
  if (!addonPath) {
    log.warn('macOS native addon not found in expected locations');
    return cachedAddon;
  }

  try {
    cachedAddon = require(addonPath) as NativeAddon;
    return cachedAddon;
  } catch (err) {
    log.error('failed to load macOS native addon:', err);
    cachedAddon = null;
    return cachedAddon;
  }
};

export const createMacBridge = (): PlatformNativeBridge | null => {
  const addon = loadMacAddon();
  if (!addon) return null;
  return new NativeBridge({
    platform: 'darwin',
    addon,
    virtualOutputPattern: VIRTUAL_OUTPUT_PATTERN
  });
};
