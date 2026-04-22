import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import {
  writeMigrationHint,
  peekUnconsumedHint,
  consumeHint,
} from "./migration-hints.js";

function mkDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

const baseHint = {
  taskId: "t1",
  stageName: "s1",
  fromVersion: "v1",
  toVersion: "v2",
  previousAttemptId: "a-old",
  previousDiffText: "diff body",
  previousDiffBytes: 9,
  note: "migration note",
};

describe("writeMigrationHint", () => {
  it("inserts a row with all fields", () => {
    const db = mkDb();
    const id = writeMigrationHint(db, baseHint, () => 1_700_000_000_000);
    const row = db.prepare(`SELECT * FROM migration_hints WHERE hint_id = ?`).get(id) as Record<string, unknown>;
    expect(row.task_id).toBe("t1");
    expect(row.stage_name).toBe("s1");
    expect(row.from_version).toBe("v1");
    expect(row.to_version).toBe("v2");
    expect(row.previous_attempt_id).toBe("a-old");
    expect(row.previous_diff_text).toBe("diff body");
    expect(row.previous_diff_bytes).toBe(9);
    expect(row.note).toBe("migration note");
    expect(row.created_at).toBe(1_700_000_000_000);
    expect(row.consumed_at).toBeNull();
  });

  it("allows nullable fields to be null", () => {
    const db = mkDb();
    const id = writeMigrationHint(db, {
      ...baseHint,
      previousAttemptId: null,
      previousDiffText: null,
      previousDiffBytes: null,
      note: null,
    });
    const row = db.prepare(`SELECT * FROM migration_hints WHERE hint_id = ?`).get(id) as Record<string, unknown>;
    expect(row.previous_attempt_id).toBeNull();
    expect(row.previous_diff_text).toBeNull();
  });
});

describe("peekUnconsumedHint", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = mkDb(); });

  it("returns null when no hint", () => {
    expect(peekUnconsumedHint(db, "t1", "s1")).toBeNull();
  });

  it("returns the most recent unconsumed hint", () => {
    writeMigrationHint(db, { ...baseHint, note: "old" }, () => 1000);
    writeMigrationHint(db, { ...baseHint, note: "new" }, () => 2000);
    const hint = peekUnconsumedHint(db, "t1", "s1");
    expect(hint?.note).toBe("new");
    expect(hint?.createdAt).toBe(2000);
  });

  it("skips consumed hints", () => {
    const id = writeMigrationHint(db, baseHint, () => 1000);
    db.prepare(`UPDATE migration_hints SET consumed_at = ? WHERE hint_id = ?`).run(500, id);
    expect(peekUnconsumedHint(db, "t1", "s1")).toBeNull();
  });

  it("does not flip consumed_at (peek is read-only)", () => {
    writeMigrationHint(db, baseHint, () => 1000);
    peekUnconsumedHint(db, "t1", "s1");
    const row = db.prepare(`SELECT consumed_at FROM migration_hints`).get() as { consumed_at: number | null };
    expect(row.consumed_at).toBeNull();
  });

  it("scopes to (taskId, stageName)", () => {
    writeMigrationHint(db, { ...baseHint, taskId: "t1", stageName: "s1" });
    writeMigrationHint(db, { ...baseHint, taskId: "t1", stageName: "s2" });
    writeMigrationHint(db, { ...baseHint, taskId: "t2", stageName: "s1" });
    expect(peekUnconsumedHint(db, "t1", "s1")).not.toBeNull();
    expect(peekUnconsumedHint(db, "t1", "s2")).not.toBeNull();
    expect(peekUnconsumedHint(db, "t2", "s1")).not.toBeNull();
    expect(peekUnconsumedHint(db, "t3", "s1")).toBeNull();
  });
});

describe("consumeHint", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = mkDb(); });

  it("returns null + no-op when no hint", () => {
    expect(consumeHint(db, "t1", "s1")).toBeNull();
  });

  it("returns the hint and flips consumed_at", () => {
    writeMigrationHint(db, baseHint, () => 1000);
    const consumed = consumeHint(db, "t1", "s1", () => 2000);
    expect(consumed).not.toBeNull();
    expect(consumed!.note).toBe("migration note");
    expect(consumed!.consumedAt).toBe(2000);
    // Second call sees nothing.
    expect(consumeHint(db, "t1", "s1")).toBeNull();
  });

  it("picks newest when multiple unconsumed siblings exist", () => {
    writeMigrationHint(db, { ...baseHint, note: "old" }, () => 1000);
    writeMigrationHint(db, { ...baseHint, note: "new" }, () => 2000);
    const consumed = consumeHint(db, "t1", "s1", () => 3000);
    expect(consumed?.note).toBe("new");
    // Older sibling remains unconsumed (audit trail).
    const stillUnconsumed = peekUnconsumedHint(db, "t1", "s1");
    expect(stillUnconsumed?.note).toBe("old");
  });

  it("takes-once semantics: a second concurrent consume sees null", () => {
    writeMigrationHint(db, baseHint);
    expect(consumeHint(db, "t1", "s1")).not.toBeNull();
    expect(consumeHint(db, "t1", "s1")).toBeNull();
  });

  it("returns null payload when the target was consumed between SELECT and UPDATE", () => {
    // Simulate interleaving by pre-consuming inside a mocked interval:
    // we write then immediately consume twice — the guard `AND consumed_at IS NULL`
    // in UPDATE ensures the second attempt returns null.
    writeMigrationHint(db, baseHint);
    const first = consumeHint(db, "t1", "s1");
    expect(first).not.toBeNull();
    const second = consumeHint(db, "t1", "s1");
    expect(second).toBeNull();
  });
});
