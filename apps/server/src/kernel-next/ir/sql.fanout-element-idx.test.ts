// B17 full: stage_attempts.fanout_element_idx column + CHECK constraint.
//
// Captures three invariants:
//   1. column exists and defaults to NULL
//   2. fanout_element rows MUST carry a non-NULL idx (CHECK rejects NULL)
//   3. non-fanout_element rows MAY carry NULL (CHECK permits it)

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "./sql.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function insertAttempt(
  db: DatabaseSync,
  args: {
    attemptId: string;
    kind: string;
    fanoutElementIdx?: number | null;
    attemptIdx?: number;
  },
): void {
  db.prepare(
    `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, status, kind, fanout_element_idx)
     VALUES (?, 'tk', 'v', 's', ?, 0, 'running', ?, ?)`,
  ).run(
    args.attemptId,
    args.attemptIdx ?? 1,
    args.kind,
    args.fanoutElementIdx ?? null,
  );
}

describe("stage_attempts.fanout_element_idx", () => {
  it("column exists and defaults to NULL", () => {
    const db = makeDb();
    const cols = db.prepare(`PRAGMA table_info(stage_attempts)`).all() as Array<{ name: string; dflt_value: unknown }>;
    const col = cols.find((c) => c.name === "fanout_element_idx");
    expect(col).toBeDefined();
    // NULL default (INTEGER NULL column)
    expect(col!.dflt_value).toBeNull();
    db.close();
  });

  it("accepts a non-NULL idx on a fanout_element row", () => {
    const db = makeDb();
    insertAttempt(db, { attemptId: "fe1", kind: "fanout_element", fanoutElementIdx: 0 });
    const row = db.prepare(`SELECT fanout_element_idx FROM stage_attempts WHERE attempt_id = 'fe1'`).get() as { fanout_element_idx: number };
    expect(row.fanout_element_idx).toBe(0);
    db.close();
  });

  it("rejects NULL fanout_element_idx on a fanout_element row (CHECK constraint)", () => {
    const db = makeDb();
    expect(() => {
      insertAttempt(db, { attemptId: "fe2", kind: "fanout_element", fanoutElementIdx: null });
    }).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("permits NULL fanout_element_idx on non-fanout_element rows", () => {
    const db = makeDb();
    for (const kind of ["regular", "fanout_aggregate", "external", "replay", "dry_run"]) {
      const aid = `a-${kind}`;
      expect(() => insertAttempt(db, { attemptId: aid, kind, fanoutElementIdx: null })).not.toThrow();
      const row = db.prepare(`SELECT fanout_element_idx FROM stage_attempts WHERE attempt_id = ?`).get(aid) as { fanout_element_idx: number | null };
      expect(row.fanout_element_idx).toBeNull();
    }
    db.close();
  });

  it("permits non-NULL idx on non-fanout_element rows (CHECK only requires it for fanout_element)", () => {
    // The CHECK is "kind != 'fanout_element' OR fanout_element_idx IS NOT NULL".
    // Writing a value on another kind must not be rejected (that's the
    // caller's contract issue, not a schema invariant).
    const db = makeDb();
    expect(() => insertAttempt(db, { attemptId: "r1", kind: "regular", fanoutElementIdx: 42 })).not.toThrow();
    db.close();
  });
});
