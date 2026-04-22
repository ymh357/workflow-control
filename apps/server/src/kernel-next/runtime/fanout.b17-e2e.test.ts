// B17 full — end-to-end: fanout run → hot-update migrate → re-run.
//
// Verifies the whole chain T1-T3 works together:
//   1. Run a fanout pipeline once; some elements succeed.
//   2. Propose + executeMigration with rerunFrom = fanout stage.
//      - migration-orchestrator preserves the successful fanout_element
//        attempts (T2) and supersedes the aggregate.
//   3. Re-run the same task against the new version.
//      - orchestrateFanoutStage skips the preserved indices (T3) and
//        aggregates preserved outputs alongside newly-computed ones.
//
// We fake interrupt by running the first pipeline to completion, then
// treating that final state as the "partial success" input to migration
// (simulating "N of N elements succeeded, but the aggregate we throw
// away so re-run can still see the preserved elements"). This is not
// the 100% realistic workflow but it exercises every T1-T3 code path
// without standing up an interrupt + resume harness.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { executeMigration, __resetOrchestratorLocksForTest } from "../hot-update/migration-orchestrator.js";
import { taskRegistry } from "./task-registry.js";
import { runPipeline } from "./runner.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function fanoutIR(promptRefF = "pf"): PipelineIR {
  return {
    name: "b17-e2e",
    stages: [
      {
        name: "SRC", type: "agent",
        inputs: [],
        outputs: [{ name: "items", type: "number[]" }],
        config: { promptRef: "ps" },
      },
      {
        name: "F", type: "agent",
        fanout: { input: "item" },
        inputs: [{ name: "item", type: "number" }],
        outputs: [{ name: "doubled", type: "number" }],
        config: { promptRef: promptRefF },
      },
      {
        name: "SUM", type: "agent",
        inputs: [{ name: "xs", type: "number[]" }],
        outputs: [{ name: "total", type: "number" }],
        config: { promptRef: "psum" },
      },
    ],
    wires: [
      { from: { stage: "SRC", port: "items" }, to: { stage: "F", port: "item" } },
      { from: { stage: "F", port: "doubled" }, to: { stage: "SUM", port: "xs" } },
    ],
  };
}

function fanoutPromptsV1() {
  // submit() validates PROMPT_REF_UNUSED so every entry must be referenced
  // by some AgentStage in the IR. Only the stages present in fanoutIR()
  // matter at submit time. The propose() call below references 'pf-v2'
  // which is not in this map — that's fine because propose does NOT
  // validate prompt_contents existence (see migration-orchestrator.fanout
  // test for the same pattern).
  return { ps: "src prompt", pf: "fanout prompt v1", psum: "sum prompt" };
}

describe("B17 full E2E: fanout run → migrate → re-run skips preserved indices", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("re-run after migration uses preserved fanout_element outputs and only runs new indices", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submitted = svc.submit(fanoutIR(), { prompts: fanoutPromptsV1() });
      if (!submitted.ok) throw new Error("submit failed: " + JSON.stringify(submitted.diagnostics));
      const v1 = submitted.versionHash;
      const taskId = "t-e2e-1";

      // First run — all 4 elements succeed under v1.
      let firstCalls = 0;
      const handlersV1: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3, 4] }),
        F: (inputs) => { firstCalls++; return { doubled: (inputs.item as number) * 2 }; },
        SUM: (inputs) => ({ total: (inputs.xs as number[]).reduce((a, b) => a + b, 0) }),
      };
      const r1 = await runPipeline({ db, ir: fanoutIR(), taskId, versionHash: v1, handlers: handlersV1 });
      expect(r1.finalState).toBe("completed");
      expect(firstCalls).toBe(4);
      expect(r1.portValues["F.doubled"]).toEqual([2, 4, 6, 8]);

      // Propose v2 that only changes F.promptRef. rerunFrom=F so
      // fanout-region attempts are eligible for supersede.
      const propose = svc.propose({
        currentVersion: v1,
        patch: {
          ops: [{
            op: "update_stage_config",
            stage: "F",
            configPatch: { promptRef: "pf-v2" },
          }],
        },
        actor: "test",
        rerunFrom: "F",
        migrateRunningTasks: [taskId],
        autoApprove: true,
      });
      if (!propose.ok) throw new Error("propose failed: " + JSON.stringify(propose.diagnostics));

      // executeMigration — startRunnerOverride is a stub since we re-run
      // the pipeline manually below to count handler calls.
      const startRunner = vi.fn(async () => ({
        ok: true as const, taskId, versionHash: propose.proposedVersion,
      }));
      const mig = await executeMigration({
        db, taskId, proposalId: propose.proposalId,
        startRunnerOverride: startRunner as never,
        interruptWaitMsOverride: 500,
      });
      if (!mig.ok) throw new Error("migration failed: " + JSON.stringify(mig));

      // After migration, the 4 successful fanout_element rows must still
      // be status='success' (preserved by T2), and the aggregate must
      // be superseded so the re-run generates a fresh one.
      const elemRows = db.prepare(
        `SELECT status, fanout_element_idx FROM stage_attempts
          WHERE task_id = ? AND stage_name = 'F' AND kind = 'fanout_element'
          ORDER BY fanout_element_idx`,
      ).all(taskId) as Array<{ status: string; fanout_element_idx: number }>;
      expect(elemRows).toEqual([
        { status: "success", fanout_element_idx: 0 },
        { status: "success", fanout_element_idx: 1 },
        { status: "success", fanout_element_idx: 2 },
        { status: "success", fanout_element_idx: 3 },
      ]);
      const aggStatus = db.prepare(
        `SELECT status FROM stage_attempts
          WHERE task_id = ? AND stage_name = 'F' AND kind = 'fanout_aggregate'`,
      ).all(taskId) as Array<{ status: string }>;
      expect(aggStatus.every((r) => r.status === "superseded")).toBe(true);

      // Re-run under v2. Handler F MUST NOT be called — every index is
      // preserved. SUM still runs (its regular attempt was superseded).
      let secondCalls = 0;
      let sumCalls = 0;
      const handlersV2: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3, 4] }),
        F: (inputs) => { secondCalls++; return { doubled: (inputs.item as number) * 999 }; },
        SUM: (inputs) => { sumCalls++; return { total: (inputs.xs as number[]).reduce((a, b) => a + b, 0) }; },
      };
      taskRegistry.__clearForTest();
      const r2 = await runPipeline({
        db, ir: fanoutIR("pf-v2"), taskId,
        versionHash: propose.proposedVersion, handlers: handlersV2,
      });
      expect(r2.finalState).toBe("completed");
      // F's handler was never invoked under v2 — preserved outputs carried
      // over even though promptRef changed. The test's F-v2 handler would
      // have produced 999*item; if it ran, the aggregate would include
      // those values. It doesn't, so we see original doubled values.
      expect(secondCalls).toBe(0);
      expect(r2.portValues["F.doubled"]).toEqual([2, 4, 6, 8]);
      expect(sumCalls).toBeGreaterThan(0);
      expect(r2.portValues["SUM.total"]).toBe(20);
    } finally {
      db.close();
    }
  });

  it("re-run runs handler only for indices whose earlier element attempt is NOT preserved", async () => {
    // This case uses seeded state instead of a real first runPipeline.
    // Simulates: an earlier run under v1 where indices 0 and 1 succeeded
    // but idx 2 errored (so idx 3 was never reached in A3.3's sequential
    // loop). The post-migration re-run must re-execute only the missing
    // indices (2 and 3) and produce a complete aggregate.
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submitted = svc.submit(fanoutIR(), { prompts: fanoutPromptsV1() });
      if (!submitted.ok) throw new Error("submit failed: " + JSON.stringify(submitted.diagnostics));
      const v1 = submitted.versionHash;
      const taskId = "t-e2e-2";

      // Seed indices 0 and 1 as successful fanout_element attempts. No
      // aggregate attempt (migration would have superseded it anyway).
      for (const i of [0, 1]) {
        const attemptId = randomUUID();
        db.prepare(
          `INSERT INTO stage_attempts
           (attempt_id, task_id, version_hash, stage_name, attempt_idx,
            started_at, ended_at, status, kind, fanout_element_idx)
           VALUES (?, ?, ?, 'F', ?, ?, ?, 'success', 'fanout_element', ?)`,
        ).run(attemptId, taskId, v1, i + 1, Date.now() - 1000, Date.now() - 500, i);
        db.prepare(
          `INSERT INTO port_values
           (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
           VALUES (?, ?, 'F', 'doubled', 'out', ?, ?)`,
        ).run(randomUUID(), attemptId, JSON.stringify((i + 1) * 2), Date.now() - 500);
      }

      // Confirm seed.
      const beforeRows = db.prepare(
        `SELECT fanout_element_idx FROM stage_attempts
          WHERE task_id = ? AND stage_name = 'F' AND kind = 'fanout_element' AND status = 'success'
          ORDER BY fanout_element_idx`,
      ).all(taskId) as Array<{ fanout_element_idx: number }>;
      expect(beforeRows.map((r) => r.fanout_element_idx)).toEqual([0, 1]);

      // Propose v2 with promptRef change, rerunFrom=F. Migration is NOT
      // executed here — this test only exercises T3's SQL-driven skip
      // logic against a preserved-state snapshot. (The migrate
      // preservation step is separately covered by migration-orchestrator
      // tests; the previous test in this file covers the full round trip.)
      const propose = svc.propose({
        currentVersion: v1,
        patch: {
          ops: [{
            op: "update_stage_config",
            stage: "F",
            configPatch: { promptRef: "pf-v2" },
          }],
        },
        actor: "test",
        rerunFrom: "F",
        autoApprove: true,
      });
      if (!propose.ok) throw new Error("propose failed: " + JSON.stringify(propose.diagnostics));

      // Re-run — F handler must be called only for indices 2 and 3
      // (the two that were never preserved). 0 and 1 are reused.
      let secondCalls = 0;
      const handlersV2: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3, 4] }),
        F: (inputs) => { secondCalls++; return { doubled: (inputs.item as number) * 2 }; },
        SUM: (inputs) => ({ total: (inputs.xs as number[]).reduce((a, b) => a + b, 0) }),
      };
      const r2 = await runPipeline({
        db, ir: fanoutIR("pf-v2"), taskId,
        versionHash: propose.proposedVersion, handlers: handlersV2,
      });
      expect(r2.finalState).toBe("completed");
      expect(secondCalls).toBe(2);
      expect(r2.portValues["F.doubled"]).toEqual([2, 4, 6, 8]);
      expect(r2.portValues["SUM.total"]).toBe(20);
    } finally {
      db.close();
    }
  });
});
