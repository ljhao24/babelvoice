import type { Direction } from '@shared/ipc-types.js';
import type { EngineId } from '@shared/engine-types.js';
import {
  PRICE_CURRENCIES,
  TOKEN_CATEGORIES,
  type MeetingUsageLine,
  type PriceCurrency,
  type TokenCounts
} from '@shared/meeting-metrics-types.js';
import { cachedStatement, getDb } from './meetings-db.js';

interface UsageRow {
  engine_id: string;
  direction: Direction;
  tokens_json: string;
  estimated: number;
  audio_in_ms: number;
  audio_out_ms: number;
  sessions: number;
  reconnects: number;
  failures: number;
  cost: number | null;
  cost_currency: string | null;
  cost_complete: number | null;
}

const UPSERT_SQL = `INSERT INTO meeting_usage
  (meeting_id, engine_id, direction, tokens_json, estimated, audio_in_ms,
   audio_out_ms, sessions, reconnects, failures, cost, cost_currency,
   cost_complete, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (meeting_id, engine_id, direction) DO UPDATE SET
    tokens_json = excluded.tokens_json,
    estimated = excluded.estimated,
    audio_in_ms = excluded.audio_in_ms,
    audio_out_ms = excluded.audio_out_ms,
    sessions = excluded.sessions,
    reconnects = excluded.reconnects,
    failures = excluded.failures,
    cost = excluded.cost,
    cost_currency = excluded.cost_currency,
    cost_complete = excluded.cost_complete,
    updated_at = excluded.updated_at`;

const SELECT_SQL = `SELECT engine_id, direction, tokens_json, estimated, audio_in_ms,
  audio_out_ms, sessions, reconnects, failures, cost, cost_currency, cost_complete
  FROM meeting_usage WHERE meeting_id = ? ORDER BY direction, engine_id`;

/** Only known categories with positive counts survive a round trip. */
const parseTokens = (json: string): TokenCounts => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  const out: TokenCounts = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const cat of TOKEN_CATEGORIES) {
    const n = (raw as Record<string, unknown>)[cat];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[cat] = n;
  }
  return out;
};

const isCurrency = (v: unknown): v is PriceCurrency =>
  (PRICE_CURRENCIES as readonly unknown[]).includes(v);

const rowToLine = (r: UsageRow): MeetingUsageLine => ({
  engineId: r.engine_id as EngineId,
  direction: r.direction,
  tokens: parseTokens(r.tokens_json),
  estimated: r.estimated !== 0,
  audioInMs: r.audio_in_ms,
  audioOutMs: r.audio_out_ms,
  sessions: r.sessions,
  reconnects: r.reconnects,
  failures: r.failures,
  cost:
    r.cost !== null && isCurrency(r.cost_currency)
      ? { amount: r.cost, currency: r.cost_currency, complete: r.cost_complete !== 0 }
      : null
});

/** Upsert running totals; one transaction for the whole batch. */
export const saveMeetingUsage = (
  meetingId: string,
  lines: readonly MeetingUsageLine[],
  at: number = Date.now()
): void => {
  if (lines.length === 0) return;
  const db = getDb();
  const upsert = cachedStatement(db, UPSERT_SQL);
  db.transaction(() => {
    for (const l of lines) {
      upsert.run(
        meetingId,
        l.engineId,
        l.direction,
        JSON.stringify(l.tokens),
        l.estimated ? 1 : 0,
        Math.round(l.audioInMs),
        Math.round(l.audioOutMs),
        l.sessions,
        l.reconnects,
        l.failures,
        l.cost?.amount ?? null,
        l.cost?.currency ?? null,
        l.cost ? (l.cost.complete ? 1 : 0) : null,
        at
      );
    }
  })();
};

export const loadMeetingUsage = (meetingId: string): MeetingUsageLine[] =>
  (cachedStatement(getDb(), SELECT_SQL).all(meetingId) as UsageRow[]).map(rowToLine);
