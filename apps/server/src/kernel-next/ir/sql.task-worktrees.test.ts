// W1 — Phase 5C worktree ownership contract — task_worktrees table.
//
// One row per task that has ever had a worktree allocated. PRIMARY KEY
// on task_id: a single task owns at most one workdir over its whole
// lifetime (including migration / resume). The status enum lets us
// distinguish active (worktree exists + usable), unavailable (git
// setup failed, caller should fall back), and pruned (user removed).

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "./sql.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function insertRow(db: DatabaseSync, args: {
  taskId: string; workdir: string; baseBranch?: string | null;
  branchName: string; status: string; diagnostic?: string | null;
}): void {
  db.prepare(
    `INSERT INTO task_worktrees
     (task_id, workdir, base_branch, branch_name, status,
      created_at, last_used_at, diagnostic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.taskId, args.workdir, args.baseBranch ?? null,
    args.branchName, args.status, Date.now(), Date.now(),
    args.diagnostic ?? null,
  );
}

describe("task_worktrees schema (W1)", () => {
  it("table exists with the expected columns", () => {
    const db = makeDb();
    const cols = db.prepare(
      `PRAGMA table_info(task_worktrees)`,
    ).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("task_id");
    expect(names).toContain("workdir");
    expect(names).toContain("base_branch");
    expect(names).toContain("branch_name");
    expect(names).toContain("status");
    expect(names).toContain("created_at");
    expect(names).toContain("last_used_at");
    expect(names).toContain("diagnostic");
    db.close();
  });

  it("task_id is PRIMARY KEY (duplicate insert fails)", () => {
    const db = makeDb();
    insertRow(db, {
      taskId: "t1", workdir: "/tmp/a", branchName: "wfc/task/t1",
      status: "active",
    });
    expect(() => insertRow(db, {
      taskId: "t1", workdir: "/tmp/b", branchName: "wfc/task/t1",
      status: "active",
    })).toThrow(/UNIQUE|PRIMARY KEY/);
    db.close();
  });

  it("status CHECK enforces the enum", () => {
    const db = makeDb();
    for (const ok of ["active", "unavailable", "pruned"]) {
      expect(() => insertRow(db, {
        taskId: `t-${ok}`, workdir: "/tmp", branchName: "b",
        status: ok,
      })).not.toThrow();
    }
    expect(() => insertRow(db, {
      taskId: "t-bad", workdir: "/tmp", branchName: "b",
      status: "busy",
    })).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("idx_tw_status index exists", () => {
    const db = makeDb();
    const rows = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_tw_%'`,
    ).all() as Array<{ name: string }>;
    expect(rows.some((r) => r.name === "idx_tw_status")).toBe(true);
    db.close();
  });
});
