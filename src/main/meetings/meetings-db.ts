import { app } from 'electron';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { log } from '@core/utils/logger.js';

let db: Database.Database | null = null;

const migrations: ((db: Database.Database) => void)[] = [
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        ended_by TEXT,
        engine_id TEXT NOT NULL,
        lang_src TEXT NOT NULL,
        lang_tgt TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_meetings_user_started
        ON meetings(user_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_meetings_active
        ON meetings(user_id, ended_at) WHERE ended_at IS NULL;

      CREATE TABLE IF NOT EXISTS transcript_lines (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id),
        direction TEXT NOT NULL,
        src TEXT NOT NULL,
        tgt TEXT NOT NULL,
        at INTEGER NOT NULL,
        session_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_lines_meeting_at
        ON transcript_lines(meeting_id, at);
    `);
  },
  // Denormalized per-meeting line stats, maintained by appendLine. The
  // meetings list used to GROUP BY the whole transcript_lines table on every
  // search keystroke — synchronously, on the main process.
  (d) => {
    d.exec(`
      ALTER TABLE meetings ADD COLUMN line_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE meetings ADD COLUMN last_line_at INTEGER;
      UPDATE meetings SET
        line_count = (
          SELECT COUNT(*) FROM transcript_lines l
          WHERE l.meeting_id = meetings.id AND l.deleted_at IS NULL
        ),
        last_line_at = (
          SELECT MAX(at) FROM transcript_lines l
          WHERE l.meeting_id = meetings.id AND l.deleted_at IS NULL
        );
    `);
  },
  // Provider usage per meeting × engine × direction (MeetingMonitor). Rows
  // hold running totals, upserted while the meeting runs; `tokens_json` is a
  // TokenCounts object so new categories need no migration. `cost` is the
  // estimate under the prices in force at the last update — history keeps
  // what a meeting cost then, not what it would cost today.
  (d) => {
    d.exec(`
      CREATE TABLE IF NOT EXISTS meeting_usage (
        meeting_id    TEXT NOT NULL REFERENCES meetings(id),
        engine_id     TEXT NOT NULL,
        direction     TEXT NOT NULL CHECK (direction IN ('speak','listen')),
        tokens_json   TEXT NOT NULL,
        estimated     INTEGER NOT NULL DEFAULT 0,
        audio_in_ms   INTEGER NOT NULL DEFAULT 0,
        audio_out_ms  INTEGER NOT NULL DEFAULT 0,
        sessions      INTEGER NOT NULL DEFAULT 0,
        reconnects    INTEGER NOT NULL DEFAULT 0,
        failures      INTEGER NOT NULL DEFAULT 0,
        cost          REAL,
        cost_currency TEXT,
        cost_complete INTEGER,
        updated_at    INTEGER NOT NULL,
        PRIMARY KEY (meeting_id, engine_id, direction)
      );
    `);
  },
  // Who said each line, for engines that tell speakers apart (1, 2, … per
  // engine session). NULL for everything else, including all older lines.
  (d) => {
    d.exec('ALTER TABLE transcript_lines ADD COLUMN speaker INTEGER;');
  }
];

// Hot statements (appendLine once per committed sentence, the usage upsert
// every few seconds) are compiled once per DB handle, not on every call.
const statementCache = new WeakMap<
  Database.Database,
  Map<string, Database.Statement>
>();
export const cachedStatement = (
  handle: Database.Database,
  sql: string
): Database.Statement => {
  let byHandle = statementCache.get(handle);
  if (!byHandle) {
    byHandle = new Map();
    statementCache.set(handle, byHandle);
  }
  let stmt = byHandle.get(sql);
  if (!stmt) {
    stmt = handle.prepare(sql);
    byHandle.set(sql, stmt);
  }
  return stmt;
};

export const getDb = (): Database.Database => {
  if (db) return db;
  const path = join(app.getPath('userData'), 'meetings.db');
  const instance = new Database(path);
  instance.pragma('journal_mode = WAL');
  instance.pragma('synchronous = NORMAL');
  instance.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      version INTEGER PRIMARY KEY
    );
  `);
  const row = instance
    .prepare<[], { version: number } | undefined>(
      'SELECT MAX(version) AS version FROM schema_meta'
    )
    .get();
  const current = row?.version ?? 0;
  for (let i = current; i < migrations.length; i += 1) {
    const tx = instance.transaction(() => {
      migrations[i](instance);
      instance
        .prepare('INSERT INTO schema_meta (version) VALUES (?)')
        .run(i + 1);
    });
    tx();
    log.info(`meetings.db migrated to v${i + 1}`);
  }
  db = instance;
  return db;
};

export const closeDb = (): void => {
  if (db) {
    db.close();
    db = null;
  }
};
