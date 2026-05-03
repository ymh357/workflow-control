// Bug 81 (dogfood-13 2026-05-03) — fanout INTERRUPT propagation.
//
// orchestrateFanoutStage now accepts an `interruptSignal` param. When
// the runner-level dispatcher observes INTERRUPT (from cancel_task /
// migrate_task / etc.), it aborts this signal so:
//   - in-flight per-element executors see their AbortSignal trip and
//     bail via their existing teardown paths;
//   - workers that haven't started yet bail on the synchronous
//     `interruptSignal.aborted` check at the top of runElement
//     instead of spawning fresh elements while INTERRUPT is in flight.
//
// Pre-fix: detached fanout promises (executorPromises in runner.ts)
// lived OUTSIDE the XState actor and ignored both INTERRUPT and
// actor.stop(). A migrate_task that landed mid-fanout would let every
// queued element run to completion before the actor terminated,
// producing a 30s MIGRATION_INTERRUPT_TIMEOUT.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  initKernelNextSchema,
  insertPipelineVersion,
} from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { orchestrateFanoutStage } from "./runner-fanout.js";
import { PortRuntime } from "./port-runtime.js";
import { MockStageExecutor } from "./mock-executor.js";
import type { PipelineIR, AgentStage } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function fanoutIR(): PipelineIR {
  return {
    name: "fanout-interrupt-test",
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
        fanout: { input: "item", concurrency: 2 },
        inputs: [{ name: "item", type: "number" }],
        outputs: [{ name: "doubled", type: "number" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { stage: "SRC", port: "items" }, to: { stage: "F", port: "item" } },
    ],
  } as unknown as PipelineIR;
}

describe("Bug 81: fanout responds to runner-level INTERRUPT", () => {
  it("aborts in-flight + queued elements when interruptSignal trips", async () => {
    const db = makeDb();
    const ir = fanoutIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const taskId = "t-bug81";
    // Seed an aggregate-level basePortValues view: SRC produced
    // a 6-element array, so without abort we'd run all 6.
    const basePortValues: Record<string, unknown> = {
      "SRC.items": [1, 2, 3, 4, 5, 6],
    };

    const elementsStarted: number[] = [];
    const interruptCtl = new AbortController();

    // Handler takes 40ms per element. With concurrency=2 over 6
    // elements, total wall time without abort is ~120ms. We trip
    // interruptSignal as soon as the first element enters its
    // handler — workers that haven't picked up an element yet bail
    // at the runElement entry check. Mock-executor's handler doesn't
    // observe AbortSignal, so the first 2 in-flight elements run to
    // completion; the remaining 4 should NOT enter the handler.
    const handlers: StageHandlerMap = {
      F: async (inputs) => {
        elementsStarted.push(inputs.item as number);
        // Trip on the very first start so subsequent workers see
        // the abort before they call into runElement.
        if (elementsStarted.length === 1) {
          // Schedule abort to land after this element's 40ms wait
          // begins but well before its 40ms expiry, so other
          // workers definitely observe the aborted state.
          setTimeout(() => interruptCtl.abort(), 5);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        return { doubled: 0 };
      },
    };

    const fanoutStage = ir.stages.find((s) => s.name === "F") as AgentStage;
    const livePortRuntime = new PortRuntime(
      db,
      { send: () => { /* swallow PORT_WRITTEN */ } },
    );
    const executor = new MockStageExecutor({ handlers });

    const result = await orchestrateFanoutStage({
      ir,
      stageDef: fanoutStage,
      taskId,
      versionHash: hash,
      basePortValues,
      handlers,
      db,
      livePortRuntime,
      executor,
      interruptSignal: interruptCtl.signal,
    });

    // Result is `error` because INTERRUPT trips firstError via the
    // synchronous "before start" path on subsequent workers.
    expect(result.status).toBe("error");

    // The decisive check: NOT all 6 elements entered the handler.
    // Pre-fix every queued element would have run because no part of
    // runElement checked the parent abort. Post-fix the queue drains
    // immediately when interruptSignal trips. Concurrency is 2, so
    // we expect roughly the first 2 in-flight elements to finish + at
    // most 1-2 more that picked up before observing the abort.
    expect(elementsStarted.length).toBeLessThan(6);
    expect(elementsStarted.length).toBeLessThanOrEqual(3);

    db.close();
  });

  it("synchronously bails when interruptSignal is already aborted at entry", async () => {
    const db = makeDb();
    const ir = fanoutIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const taskId = "t-bug81-pre-aborted";
    const basePortValues: Record<string, unknown> = {
      "SRC.items": [1, 2, 3, 4, 5, 6],
    };

    let elementsStarted = 0;
    const handlers: StageHandlerMap = {
      F: async () => {
        elementsStarted++;
        return { doubled: 0 };
      },
    };

    const fanoutStage2 = ir.stages.find((s) => s.name === "F") as AgentStage;
    const livePortRuntime2 = new PortRuntime(
      db,
      { send: () => { /* swallow */ } },
    );
    const executor2 = new MockStageExecutor({ handlers });

    const interruptCtl = new AbortController();
    interruptCtl.abort(); // already aborted before orchestration starts

    const result = await orchestrateFanoutStage({
      ir,
      stageDef: fanoutStage2,
      taskId,
      versionHash: hash,
      basePortValues,
      handlers,
      db,
      livePortRuntime: livePortRuntime2,
      executor: executor2,
      interruptSignal: interruptCtl.signal,
    });

    expect(result.status).toBe("error");
    // No element should have entered the handler — the entry check at
    // the top of runElement bails synchronously before any work.
    expect(elementsStarted).toBe(0);

    db.close();
  });
});
