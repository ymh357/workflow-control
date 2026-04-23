// P5.1 — fanout concurrency cap.
//
// FanoutSpec.concurrency bounds the number of simultaneously-running
// per-element executions inside orchestrateFanoutStage. Default cap is 3;
// the schema's hard ceiling is 20. Enforced via a worker-pool pattern so
// that large source arrays cannot trigger N parallel Claude sessions and
// exhaust Anthropic rate limits / blow the cost budget.
//
// These tests pair a slow handler (tracks concurrent invocations) with a
// pipeline that has a single fanout stage. The handler records the peak
// "in-flight" count and total invocation count. Assertions:
//   - default cap (no concurrency set) holds peak at 3
//   - concurrency: 1 forces strictly serial execution (timing lower bound)
//   - concurrency >= element count allows full parallelism
//   - schema rejects concurrency out of range (0, negative, >20)

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import { FanoutSpecSchema, type PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

interface ConcurrencyTracker {
  inFlight: number;
  peak: number;
  total: number;
}

function makeTracker(): ConcurrencyTracker {
  return { inFlight: 0, peak: 0, total: 0 };
}

// Sleep that yields through the microtask queue — enough ticks that
// other workers have a chance to grab elements. Avoids `setTimeout`
// timing flakes on loaded CI runners while still letting us measure
// "how many workers were simultaneously past enter() before exit()".
function slowHandler(
  tracker: ConcurrencyTracker,
  sleepMs: number,
): (inputs: Record<string, unknown>) => Promise<Record<string, unknown>> {
  return async (inputs) => {
    tracker.inFlight++;
    tracker.total++;
    if (tracker.inFlight > tracker.peak) tracker.peak = tracker.inFlight;
    await new Promise((r) => setTimeout(r, sleepMs));
    tracker.inFlight--;
    return { doubled: (inputs.item as number) * 2 };
  };
}

function fanoutIR(opts: { elementCount: number; concurrency?: number }): PipelineIR {
  return {
    name: `fanout-concurrency-${opts.concurrency ?? "default"}`,
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
        fanout: opts.concurrency !== undefined
          ? { input: "item", concurrency: opts.concurrency }
          : { input: "item" },
        inputs: [{ name: "item", type: "number" }],
        outputs: [{ name: "doubled", type: "number" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { stage: "SRC", port: "items" }, to: { stage: "F", port: "item" } },
    ],
  };
}

describe("P5.1: fanout concurrency cap", () => {
  it("enforces default cap of 3 when concurrency unspecified", async () => {
    const db = makeDb();
    try {
      const ir = fanoutIR({ elementCount: 10 });
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const tracker = makeTracker();
      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }),
        F: slowHandler(tracker, 20),
      };

      const result = await runPipeline({
        db, ir, taskId: `t-${Math.random().toString(36).slice(2)}`, versionHash: hash, handlers,
      });

      expect(result.finalState).toBe("completed");
      expect(tracker.total).toBe(10);
      expect(tracker.peak).toBeLessThanOrEqual(3);
      // Sanity — with 10 elements and cap 3, we should have observed
      // strictly more than 1 concurrent element at some point (else we
      // are accidentally serial and not actually testing the cap).
      expect(tracker.peak).toBeGreaterThan(1);
    } finally {
      db.close();
    }
  });

  it("respects explicit concurrency: 1 (serial)", async () => {
    const db = makeDb();
    try {
      const ir = fanoutIR({ elementCount: 5, concurrency: 1 });
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const tracker = makeTracker();
      const perElementMs = 30;
      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3, 4, 5] }),
        F: slowHandler(tracker, perElementMs),
      };

      const t0 = Date.now();
      const result = await runPipeline({
        db, ir, taskId: `t-${Math.random().toString(36).slice(2)}`, versionHash: hash, handlers,
      });
      const elapsed = Date.now() - t0;

      expect(result.finalState).toBe("completed");
      expect(tracker.total).toBe(5);
      expect(tracker.peak).toBe(1);
      // Serial lower bound: 5 elements × 30ms = 150ms. Leave generous
      // headroom (120ms) to avoid flakes on timer granularity.
      expect(elapsed).toBeGreaterThanOrEqual(120);
    } finally {
      db.close();
    }
  });

  it("respects explicit concurrency: 10 (unbounded for small arrays)", async () => {
    const db = makeDb();
    try {
      const ir = fanoutIR({ elementCount: 5, concurrency: 10 });
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const tracker = makeTracker();
      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3, 4, 5] }),
        F: slowHandler(tracker, 20),
      };

      const result = await runPipeline({
        db, ir, taskId: `t-${Math.random().toString(36).slice(2)}`, versionHash: hash, handlers,
      });

      expect(result.finalState).toBe("completed");
      expect(tracker.total).toBe(5);
      // cap=10 and 5 elements → all 5 should run in parallel
      expect(tracker.peak).toBe(5);
    } finally {
      db.close();
    }
  });

  it("schema rejects concurrency out of range", () => {
    // zero, negative, and above the 20 ceiling must all fail parse.
    expect(() => FanoutSpecSchema.parse({ input: "item", concurrency: 0 })).toThrow();
    expect(() => FanoutSpecSchema.parse({ input: "item", concurrency: -1 })).toThrow();
    expect(() => FanoutSpecSchema.parse({ input: "item", concurrency: 21 })).toThrow();
    expect(() => FanoutSpecSchema.parse({ input: "item", concurrency: 1.5 })).toThrow();
    // Valid boundaries pass.
    expect(() => FanoutSpecSchema.parse({ input: "item", concurrency: 1 })).not.toThrow();
    expect(() => FanoutSpecSchema.parse({ input: "item", concurrency: 20 })).not.toThrow();
    // Absent concurrency is the (backward-compatible) default.
    expect(() => FanoutSpecSchema.parse({ input: "item" })).not.toThrow();
  });
});
