// P6-1 regression: runner.finally writes an authoritative row into
// task_finals, and KernelService.getTaskStatus reads it in preference
// to deriving from stage_attempts.
//
// Without this, a run that timed out or threw after only some stages
// ran would look "completed" to the status endpoint — the DB had a
// success row for the stages that ran and no running/error row for the
// stages that didn't, which the latest-per-stage derivation happily
// accepted as done.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline, DEFAULT_RUN_TIMEOUT_MS } from "./runner.js";
import { KernelService } from "../mcp/kernel.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

// Two-stage linear pipeline; upstream has no inputs.
function linearIR(): PipelineIR {
  return {
    name: "linear",
    stages: [
      {
        name: "a", type: "agent",
        inputs: [],
        outputs: [{ name: "v", type: "string" }],
        config: { promptRef: "p" },
      },
      {
        name: "b", type: "agent",
        inputs: [{ name: "v", type: "string" }],
        outputs: [{ name: "out", type: "string" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { stage: "a", port: "v" }, to: { stage: "b", port: "v" } },
    ],
  };
}

describe("P6-1: task_finals authoritative final-state tracking", () => {
  it("natural completion writes task_finals with state=completed, reason=natural", async () => {
    const db = makeDb();
    try {
      const ir = linearIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        a: () => ({ v: "hello" }),
        b: (inputs) => ({ out: `echo: ${inputs.v}` }),
      };

      const r = await runPipeline({
        db, ir, taskId: "t-natural", versionHash: hash, handlers,
      });

      expect(r.finalState).toBe("completed");

      const row = db.prepare(
        `SELECT final_state, reason, detail FROM task_finals WHERE task_id = ?`,
      ).get("t-natural") as { final_state: string; reason: string; detail: string | null };
      expect(row).toBeDefined();
      expect(row.final_state).toBe("completed");
      expect(row.reason).toBe("natural");
      expect(row.detail).toBeNull();

      const svc = new KernelService(db, { skipTypeCheck: true });
      expect(svc.getTaskStatus("t-natural")).toEqual({
        ok: true, status: "completed", taskId: "t-natural",
      });
    } finally {
      db.close();
    }
  });

  it("timeout writes task_finals with state=failed, reason=timeout (even though stage_attempts would derive completed)", async () => {
    const db = makeDb();
    try {
      const ir = linearIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      // Handler sleeps longer than the runner's timeoutMs so the run
      // dies before stage `b` is reached. Stage `a` WILL complete
      // (writes port_values + marks stage_attempts success) before the
      // runner-level timer fires, reproducing the prod bug shape.
      const handlers: StageHandlerMap = {
        a: async () => { await new Promise((res) => setTimeout(res, 200)); return { v: "slow" }; },
        b: () => ({ out: "should never run" }),
      };

      // Intentionally short timeout — the MockStageExecutor races against
      // setTimeout so stage `a` completes (~200ms) and stage `b` gets
      // dispatched but the runner-level timer (50ms) fires before `b`
      // finishes, taking down the run.
      let threw = false;
      try {
        await runPipeline({
          db, ir, taskId: "t-timeout", versionHash: hash, handlers,
        }, 50);
      } catch (err) {
        threw = true;
        expect((err as Error).message).toMatch(/runPipeline timeout/);
      }
      expect(threw).toBe(true);

      const row = db.prepare(
        `SELECT final_state, reason, detail FROM task_finals WHERE task_id = ?`,
      ).get("t-timeout") as { final_state: string; reason: string; detail: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row!.final_state).toBe("failed");
      expect(row!.reason).toBe("timeout");
      expect(row!.detail).toMatch(/timeout after 50ms/);

      // Critical: status endpoint must NOT report 'completed' just
      // because stage_attempts has a success row for `a` and no row
      // for `b`.
      const svc = new KernelService(db, { skipTypeCheck: true });
      expect(svc.getTaskStatus("t-timeout")).toEqual({
        ok: true, status: "failed", taskId: "t-timeout",
      });
    } finally {
      db.close();
    }
  });

  it("getTaskStatus prefers task_finals over stage_attempts derivation", async () => {
    const db = makeDb();
    try {
      const ir = linearIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      // Synthesise a task where stage_attempts says 'all success' but
      // task_finals says 'failed'. The DB truth (task_finals) must win.
      db.prepare(
        `INSERT INTO stage_attempts
         (attempt_id, task_id, version_hash, stage_name, attempt_idx,
          started_at, ended_at, status, kind)
         VALUES ('a1', 't-mix', ?, 'a', 0, 0, 1, 'success', 'regular')`,
      ).run(hash);
      db.prepare(
        `INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
         VALUES ('t-mix', ?, 'failed', 'timeout', 'synth', 100)`,
      ).run(hash);

      const svc = new KernelService(db, { skipTypeCheck: true });
      expect(svc.getTaskStatus("t-mix")).toEqual({
        ok: true, status: "failed", taskId: "t-mix",
      });
    } finally {
      db.close();
    }
  });

  it("P6-2: DEFAULT_RUN_TIMEOUT_MS is long enough for real agent chains (sanity check on the magic number)", () => {
    // 30 min — tighter than this and a multi-stage real agent run will
    // false-positive timeout. Looser than a single stage's natural
    // budget and runaway machines stay stuck forever. If the constant
    // changes intentionally, update this assertion.
    expect(DEFAULT_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
    // And a sanity ceiling so the constant can't silently balloon to
    // 'effectively infinity' without an explicit code change.
    expect(DEFAULT_RUN_TIMEOUT_MS).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });

  it("P6-9: getTaskStatus returns task_finals.final_state even when stage_attempts is empty (empty-shell IR case)", async () => {
    const db = makeDb();
    try {
      const ir = linearIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      // No stage_attempts rows for this task — simulates the AI-generated
      // empty-shell pipeline case where all stages have inputs=[] outputs=[]
      // and no wires, causing the machine to reach parallel.onDone without
      // activating any region.
      db.prepare(
        `INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
         VALUES ('t-empty', ?, 'completed', 'natural', NULL, 100)`,
      ).run(hash);

      const svc = new KernelService(db, { skipTypeCheck: true });
      // Pre-P6-9 bug would return not_found because stage_attempts is empty.
      expect(svc.getTaskStatus("t-empty")).toEqual({
        ok: true, status: "completed", taskId: "t-empty",
      });
    } finally {
      db.close();
    }
  });

  it("getTaskStatus still returns not_found when both tables are empty for the taskId", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      expect(svc.getTaskStatus("truly-nonexistent")).toEqual({
        ok: true, status: "not_found", taskId: "truly-nonexistent",
      });
    } finally {
      db.close();
    }
  });

  it("getTaskStatus falls back to stage_attempts when task_finals is absent (legacy row or in-flight)", async () => {
    const db = makeDb();
    try {
      const ir = linearIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      db.prepare(
        `INSERT INTO stage_attempts
         (attempt_id, task_id, version_hash, stage_name, attempt_idx,
          started_at, ended_at, status, kind)
         VALUES ('a1', 't-run', ?, 'a', 0, 0, NULL, 'running', 'regular')`,
      ).run(hash);

      const svc = new KernelService(db, { skipTypeCheck: true });
      expect(svc.getTaskStatus("t-run")).toEqual({
        ok: true, status: "running", taskId: "t-run",
      });
    } finally {
      db.close();
    }
  });
});
