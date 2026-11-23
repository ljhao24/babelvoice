/**
 * Windows-side wiring for the cross-platform NativeBridge: locates and loads
 * the WASAPI .node addon (`native/win/`), then constructs a NativeBridge
 * with the Windows device pattern (see `platform/windows.ts`'s
 * `VIRTUAL_OUTPUT_PATTERN`). Mirrors `mac-bridge.ts`.
 */
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { log } from '@core/utils/logger.js';
import { VIRTUAL_OUTPUT_PATTERN } from '../platform/windows.js';
import {
  NativeBridge,
  type NativeAddon,
  type PlatformNativeBridge
} from './platform-native-bridge.js';

const require = createRequire(import.meta.url);
let cachedAddon: NativeAddon | null | undefined;

const loadWindowsAddon = (): NativeAddon | null => {
  if (cachedAddon !== undefined) return cachedAddon;
  cachedAddon = null;

  const archDir = `win32-${process.arch}`;
  const candidates = [
    join(process.resourcesPath, 'native', archDir, 'babelvoice_native.node'),
    join(app.getAppPath(), 'resources', 'native', archDir, 'babelvoice_native.node'),
    join(app.getAppPath(), 'build', 'Release', 'babelvoice_native.node'),
    join(process.cwd(), 'resources', 'native', archDir, 'babelvoice_native.node'),
    join(process.cwd(), 'build', 'Release', 'babelvoice_native.node')
  ];

  const addonPath = candidates.find((path) => existsSync(path));
  if (!addonPath) {
    log.warn('Windows native addon not found in expected locations');
    return cachedAddon;
  }

  try {
    cachedAddon = require(addonPath) as NativeAddon;
    return cachedAddon;
  } catch (err) {
    log.error('failed to load Windows native addon:', err);
    cachedAddon = null;
    return cachedAddon;
  }
};

export const createWindowsBridge = (): PlatformNativeBridge | null => {
  const addon = loadWindowsAddon();
  if (!addon) return null;
  return new NativeBridge({
    platform: 'win32',
    addon,
    virtualOutputPattern: VIRTUAL_OUTPUT_PATTERN
  });
};
