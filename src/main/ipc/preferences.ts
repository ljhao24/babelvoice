import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-types.js';
import type { UserPreferences } from '@shared/config-types.js';
import type { Locale } from '@shared/i18n-types.js';
import type { PreferencesService } from '../preferences-service.js';
import { getLocale, setLocale } from '../i18n.js';

/** Preferences and the device-local UI locale. */
export const registerPreferencesHandlers = (
  preferences: PreferencesService
): void => {
  ipcMain.handle(IPC.PreferencesGet, (): UserPreferences => preferences.get());

  ipcMain.handle(
    IPC.PreferencesSet,
    (_evt, partial: Partial<UserPreferences>): Promise<UserPreferences> =>
      preferences.set(partial)
  );

  ipcMain.handle(IPC.I18nGetLocale, (): Locale => getLocale());

  ipcMain.handle(IPC.I18nSetLocale, (_evt, locale: Locale): Locale => {
    return setLocale(locale);
  });
};
