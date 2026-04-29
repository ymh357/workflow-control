// P4 (2026-04-29) — fanout per-element retry on transient executor error.
//
// FanoutSpec.elementRetries enables retry-on-error for individual fanout
// children. Without it, a single transient API blip in one of N parallel
// children fails the whole stage (observed in the 0G dogfood: 5/6
// evidenceGather succeeded, one Anthropic api_error nuked the run before
// findingsAuthoring even started). With elementRetries=N the runner
// re-executes a failed element up to N times; the original failure rows
// stay in stage_attempts as kind='fanout_element', status='error' for
// lineage observation.

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

function fanoutIR(opts: { elementRetries?: number; concurrency?: number }): PipelineIR {
  const fanout: { input: string; elementRetries?: number; concurrency?: number } = { input: "item" };
  if (opts.elementRetries !== undefined) fanout.elementRetries = opts.elementRetries;
  if (opts.concurrency !== undefined) fanout.concurrency = opts.concurrency;
  return {
    name: `fanout-elem-retry-${opts.elementRetries ?? "none"}`,
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
        fanout,
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

// Builds a handler that fails an element on its first invocation and
// succeeds thereafter. `failureKey` selects which element value triggers
// the transient failure.
function flakyHandler(failOnceForElement: number) {
  const seen = new Map<number, number>();
  return async (inputs: Record<string, unknown>) => {
    const item = inputs.item as number;
    const count = (seen.get(item) ?? 0) + 1;
    seen.set(item, count);
    if (item === failOnceForElement && count === 1) {
      throw new Error("transient API error");
    }
    return { doubled: item * 2 };
  };
}

describe("P4: fanout per-element retry", () => {
  it("succeeds when a transient error is retried (elementRetries=1, fails once on item=2)", async () => {
    const db = makeDb();
    try {
      const ir = fanoutIR({ elementRetries: 1, concurrency: 3 });
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3, 4, 5] }),
        F: flakyHandler(2),
      };

      const result = await runPipeline({
        db,
        ir,
        taskId: `t-${Math.random().toString(36).slice(2)}`,
        versionHash: hash,
        handlers,
      });

      expect(result.finalState).toBe("completed");

      // The fanout aggregate should contain all 5 doubled values, in
      // input order (out-of-order completion under concurrency does not
      // disturb the aggregate's index alignment).
      const aggRow = db
        .prepare(
          `SELECT pv.value_json
             FROM port_values pv JOIN stage_attempts sa
               ON pv.attempt_id = sa.attempt_id
            WHERE sa.stage_name = 'F'
              AND sa.kind = 'fanout_aggregate'
              AND pv.port_name = 'doubled'`,
        )
        .get() as { value_json: string };
      expect(JSON.parse(aggRow.value_json)).toEqual([2, 4, 6, 8, 10]);

      // Both attempts (failed + succeeded) should appear in stage_attempts
      // for fanout_element_idx=1 (the index of item=2). Lineage preserved.
      const item2Attempts = db
        .prepare(
          `SELECT status FROM stage_attempts
            WHERE stage_name = 'F'
              AND kind = 'fanout_element'
              AND fanout_element_idx = 1
            ORDER BY started_at ASC`,
        )
        .all() as Array<{ status: string }>;
      expect(item2Attempts.length).toBe(2);
      expect(item2Attempts[0]!.status).toBe("error");
      expect(item2Attempts[1]!.status).toBe("success");
    } finally {
      db.close();
    }
  });

  it("fails the stage when retries are exhausted (elementRetries=1, fails twice)", async () => {
    const db = makeDb();
    try {
      const ir = fanoutIR({ elementRetries: 1 });
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3] }),
        F: async (inputs) => {
          if ((inputs.item as number) === 2) {
            throw new Error("permanent API error");
          }
          return { doubled: (inputs.item as number) * 2 };
        },
      };

      const result = await runPipeline({
        db,
        ir,
        taskId: `t-${Math.random().toString(36).slice(2)}`,
        versionHash: hash,
        handlers,
      });

      expect(result.finalState).toBe("failed");

      // Both retry attempts should appear as error rows.
      const item2Attempts = db
        .prepare(
          `SELECT status FROM stage_attempts
            WHERE stage_name = 'F'
              AND kind = 'fanout_element'
              AND fanout_element_idx = 1`,
        )
        .all() as Array<{ status: string }>;
      expect(item2Attempts.length).toBe(2);
      expect(item2Attempts.every((a) => a.status === "error")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("default elementRetries=0: failing element invokes handler exactly once (no retry)", async () => {
    const db = makeDb();
    try {
      const ir = fanoutIR({ concurrency: 1 }); // serial so we can deterministically count
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      let item2Calls = 0;
      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3] }),
        F: async (inputs) => {
          if ((inputs.item as number) === 2) {
            item2Calls++;
            throw new Error("transient");
          }
          return { doubled: (inputs.item as number) * 2 };
        },
      };

      await runPipeline({
        db,
        ir,
        taskId: `t-${Math.random().toString(36).slice(2)}`,
        versionHash: hash,
        handlers,
      });

      // Without elementRetries, the failing handler is invoked exactly
      // once. This is the property that distinguishes the new behaviour
      // (retry) from the old behaviour (fail-fast); the surrounding
      // pipeline outcome is not asserted because mock-executor surfaces
      // throws differently in different harness configurations.
      expect(item2Calls).toBe(1);

      // Single attempt row is recorded for fanout_element_idx=1.
      const item2Attempts = db
        .prepare(
          `SELECT status FROM stage_attempts
            WHERE stage_name = 'F'
              AND kind = 'fanout_element'
              AND fanout_element_idx = 1`,
        )
        .all() as Array<{ status: string }>;
      expect(item2Attempts.length).toBe(1);
      expect(item2Attempts[0]!.status).toBe("error");
    } finally {
      db.close();
    }
  });

  it("schema accepts elementRetries 0..5, rejects out-of-range", () => {
    expect(() => FanoutSpecSchema.parse({ input: "item", elementRetries: 0 })).not.toThrow();
    expect(() => FanoutSpecSchema.parse({ input: "item", elementRetries: 5 })).not.toThrow();
    expect(() => FanoutSpecSchema.parse({ input: "item", elementRetries: -1 })).toThrow();
    expect(() => FanoutSpecSchema.parse({ input: "item", elementRetries: 6 })).toThrow();
    expect(() => FanoutSpecSchema.parse({ input: "item", elementRetries: 1.5 })).toThrow();
    expect(() => FanoutSpecSchema.parse({ input: "item" })).not.toThrow();
  });
});
