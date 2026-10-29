import { app, BrowserWindow, nativeTheme, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPreferences } from './config-store.js';
import { platformNativeBridge } from './native/platform-native-bridge.js';
import { subtitleOverlayCoordinator } from './subtitle-overlay-coordinator.js';
import { IPC } from '@shared/ipc-types.js';
import { log } from '@core/utils/logger.js';

const here = dirname(fileURLToPath(import.meta.url));

interface Windows {
  control: BrowserWindow | null;
  subtitle: BrowserWindow | null;
}

const windows: Windows = { control: null, subtitle: null };

// Registered at import time, i.e. before any window exists, so it runs ahead
// of the close events a quit triggers.
let quitting = false;
app.on('before-quit', () => {
  quitting = true;
});

const preloadPath = join(here, '..', 'preload', 'index.mjs');

const isDev = !!process.env.ELECTRON_RENDERER_URL;
const rendererUrl = process.env.ELECTRON_RENDERER_URL ?? '';

const loadRenderer = (win: BrowserWindow, htmlFile: string): void => {
  if (isDev) {
    win.loadURL(`${rendererUrl}/${htmlFile}`);
  } else {
    win.loadFile(join(here, '..', 'renderer', htmlFile));
  }
};

const CRASH_RELOAD_COOLDOWN_MS = 10_000;

/**
 * Sessions live in main and keep running when a renderer crashes, so a dead
 * renderer means silently lost subtitles / transcript persistence. Reload it;
 * on mount it re-syncs session statuses (TranslationGetStatuses).
 */
const reloadOnCrash = (win: BrowserWindow, name: string): void => {
  let lastReloadAt = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`${name} renderer gone (${details.reason}, exit ${details.exitCode})`);
    if (details.reason === 'clean-exit' || win.isDestroyed()) return;
    // A renderer that dies again right after reloading is crash-looping.
    if (Date.now() - lastReloadAt < CRASH_RELOAD_COOLDOWN_MS) return;
    lastReloadAt = Date.now();
    win.webContents.reload();
  });
};

/**
 * What the control window paints before the renderer's first frame: the
 * window background (`--background`) of the theme the UI is about to use,
 * so opening it never flashes the other theme.
 */
const controlWindowBackground = (): string => {
  const { theme } = getPreferences();
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? '#1e1e1e' : '#f5f5f7';
};

export const createControlWindow = (): BrowserWindow => {
  if (windows.control && !windows.control.isDestroyed()) return windows.control;

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'BabelVoice',
    backgroundColor: controlWindowBackground(),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  loadRenderer(win, 'index.html');
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  reloadOnCrash(win, 'control');

  // macOS keeps the app running when the window is closed, and sessions keep
  // running with it. This renderer owns transcript stitching + persistence
  // and the hotkey subscription, so destroying it silently stopped saving
  // the meeting and left the hotkey dead. Hide instead; Dock/tray reopen it.
  win.on('close', (e) => {
    if (process.platform === 'darwin' && !quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    windows.control = null;
  });

  windows.control = win;
  return win;
};

/**
 * Default overlay size: tall enough for a few lines of history above the
 * live caption. Centered near the bottom of the primary display, never
 * taller than its work area allows.
 */
const SUBTITLE_WIDTH = 720;
const SUBTITLE_HEIGHT = 400;
const SUBTITLE_BOTTOM_MARGIN = 40;

export const createSubtitleOverlay = (): BrowserWindow => {
  if (windows.subtitle && !windows.subtitle.isDestroyed()) return windows.subtitle;

  subtitleOverlayCoordinator.reset();
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;
  const overlayHeight = Math.min(SUBTITLE_HEIGHT, height - 2 * SUBTITLE_BOTTOM_MARGIN);

  const win = new BrowserWindow({
    width: SUBTITLE_WIDTH,
    height: overlayHeight,
    x: Math.floor((width - SUBTITLE_WIDTH) / 2),
    y: height - overlayHeight - SUBTITLE_BOTTOM_MARGIN,
    show: false,
    transparent: true,
    frame: false,
    resizable: true,
    // The whole panel is a drag region; on macOS double-clicking one runs
    // the title-bar zoom action, which would blow the overlay up to fill
    // the screen.
    maximizable: false,
    fullscreenable: false,
    // Do NOT set skipTaskbar:true on macOS. Combined with transparent +
    // frame:false + alwaysOnTop it triggers the panel-style window path
    // and Electron flips the app into accessory mode, hiding the Dock icon.
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  // Floating level keeps it above normal windows without escalating to
  // panel level (which is what hides the Dock icon).
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void platformNativeBridge.configureSubtitleWindow(win);
  // Any (re)load — including the crash reload below — unmounts the page that
  // announced readiness; the new one must announce again before events flow.
  win.webContents.on('did-start-loading', () => subtitleOverlayCoordinator.reset());
  reloadOnCrash(win, 'subtitle');
  loadRenderer(win, 'subtitle.html');

  // Every show/hide path (session auto-show, the overlay's close button, the
  // control panel toggle) lands here, so the control window's toggle button
  // always mirrors the real state.
  const notifyVisibility = (): void =>
    sendToControlWindow(IPC.SubtitleVisibility, isSubtitleOverlayVisible());
  win.on('show', notifyVisibility);
  win.on('hide', notifyVisibility);

  win.on('closed', () => {
    windows.subtitle = null;
    subtitleOverlayCoordinator.abandon();
    notifyVisibility();
  });

  windows.subtitle = win;

  // Creating a transparent + frameless overlay can briefly flip the app into
  // accessory mode on macOS. Keep the Dock icon visible after construction.
  if (process.platform === 'darwin') {
    void app.dock?.show();
  }
  return win;
};

export const markSubtitleOverlayReady = (): void => {
  const win = windows.subtitle;
  if (!win || win.isDestroyed()) return;
  subtitleOverlayCoordinator.markReady(win.id);
};

export const ensureSubtitleOverlayReady = async (): Promise<void> => {
  const win = createSubtitleOverlay();
  if (!win.isVisible()) win.showInactive();
  await subtitleOverlayCoordinator.awaitReady(win.id);
};

export const showSubtitleOverlay = (): void => {
  const win = createSubtitleOverlay();
  if (!win.isVisible()) win.showInactive();
  if (process.platform === 'darwin') {
    void app.dock?.show();
  }
};

export const hideSubtitleOverlay = (): void => {
  const win = windows.subtitle;
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
};

export const isSubtitleOverlayVisible = (): boolean => {
  const win = windows.subtitle;
  return !!win && !win.isDestroyed() && win.isVisible();
};

export const toggleSubtitleOverlay = (): boolean => {
  const win = windows.subtitle;
  if (win && !win.isDestroyed() && win.isVisible()) {
    win.hide();
    return false;
  }
  showSubtitleOverlay();
  return true;
};

export const broadcastToAllRenderers = (
  channel: string,
  ...args: unknown[]
): void => {
  for (const w of [windows.control, windows.subtitle]) {
    if (w && !w.isDestroyed()) {
      w.webContents.send(channel, ...args);
    }
  }
};

/** Channels only the control window consumes (e.g. TTS chunks). */
export const sendToControlWindow = (
  channel: string,
  ...args: unknown[]
): void => {
  const w = windows.control;
  if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
};

/** Bring the (possibly hidden) control window forward, creating it if needed. */
export const showControlWindow = (): BrowserWindow => {
  const win = createControlWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
};

export const getControlWindow = (): BrowserWindow | null => windows.control;
export const getSubtitleWindow = (): BrowserWindow | null => windows.subtitle;
