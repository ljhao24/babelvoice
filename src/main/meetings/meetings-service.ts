import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AppendLinePayload,
  ListMeetingsFilter,
  LoadMeetingResult,
  Meeting,
  MeetingEndedBy,
  MeetingSummary,
  MeetingTranscriptLine,
  OpenMeetingResult
} from '@shared/meeting-types.js';
import { MIN_LISTED_LINE_COUNT } from '@shared/meeting-types.js';
import { log } from '@core/utils/logger.js';
import { t } from '../i18n.js';
import { cachedStatement, getDb } from './meetings-db.js';
import { resetIdleTimer, stopIdleTimer } from './idle-watcher.js';

const LOCAL_USER_ID = 'local-default';

interface MeetingRow {
  id: string;
  user_id: string;
  title: string;
  started_at: number;
  ended_at: number | null;
  ended_by: MeetingEndedBy | null;
  engine_id: string;
  lang_src: string;
  lang_tgt: string;
  updated_at: number;
  deleted_at: number | null;
}

interface TranscriptRow {
  id: string;
  meeting_id: string;
  direction: 'speak' | 'listen';
  src: string;
  tgt: string;
  at: number;
  session_seq: number;
  speaker: number | null;
  updated_at: number;
  deleted_at: number | null;
}

const rowToMeeting = (r: MeetingRow): Meeting => ({
  id: r.id,
  userId: r.user_id,
  title: r.title,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  endedBy: r.ended_by,
  engineId: r.engine_id,
  langSrc: r.lang_src,
  langTgt: r.lang_tgt,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at
});

const rowToLine = (r: TranscriptRow): MeetingTranscriptLine => ({
  id: r.id,
  meetingId: r.meeting_id,
  direction: r.direction,
  src: r.src,
  tgt: r.tgt,
  at: r.at,
  sessionSeq: r.session_seq,
  ...(r.speaker === null ? {} : { speaker: r.speaker }),
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at
});

let currentMeetingId: string | null = null;
let onActiveChangeFn: ((active: boolean) => void) | null = null;

export const getCurrentMeetingId = (): string | null => currentMeetingId;

/** Called whenever a meeting opens (true) or ends, on any path (false). */
export const setMeetingActiveHandler = (fn: (active: boolean) => void): void => {
  onActiveChangeFn = fn;
};

const formatDefaultTitle = (at: number): string => {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${t('common:meetingTitleSuffix')}`;
};

/** Run on startup: any meeting with ended_at IS NULL is a crashed leftover. */
export const recoverCrashedMeetings = (): void => {
  const db = getDb();
  const rows = db
    .prepare<[string], MeetingRow>(
      `SELECT * FROM meetings
       WHERE user_id = ? AND ended_at IS NULL AND deleted_at IS NULL`
    )
    .all(LOCAL_USER_ID);
  if (rows.length === 0) return;

  const lastAtStmt = db.prepare<[string], { max_at: number | null }>(
    `SELECT MAX(at) AS max_at FROM transcript_lines WHERE meeting_id = ? AND deleted_at IS NULL`
  );
  const updateStmt = db.prepare(
    `UPDATE meetings SET ended_at = ?, ended_by = 'crashed', updated_at = ? WHERE id = ?`
  );
  for (const r of rows) {
    const max = lastAtStmt.get(r.id);
    const endedAt = max?.max_at ?? r.started_at;
    updateStmt.run(endedAt, Date.now(), r.id);
    log.info(`recovered crashed meeting ${r.id} (ended_at=${endedAt})`);
  }
};

interface OpenParams {
  engineId: string;
  langSrc: string;
  langTgt: string;
}

export const openMeeting = (params: OpenParams): OpenMeetingResult => {
  if (currentMeetingId) {
    throw new Error(`A meeting is already active (${currentMeetingId})`);
  }
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const title = formatDefaultTitle(now);
  db.prepare(
    `INSERT INTO meetings
       (id, user_id, title, started_at, ended_at, ended_by, engine_id, lang_src, lang_tgt, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL)`
  ).run(
    id,
    LOCAL_USER_ID,
    title,
    now,
    params.engineId,
    params.langSrc,
    params.langTgt,
    now
  );
  currentMeetingId = id;
  resetIdleTimer();
  log.info(`opened meeting ${id} "${title}"`);
  onActiveChangeFn?.(true);
  const row = db
    .prepare<[string], MeetingRow>('SELECT * FROM meetings WHERE id = ?')
    .get(id);
  if (!row) throw new Error('meeting row vanished after insert');
  return { meeting: rowToMeeting(row) };
};

export const endMeeting = (endedBy: MeetingEndedBy): Meeting | null => {
  if (!currentMeetingId) return null;
  const id = currentMeetingId;
  currentMeetingId = null;
  stopIdleTimer();
  onActiveChangeFn?.(false);

  const db = getDb();
  const now = Date.now();
  const lastAt = db
    .prepare<[string], { max_at: number | null }>(
      `SELECT MAX(at) AS max_at FROM transcript_lines WHERE meeting_id = ? AND deleted_at IS NULL`
    )
    .get(id);
  const endedAt = lastAt?.max_at ?? now;
  db.prepare(
    `UPDATE meetings SET ended_at = ?, ended_by = ?, updated_at = ? WHERE id = ? AND ended_at IS NULL`
  ).run(endedAt, endedBy, now, id);
  log.info(`ended meeting ${id} (${endedBy})`);
  const row = db
    .prepare<[string], MeetingRow>('SELECT * FROM meetings WHERE id = ?')
    .get(id);
  return row ? rowToMeeting(row) : null;
};

const INSERT_LINE_SQL = `INSERT INTO transcript_lines
   (id, meeting_id, direction, src, tgt, at, session_seq, speaker, updated_at, deleted_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`;

const BUMP_LINE_STATS_SQL = `UPDATE meetings
   SET line_count = line_count + 1,
       last_line_at = MAX(COALESCE(last_line_at, ?), ?)
 WHERE id = ?`;

/** Upper bound on one list page, whatever the renderer asks for. */
const MAX_LIST_LIMIT = 500;

export const appendLine = (payload: AppendLinePayload): void => {
  const id = payload.meetingId ?? currentMeetingId;
  if (!id) {
    log.warn('appendLine called with no active meeting; dropping');
    return;
  }
  const db = getDb();
  const now = Date.now();
  const isCurrent = id === currentMeetingId;
  if (!isCurrent) {
    // Late flush for a meeting main already ended (the renderer settles its
    // last stitched sentence after the end IPC returns). Accept it for a
    // real, non-deleted meeting only.
    const meeting = cachedStatement(
      db,
      'SELECT ended_at FROM meetings WHERE id = ? AND deleted_at IS NULL'
    ).get(id) as { ended_at: number | null } | undefined;
    if (!meeting) {
      log.warn(`appendLine for unknown meeting ${id}; dropping`);
      return;
    }
  }
  db.transaction(() => {
    cachedStatement(db, INSERT_LINE_SQL).run(
      payload.id,
      id,
      payload.direction,
      payload.src,
      payload.tgt,
      payload.at,
      payload.sessionSeq,
      Number.isInteger(payload.speaker) ? payload.speaker : null,
      now
    );
    cachedStatement(db, BUMP_LINE_STATS_SQL).run(payload.at, payload.at, id);
  })();
  if (isCurrent) {
    resetIdleTimer();
  } else {
    // ended_at was derived from the last line at end time; keep it covering
    // the late line so the meeting duration stays consistent.
    cachedStatement(
      db,
      'UPDATE meetings SET ended_at = MAX(ended_at, ?), updated_at = ? WHERE id = ? AND ended_at IS NOT NULL'
    ).run(payload.at, now, id);
  }
};

export const listMeetings = (
  filter: ListMeetingsFilter = {}
): MeetingSummary[] => {
  const db = getDb();
  const requested = Number(filter.limit ?? 200);
  const limit = Number.isFinite(requested)
    ? Math.min(Math.max(1, Math.floor(requested)), MAX_LIST_LIMIT)
    : 200;
  const minLines = filter.includeEmpty ? 0 : MIN_LISTED_LINE_COUNT;
  const params: unknown[] = [LOCAL_USER_ID];
  let whereTitle = '';
  if (typeof filter.query === 'string' && filter.query.trim()) {
    whereTitle = ' AND m.title LIKE ?';
    params.push(`%${filter.query.trim()}%`);
  }
  params.push(minLines, limit);
  const rows = cachedStatement(
    db,
    `SELECT m.*,
            m.line_count AS line_count,
            COALESCE(m.last_line_at, m.started_at) AS last_activity_at
     FROM meetings m
     WHERE m.user_id = ?
       AND m.deleted_at IS NULL
       ${whereTitle}
       AND m.line_count >= ?
     ORDER BY m.started_at DESC
     LIMIT ?`
  ).all(...params) as Array<
    MeetingRow & { line_count: number; last_activity_at: number }
  >;
  return rows.map((r) => ({
    ...rowToMeeting(r),
    lineCount: r.line_count,
    lastActivityAt: r.last_activity_at
  }));
};

export const loadMeeting = (id: string): LoadMeetingResult | null => {
  const db = getDb();
  const row = db
    .prepare<[string], MeetingRow>(
      'SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL'
    )
    .get(id);
  if (!row) return null;
  const lines = db
    .prepare<[string], TranscriptRow>(
      `SELECT * FROM transcript_lines
       WHERE meeting_id = ? AND deleted_at IS NULL
       ORDER BY at ASC`
    )
    .all(id);
  return {
    meeting: rowToMeeting(row),
    lines: lines.map(rowToLine)
  };
};

export const renameMeeting = (id: string, title: string): Meeting | null => {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE meetings SET title = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`
  ).run(title, now, id);
  const row = db
    .prepare<[string], MeetingRow>('SELECT * FROM meetings WHERE id = ?')
    .get(id);
  return row ? rowToMeeting(row) : null;
};

export const softDeleteMeeting = (id: string): void => {
  if (currentMeetingId === id) {
    throw new Error('Cannot delete the active meeting; end it first');
  }
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `UPDATE meetings SET deleted_at = ?, updated_at = ? WHERE id = ?`
  ).run(now, now, id);
};

export const getCurrentMeeting = (): Meeting | null => {
  if (!currentMeetingId) return null;
  const db = getDb();
  const row = db
    .prepare<[string], MeetingRow>('SELECT * FROM meetings WHERE id = ?')
    .get(currentMeetingId);
  return row ? rowToMeeting(row) : null;
};
