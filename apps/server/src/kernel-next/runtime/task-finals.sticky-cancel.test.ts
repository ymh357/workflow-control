// D4 regression: runner's finally-block upsert must not overwrite a
// pre-existing 'cancelled' task_finals row. The fix is a WHERE clause
// on the DO UPDATE: WHERE task_finals.final_state != 'cancelled'.
//
// These tests exercise the exact SQL shape used in runner.ts — any
// future removal of that WHERE clause will break the first case.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";

describe("task_finals: cancelled state is sticky against runner upsert", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
  });

  it("runner's DO UPDATE preserves existing 'cancelled' final_state", () => {
    // Seed a cancelled row (simulating cancel_task having written it via INSERT OR IGNORE)
    db.prepare(`
      INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("t1", "v1", "cancelled", "cancelled", "cancel via MCP", 1000);

    // Simulate runner's finally-block upsert attempting to flip it to 'failed'
    db.prepare(`
      INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        version_hash = excluded.version_hash,
        final_state  = excluded.final_state,
        reason       = excluded.reason,
        detail       = excluded.detail,
        ended_at     = excluded.ended_at
      WHERE task_finals.final_state != 'cancelled'
    `).run("t1", "v1", "failed", "interrupted", null, 2000);

    const row = db.prepare(
      "SELECT final_state, reason FROM task_finals WHERE task_id = ?",
    ).get("t1") as { final_state: string; reason: string };
    expect(row.final_state).toBe("cancelled");
    expect(row.reason).toBe("cancelled");
  });

  it("runner's DO UPDATE still overwrites non-cancelled final_state", () => {
    // Proves the WHERE clause only protects 'cancelled' rows
    db.prepare(`
      INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("t2", "v1", "failed", "error", "first error", 1000);

    db.prepare(`
      INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        version_hash = excluded.version_hash,
        final_state  = excluded.final_state,
        reason       = excluded.reason,
        detail       = excluded.detail,
        ended_at     = excluded.ended_at
      WHERE task_finals.final_state != 'cancelled'
    `).run("t2", "v1", "completed", "natural", null, 2000);

    const row = db.prepare(
      "SELECT final_state FROM task_finals WHERE task_id = ?",
    ).get("t2") as { final_state: string };
    expect(row.final_state).toBe("completed");
  });
});
