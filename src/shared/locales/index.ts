/**
 * Aggregates every locale namespace into one bundle keyed by locale, then by
 * namespace. Both main and renderer import from here so they share the exact
 * same source of truth — main does substitution with a tiny resolver, the
 * renderer feeds it to i18next as `resources`.
 */
import zhCNCommon from './zh-CN/common.json';
import zhCNSettings from './zh-CN/settings.json';
import zhCNSubtitle from './zh-CN/subtitle.json';
import zhCNErrors from './zh-CN/errors.json';
import zhCNNav from './zh-CN/nav.json';
import zhCNControl from './zh-CN/control.json';
import zhCNAudio from './zh-CN/audio.json';
import zhCNTranscript from './zh-CN/transcript.json';
import zhCNOnboarding from './zh-CN/onboarding.json';
import zhCNQuickPicker from './zh-CN/quickPicker.json';
import zhCNLanguages from './zh-CN/languages.json';
import zhCNToast from './zh-CN/toast.json';
import zhCNConnectivity from './zh-CN/connectivity.json';
import enCommon from './en/common.json';
import enSettings from './en/settings.json';
import enSubtitle from './en/subtitle.json';
import enErrors from './en/errors.json';
import enNav from './en/nav.json';
import enControl from './en/control.json';
import enAudio from './en/audio.json';
import enTranscript from './en/transcript.json';
import enOnboarding from './en/onboarding.json';
import enQuickPicker from './en/quickPicker.json';
import enLanguages from './en/languages.json';
import enToast from './en/toast.json';
import enConnectivity from './en/connectivity.json';

import type { Locale, Namespace } from '../i18n-types.js';

export type LocaleResources = Record<Namespace, Record<string, unknown>>;

export const resources: Record<Locale, LocaleResources> = {
  'zh-CN': {
    common: zhCNCommon,
    settings: zhCNSettings,
    subtitle: zhCNSubtitle,
    errors: zhCNErrors,
    nav: zhCNNav,
    control: zhCNControl,
    audio: zhCNAudio,
    transcript: zhCNTranscript,
    onboarding: zhCNOnboarding,
    quickPicker: zhCNQuickPicker,
    languages: zhCNLanguages,
    toast: zhCNToast,
    connectivity: zhCNConnectivity
  },
  en: {
    common: enCommon,
    settings: enSettings,
    subtitle: enSubtitle,
    errors: enErrors,
    nav: enNav,
    control: enControl,
    audio: enAudio,
    transcript: enTranscript,
    onboarding: enOnboarding,
    quickPicker: enQuickPicker,
    languages: enLanguages,
    toast: enToast,
    connectivity: enConnectivity
  }
};
