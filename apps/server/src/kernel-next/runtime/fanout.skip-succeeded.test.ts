// B17 full: orchestrateFanoutStage skips fanout_element indices that
// already succeeded on an earlier run of the same (task, stage).
//
// Scenario: hot-update migration preserved some successful per-element
// attempts (§7.4 B17 T2). On the next run under the new pipeline version,
// the runner must NOT re-execute those indices; it must incorporate
// their prior outputs into the aggregate array.
//
// These tests simulate the pre-existing state by seeding successful
// fanout_element attempts with port_values directly, then running the
// pipeline. The runner is responsible for discovering + honouring them.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

interface SeedArgs {
  db: DatabaseSync;
  taskId: string;
  versionHash: string;
  stageName: string;
  idx: number;
  // Output ports from prior successful run — the runner must read these
  // instead of rerunning the handler.
  outputs: Record<string, unknown>;
}

function seedSuccessfulFanoutElement(a: SeedArgs): string {
  const attemptId = randomUUID();
  // attempt_idx must be unique per (task, stage). Since this helper is
  // called only by tests that want a pre-existing succeeded element,
  // use idx+1 as the attempt_idx (stable and monotonic).
  const attemptIdxCol = a.idx + 1;
  a.db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx,
      started_at, ended_at, status, kind, fanout_element_idx)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'success', 'fanout_element', ?)`,
  ).run(attemptId, a.taskId, a.versionHash, a.stageName,
    attemptIdxCol, Date.now() - 1000, Date.now() - 500, a.idx);
  for (const [port, value] of Object.entries(a.outputs)) {
    a.db.prepare(
      `INSERT INTO port_values
       (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
       VALUES (?, ?, ?, ?, 'out', ?, ?)`,
    ).run(randomUUID(), attemptId, a.stageName, port,
      JSON.stringify(value), Date.now() - 500);
  }
  return attemptId;
}

function fanoutIR(): PipelineIR {
  return {
    name: "fanout-skip",
    stages: [
      {
        name: "SRC", type: "agent",
        inputs: [],
        outputs: [{ name: "items", type: "number[]" }],
        config: { promptRef: "p" },
      },
      {
        name: "F", type: "agent",
        fanout: { input: "item" },
        inputs: [{ name: "item", type: "number" }],
        outputs: [{ name: "doubled", type: "number" }],
        config: { promptRef: "p" },
      },
      {
        name: "SUM", type: "agent",
        inputs: [{ name: "xs", type: "number[]" }],
        outputs: [{ name: "total", type: "number" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { stage: "SRC", port: "items" }, to: { stage: "F", port: "item" } },
      { from: { stage: "F", port: "doubled" }, to: { stage: "SUM", port: "xs" } },
    ],
  };
}

describe("B17 full: fanout skip already-succeeded indices", () => {
  it("skips indices whose fanout_element attempt already succeeded and reuses their outputs", async () => {
    const db = makeDb();
    try {
      const ir = fanoutIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
      const taskId = `t-${Math.random().toString(36).slice(2)}`;

      // Seed: indices 0 and 2 already succeeded (items [1,2,3,4] ×2 → 2,6).
      seedSuccessfulFanoutElement({
        db, taskId, versionHash: hash, stageName: "F", idx: 0,
        outputs: { doubled: 2 },
      });
      seedSuccessfulFanoutElement({
        db, taskId, versionHash: hash, stageName: "F", idx: 2,
        outputs: { doubled: 6 },
      });

      // Count handler invocations — only idx 1 and 3 should actually run.
      let fCalls = 0;
      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3, 4] }),
        F: (inputs) => { fCalls++; return { doubled: (inputs.item as number) * 2 }; },
        SUM: (inputs) => ({ total: (inputs.xs as number[]).reduce((a, b) => a + b, 0) }),
      };

      const result = await runPipeline({
        db, ir, taskId, versionHash: hash, handlers,
      });

      expect(result.finalState).toBe("completed");
      // Only 2 fresh handler calls — idx 1 and 3.
      expect(fCalls).toBe(2);
      // Aggregate must contain all 4 doubled values in input order.
      expect(result.portValues["F.doubled"]).toEqual([2, 4, 6, 8]);
      // Downstream sees the full array.
      expect(result.portValues["SUM.total"]).toBe(20);
    } finally {
      db.close();
    }
  });

  it("does nothing special when no prior fanout_element attempts exist (fresh run)", async () => {
    const db = makeDb();
    try {
      const ir = fanoutIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
      const taskId = `t-${Math.random().toString(36).slice(2)}`;

      let fCalls = 0;
      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [10, 20, 30] }),
        F: (inputs) => { fCalls++; return { doubled: (inputs.item as number) * 2 }; },
        SUM: (inputs) => ({ total: (inputs.xs as number[]).reduce((a, b) => a + b, 0) }),
      };

      const result = await runPipeline({
        db, ir, taskId, versionHash: hash, handlers,
      });

      expect(result.finalState).toBe("completed");
      expect(fCalls).toBe(3);
      expect(result.portValues["F.doubled"]).toEqual([20, 40, 60]);
    } finally {
      db.close();
    }
  });

  it("skips all elements when every index already succeeded — runs zero handler calls", async () => {
    const db = makeDb();
    try {
      const ir = fanoutIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
      const taskId = `t-${Math.random().toString(36).slice(2)}`;

      for (let i = 0; i < 3; i++) {
        seedSuccessfulFanoutElement({
          db, taskId, versionHash: hash, stageName: "F", idx: i,
          outputs: { doubled: (i + 1) * 2 },
        });
      }

      let fCalls = 0;
      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3] }),
        F: (inputs) => { fCalls++; return { doubled: (inputs.item as number) * 2 }; },
        SUM: (inputs) => ({ total: (inputs.xs as number[]).reduce((a, b) => a + b, 0) }),
      };

      const result = await runPipeline({
        db, ir, taskId, versionHash: hash, handlers,
      });

      expect(result.finalState).toBe("completed");
      expect(fCalls).toBe(0);
      expect(result.portValues["F.doubled"]).toEqual([2, 4, 6]);
      expect(result.portValues["SUM.total"]).toBe(12);
    } finally {
      db.close();
    }
  });

  it("ignores preserved elements with idx outside the current input range (source array shrank)", async () => {
    // Edge: if the new run's source array is shorter than the prior one
    // (e.g. filter added upstream), out-of-range preserved indices must
    // not contaminate the aggregate. Only indices in [0, N) matter.
    const db = makeDb();
    try {
      const ir = fanoutIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
      const taskId = `t-${Math.random().toString(36).slice(2)}`;

      // Prior run had 5 elements; idx=3 and idx=4 succeeded. New run's
      // SRC emits only 2 items, so only indices 0..1 matter.
      seedSuccessfulFanoutElement({
        db, taskId, versionHash: hash, stageName: "F", idx: 3,
        outputs: { doubled: 999 },
      });
      seedSuccessfulFanoutElement({
        db, taskId, versionHash: hash, stageName: "F", idx: 4,
        outputs: { doubled: 888 },
      });

      let fCalls = 0;
      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [5, 6] }),
        F: (inputs) => { fCalls++; return { doubled: (inputs.item as number) * 2 }; },
        SUM: (inputs) => ({ total: (inputs.xs as number[]).reduce((a, b) => a + b, 0) }),
      };

      const result = await runPipeline({
        db, ir, taskId, versionHash: hash, handlers,
      });

      expect(result.finalState).toBe("completed");
      expect(fCalls).toBe(2);
      expect(result.portValues["F.doubled"]).toEqual([10, 12]);
    } finally {
      db.close();
    }
  });
});
