import type { DatabaseSync } from "node:sqlite";
import type { SessionRow, SessionEvent } from "../types.js";

export function upsertSession(
  db: DatabaseSync,
  args: {
    sessionId: string;
    cwd: string;
    jsonlPath: string;
    firstSeenAt: number;
    lastEventAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO sessions(session_id, cwd, jsonl_path, first_seen_at, last_event_at, status, event_count)
     VALUES (?, ?, ?, ?, ?, 'active', 0)
     ON CONFLICT(session_id) DO UPDATE SET
       last_event_at = MAX(last_event_at, excluded.last_event_at)`,
  ).run(args.sessionId, args.cwd, args.jsonlPath, args.firstSeenAt, args.lastEventAt);
}

function rowToSession(row: Record<string, unknown>): SessionRow {
  return {
    sessionId: row.session_id as string,
    cwd: row.cwd as string,
    jsonlPath: row.jsonl_path as string,
    byteOffset: row.byte_offset as number,
    firstSeenAt: row.first_seen_at as number,
    lastEventAt: row.last_event_at as number,
    status: row.status as SessionRow["status"],
    eventCount: row.event_count as number,
    skipReason: (row.skip_reason as string | null) ?? null,
  };
}

export function getSession(db: DatabaseSync, sessionId: string): SessionRow | null {
  const row = db.prepare(
    `SELECT * FROM sessions WHERE session_id = ?`,
  ).get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToSession(row);
}

export function advanceByteOffset(db: DatabaseSync, sessionId: string, newOffset: number): void {
  db.prepare(
    `UPDATE sessions SET byte_offset = MAX(byte_offset, ?) WHERE session_id = ?`,
  ).run(newOffset, sessionId);
}

export function setSessionStatus(
  db: DatabaseSync,
  sessionId: string,
  status: SessionRow["status"],
  skipReason?: string,
): void {
  db.prepare(
    `UPDATE sessions SET status = ?, skip_reason = ? WHERE session_id = ?`,
  ).run(status, skipReason ?? null, sessionId);
}

export function listSessionsByStatus(
  db: DatabaseSync,
  status: SessionRow["status"],
): SessionRow[] {
  const rows = db.prepare(
    `SELECT * FROM sessions WHERE status = ? ORDER BY last_event_at ASC`,
  ).all(status) as Array<Record<string, unknown>>;
  return rows.map(rowToSession);
}

export function listAllSessions(db: DatabaseSync, limit = 200): SessionRow[] {
  const rows = db.prepare(
    `SELECT * FROM sessions ORDER BY last_event_at DESC LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToSession);
}

function rowToEvent(r: Record<string, unknown>): SessionEvent {
  return {
    sessionId: r.session_id as string,
    seq: r.seq as number,
    ts: r.ts as number,
    role: r.role as SessionEvent["role"],
    textExcerpt: (r.text_excerpt as string | null) ?? null,
    textHash: (r.text_hash as string | null) ?? null,
    textLength: (r.text_length as number | null) ?? null,
    toolName: (r.tool_name as string | null) ?? null,
    toolArgsExcerpt: (r.tool_args_excerpt as string | null) ?? null,
  };
}

export function insertEvents(db: DatabaseSync, sessionId: string, events: SessionEvent[]): void {
  if (events.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO session_events
       (session_id, seq, ts, role, text_excerpt, text_hash, text_length, tool_name, tool_args_excerpt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let inserted = 0;
  for (const e of events) {
    const r = stmt.run(
      e.sessionId, e.seq, e.ts, e.role,
      e.textExcerpt, e.textHash, e.textLength,
      e.toolName, e.toolArgsExcerpt,
    );
    inserted += Number(r.changes);
  }
  db.prepare(
    `UPDATE sessions SET event_count = event_count + ? WHERE session_id = ?`,
  ).run(inserted, sessionId);
}

export function listEventsBySession(db: DatabaseSync, sessionId: string): SessionEvent[] {
  const rows = db.prepare(
    `SELECT * FROM session_events WHERE session_id = ? ORDER BY seq ASC`,
  ).all(sessionId) as Array<Record<string, unknown>>;
  return rows.map(rowToEvent);
}

export function getMaxSeq(db: DatabaseSync, sessionId: string): number {
  const r = db.prepare(
    `SELECT MAX(seq) as m FROM session_events WHERE session_id = ?`,
  ).get(sessionId) as { m: number | null };
  return r.m ?? 0;
}
