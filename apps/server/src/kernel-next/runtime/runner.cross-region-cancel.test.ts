// Cross-region cancellation propagation. When a stage enters its
// `error` final, every transitive downstream stage's region must also
// reach a final state so the parallel pipeline machine's onDone can
// resolve. Without propagation, a region waiting on inbound wires
// from the failed upstream hangs in `waiting` forever and the run
// only terminates via the wall-clock budget.
//
// These tests pin the contract:
//   1. Direct downstream of a failed stage transitions to `error`
//      with finalizedStages.reason === "upstream_cancelled".
//   2. Transitive (multi-hop) downstream reaches the same end state.
//   3. Parallel siblings (no wire dependency) are NOT cancelled —
//      independence is preserved.
//   4. The run resolves cleanly within a fast wall-clock budget; no
//      timeout reject.
//   5. Reverse-verify: removing the cancellation propagation makes
//      the test hang (covered by the test's own timeout assertion).

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { runPipeline } from "./runner.js";
import { versionHash } from "../ir/canonical.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

describe("runPipeline cross-region cancellation propagation", () => {
  it("direct downstream of a failing stage is cancelled, run resolves", async () => {
    const db = makeDb();
    try {
      // A → B. A throws. Without propagation, B's region waits on
      // A.x → B.x forever. With propagation, B receives STAGE_CANCELLED
      // and its region closes via reason='upstream_cancelled'.
      const ir: PipelineIR = {
        name: "cancel-direct",
        stages: [
          {
            name: "A",
            type: "agent",
            inputs: [],
            outputs: [{ name: "x", type: "number" }],
            config: { promptRef: "p" },
          },
          {
            name: "B",
            type: "agent",
            inputs: [{ name: "x", type: "number" }],
            outputs: [{ name: "y", type: "number" }],
            config: { promptRef: "p" },
          },
        ],
        wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        A: () => { throw new Error("A boom"); },
        B: () => ({ y: 0 }),
      };

      // Tight timeout — proves we resolve on cross-region cancel,
      // not on wall-clock. Without propagation this would reject.
      const result = await runPipeline(
        { db, ir, taskId: "cancel-direct", versionHash: hash, handlers },
        2_000,
      );

      expect(result.finalState).toBe("failed");
      // Only A surfaces in stageErrors; B was cancelled, not failed.
      expect(result.stageErrors.map((e) => e.stage)).toEqual(["A"]);

      // stage_attempts: A has status='error'; B has zero attempts
      // (its handler never ran).
      const attempts = db
        .prepare(`SELECT stage_name, status FROM stage_attempts WHERE task_id = ? ORDER BY started_at`)
        .all("cancel-direct") as Array<{ stage_name: string; status: string }>;
      expect(attempts.find((a) => a.stage_name === "A")?.status).toBe("error");
      expect(attempts.find((a) => a.stage_name === "B")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("transitive (multi-hop) downstream is cancelled too", async () => {
    const db = makeDb();
    try {
      // A → B → C. A throws. B and C must both be cancelled.
      const ir: PipelineIR = {
        name: "cancel-transitive",
        stages: [
          { name: "A", type: "agent", inputs: [],
            outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
          { name: "B", type: "agent",
            inputs: [{ name: "x", type: "number" }],
            outputs: [{ name: "y", type: "number" }], config: { promptRef: "p" } },
          { name: "C", type: "agent",
            inputs: [{ name: "y", type: "number" }],
            outputs: [{ name: "z", type: "number" }], config: { promptRef: "p" } },
        ],
        wires: [
          { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
          { from: { stage: "B", port: "y" }, to: { stage: "C", port: "y" } },
        ],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        A: () => { throw new Error("A boom"); },
        B: () => ({ y: 0 }),
        C: () => ({ z: 0 }),
      };

      const result = await runPipeline(
        { db, ir, taskId: "cancel-transitive", versionHash: hash, handlers },
        2_000,
      );

      expect(result.finalState).toBe("failed");
      expect(result.stageErrors.map((e) => e.stage)).toEqual(["A"]);

      const attempts = db
        .prepare(`SELECT stage_name FROM stage_attempts WHERE task_id = ?`)
        .all("cancel-transitive") as Array<{ stage_name: string }>;
      const stagesWithAttempts = new Set(attempts.map((a) => a.stage_name));
      expect(stagesWithAttempts.has("A")).toBe(true);
      // Neither B nor C started.
      expect(stagesWithAttempts.has("B")).toBe(false);
      expect(stagesWithAttempts.has("C")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("parallel siblings of the failing stage (no wire dependency) are NOT cancelled", async () => {
    const db = makeDb();
    try {
      // A1, A2 are independent (no wires between them). A1 throws.
      // A2 must run to completion — sibling independence preserved.
      const ir: PipelineIR = {
        name: "cancel-siblings",
        stages: [
          { name: "A1", type: "agent", inputs: [],
            outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
          { name: "A2", type: "agent", inputs: [],
            outputs: [{ name: "y", type: "number" }], config: { promptRef: "p" } },
        ],
        wires: [],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      let a2Ran = false;
      const handlers: StageHandlerMap = {
        A1: () => { throw new Error("A1 boom"); },
        A2: () => { a2Ran = true; return { y: 1 }; },
      };

      const result = await runPipeline(
        { db, ir, taskId: "cancel-siblings", versionHash: hash, handlers },
        2_000,
      );

      expect(result.finalState).toBe("failed");
      expect(a2Ran).toBe(true);

      const attempts = db
        .prepare(`SELECT stage_name, status FROM stage_attempts WHERE task_id = ?`)
        .all("cancel-siblings") as Array<{ stage_name: string; status: string }>;
      expect(attempts.find((a) => a.stage_name === "A1")?.status).toBe("error");
      expect(attempts.find((a) => a.stage_name === "A2")?.status).toBe("success");
    } finally {
      db.close();
    }
  });

  it("emits stage_error events with reason='upstream_cancelled' for cancelled stages", async () => {
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "cancel-sse",
        stages: [
          { name: "A", type: "agent", inputs: [],
            outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
          { name: "B", type: "agent",
            inputs: [{ name: "x", type: "number" }],
            outputs: [{ name: "y", type: "number" }], config: { promptRef: "p" } },
        ],
        wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        A: () => { throw new Error("A boom"); },
        B: () => ({ y: 0 }),
      };

      // Capture published SSE events via a custom broadcaster.
      const { KernelNextBroadcaster } = await import("../sse/broadcaster.js");
      const broadcaster = new KernelNextBroadcaster();

      await runPipeline(
        { db, ir, taskId: "cancel-sse", versionHash: hash, handlers, broadcaster },
        2_000,
      );

      const events = broadcaster.historyFor("cancel-sse");
      const stageErrors = events.filter((e) => e.type === "stage_error") as Array<{
        type: "stage_error";
        data: { stage: string; reason?: string; message: string };
      }>;
      expect(stageErrors.find((e) => e.data.stage === "A")?.data.reason).toBe("executor_failed");
      expect(stageErrors.find((e) => e.data.stage === "B")?.data.reason).toBe("upstream_cancelled");
    } finally {
      db.close();
    }
  });
});
