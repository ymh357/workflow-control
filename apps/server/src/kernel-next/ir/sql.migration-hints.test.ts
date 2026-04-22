import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "./sql.js";

describe("migration_hints table", () => {
  it("creates table with expected columns", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);

    const columns = db
      .prepare(`PRAGMA table_info(migration_hints)`)
      .all() as Array<{ name: string; notnull: number; pk: number }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

    expect(byName.hint_id?.pk).toBe(1);
    expect(byName.task_id?.notnull).toBe(1);
    expect(byName.stage_name?.notnull).toBe(1);
    expect(byName.from_version?.notnull).toBe(1);
    expect(byName.to_version?.notnull).toBe(1);
    expect(byName.previous_attempt_id).toBeDefined();
    expect(byName.previous_diff_text).toBeDefined();
    expect(byName.previous_diff_bytes).toBeDefined();
    expect(byName.note).toBeDefined();
    expect(byName.created_at?.notnull).toBe(1);
    expect(byName.consumed_at).toBeDefined();
  });

  it("accepts INSERT with only required columns + leaves optional nullable", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    expect(() =>
      db.prepare(
        `INSERT INTO migration_hints
         (hint_id, task_id, stage_name, from_version, to_version, created_at)
         VALUES ('h1', 't1', 's1', 'v1', 'v2', 1000)`,
      ).run(),
    ).not.toThrow();
    const row = db.prepare(
      `SELECT previous_attempt_id, previous_diff_text, consumed_at FROM migration_hints`,
    ).get() as {
      previous_attempt_id: string | null;
      previous_diff_text: string | null;
      consumed_at: number | null;
    };
    expect(row.previous_attempt_id).toBeNull();
    expect(row.previous_diff_text).toBeNull();
    expect(row.consumed_at).toBeNull();
  });

  it("partial index on (task_id, stage_name) WHERE consumed_at IS NULL exists", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const idx = db
      .prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name='idx_mh_task_stage_unconsumed'`)
      .get();
    expect(idx).toBeDefined();
  });
});
