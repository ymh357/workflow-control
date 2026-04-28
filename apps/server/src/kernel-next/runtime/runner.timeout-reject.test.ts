// Wall-clock timeout reject regression. Pre-fix, the timer set in
// runPipeline only flipped a `timedOut` flag; rejection happened
// only inside actor.subscribe when a snapshot fired. If the actor
// stalled in a region that did not emit further snapshots (e.g. a
// stage waiting on an inbound wire that will never deliver and no
// other parallel region triggering snapshot churn), runPipeline
// never resolved nor rejected. The test harness's own timeout was
// the only escape hatch.
//
// Fix (continuation 3): the timer callback rejects the in-flight
// attempt directly via a captured rejecter. This test pins that
// behavior — a wire-gated stage that is unreachable resolves to a
// thrown timeout within a small budget instead of hanging until
// the test harness kills it.

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

describe("runPipeline wall-clock timeout reject path", () => {
  it("rejects with timeout error when no stage can ever activate", async () => {
    const db = makeDb();
    try {
      // Pipeline: A produces x=0, B has a wire from A.x with a guard
      // that rejects the value. B's only inbound wire is dropped so
      // B never activates AND every wire is settled — but the
      // noDeliverableWire path needs all-settled-but-some-dropped to
      // fire NO_ACTIVE_WIRE. Here we rely on a handler that NEVER
      // resolves (returns a never-settling promise) so A's region
      // stays in `executing` forever; meanwhile B is in `waiting`
      // for A.x which will never be written. No snapshot churn after
      // initial idle→running.
      const ir: PipelineIR = {
        name: "stuck",
        externalInputs: [],
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
        wires: [
          { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
        ],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      // A's handler returns a Promise that never resolves; A's region
      // sits in `executing` forever. B's region sits in `waiting` for
      // A.x. Both unproductive; subscribe loop quiet after the initial
      // idle→running snapshot.
      const handlers: StageHandlerMap = {
        A: () => new Promise(() => {}),
        B: () => ({ y: 1 }),
      };

      const t0 = Date.now();
      // 800ms wall-clock budget. Without the fix, this would resolve
      // far later (test runner timeout ~5s) or never. With the fix,
      // the timer callback rejects the in-flight attempt directly.
      // seedValues intentionally omits "trigger", so A's external
      // wire never delivers → stage A stays in waiting → no snapshot
      // churn after the initial idle→running burst.
      await expect(
        runPipeline(
          {
            db, ir, taskId: "stuck-1", versionHash: hash,
            handlers,
          },
          800,
        ),
      ).rejects.toThrow(/runPipeline timeout after 800ms/);
      const elapsed = Date.now() - t0;
      // Should reject within a tight envelope of the budget. A 2s
      // upper bound covers actor teardown overhead but proves we
      // didn't fall through to the harness timeout.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      db.close();
    }
  });
});
