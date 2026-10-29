/**
 * UI locale identifiers. Kept narrow on purpose — adding a new locale is a
 * deliberate act (translate every namespace, add the option to the language
 * switcher). The literal union catches missing translations at compile time
 * when used as a Record key.
 */
export const LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** Fallback when `app.getLocale()` returns something we don't ship. */
export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** Available i18next namespaces. Each maps 1:1 to a JSON file per locale. */
export const NAMESPACES = [
  'common',
  'settings',
  'subtitle',
  'errors',
  'nav',
  'control',
  'audio',
  'transcript',
  'onboarding',
  'quickPicker',
  'languages',
  'toast',
  'connectivity'
] as const;
export type Namespace = (typeof NAMESPACES)[number];

/**
 * Best-effort BCP-47 → app locale mapping. Electron's `app.getLocale()` can
 * return `zh-CN`, `zh-Hans-CN`, `zh-TW`, `en-US`, etc. We collapse anything
 * Chinese-script to `zh-CN` (we don't ship Traditional yet) and anything
 * else to `en`. Returns `null` when the input is malformed.
 */
export const resolveLocale = (raw: string | null | undefined): Locale => {
  if (!raw) return DEFAULT_LOCALE;
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
};
