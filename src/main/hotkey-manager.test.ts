import { beforeEach, describe, expect, it, vi } from 'vitest';

const globalShortcut = vi.hoisted(() => ({
  register: vi.fn(() => true),
  unregister: vi.fn(),
  unregisterAll: vi.fn()
}));
vi.mock('electron', () => ({ globalShortcut }));
vi.mock('./window-manager.js', () => ({
  broadcastToAllRenderers: vi.fn()
}));

const {
  registerHotkey,
  resumeHotkey,
  suspendHotkey,
  toElectronAccelerator,
  unregisterAll
} = await import('./hotkey-manager.js');

describe('toElectronAccelerator', () => {
  it('maps the capture UI tokens onto Electron names', () => {
    expect(toElectronAccelerator('Option+Space')).toBe('Alt+Space');
    expect(toElectronAccelerator('Alt+Space')).toBe('Alt+Space');
    expect(toElectronAccelerator('Command+Shift+t')).toBe('Command+Shift+T');
    expect(toElectronAccelerator('Control+ForwardDelete')).toBe('Control+Delete');
    expect(toElectronAccelerator('Command+Delete')).toBe('Command+Backspace');
    expect(toElectronAccelerator('Option+LeftBracket')).toBe('Alt+[');
    expect(toElectronAccelerator('Control+Grave')).toBe('Control+`');
    expect(toElectronAccelerator('F19')).toBe('F19');
  });

  it('rejects what Electron cannot register', () => {
    expect(toElectronAccelerator('')).toBeNull();
    expect(toElectronAccelerator('Fn+Space')).toBeNull();
    expect(toElectronAccelerator('Command+F21')).toBeNull();
    expect(toElectronAccelerator('Command+Escape')).toBeNull();
  });
});

describe('registerHotkey', () => {
  beforeEach(() => {
    unregisterAll();
    globalShortcut.register.mockReset().mockReturnValue(true);
    globalShortcut.unregister.mockReset();
  });

  it('keeps the working binding when the new value is invalid', async () => {
    expect(await registerHotkey('Option+Space')).toBe(true);
    expect(await registerHotkey('Fn+Space')).toBe(false);
    expect(await registerHotkey(42 as unknown as string)).toBe(false);
    expect(globalShortcut.unregister).not.toHaveBeenCalled();
  });

  it('releases the binding while suspended and restores it on resume', async () => {
    await registerHotkey('Option+Space');
    suspendHotkey();
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Alt+Space');

    // A capture saved while suspended is probed, then bound on resume.
    expect(await registerHotkey('Command+Shift+T')).toBe(true);
    expect(globalShortcut.unregister).toHaveBeenLastCalledWith('Command+Shift+T');
    globalShortcut.register.mockClear();

    resumeHotkey();
    expect(globalShortcut.register).toHaveBeenCalledTimes(1);
    expect(globalShortcut.register).toHaveBeenCalledWith(
      'Command+Shift+T',
      expect.any(Function)
    );
  });

  it('reports a combo held by another app even while suspended', async () => {
    suspendHotkey();
    globalShortcut.register.mockReturnValue(false);
    expect(await registerHotkey('Option+Space')).toBe(false);
    resumeHotkey();
  });
});
