import { useTranslation } from 'react-i18next';
import type { Meeting, MeetingSummary } from '@shared/meeting-types.js';

const DAY_MS = 86_400_000;

const startOfDay = (at: number): number => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Calendar days from `at` to `now` in local time: 0 today, 1 yesterday. */
export const daysAgo = (at: number, now: number): number =>
  Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);

/**
 * Splits a newest-first list into runs that started on the same local day,
 * keeping the order. `day` is that day's local midnight.
 */
export const groupByDay = <T extends { startedAt: number }>(
  items: readonly T[]
): { day: number; items: T[] }[] => {
  const groups: { day: number; items: T[] }[] = [];
  for (const item of items) {
    const day = startOfDay(item.startedAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.items.push(item);
    else groups.push({ day, items: [item] });
  }
  return groups;
};

/**
 * How long the meeting ran. An unfinished one (still open, or cut off by a
 * crash) runs to its last line.
 */
export const meetingLengthMs = (
  m: Pick<Meeting, 'startedAt' | 'endedAt'> & Partial<Pick<MeetingSummary, 'lastActivityAt'>>,
  now = Date.now()
): number => Math.max(0, (m.endedAt ?? m.lastActivityAt ?? now) - m.startedAt);

/** Whole minutes, rounded, split for "1 小时 12 分钟"; null under a minute. */
export const splitMinutes = (ms: number): { h: number; m: number } | null => {
  const total = Math.round(ms / 60_000);
  if (total < 1) return null;
  return { h: Math.floor(total / 60), m: total % 60 };
};

export type MeetingStatus = 'live' | 'interrupted' | 'ended';

/**
 * `live` is the meeting open right now. A meeting that never ended and isn't
 * open was cut off (the app crashed or was killed); main marks it `crashed`
 * when the next one opens.
 */
export const meetingStatus = (
  m: Pick<Meeting, 'id' | 'endedAt' | 'endedBy'>,
  currentId: string | null | undefined
): MeetingStatus => {
  if (m.id === currentId) return 'live';
  if (m.endedBy === 'crashed' || m.endedAt === null) return 'interrupted';
  return 'ended';
};

/** Formatters in the UI language, for meeting lists and headers. */
export function useMeetingFormat(): {
  /** 今天 · 昨天 · 10月18日周六 · 2025年10月18日周六 */
  day: (at: number) => string;
  /** 2026年10月18日周六 */
  fullDate: (at: number) => string;
  /** 14:05 */
  clock: (at: number) => string;
  /** 14:05–14:48, with the date on the end when it ran past midnight. */
  timeRange: (start: number, end: number | null) => string;
  /** 不到 1 分钟 · 43 分钟 · 1 小时 12 分钟 */
  length: (ms: number) => string;
  /** 中文 ⇄ English: you speak the first, the others the second. */
  languages: (m: Pick<Meeting, 'langSrc' | 'langTgt'>) => string;
} {
  const { t, i18n } = useTranslation('transcript');
  const { t: tLang } = useTranslation('languages');
  const locale = i18n.language;

  const clockFormat = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  const clock = (at: number): string => clockFormat.format(at);

  return {
    day: (at) => {
      const now = Date.now();
      const ago = daysAgo(at, now);
      if (ago === 0) return t('day.today');
      if (ago === 1) return t('day.yesterday');
      const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
      return new Intl.DateTimeFormat(locale, {
        ...(sameYear ? {} : { year: 'numeric' }),
        month: 'long',
        day: 'numeric',
        weekday: 'short'
      }).format(at);
    },
    fullDate: (at) =>
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'short'
      }).format(at),
    clock,
    timeRange: (start, end) => {
      if (end === null) return clock(start);
      if (daysAgo(start, end) === 0) return clockFormat.formatRange(start, end);
      return new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      }).formatRange(start, end);
    },
    length: (ms) => {
      const parts = splitMinutes(ms);
      if (!parts) return t('length.underMinute');
      if (parts.h === 0) return t('length.minutes', { count: parts.m });
      if (parts.m === 0) return t('length.hours', { count: parts.h });
      return t('length.hoursMinutes', { h: parts.h, m: parts.m });
    },
    languages: (m) =>
      t('languagePair', {
        src: tLang(`names.${m.langSrc}`, { defaultValue: m.langSrc }),
        tgt: tLang(`names.${m.langTgt}`, { defaultValue: m.langTgt })
      })
  };
}
