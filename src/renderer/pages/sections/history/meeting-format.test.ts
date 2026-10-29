import { describe, expect, it } from 'vitest';
import { daysAgo, groupByDay, meetingLengthMs, meetingStatus, splitMinutes } from './meeting-format.js';

const at = (y: number, mo: number, d: number, h = 12, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi).getTime();

describe('daysAgo', () => {
  it('counts calendar days, not 24-hour spans', () => {
    const now = at(2026, 10, 21, 0, 30);
    expect(daysAgo(at(2026, 10, 21, 0, 5), now)).toBe(0);
    expect(daysAgo(at(2026, 10, 20, 23, 50), now)).toBe(1);
    expect(daysAgo(at(2026, 10, 14, 9), now)).toBe(7);
  });
});

describe('groupByDay', () => {
  it('groups consecutive meetings from the same local day, keeping order', () => {
    const items = [
      { id: 'a', startedAt: at(2026, 10, 21, 15) },
      { id: 'b', startedAt: at(2026, 10, 21, 9) },
      { id: 'c', startedAt: at(2026, 10, 19, 18) }
    ];
    const groups = groupByDay(items);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([['a', 'b'], ['c']]);
    expect(groups[0]!.day).toBe(at(2026, 10, 21, 0));
  });

  it('returns no groups for no meetings', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('meetingLengthMs', () => {
  it('runs to the end, else to the last line, else to now', () => {
    const startedAt = at(2026, 10, 21, 14);
    expect(meetingLengthMs({ startedAt, endedAt: startedAt + 60_000, lastActivityAt: 0 })).toBe(60_000);
    expect(meetingLengthMs({ startedAt, endedAt: null, lastActivityAt: startedAt + 5_000 })).toBe(5_000);
    expect(meetingLengthMs({ startedAt, endedAt: null }, startedAt + 7_000)).toBe(7_000);
  });
});

describe('splitMinutes', () => {
  it('rounds to whole minutes and splits off hours', () => {
    expect(splitMinutes(29_000)).toBeNull();
    expect(splitMinutes(31_000)).toEqual({ h: 0, m: 1 });
    expect(splitMinutes(43 * 60_000)).toEqual({ h: 0, m: 43 });
    expect(splitMinutes(72 * 60_000 + 20_000)).toEqual({ h: 1, m: 12 });
  });
});

describe('meetingStatus', () => {
  const ended = { id: 'm', endedAt: 1, endedBy: 'manual' as const };
  it('is live only for the open meeting', () => {
    expect(meetingStatus({ ...ended, endedAt: null, endedBy: null }, 'm')).toBe('live');
  });
  it('treats a crashed or never-ended meeting as interrupted', () => {
    expect(meetingStatus({ ...ended, endedBy: 'crashed' }, null)).toBe('interrupted');
    expect(meetingStatus({ ...ended, endedAt: null, endedBy: null }, 'other')).toBe('interrupted');
  });
  it('treats every other way of ending as a normal end', () => {
    expect(meetingStatus(ended, null)).toBe('ended');
    expect(meetingStatus({ ...ended, endedBy: 'idle-timeout' }, null)).toBe('ended');
  });
});
