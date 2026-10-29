import { app } from 'electron';
import Store from 'electron-store';
import { log } from '@core/utils/logger.js';
import {
  DEFAULT_LOCALE,
  LOCALES,
  resolveLocale,
  type Locale,
  type Namespace
} from '@shared/i18n-types.js';
import { resources } from '@shared/locales/index.js';

/**
 * Main-side i18n is the source of truth for the user's locale choice.
 * The renderer mirrors it — never the other way around — so a refresh or a
 * second window always sees the same language as the menu/tray strings the
 * main process renders. We persist the override in its own electron-store
 * file (rather than mixing it into `preferences`) so it stays separate
 * from the translation settings.
 */

interface LocaleStore {
  override?: Locale;
}

const store = new Store<LocaleStore>({ name: 'babelvoice-i18n' });

let currentLocale: Locale | null = null;
const subscribers = new Set<(locale: Locale) => void>();

const isLocale = (v: unknown): v is Locale =>
  (LOCALES as readonly unknown[]).includes(v);

/**
 * The persisted override, if it is a locale we ship. An unknown value (e.g.
 * 'zh' from a buggy caller) would make every `resources[locale]` lookup
 * throw, on every launch.
 */
const readOverride = (): Locale | undefined => {
  const raw = store.get('override');
  return isLocale(raw) ? raw : undefined;
};

const detectSystemLocale = (): Locale => {
  // `app.getLocale()` requires `whenReady`; before that we fall back to the
  // configured override or the default. Calling code is expected to invoke
  // `initI18n()` from `app.whenReady()`, but defensively we don't crash if
  // it's called early.
  if (!app.isReady()) {
    return readOverride() ?? DEFAULT_LOCALE;
  }
  try {
    return resolveLocale(app.getLocale());
  } catch {
    return DEFAULT_LOCALE;
  }
};

export const initI18n = (): Locale => {
  const override = readOverride();
  currentLocale = override ?? detectSystemLocale();
  log.info(
    `i18n: locale resolved to "${currentLocale}" (override=${override ?? 'none'})`
  );
  return currentLocale;
};

export const getLocale = (): Locale => {
  if (currentLocale) return currentLocale;
  return initI18n();
};

export const setLocale = (next: Locale): Locale => {
  if (!isLocale(next)) {
    throw new Error(`Unsupported locale ${String(next)}`);
  }
  if (next === currentLocale) return currentLocale;
  currentLocale = next;
  store.set('override', next);
  for (const cb of subscribers) {
    try {
      cb(next);
    } catch (err) {
      log.error('i18n subscriber threw:', err);
    }
  }
  return next;
};

export const subscribeLocale = (cb: (locale: Locale) => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

const lookup = (
  locale: Locale,
  namespace: Namespace,
  keyPath: string
): string | undefined => {
  const segments = keyPath.split('.');
  let node: unknown = resources[locale][namespace];
  for (const seg of segments) {
    if (node && typeof node === 'object' && seg in (node as object)) {
      node = (node as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return typeof node === 'string' ? node : undefined;
};

const interpolate = (
  template: string,
  params: Record<string, string | number> | undefined
): string => {
  if (!params) return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => {
    const value = params[name];
    return value === undefined ? '' : String(value);
  });
};

/**
 * Tiny localiser for main-side strings (mostly thrown errors / IPC error
 * payloads). Falls back to English then to the raw key, so a typo surfaces
 * obviously rather than as an empty string. Use the format
 * `t('errors:endMeetingFirst')` or `t('namespace:key', params)`.
 */
export const t = (
  qualifiedKey: string,
  params?: Record<string, string | number>
): string => {
  const [namespace, ...rest] = qualifiedKey.split(':');
  const keyPath = rest.join(':');
  if (!keyPath) {
    log.warn(`i18n: malformed key "${qualifiedKey}" (expected ns:key.path)`);
    return qualifiedKey;
  }
  const ns = namespace as Namespace;
  const locale = getLocale();
  const direct = lookup(locale, ns, keyPath);
  if (direct !== undefined) return interpolate(direct, params);
  const fallback = lookup('en', ns, keyPath);
  if (fallback !== undefined) return interpolate(fallback, params);
  log.warn(`i18n: missing translation "${qualifiedKey}" (locale=${locale})`);
  return qualifiedKey;
};
