import { Tray, Menu, nativeImage, app } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createControlWindow } from './window-manager.js';
import { subscribeLocale, t } from './i18n.js';

let tray: Tray | null = null;

/** Menu-bar icon height on macOS. */
const TRAY_ICON_SIZE = 18;

const findIcon = (): Electron.NativeImage => {
  // A dedicated (template) tray icon wins if one ships; otherwise scale the
  // app icon down. An empty image would leave an invisible, unclickable
  // menu-bar item.
  const dedicated = join(process.resourcesPath, 'tray-icon.png');
  if (existsSync(dedicated)) return nativeImage.createFromPath(dedicated);
  const appIcon = nativeImage.createFromPath(
    join(app.getAppPath(), 'resources', 'icons', 'icon.png')
  );
  return appIcon.isEmpty()
    ? appIcon
    : appIcon.resize({ height: TRAY_ICON_SIZE, quality: 'best' });
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
