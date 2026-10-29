import type { TranslationErrorKind } from '@shared/translation-error-types.js';

/** The slice of i18next's `t` this module needs (keeps it testable). */
type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface SessionErrorView {
  /** User-facing line: the kind's copy, else the raw message as is. */
  text: string;
  /** The raw technical message, when `text` replaced it. */
  detail: string | null;
  /** The fix lives in Settings (engine credentials) — offer a way there. */
  needsSettings: boolean;
}

const SETTINGS_KINDS: ReadonlySet<TranslationErrorKind> = new Set([
  'auth',
  'credentials-missing'
]);

/**
 * Map main's error classification to UI copy (ADR-0003: main classifies,
 * the renderer only localizes). `unknown` and a missing kind fall back to
 * the raw message: that covers start rejections main already localized
 * (same language pair, sessions stopping, listen loopback) and anything a
 * provider reports that we can't classify.
 */
export const describeSessionError = (
  t: Translate,
  kind: TranslationErrorKind | null | undefined,
  message: string | null | undefined
): SessionErrorView => {
  // The store records a bare 'unknown' when a failure carried no message.
  const raw = message && message !== 'unknown' ? message.trim() : '';
  if (!kind || kind === 'unknown') {
    return {
      text: raw || t('errors:sessionKind.unknown'),
      detail: null,
      needsSettings: false
    };
  }
  const text = t(`errors:sessionKind.${kind}`);
  // "No credentials for qwen" says nothing the copy doesn't.
  const detail =
    kind === 'credentials-missing' || !raw || raw === text ? null : raw;
  return { text, detail, needsSettings: SETTINGS_KINDS.has(kind) };
};

/** One line for places with no room for a separate detail row. */
export const formatSessionError = (
  t: Translate,
  view: SessionErrorView
): string =>
  view.detail
    ? t('errors:sessionKind.withDetail', {
        text: view.text,
        detail: view.detail
      })
    : view.text;
