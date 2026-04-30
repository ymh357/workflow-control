// C10 (2026-04-30) — fanout per-element wall-clock timeout.
//
// FanoutSpec.elementTimeoutMs (default 30 min) caps how long each fanout
// child can run before the runner aborts and treats it as an error. The
// underlying motivation: dogfood-c10 hit a wedged Claude SDK session (one
// fanout child stuck `running` past the 90-min global budget while peers
// finished in 5 min), which left the whole task in a perpetual orphan
// state because the worker pool never settled. With per-element timeout,
// the wedged child fails normally and the elementRetries loop (or the
// stage error path) takes over.
//
// Test handler: a "hangs forever" handler that ignores AbortSignal and
// never resolves. With the timeout in place, the runner must NOT block
// indefinitely; instead it surfaces a timeout error.

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

function fanoutIR(opts: { elementTimeoutMs: number; elementRetries?: number }): PipelineIR {
  const fanout: { input: string; elementTimeoutMs: number; elementRetries?: number } = {
    input: "item",
    elementTimeoutMs: opts.elementTimeoutMs,
  };
  if (opts.elementRetries !== undefined) fanout.elementRetries = opts.elementRetries;
  return {
    name: `fanout-elem-timeout-${opts.elementTimeoutMs}`,
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

describe("C10: fanout per-element timeout", () => {
  it("times out a hung child and fails the stage (no retries)", async () => {
    const db = makeDb();
    try {
      // Tight 100ms timeout so the test runs fast; production default is 30 min.
      const ir = fanoutIR({ elementTimeoutMs: 100 });
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3] }),
        // Item 2 hangs forever; items 1 and 3 succeed instantly. Without
        // per-element timeout, the worker pool would block on item 2's
        // promise and runPipeline would hang past the test's wall-clock.
        F: async (inputs) => {
          if ((inputs.item as number) === 2) {
            await new Promise(() => { /* never resolves */ });
          }
          return { doubled: (inputs.item as number) * 2 };
        },
      };

      // The CRITICAL invariant: runPipeline must RETURN within a wall-clock
      // window proportional to the timeout, not hang waiting on the wedged
      // element. (We don't assert finalState here because mock-executor
      // doesn't close its stage_attempts row when handler hangs — that's a
      // mock-vs-real divergence, not a timeout-mechanism concern. The
      // real-executor closes its row via finally{} after abort. What
      // matters for production is that the worker pool unblocks.)
      const start = Date.now();
      const runPromise = runPipeline({
        db,
        ir,
        taskId: `t-${Math.random().toString(36).slice(2)}`,
        versionHash: hash,
        handlers,
      });
      const watchdog = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("runPipeline did not return — fanout timeout did not unblock the worker pool")),
          5000,
        ),
      );
      const result = await Promise.race([runPromise, watchdog]);
      const elapsed = Date.now() - start;

      // Elapsed must be close to the per-element timeout (100ms), proving
      // the runner didn't wait for the hung element 2 indefinitely.
      expect(elapsed).toBeLessThan(2000);

      // The runner's machine must observe F transitioning into its error
      // final via STAGE_FAILED (which is the correct fanout-error path).
      expect(result.log).toContain("F:error");
    } finally {
      db.close();
    }
  });

  it("retries a timed-out element and succeeds when next attempt resolves", async () => {
    const db = makeDb();
    try {
      const ir = fanoutIR({ elementTimeoutMs: 200, elementRetries: 1 });
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const seen = new Map<number, number>();
      const handlers: StageHandlerMap = {
        SRC: () => ({ items: [1, 2, 3] }),
        F: async (inputs) => {
          const item = inputs.item as number;
          const count = (seen.get(item) ?? 0) + 1;
          seen.set(item, count);
          // Item 2 hangs on first call, succeeds on retry.
          if (item === 2 && count === 1) {
            await new Promise(() => { /* hang */ });
          }
          return { doubled: item * 2 };
        },
      };

      const result = await runPipeline({
        db,
        ir,
        taskId: `t-${Math.random().toString(36).slice(2)}`,
        versionHash: hash,
        handlers,
      });

      expect(result.finalState).toBe("completed");

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
      expect(JSON.parse(aggRow.value_json)).toEqual([2, 4, 6]);
    } finally {
      db.close();
    }
  });
});
