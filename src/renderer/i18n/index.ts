/**
 * i18next setup for the renderer. Initialised once before mount with the
 * locale main reports — never derived locally — and re-keyed via
 * `i18n.changeLanguage` when main broadcasts a change. Components consume
 * strings exclusively via `useTranslation`/`<Trans>`; raw resource access
 * should not leak into UI code.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  DEFAULT_LOCALE,
  NAMESPACES,
  type Locale
} from '@shared/i18n-types.js';
import { resources } from '@shared/locales/index.js';

let initPromise: Promise<void> | null = null;

/** Keep `<html lang>` in step so fonts, hyphenation and a11y follow the UI. */
const syncDocumentLang = (lng: string): void => {
  if (typeof document !== 'undefined' && lng) {
    document.documentElement.lang = lng;
  }
};

export const initRendererI18n = async (
  initialLocale: Locale = DEFAULT_LOCALE
): Promise<void> => {
  if (!initPromise) {
    i18n.on('languageChanged', syncDocumentLang);
    initPromise = i18n
      .use(initReactI18next)
      .init({
        lng: initialLocale,
        fallbackLng: 'en',
        ns: [...NAMESPACES],
        defaultNS: 'common',
        resources,
        interpolation: {
          // We never inject user-supplied HTML through interpolated values,
          // and disabling escaping lets us render `<strong>` from `<Trans>`
          // inline without triple braces. (User input would not flow through
          // here in any case — it'd round-trip via React props instead.)
          escapeValue: false
        },
        returnNull: false
      })
      .then(() => syncDocumentLang(i18n.language));
  }
  await initPromise;
};

export const changeRendererLocale = async (locale: Locale): Promise<void> => {
  if (i18n.language === locale) return;
  await i18n.changeLanguage(locale);
};

export { i18n };
