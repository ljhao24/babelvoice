import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'babelvoice-meetings-'));

vi.mock('electron', () => ({ app: { getPath: () => dir } }));
vi.mock('../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('./idle-watcher.js', () => ({
  resetIdleTimer: vi.fn(),
  stopIdleTimer: vi.fn()
}));

const {
  appendLine,
  endMeeting,
  listMeetings,
  loadMeeting,
  openMeeting,
  setMeetingActiveHandler
} = await import('./meetings-service.js');
const { closeDb } = await import('./meetings-db.js');

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const line = (id: string, at: number, meetingId?: string) => ({
  id,
  meetingId,
  direction: 'listen' as const,
  src: `src ${id}`,
  tgt: `tgt ${id}`,
  at,
  sessionSeq: 1
});

describe('setMeetingActiveHandler', () => {
  it('reports a meeting opening and ending, and nothing for an end with none open', () => {
    const seen: boolean[] = [];
    setMeetingActiveHandler((active) => seen.push(active));
    try {
      openMeeting({ engineId: 'mock', langSrc: 'en', langTgt: 'zh' });
      endMeeting('idle-timeout');
      endMeeting('manual');
      expect(seen).toEqual([true, false]);
    } finally {
      setMeetingActiveHandler(() => undefined);
    }
  });
});

describe('appendLine', () => {
  it('attaches a line flushed after the meeting ended to that meeting', () => {
    const { meeting } = openMeeting({
      engineId: 'mock',
      langSrc: 'en',
      langTgt: 'zh'
    });
    appendLine(line('a', 1_000));
    endMeeting('manual');

    // The renderer settles its last stitched sentence after End returns.
    appendLine(line('b', 2_000, meeting.id));

    const loaded = loadMeeting(meeting.id);
    expect(loaded?.lines.map((l) => l.id)).toEqual(['a', 'b']);
    expect(loaded?.meeting.endedAt).toBe(2_000);
  });

  it('round-trips the speaker, and stores only whole numbers', () => {
    const { meeting } = openMeeting({ engineId: 'qwen', langSrc: 'en', langTgt: 'zh' });
    appendLine({ ...line('s1', 1_000), speaker: 2 });
    appendLine(line('s2', 2_000));
    appendLine({ ...line('s3', 3_000), speaker: 1.5 });
    endMeeting('manual');

    const lines = loadMeeting(meeting.id)?.lines ?? [];
    expect(lines.map((l) => [l.id, l.speaker])).toEqual([
      ['s1', 2],
      ['s2', undefined],
      ['s3', undefined]
    ]);
    expect(lines[1]).not.toHaveProperty('speaker');
  });

  it('drops lines with no active or named meeting', () => {
    expect(() => appendLine(line('c', 3_000))).not.toThrow();
    expect(() => appendLine(line('d', 3_000, 'nope'))).not.toThrow();
  });
});

describe('listMeetings', () => {
  it('reports per-meeting line stats maintained by appendLine', () => {
    const { meeting } = openMeeting({
      engineId: 'mock',
      langSrc: 'en',
      langTgt: 'zh'
    });
    appendLine(line('l1', 10_000));
    appendLine(line('l2', 12_000));
    endMeeting('manual');

    const short = listMeetings({}).find((m) => m.id === meeting.id);
    expect(short).toBeUndefined(); // below the 3-line threshold

    appendLine(line('l3', 15_000, meeting.id));
    const listed = listMeetings({}).find((m) => m.id === meeting.id);
    expect(listed?.lineCount).toBe(3);
    expect(listed?.lastActivityAt).toBe(15_000);
  });

  it('clamps the page size', () => {
    expect(() => listMeetings({ limit: -5 })).not.toThrow();
    expect(() => listMeetings({ limit: 1e9, includeEmpty: true })).not.toThrow();
  });
});
