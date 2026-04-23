import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { scanOrphanTaskIds } from "./orphan-reconciler.js";

describe("scanOrphanTaskIds", () => {
  it("returns task ids with attempts but no task_finals row", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','s1',0,'v','regular','running',?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a2','t2','s1',0,'v','regular','success',?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO task_finals (task_id, version_hash, final_state, reason, ended_at)
       VALUES ('t2','v','completed','natural',?)`,
    ).run(now);

    const orphans = scanOrphanTaskIds(db);
    expect(orphans).toEqual(["t1"]);
  });

  it("returns empty array when every task has task_finals", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const orphans = scanOrphanTaskIds(db);
    expect(orphans).toEqual([]);
  });
});
