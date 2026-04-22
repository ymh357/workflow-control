import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "./sql.js";

describe("stage_checkpoints table", () => {
  it("creates table with expected columns and CHECK on status", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);

    const columns = db
      .prepare(`PRAGMA table_info(stage_checkpoints)`)
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

    expect(byName.attempt_id).toBeDefined();
    expect(byName.attempt_id?.pk).toBe(1);
    expect(byName.workdir?.notnull).toBe(1);
    expect(byName.before_sha).toBeDefined();
    expect(byName.after_sha).toBeDefined();
    expect(byName.diff_text).toBeDefined();
    expect(byName.diff_bytes).toBeDefined();
    expect(byName.status?.notnull).toBe(1);
    expect(byName.diagnostic).toBeDefined();
    expect(byName.captured_before_at?.notnull).toBe(1);
    expect(byName.captured_after_at).toBeDefined();
  });

  it("enforces status CHECK constraint", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    db.exec("PRAGMA foreign_keys = OFF");

    expect(() =>
      db.prepare(
        `INSERT INTO stage_checkpoints
         (attempt_id, workdir, status, captured_before_at)
         VALUES (?, ?, ?, ?)`,
      ).run("a1", "/tmp", "bogus_status", 1),
    ).toThrow(/CHECK/);

    expect(() =>
      db.prepare(
        `INSERT INTO stage_checkpoints
         (attempt_id, workdir, status, captured_before_at)
         VALUES (?, ?, ?, ?)`,
      ).run("a2", "/tmp", "capturing", 1),
    ).not.toThrow();
  });

  it("cascades on stage_attempts delete", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    db.exec("PRAGMA foreign_keys = ON");

    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
       VALUES ('a1','t1','v1','s1',1,1,'running','regular')`,
    ).run();
    db.prepare(
      `INSERT INTO stage_checkpoints
       (attempt_id, workdir, status, captured_before_at)
       VALUES ('a1', '/tmp', 'capturing', 1)`,
    ).run();

    db.prepare(`DELETE FROM stage_attempts WHERE attempt_id = ?`).run("a1");
    const count = (db.prepare(
      `SELECT COUNT(*) AS c FROM stage_checkpoints WHERE attempt_id = ?`,
    ).get("a1") as { c: number }).c;
    expect(count).toBe(0);
  });
});
