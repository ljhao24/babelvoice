import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, type UserPreferences } from '@shared/config-types.js';
import { PreferencesService } from './preferences-service.js';

const makeHarness = (initial: Partial<UserPreferences> = {}) => {
  let stored: UserPreferences = {
    ...DEFAULT_PREFERENCES,
    engineId: 'doubao',
    hotkey: 'Option+Space',
    ...initial
  };
  let sessionActive = false;
  /** Hotkeys another app holds. */
  const taken = new Set<string>();
  const deps = {
    getPreferences: () => structuredClone(stored),
    setPreferences: vi.fn((partial: Partial<UserPreferences>) => {
      stored = { ...stored, ...partial };
    }),
    hasActiveSessions: () => sessionActive,
    registerHotkey: vi.fn(async (accelerator: string) => !taken.has(accelerator)),
    broadcastChanged: vi.fn(),
    micPassthrough: {
      setMicrophoneDeviceUid: vi.fn(),
      setDesired: vi.fn()
    }
  };
  return {
    service: new PreferencesService(deps),
    deps,
    stored: () => stored,
    taken,
    setSessionActive: (v: boolean) => {
      sessionActive = v;
    }
  };
};

describe('PreferencesService.set (user edit)', () => {
  it('persists, broadcasts and reconciles passthrough', async () => {
    const h = makeHarness();
    const next = await h.service.set({
      theme: 'dark',
      micPassthroughWhenIdle: true,
      preferredMicrophoneUid: 'mic-2'
    });

    expect(next.theme).toBe('dark');
    expect(h.stored().theme).toBe('dark');
    expect(h.deps.broadcastChanged).toHaveBeenCalledWith(next);
    expect(h.deps.micPassthrough.setMicrophoneDeviceUid).toHaveBeenCalledWith('mic-2');
    expect(h.deps.micPassthrough.setDesired).toHaveBeenCalledWith(true);
    expect(h.deps.registerHotkey).not.toHaveBeenCalled();
  });

  it('rejects an unknown engine before anything else happens', async () => {
    const h = makeHarness();
    await expect(
      h.service.set({ engineId: 'deepl' as never, hotkey: 'Command+T' })
    ).rejects.toThrow('Unknown engine deepl');

    expect(h.deps.registerHotkey).not.toHaveBeenCalled();
    expect(h.deps.setPreferences).not.toHaveBeenCalled();
    expect(h.deps.broadcastChanged).not.toHaveBeenCalled();
  });

  it('locks the engine while a session is alive, without binding the new hotkey', async () => {
    const h = makeHarness();
    h.setSessionActive(true);
    await expect(
      h.service.set({ engineId: 'qwen', hotkey: 'Command+T' })
    ).rejects.toThrow('engine_locked');

    expect(h.deps.registerHotkey).not.toHaveBeenCalled();
    expect(h.deps.setPreferences).not.toHaveBeenCalled();
    expect(h.stored().engineId).toBe('doubao');

    // Re-sending the current engine is not a switch.
    await h.service.set({ engineId: 'doubao', theme: 'dark' });
    expect(h.stored().theme).toBe('dark');
  });

  it('an unavailable hotkey restores the previous one and saves nothing', async () => {
    const h = makeHarness();
    h.taken.add('Command+T');
    await expect(
      h.service.set({ hotkey: 'Command+T', theme: 'dark' })
    ).rejects.toThrow('Hotkey Command+T unavailable');

    expect(h.deps.registerHotkey.mock.calls).toEqual([
      ['Command+T'],
      ['Option+Space']
    ]);
    expect(h.stored().hotkey).toBe('Option+Space');
    expect(h.stored().theme).not.toBe('dark');
    expect(h.deps.broadcastChanged).not.toHaveBeenCalled();
  });

  it('binds a new hotkey before persisting it', async () => {
    const h = makeHarness();
    await h.service.set({ hotkey: 'Command+T' });
    expect(h.deps.registerHotkey).toHaveBeenCalledWith('Command+T');
    expect(h.deps.registerHotkey.mock.invocationCallOrder[0]).toBeLessThan(
      h.deps.setPreferences.mock.invocationCallOrder[0]
    );
    expect(h.stored().hotkey).toBe('Command+T');
  });
});

describe('PreferencesService — serialized commits', () => {
  it('a second edit waits for an in-flight one instead of interleaving at the hotkey', async () => {
    const h = makeHarness();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.deps.registerHotkey.mockImplementation(async () => {
      await held;
      return true;
    });

    const edit = h.service.set({ hotkey: 'Command+T' });
    const second = h.service.set({ hotkey: 'Command+Y' });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(h.deps.registerHotkey.mock.calls).toEqual([['Command+T']]);

    release();
    await Promise.all([edit, second]);
    // The second edit saw the first one's hotkey as its starting point.
    expect(h.deps.registerHotkey.mock.calls).toEqual([
      ['Command+T'],
      ['Command+Y']
    ]);
    expect(h.stored().hotkey).toBe('Command+Y');
  });

  it('a rejected edit does not block the next one', async () => {
    const h = makeHarness();
    await expect(h.service.set({ engineId: 'deepl' as never })).rejects.toThrow();
    await expect(h.service.set({ theme: 'dark' })).resolves.toMatchObject({
      theme: 'dark'
    });
  });
});
