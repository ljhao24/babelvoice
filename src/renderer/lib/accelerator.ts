/**
 * Browser KeyboardEvent ⇄ Electron-accelerator string utilities for the
 * hotkey capture UI.
 *
 * Authority: `toElectronAccelerator` in `src/main/hotkey-manager.ts` maps
 * these tokens onto Electron globalShortcut names and decides which
 * accelerators actually register. Keep the tables below in lockstep with it
 * so the capture modal can reject combos before the user tries to save.
 *
 * Capability summary (toggle model — solo modifiers / push-to-talk are
 * intentionally not supported):
 *   - Combo: any modifier(s) + one main key (A–Z, 0–9, F1–F20, Space,
 *     Tab, Return, Delete/Backspace, ForwardDelete, arrows, Home/End/
 *     PageUp/PageDown, common punctuation).
 *   - Function-key solo (e.g. F2, F19) — no modifier required.
 *   - A modifier-only press surfaces as a captured value so the modal
 *     can show what the user pressed and explain it isn't acceptable;
 *     `validateAccelerator` rejects it.
 */

export type AcceleratorPart = {
  /** Display label (macOS symbol for modifiers, plain label for keys). */
  display: string;
  /** Whether the part is a modifier or the main key. */
  kind: 'modifier' | 'key';
};

interface KeyEventInput {
  key: string;
  code?: string;
  /** 0=standard, 1=left, 2=right, 3=numpad. Mirrors DOM KeyboardEvent. */
  location?: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_KEY_NAMES = new Set([
  'Control',
  'Meta',
  'Alt',
  'AltGraph',
  'Shift',
  'CapsLock',
  'OS',
  'Fn',
  'FnLock'
]);

// Tokens accepted as modifiers when sitting alongside a main key.
// Apple's CGEvent flags are not side-aware, so we don't expose
// LeftCommand/RightOption/etc. — they would all collapse to the same
// bitmask and the toggle model has no use for the distinction.
const COMBO_MODIFIER_TOKENS = new Set<string>([
  'command',
  'cmd',
  'control',
  'ctrl',
  'option',
  'alt',
  'shift'
]);

// Main-key tokens. Mirror native MainKeyTable.
const MAIN_KEY_TOKENS = new Set<string>([
  // Letters
  'a','b','c','d','e','f','g','h','i','j','k','l','m',
  'n','o','p','q','r','s','t','u','v','w','x','y','z',
  // Digits
  '0','1','2','3','4','5','6','7','8','9',
  // Function keys
  'f1','f2','f3','f4','f5','f6','f7','f8','f9','f10',
  'f11','f12','f13','f14','f15','f16','f17','f18','f19','f20',
  // Named keys
  'space','tab','return','enter','delete','backspace','forwarddelete',
  'home','end','pageup','pagedown',
  'left','leftarrow','right','rightarrow',
  'up','uparrow','down','downarrow',
  // Punctuation
  'minus','equal','comma','period','slash','semicolon','quote',
  'backslash','leftbracket','rightbracket','grave','backtick'
]);

function tokenize(accel: string): string[] {
  return accel
    .split(/[+ ]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function isFunctionKeyToken(tok: string): boolean {
  return /^f([1-9]|1\d|20)$/.test(tok);
}

/**
 * Build an Electron accelerator from a keyboard event. Returns `null`
 * for events that aren't directly capturable (Esc — reserved as the
 * universal cancel). Modifier-only keydowns return the bare modifier
 * name so the capture modal can preview what the user pressed and
 * explain why it isn't acceptable; `validateAccelerator` then rejects it.
 */
export function keyEventToAccelerator(e: KeyEventInput): string | null {
  if (e.key === 'Escape') return null;

  if (MODIFIER_KEY_NAMES.has(e.key)) {
    return soloModifierName(e.key);
  }

  const parts: string[] = [];
  if (e.metaKey) parts.push('Command');
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Option');
  if (e.shiftKey) parts.push('Shift');

  const main = mainKeyName(e);
  if (!main) return null;
  parts.push(main);
  return parts.join('+');
}

function soloModifierName(key: string): string {
  switch (key) {
    case 'Meta':
      return 'Command';
    case 'Control':
      return 'Control';
    case 'Alt':
    case 'AltGraph':
      return 'Option';
    case 'Shift':
      return 'Shift';
    case 'Fn':
    case 'FnLock':
      return 'Fn';
    default:
      return key;
  }
}

function mainKeyName(e: KeyEventInput): string | null {
  // Prefer `code` so layout-shifted keys (AZERTY-A reporting key='q')
  // still serialise consistently.
  if (e.code) {
    if (e.code === 'Space') return 'Space';
    if (e.code === 'Tab') return 'Tab';
    if (e.code === 'Enter' || e.code === 'NumpadEnter') return 'Return';
    if (e.code === 'Backspace') return 'Backspace';
    if (e.code === 'Delete') return 'ForwardDelete';
    if (e.code === 'Home') return 'Home';
    if (e.code === 'End') return 'End';
    if (e.code === 'PageUp') return 'PageUp';
    if (e.code === 'PageDown') return 'PageDown';
    if (e.code === 'ArrowLeft') return 'Left';
    if (e.code === 'ArrowRight') return 'Right';
    if (e.code === 'ArrowUp') return 'Up';
    if (e.code === 'ArrowDown') return 'Down';
    if (e.code.startsWith('Key') && e.code.length === 4) {
      return e.code.slice(3).toUpperCase();
    }
    if (e.code.startsWith('Digit') && e.code.length === 6) {
      return e.code.slice(5);
    }
    if (/^F([1-9]|1\d|20)$/.test(e.code)) return e.code;
    if (e.code === 'Minus') return 'Minus';
    if (e.code === 'Equal') return 'Equal';
    if (e.code === 'Comma') return 'Comma';
    if (e.code === 'Period') return 'Period';
    if (e.code === 'Slash') return 'Slash';
    if (e.code === 'Semicolon') return 'Semicolon';
    if (e.code === 'Quote') return 'Quote';
    if (e.code === 'Backslash') return 'Backslash';
    if (e.code === 'BracketLeft') return 'LeftBracket';
    if (e.code === 'BracketRight') return 'RightBracket';
    if (e.code === 'Backquote') return 'Grave';
  }
  if (e.key === ' ') return 'Space';
  if (/^[a-zA-Z]$/.test(e.key)) return e.key.toUpperCase();
  if (/^[0-9]$/.test(e.key)) return e.key;
  if (/^F([1-9]|1\d|20)$/.test(e.key)) return e.key;
  return null;
}

export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported-key' | 'empty' };

/**
 * Mirror of `ParseAccelerator` in macos_audio_bridge.mm. Returns `ok`
 * if the native side will register the accelerator; otherwise a stable
 * reason code the UI can localise. Solo modifiers and bare letters fall
 * through to `unsupported-key` — the user-facing contract is "press once
 * to start, press again to stop", so single-key triggers would intercept
 * normal typing.
 */
export function validateAccelerator(accel: string): ValidateResult {
  if (!accel) return { ok: false, reason: 'empty' };
  const tokens = tokenize(accel);
  if (tokens.length === 0) return { ok: false, reason: 'empty' };

  if (tokens.length === 1) {
    const only = tokens[0];
    if (isFunctionKeyToken(only) && MAIN_KEY_TOKENS.has(only)) {
      return { ok: true };
    }
    return { ok: false, reason: 'unsupported-key' };
  }

  let mainTok: string | null = null;
  let hasModifier = false;
  for (const tok of tokens) {
    if (COMBO_MODIFIER_TOKENS.has(tok)) {
      hasModifier = true;
      continue;
    }
    if (mainTok != null) return { ok: false, reason: 'unsupported-key' };
    mainTok = tok;
  }
  if (!hasModifier || mainTok == null) {
    return { ok: false, reason: 'unsupported-key' };
  }
  if (!MAIN_KEY_TOKENS.has(mainTok)) {
    return { ok: false, reason: 'unsupported-key' };
  }
  return { ok: true };
}

const MODIFIER_SYMBOL: Record<string, string> = {
  command: '⌘',
  cmd: '⌘',
  control: '⌃',
  ctrl: '⌃',
  option: '⌥',
  alt: '⌥',
  shift: '⇧',
  // `fn` only ever shows up as a captured solo press for the rejection
  // preview; not registrable, but we still display it.
  fn: 'fn',
  function: 'fn'
};

const MAIN_KEY_DISPLAY: Record<string, string> = {
  space: 'Space',
  tab: 'Tab',
  return: '↵',
  enter: '↵',
  delete: '⌫',
  backspace: '⌫',
  forwarddelete: '⌦',
  home: '↖',
  end: '↘',
  pageup: '⇞',
  pagedown: '⇟',
  left: '←',
  leftarrow: '←',
  right: '→',
  rightarrow: '→',
  up: '↑',
  uparrow: '↑',
  down: '↓',
  downarrow: '↓',
  minus: '-',
  equal: '=',
  comma: ',',
  period: '.',
  slash: '/',
  semicolon: ';',
  quote: '\'',
  backslash: '\\',
  leftbracket: '[',
  rightbracket: ']',
  grave: '`',
  backtick: '`'
};

export function acceleratorToTokens(accel: string): AcceleratorPart[] {
  if (!accel) return [];
  const tokens = tokenize(accel);
  const out: AcceleratorPart[] = [];
  for (const tok of tokens) {
    const sym = MODIFIER_SYMBOL[tok];
    if (sym) {
      out.push({ display: sym, kind: 'modifier' });
      continue;
    }
    if (MAIN_KEY_DISPLAY[tok]) {
      out.push({ display: MAIN_KEY_DISPLAY[tok], kind: 'key' });
      continue;
    }
    if (isFunctionKeyToken(tok)) {
      out.push({ display: tok.toUpperCase(), kind: 'key' });
      continue;
    }
    if (/^[a-z0-9]$/.test(tok)) {
      out.push({ display: tok.toUpperCase(), kind: 'key' });
      continue;
    }
    // Unknown token — preserve original casing-ish for visibility.
    out.push({
      display: tok.length === 1 ? tok.toUpperCase() : tok,
      kind: 'key'
    });
  }
  return out;
}
