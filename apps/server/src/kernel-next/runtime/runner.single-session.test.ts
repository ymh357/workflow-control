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

  it("diamond fan-out a→b, a→c: both b and c resume a's session_id (cross-segment resume per spec §3)", async () => {
    // Spec §3: "At a segment boundary (gate / script / fanout / pipeline
    // end), terminate the SDK query, persist the final session_id, and
    // the next segment opens a new query with options.resume pointing
    // at it." Both b and c are next-segment stages from a; both must
    // resume a's session_id.
    //
    // Crucial distinction (Q3 bug fix 2026-04-25):
    //   - b: idx 1 of segment 0 → uses continuation prompt form
    //     (SDK already saw a's full prompt in this same query)
    //   - c: idx 0 of segment 1 → uses FULL prompt form (new SDK query
    //     resuming a's session — spec §8.4 example: "Stage 3's prompt
    //     is full ... even though semantically it's 'after the user
    //     answered the gate'")
    //
    // Both branches resuming the same session_id concurrently is a
    // separate concern (real SDK behavior under that condition is
    // verified elsewhere; this test only verifies the runner's intent).
    const ir = PipelineIRSchema.parse({
      name: "diamond",
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
          outputs: [{ name: "yb", type: "string" }],
          config: { promptRef: "p/b" },
        },
        {
          name: "c", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "yc", type: "string" }],
          config: { promptRef: "p/c" },
        },
      ],
      wires: [
        { from: { source: "external", port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "c", port: "x" } },
      ],
    });

    const db = makeDb();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    const seenContinuation: Array<{ stage: string; segCont: ExecuteStageArgs["segmentContinuation"] }> = [];
    const diamondHandlers = {
      a: (): { x: string } => ({ x: "a-out" }),
      b: (): { yb: string } => ({ yb: "b-out" }),
      c: (): { yc: string } => ({ yc: "c-out" }),
    };
    const executor = new MockStageExecutor({
      handlers: diamondHandlers,
      onExecute: (args) =>
        seenContinuation.push({ stage: args.stageName, segCont: args.segmentContinuation }),
      persistSessionIdMap: { a: { sessionId: "sa", numTurns: 2 } },
    });

    const result = await runPipeline({
      db, ir, taskId: "t-diamond", versionHash: hash,
      handlers: diamondHandlers, executor, seedValues: { seed: "s0" },
    });

    expect(result.finalState).toBe("completed");
    expect(seenContinuation).toHaveLength(3);

    // a: first stage of segment 0, no upstream agent → no resume.
    const aRecord = seenContinuation.find((r) => r.stage === "a")!;
    expect(aRecord.segCont).toBeUndefined();

    // b: idx 1 of segment 0 → continuation prompt form, resumes a.
    const bRecord = seenContinuation.find((r) => r.stage === "b")!;
    expect(bRecord.segCont?.resumeSessionId).toBe("sa");
    expect(bRecord.segCont?.isContinuationStage).toBe(true);

    // c: idx 0 of segment 1, but upstream by wire is `a` (an agent
    // with persisted session). Cross-segment resume per spec §3 +
    // §8.4: c resumes a's session_id but uses FULL prompt form.
    const cRecord = seenContinuation.find((r) => r.stage === "c")!;
    expect(cRecord.segCont?.resumeSessionId).toBe("sa");
    expect(cRecord.segCont?.isContinuationStage).toBe(false);
    db.close();
  });

  it("isContinuationStage flag distinguishes prompt form (continuation) from resume (always when upstream session exists)", async () => {
    // Linear single chain a→b→c: all three should reuse a's segment.
    //   - a: idx 0, no upstream → undefined
    //   - b: idx 1 → resume sa, continuation form
    //   - c: idx 2 → resume sa (or sb if intermediate stage persisted), continuation form
    const ir = PipelineIRSchema.parse({
      name: "linear-three",
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
    const handlers = {
      a: (): { x: string } => ({ x: "a-out" }),
      b: (): { y: string } => ({ y: "b-out" }),
      c: (): { z: string } => ({ z: "c-out" }),
    };
    const executor = new MockStageExecutor({
      handlers,
      onExecute: (args) =>
        seenContinuation.push({ stage: args.stageName, segCont: args.segmentContinuation }),
      persistSessionIdMap: {
        a: { sessionId: "sa", numTurns: 1 },
        b: { sessionId: "sb", numTurns: 1 },
      },
    });

    const result = await runPipeline({
      db, ir, taskId: "t-linear", versionHash: hash,
      handlers, executor, seedValues: { seed: "s0" },
    });

    expect(result.finalState).toBe("completed");
    const a = seenContinuation.find((r) => r.stage === "a")!;
    const b = seenContinuation.find((r) => r.stage === "b")!;
    const c = seenContinuation.find((r) => r.stage === "c")!;

    expect(a.segCont).toBeUndefined();
    // Both b and c are idx>0 in their segment → continuation form.
    expect(b.segCont?.isContinuationStage).toBe(true);
    expect(c.segCont?.isContinuationStage).toBe(true);
    // c resumes the most recent persisted session in its segment (b's).
    expect(c.segCont?.resumeSessionId).toBe("sb");
    db.close();
  });
});
