import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'babelvoice-meetings-db-'));

vi.mock('electron', () => ({ app: { getPath: () => dir } }));

// A database left behind by a build that only knew schema v1.
const seed = new Database(join(dir, 'meetings.db'));
seed.exec(`
  CREATE TABLE schema_meta (version INTEGER PRIMARY KEY);
  INSERT INTO schema_meta (version) VALUES (1);
  CREATE TABLE meetings (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER, ended_by TEXT,
    engine_id TEXT NOT NULL, lang_src TEXT NOT NULL, lang_tgt TEXT NOT NULL,
    updated_at INTEGER NOT NULL, deleted_at INTEGER
  );
  CREATE TABLE transcript_lines (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id),
    direction TEXT NOT NULL, src TEXT NOT NULL, tgt TEXT NOT NULL,
    at INTEGER NOT NULL, session_seq INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, deleted_at INTEGER
  );
  INSERT INTO meetings VALUES ('m1', 'local', 't', 100, 900, 'manual', 'mock', 'en', 'zh', 900, NULL);
  INSERT INTO meetings VALUES ('m2', 'local', 't', 200, NULL, NULL, 'mock', 'en', 'zh', 200, NULL);
  INSERT INTO transcript_lines VALUES ('a', 'm1', 'listen', 's', 't', 300, 1, 300, NULL);
  INSERT INTO transcript_lines VALUES ('b', 'm1', 'listen', 's', 't', 800, 1, 800, NULL);
`);
seed.close();

const { closeDb, getDb } = await import('./meetings-db.js');
const { loadMeetingUsage, saveMeetingUsage } = await import('./meeting-usage-repo.js');

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('meetings.db migrations', () => {
  it('backfills line stats when upgrading from v1', () => {
    const rows = getDb()
      .prepare('SELECT id, line_count, last_line_at FROM meetings ORDER BY id')
      .all();
    expect(rows).toEqual([
      { id: 'm1', line_count: 2, last_line_at: 800 },
      { id: 'm2', line_count: 0, last_line_at: null }
    ]);
  });

  it('upgrades to v4 and round-trips running usage totals', () => {
    expect(
      getDb().prepare('SELECT MAX(version) AS v FROM schema_meta').get()
    ).toEqual({ v: 4 });
    const line = {
      engineId: 'qwen' as const,
      direction: 'speak' as const,
      tokens: { inputAudio: 1200, outputText: 80 },
      estimated: true,
      audioInMs: 48_000.4,
      audioOutMs: 0,
      sessions: 2,
      reconnects: 1,
      failures: 0,
      cost: { amount: 0.25, currency: 'CNY' as const, complete: false }
    };
    saveMeetingUsage('m1', [line], 1000);
    // Totals overwrite, they don't add up.
    saveMeetingUsage('m1', [{ ...line, sessions: 3, cost: null }], 2000);
    expect(loadMeetingUsage('m1')).toEqual([
      { ...line, audioInMs: 48_000, sessions: 3, cost: null }
    ]);
    expect(loadMeetingUsage('m2')).toEqual([]);
  });

  it('gives existing lines an empty speaker', () => {
    expect(
      getDb().prepare('SELECT id, speaker FROM transcript_lines ORDER BY id').all()
    ).toEqual([
      { id: 'a', speaker: null },
      { id: 'b', speaker: null }
    ]);
  });
});
