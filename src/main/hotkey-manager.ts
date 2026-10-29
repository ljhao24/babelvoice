import { globalShortcut } from 'electron';
import { broadcastToAllRenderers } from './window-manager.js';
import { IPC } from '@shared/ipc-types.js';
import { log } from '@core/utils/logger.js';

/**
 * Global toggle hotkey via Electron's globalShortcut (Carbon
 * RegisterEventHotKey on macOS).
 *
 * This replaced the native listen-only CGEventTap, which (a) couldn't
 * swallow the combo, so the default Option+Space also typed a no-break
 * space into whatever app had focus (e.g. the meeting chat), (b) fired on
 * key auto-repeat, so holding the combo toggled start/cancel repeatedly, and
 * (c) required the Input Monitoring permission. The tap only existed for
 * push-to-talk key-up events, which the toggle model no longer uses.
 */

/** Presses closer together than this are one physical press. */
const PRESS_DEBOUNCE_MS = 300;

let registeredAccelerator: string | null = null;
/** The stored-form hotkey currently registered, kept across a suspend. */
let activeHotkey: string | null = null;
let suspended = false;
let lastPressAt = 0;

const MODIFIERS: Record<string, string> = {
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift'
};

const KEYS: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  return: 'Return',
  enter: 'Return',
  // The Mac "delete" key is backspace; forward delete is Electron's Delete.
  delete: 'Backspace',
  backspace: 'Backspace',
  forwarddelete: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  left: 'Left',
  leftarrow: 'Left',
  right: 'Right',
  rightarrow: 'Right',
  up: 'Up',
  uparrow: 'Up',
  down: 'Down',
  downarrow: 'Down',
  minus: '-',
  equal: '=',
  comma: ',',
  period: '.',
  slash: '/',
  semicolon: ';',
  quote: "'",
  backslash: '\\',
  leftbracket: '[',
  rightbracket: ']',
  grave: '`',
  backtick: '`'
};

/**
 * Stored hotkeys use the token set of the capture UI
 * (renderer/lib/accelerator.ts), e.g. "Option+Space", "Command+ForwardDelete".
 * Map them onto Electron accelerator names so existing preferences keep
 * working. Returns null for anything Electron can't express.
 */
export const toElectronAccelerator = (accelerator: string): string | null => {
  const tokens = accelerator
    .split('+')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const out: string[] = [];
  for (const [i, raw] of tokens.entries()) {
    const token = raw.toLowerCase();
    const isLast = i === tokens.length - 1;
    if (!isLast) {
      const mod = MODIFIERS[token];
      if (!mod) return null;
      out.push(mod);
      continue;
    }
    if (/^[a-z0-9]$/.test(token)) out.push(token.toUpperCase());
    else if (/^f([1-9]|1[0-9]|20)$/.test(token)) out.push(token.toUpperCase());
    else if (KEYS[token]) out.push(KEYS[token]);
    else return null;
  }
  return out.join('+');
};

const onPressed = (accelerator: string): void => {
  const now = Date.now();
  if (now - lastPressAt < PRESS_DEBOUNCE_MS) return;
  lastPressAt = now;
  log.info('hotkey pressed', accelerator);
  broadcastToAllRenderers(IPC.HotkeyPressed, { accelerator, at: now });
};

const registerNow = (
  accelerator: string,
  electronAccelerator: string
): boolean => {
  try {
    const ok = globalShortcut.register(electronAccelerator, () =>
      onPressed(accelerator)
    );
    if (!ok) {
      log.warn(`Hotkey ${accelerator} is held by another app`);
      return false;
    }
    registeredAccelerator = electronAccelerator;
    return true;
  } catch (err) {
    log.warn(`Failed to register hotkey ${accelerator}:`, err);
    return false;
  }
};

export const registerHotkey = async (accelerator: string): Promise<boolean> => {
  // Validate before dropping the current binding, so a bad value leaves the
  // working hotkey in place.
  const electronAccelerator =
    typeof accelerator === 'string' ? toElectronAccelerator(accelerator) : null;
  if (!electronAccelerator) {
    log.warn(`Unsupported hotkey ${String(accelerator)}`);
    return false;
  }
  unregisterHotkeyNow();
  activeHotkey = accelerator;
  const ok = registerNow(accelerator, electronAccelerator);
  // While the capture UI is open, only probe availability; resumeHotkey()
  // binds it for real.
  if (ok && suspended) unregisterHotkeyNow();
  return ok;
};

/**
 * Release the global binding while the renderer captures a new hotkey —
 * otherwise pressing the current combo is swallowed by the OS (never reaches
 * the capture modal) and toggles the speak session instead.
 */
export const suspendHotkey = (): void => {
  suspended = true;
  unregisterHotkeyNow();
};

export const resumeHotkey = (): void => {
  if (!suspended) return;
  suspended = false;
  if (registeredAccelerator || !activeHotkey) return;
  const electronAccelerator = toElectronAccelerator(activeHotkey);
  if (electronAccelerator) registerNow(activeHotkey, electronAccelerator);
};

const unregisterHotkeyNow = (): void => {
  if (registeredAccelerator) {
    globalShortcut.unregister(registeredAccelerator);
    registeredAccelerator = null;
  }
};

export const unregisterHotkey = async (): Promise<void> => {
  unregisterHotkeyNow();
  activeHotkey = null;
};

export const unregisterAll = (): void => {
  globalShortcut.unregisterAll();
  registeredAccelerator = null;
  activeHotkey = null;
};
