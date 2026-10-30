import { Tray, Menu, nativeImage, app } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createControlWindow } from './window-manager.js';
import { subscribeLocale, t } from './i18n.js';

let tray: Tray | null = null;

const findIcon = (): Electron.NativeImage => {
  // A template image: the "Template" suffix lets macOS tint it for light and
  // dark menu bars, and trayTemplate@2x.png loads alongside it. Packaged
  // builds ship it in Resources (extraResources); dev reads the source tree.
  const packaged = join(process.resourcesPath, 'trayTemplate.png');
  return nativeImage.createFromPath(
    existsSync(packaged)
      ? packaged
      : join(app.getAppPath(), 'resources', 'icons', 'trayTemplate.png')
  );
};

const buildMenu = (): Menu =>
  Menu.buildFromTemplate([
    {
      label: t('common:tray.openControlPanel'),
      click: () => createControlWindow().show()
    },
    { type: 'separator' },
    { label: t('common:tray.quit'), click: () => app.quit() }
  ]);

export const createTray = (): Tray => {
  if (tray) return tray;
  tray = new Tray(findIcon());
  tray.setToolTip('BabelVoice');
  tray.setContextMenu(buildMenu());
  subscribeLocale(() => tray?.setContextMenu(buildMenu()));
  return tray;
};
