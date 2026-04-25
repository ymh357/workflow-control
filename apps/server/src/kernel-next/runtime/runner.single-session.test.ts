import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runPipeline } from "./runner.js";
import { MockStageExecutor } from "./mock-executor.js";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { PipelineIRSchema } from "../ir/schema.js";
import { versionHash } from "../ir/canonical.js";
import type { ExecuteStageArgs } from "./executor.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function buildIR(sessionMode: "multi" | "single") {
  return PipelineIRSchema.parse({
    name: "two-stage",
    session_mode: sessionMode,
    externalInputs: [{ name: "seed", type: "string" }],
    stages: [
      {
        name: "a",
        type: "agent",
        inputs: [{ name: "seed", type: "string" }],
        outputs: [{ name: "x", type: "string" }],
        config: { promptRef: "p/a" },
      },
      {
        name: "b",
        type: "agent",
        inputs: [{ name: "x", type: "string" }],
        outputs: [{ name: "y", type: "string" }],
        config: { promptRef: "p/b" },
      },
    ],
    wires: [
      { from: { source: "external", port: "seed" }, to: { stage: "a", port: "seed" } },
      { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
    ],
  });
}

// Handler maps shared between opts.handlers and MockStageExecutor so the
// runner's `handlers: opts.handlers` propagation reaches the inner
// executeStage function (args.handlers ?? this.handlers picks the non-empty
// opts map, which is identical to this.handlers).
const stageHandlers = {
  a: (): { x: string } => ({ x: "a-out" }),
  b: (): { y: string } => ({ y: "b-out" }),
};

describe("runner: single-session segment plumbing", () => {
  it("passes segmentContinuation to stage 2 of a single-mode 2-stage segment", async () => {
    const db = makeDb();
    const ir = buildIR("single");
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const seenContinuation: Array<{
      stage: string;
      segCont: ExecuteStageArgs["segmentContinuation"];
    }> = [];

    const executor = new MockStageExecutor({
      handlers: stageHandlers,
      onExecute: (args) =>
        seenContinuation.push({
          stage: args.stageName,
          segCont: args.segmentContinuation,
        }),
      persistSessionIdMap: { a: "sess-a" },
    });

    const result = await runPipeline({
      db,
      ir,
      taskId: "t-single",
      versionHash: hash,
      handlers: stageHandlers,
      executor,
      seedValues: { seed: "s0" },
    });

    expect(result.finalState).toBe("completed");
    expect(seenContinuation).toHaveLength(2);
    expect(seenContinuation[0]?.stage).toBe("a");
    expect(seenContinuation[0]?.segCont).toBeUndefined();
    expect(seenContinuation[1]?.stage).toBe("b");
    expect(seenContinuation[1]?.segCont?.resumeSessionId).toBe("sess-a");
    db.close();
  });

  it("does NOT pass segmentContinuation when session_mode='multi'", async () => {
    const db = makeDb();
    const ir = buildIR("multi");
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const seenContinuation: Array<ExecuteStageArgs["segmentContinuation"]> = [];

    const executor = new MockStageExecutor({
      handlers: stageHandlers,
      onExecute: (args) => seenContinuation.push(args.segmentContinuation),
      persistSessionIdMap: { a: "sess-a" },
    });

    const result = await runPipeline({
      db,
      ir,
      taskId: "t-multi",
      versionHash: hash,
      handlers: stageHandlers,
      executor,
      seedValues: { seed: "s0" },
    });

    expect(result.finalState).toBe("completed");
    expect(seenContinuation).toHaveLength(2);
    expect(seenContinuation[0]).toBeUndefined();
    expect(seenContinuation[1]).toBeUndefined();
    db.close();
  });

  it("3-stage segment: stage 3 sees segment-wide priorNumTurns sum + priorAttempts ordered", async () => {
    // Regression test for spec §4.4 segment-wide budget. Stage c's
    // priorNumTurns must equal numTurns(a)+numTurns(b), not just one
    // predecessor. Also asserts priorAttempts captures both prior
    // attempt_ids in topological order, and resumeSessionId is the
    // most recent persisted session (stage b's, not stage a's).
    const ir = PipelineIRSchema.parse({
      name: "three-stage",
      session_mode: "single",
      externalInputs: [{ name: "seed", type: "string" }],
      stages: [
        {
          name: "a", type: "agent",
          inputs: [{ name: "seed", type: "string" }],
          outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "p/a" },
        },
        {
          name: "b", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "y", type: "string" }],
          config: { promptRef: "p/b" },
        },
        {
          name: "c", type: "agent",
          inputs: [{ name: "y", type: "string" }],
          outputs: [{ name: "z", type: "string" }],
          config: { promptRef: "p/c" },
        },
      ],
      wires: [
        { from: { source: "external", port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
        { from: { source: "stage", stage: "b", port: "y" }, to: { stage: "c", port: "y" } },
      ],
    });

    const db = makeDb();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const seenContinuation: Array<{ stage: string; segCont: ExecuteStageArgs["segmentContinuation"] }> = [];
    const threeStageHandlers = {
      a: (): { x: string } => ({ x: "a-out" }),
      b: (): { y: string } => ({ y: "b-out" }),
      c: (): { z: string } => ({ z: "c-out" }),
    };
    const executor = new MockStageExecutor({
      handlers: threeStageHandlers,
      onExecute: (args) =>
        seenContinuation.push({ stage: args.stageName, segCont: args.segmentContinuation }),
      persistSessionIdMap: {
        a: { sessionId: "sa", numTurns: 3 },
        b: { sessionId: "sb", numTurns: 5 },
      },
    });

    const result = await runPipeline({
      db, ir, taskId: "t-3stage", versionHash: hash,
      handlers: threeStageHandlers, executor, seedValues: { seed: "s0" },
    });

    expect(result.finalState).toBe("completed");
    expect(seenContinuation).toHaveLength(3);

    // Stage a: segment-first, no continuation.
    expect(seenContinuation[0]?.segCont).toBeUndefined();

    // Stage b: continuation of a. Sees a's session_id, num_turns=3.
    expect(seenContinuation[1]?.segCont?.resumeSessionId).toBe("sa");
    expect(seenContinuation[1]?.segCont?.priorNumTurns).toBe(3);
    expect(seenContinuation[1]?.segCont?.priorAttempts).toHaveLength(1);

    // Stage c: continuation. Sees b's session_id (most recent),
    // priorNumTurns = 3 + 5 = 8 (segment-wide sum), priorAttempts has both.
    expect(seenContinuation[2]?.segCont?.resumeSessionId).toBe("sb");
    expect(seenContinuation[2]?.segCont?.priorNumTurns).toBe(8);
    expect(seenContinuation[2]?.segCont?.priorAttempts).toHaveLength(2);
    db.close();
  });
});
