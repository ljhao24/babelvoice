// Load `.env` from the project root before anything reads process.env.
// Production builds inherit env from however electron-builder ships them
// (LaunchAgents, plist, etc.); the .env path is a dev-time convenience so
// `npm run dev` works regardless of how the user starts it.
import 'dotenv/config';
import { app } from 'electron';
import electronLog from 'electron-log';
import {
  broadcastToAllRenderers,
  createControlWindow,
  showControlWindow
} from './window-manager.js';
import { registerHotkey, unregisterAll } from './hotkey-manager.js';
import { registerIpcHandlers } from './ipc/index.js';
import { meetingMonitor, sessionOrchestrator } from './app-services.js';
import { micPassthroughCoordinator } from './sessions/mic-passthrough-coordinator.js';
import { createTray } from './tray.js';
import { getPreferences } from './config-store.js';
import { setLogSink, log } from '@core/utils/logger.js';
import {
  closeDb,
  endMeeting,
  getCurrentMeetingId,
  recoverCrashedMeetings,
  setIdleTimeoutHandler,
  setMeetingActiveHandler
} from './meetings/index.js';
import { MEETING_IPC } from '@shared/meeting-types.js';
import { IPC } from '@shared/ipc-types.js';
import { initI18n, subscribeLocale } from './i18n.js';

// `DOUBAO_VERBOSE=1` (or =2) also lifts electron-log to debug so log.debug
// calls in the doubao client land in the terminal / log file.
if (process.env.DOUBAO_VERBOSE) {
  electronLog.transports.console.level = 'debug';
  electronLog.transports.file.level = 'debug';
}

setLogSink({
  info: (...a) => electronLog.info(...a),
  warn: (...a) => electronLog.warn(...a),
  error: (...a) => electronLog.error(...a),
  debug: (...a) => electronLog.debug(...a)
});

app.setName('BabelVoice');

// Take the single-instance lock before anything touches shared state. A
// second instance used to run recoverCrashedMeetings() first — stamping the
// running instance's live meeting as crashed — and, since app.quit() is
// async, go on to register the hotkey.
// Dev-only: `BABELVOICE_SOAK` runs the provider soak test instead of the app
// (dev/soak-test.ts). It touches no shared state, so it takes no lock: the
// app, or another soak, can run alongside.
const soakTest = !app.isPackaged && Boolean(process.env.BABELVOICE_SOAK);
const isPrimaryInstance = soakTest || app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  log.warn('another instance is running; exiting this one');
  app.exit(0);
}

const onReady = async (): Promise<void> => {
  // Resolve the user's UI locale before any service throws an i18n'd error
  // string — services initialised below can call `t()` synchronously and
  // would otherwise log a "missing translation" warning during the first
  // call.
  initI18n();

  if (soakTest) {
    const { runSoakTest } = await import('./dev/soak-test.js');
    await runSoakTest();
    app.exit(0);
    return;
  }

  subscribeLocale((locale) => {
    broadcastToAllRenderers(IPC.I18nLocaleChanged, locale);
  });

  recoverCrashedMeetings();
  // Mic passthrough holds the mic only while a meeting is open.
  setMeetingActiveHandler((active) => micPassthroughCoordinator.setMeetingActive(active));
  setIdleTimeoutHandler(() => {
    void sessionOrchestrator.cancelAll('halt');
    const ended = endMeeting('idle-timeout');
    meetingMonitor.sync();
    if (ended) {
      broadcastToAllRenderers(MEETING_IPC.AutoEnded, ended);
    }
  });
  registerIpcHandlers();
  createControlWindow();
  createTray();

  const prefs = getPreferences();
  if (!(await registerHotkey(prefs.hotkey))) {
    log.warn(
      `Hotkey ${prefs.hotkey} unavailable; another app may be holding it`
    );
  }
  // Boot the mic passthrough state machine from persisted prefs. No-op when
  // the user hasn't opted in; otherwise engages once a meeting opens, so the
  // meeting peer hears the speaker even before any translation session starts.
  micPassthroughCoordinator.setMicrophoneDeviceUid(prefs.preferredMicrophoneUid);
  micPassthroughCoordinator.setDesired(prefs.micPassthroughWhenIdle);
};

if (isPrimaryInstance) {
  app.whenReady().then(onReady).catch((err) => {
    log.error('Failed to start app:', err);
    app.quit();
  });
}

// Relaunching the app (Dock, Spotlight, `open -n`) lands here instead of
// starting a second copy; bring the existing window forward.
app.on('second-instance', () => {
  if (app.isReady()) showControlWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // The control window hides on close (window-manager), and the overlay
  // counts as a window too, so "no windows → create" never fired.
  showControlWindow();
});

/** Upper bound on graceful shutdown before we quit regardless. */
const QUIT_CLEANUP_TIMEOUT_MS = 2000;
let shutdownStarted = false;

app.on('before-quit', (e) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  // Hold the quit until sessions and native capture are stopped. The mic
  // AudioQueue (passthrough runs it in a meeting even with no session) and
  // ScreenCaptureKit threads call into N-API callbacks that Node frees at
  // env teardown — they must be gone before that.
  e.preventDefault();
  void (async () => {
    try {
      await Promise.race([
        sessionOrchestrator.cancelAll('halt'),
        new Promise((resolve) => setTimeout(resolve, QUIT_CLEANUP_TIMEOUT_MS))
      ]);
      if (getCurrentMeetingId()) endMeeting('app-quit');
    } catch (err) {
      log.error('cleanup on quit failed:', err);
    } finally {
      app.quit();
    }
  })();
});

app.on('will-quit', () => {
  unregisterAll();
  // The ended meeting's last usage totals, before the DB goes away.
  meetingMonitor.dispose();
  closeDb();
});
