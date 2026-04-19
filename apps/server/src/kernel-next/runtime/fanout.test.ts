// A3.3 — fanout runner integration tests.
//
// Covers the minimum-viable fanout path per design doc §6.3:
//   - Array input → N virtual attempts (one per element)
//   - Each attempt writes its own port_values rows (lineage preserved)
//   - Outputs aggregated into an array written to the stage's output port
//   - Downstream stages consume the aggregated array
//   - Non-array fanout source → stage error
//
// Out of scope for A3.3: concurrency control, partial-failure recovery,
// cancellation.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
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

describe("A3.3: fanout — happy path", () => {
  it("runs N virtual attempts and aggregates outputs into an array", async () => {
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "fanout-basic",
        stages: [
          {
            name: "SRC",
            type: "agent",
            inputs: [],
            outputs: [{ name: "items", type: "number[]" }],
            config: { promptRef: "p" },
          },
          {
            name: "F",
            type: "agent",
            fanout: { input: "item" },
            inputs: [{ name: "item", type: "number" }],
            outputs: [{ name: "doubled", type: "number" }],
            config: { promptRef: "p" },
          },
          {
            name: "SUM",
            type: "agent",
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
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      // Script handlers use the StageHandler surface; `item` arrives as
      // a single element (not the array) thanks to the runner override.
      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3, 4] }),
        F: (inputs) => ({ doubled: (inputs.item as number) * 2 }),
        SUM: (inputs) => ({ total: (inputs.xs as number[]).reduce((a, b) => a + b, 0) }),
      };

      const result = await runPipeline({
        db, ir, taskId: `t-${Math.random().toString(36).slice(2)}`, versionHash: hash, handlers,
      });

      expect(result.finalState).toBe("completed");
      // Aggregated array is the per-element output, in input order.
      expect(result.portValues["F.doubled"]).toEqual([2, 4, 6, 8]);
      // Downstream consumer sees the array.
      expect(result.portValues["SUM.total"]).toBe(20);

      // Lineage: 4 attempts for stage F, each with its own row.
      const rows = db.prepare(
        `SELECT attempt_idx FROM stage_attempts WHERE stage_name = 'F' ORDER BY attempt_idx`,
      ).all() as Array<{ attempt_idx: number }>;
      expect(rows.map((r) => r.attempt_idx)).toEqual([1, 2, 3, 4]);
    } finally {
      db.close();
    }
  });

  it("empty array input → 0 attempts, aggregated empty array", async () => {
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "fanout-empty",
        stages: [
          {
            name: "SRC",
            type: "agent",
            inputs: [],
            outputs: [{ name: "items", type: "number[]" }],
            config: { promptRef: "p" },
          },
          {
            name: "F",
            type: "agent",
            fanout: { input: "item" },
            inputs: [{ name: "item", type: "number" }],
            outputs: [{ name: "doubled", type: "number" }],
            config: { promptRef: "p" },
          },
        ],
        wires: [
          { from: { stage: "SRC", port: "items" }, to: { stage: "F", port: "item" } },
        ],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [] }),
        F: () => { throw new Error("should not be called for empty fanout"); },
      };

      const result = await runPipeline({
        db, ir, taskId: `t-${Math.random().toString(36).slice(2)}`, versionHash: hash, handlers,
      });

      expect(result.finalState).toBe("completed");
      expect(result.portValues["F.doubled"]).toEqual([]);

      const rows = db.prepare(
        `SELECT COUNT(*) AS n FROM stage_attempts WHERE stage_name = 'F'`,
      ).get() as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("A3.3: fanout — error paths", () => {
  it("non-array fanout source → stage error", async () => {
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "fanout-bad",
        stages: [
          {
            name: "SRC",
            type: "agent",
            inputs: [],
            outputs: [{ name: "items", type: "string" }],
            config: { promptRef: "p" },
          },
          {
            name: "F",
            type: "agent",
            fanout: { input: "item" },
            inputs: [{ name: "item", type: "string" }],
            outputs: [{ name: "doubled", type: "string" }],
            config: { promptRef: "p" },
          },
        ],
        wires: [
          { from: { stage: "SRC", port: "items" }, to: { stage: "F", port: "item" } },
        ],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        SRC: () => ({ items: "not an array" }),
        F: () => ({ doubled: "x" }),
      };

      const result = await runPipeline({
        db, ir, taskId: `t-${Math.random().toString(36).slice(2)}`, versionHash: hash, handlers,
      });

      expect(result.finalState).toBe("failed");
      expect(result.stageErrors).toEqual([
        {
          stage: "F",
          message: expect.stringContaining("not an array") as unknown as string,
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("mid-element failure fails the whole stage; remaining elements not run", async () => {
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "fanout-fail",
        stages: [
          {
            name: "SRC",
            type: "agent",
            inputs: [],
            outputs: [{ name: "items", type: "number[]" }],
            config: { promptRef: "p" },
          },
          {
            name: "F",
            type: "agent",
            fanout: { input: "item" },
            inputs: [{ name: "item", type: "number" }],
            outputs: [{ name: "doubled", type: "number" }],
            config: { promptRef: "p" },
          },
        ],
        wires: [
          { from: { stage: "SRC", port: "items" }, to: { stage: "F", port: "item" } },
        ],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      let calls = 0;
      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3] }),
        F: (inputs) => {
          calls++;
          if (inputs.item === 2) throw new Error("second element kaboom");
          return { doubled: (inputs.item as number) * 2 };
        },
      };

      const result = await runPipeline({
        db, ir, taskId: `t-${Math.random().toString(36).slice(2)}`, versionHash: hash, handlers,
      });

      expect(result.finalState).toBe("failed");
      expect(calls).toBe(2); // third element never runs
      expect(result.stageErrors[0]?.stage).toBe("F");
      expect(result.stageErrors[0]?.message).toMatch(/kaboom/);
    } finally {
      db.close();
    }
  });
});
