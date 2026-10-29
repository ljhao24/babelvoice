import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  app: { isPackaged: false, getAppPath: vi.fn(() => '/repo') },
  shell: {
    openPath: vi.fn(async (_p: string) => ''),
    showItemInFolder: vi.fn()
  }
}));

vi.mock('electron', () => electron);
vi.mock('../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../native/platform-native-bridge.js', () => ({
  platformNativeBridge: {}
}));

const { openSetupGuide, resolveSetupGuidePath } = await import('./macos.js');

const originalResourcesPath = process.resourcesPath;

afterEach(() => {
  electron.app.isPackaged = false;
  Object.defineProperty(process, 'resourcesPath', {
    value: originalResourcesPath,
    configurable: true
  });
});

describe('resolveSetupGuidePath', () => {
  it('reads the guide from the repo in dev', () => {
    expect(resolveSetupGuidePath()).toBe('/repo/docs/SETUP-macOS.md');
  });

  it('reads the bundled copy from Resources when packaged', () => {
    electron.app.isPackaged = true;
    Object.defineProperty(process, 'resourcesPath', {
      value: '/Applications/BabelVoice.app/Contents/Resources',
      configurable: true
    });
    expect(resolveSetupGuidePath()).toBe(
      '/Applications/BabelVoice.app/Contents/Resources/docs/SETUP-macOS.md'
    );
  });
});

describe('openSetupGuide', () => {
  it('opens the guide with the default app', async () => {
    await openSetupGuide();
    expect(electron.shell.openPath).toHaveBeenCalledWith('/repo/docs/SETUP-macOS.md');
    expect(electron.shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('reveals the guide in Finder when it cannot be opened', async () => {
    electron.shell.openPath.mockResolvedValueOnce('No application knows how to open');
    await openSetupGuide();
    expect(electron.shell.showItemInFolder).toHaveBeenCalledWith(
      '/repo/docs/SETUP-macOS.md'
    );
  });
});
