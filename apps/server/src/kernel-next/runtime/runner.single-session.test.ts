import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runPipeline, segmentContinuationFor } from "./runner.js";
import { MockStageExecutor } from "./mock-executor.js";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { PipelineIRSchema } from "../ir/schema.js";
import { versionHash } from "../ir/canonical.js";
import { planSegments } from "./segment-planner.js";
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

  it("diamond fan-out a→b, a→c: c does NOT resume a by default (cross-segment-resume opt-in per 2026-04-26 pivot)", async () => {
    // 2026-04-26 pivot: cross-segment resume is now opt-in via
    // cross_segment_resume_from. Without that field, c (idx 0 of its
    // own segment) does NOT walk wires back to a. b (idx 1 of segment 0)
    // still uses in-segment continuation — that's unchanged.
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
    expect(seenContinuation.find((r) => r.stage === "a")!.segCont).toBeUndefined();

    // b: idx 1 of segment 0 → in-segment continuation (unchanged behavior).
    const bRecord = seenContinuation.find((r) => r.stage === "b")!;
    expect(bRecord.segCont?.resumeSessionId).toBe("sa");
    expect(bRecord.segCont?.isContinuationStage).toBe(true);

    // c: idx 0 of segment 1. Without cross_segment_resume_from, no
    // resume — this is the post-pivot default.
    expect(seenContinuation.find((r) => r.stage === "c")!.segCont).toBeUndefined();
    db.close();
  });

  it("diamond fan-out with cross_segment_resume_from='a' on c: c resumes a's session", async () => {
    // Same diamond as above, but c declares cross_segment_resume_from.
    // c is now expected to resume a's session via the explicit opt-in.
    const ir = PipelineIRSchema.parse({
      name: "diamond-opt-in",
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
          config: { promptRef: "p/c", cross_segment_resume_from: "a" },
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
    const handlers = {
      a: (): { x: string } => ({ x: "a-out" }),
      b: (): { yb: string } => ({ yb: "b-out" }),
      c: (): { yc: string } => ({ yc: "c-out" }),
    };
    const executor = new MockStageExecutor({
      handlers,
      onExecute: (args) =>
        seenContinuation.push({ stage: args.stageName, segCont: args.segmentContinuation }),
      persistSessionIdMap: { a: { sessionId: "sa", numTurns: 2 } },
    });

    const result = await runPipeline({
      db, ir, taskId: "t-diamond-optin", versionHash: hash,
      handlers, executor, seedValues: { seed: "s0" },
    });

    expect(result.finalState).toBe("completed");

    // c: opt-in resume → resumeSessionId === "sa", isContinuationStage === false
    // (segment-first stage; full prompt form per spec §8.4).
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

  it("retry path: prefers latest SUCCESS attempt over superseded/error attempts when picking session", () => {
    // Direct unit test on segmentContinuationFor. Setup: two attempts
    // for stage `a` — first attempt was superseded (e.g. by a hot-update
    // or an earlier retry), second attempt succeeded. Stage `b` retry
    // must resume the SUCCESS session, not the superseded one.
    //
    // Bug history: pre-fix, segmentContinuationFor's SQL used
    // `ORDER BY started_at DESC LIMIT 1` without filtering by status —
    // so it would pick the most recent attempt regardless of status,
    // potentially resuming a superseded/error session.
    const ir = PipelineIRSchema.parse({
      name: "retry-status-filter",
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
      ],
      wires: [
        { from: { source: "external", port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
      ],
    });

    const db = makeDb();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const taskId = "t-retry-filter";

    // Seed prompt_contents (FK target).
    db.prepare(
      `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at) VALUES ('h', '', 0)`,
    ).run();

    // Attempt 1 of stage a: superseded with old session_id, started earlier.
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES ('a-att1', ?, ?, 'a', 0, 100, 'superseded')`,
    ).run(taskId, hash);
    db.prepare(
      `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, session_id, started_at, last_heartbeat_at) VALUES ('a-att1', 'r', 'h', '', 'm', 'old-superseded-sess', 100, 100)`,
    ).run();

    // Attempt 2 of stage a: success with new session_id, started later.
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES ('a-att2', ?, ?, 'a', 1, 200, 'success')`,
    ).run(taskId, hash);
    db.prepare(
      `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, session_id, started_at, last_heartbeat_at) VALUES ('a-att2', 'r', 'h', '', 'm', 'new-success-sess', 200, 200)`,
    ).run();

    const segments = planSegments(ir);
    // Build a minimal RunnerOptions stub for segmentContinuationFor.
    const stubOpts = {
      db, ir, taskId, versionHash: hash, handlers: {},
    } as Parameters<typeof segmentContinuationFor>[0];

    const result = segmentContinuationFor(stubOpts, "b", taskId, ir, segments);
    expect(result?.resumeSessionId).toBe("new-success-sess");
    db.close();
  });

  it("retry path: prefers earlier SUCCESS over later SUPERSEDED attempt (status > recency)", () => {
    // The bug-revealing variant: success attempt is FIRST (started_at=100),
    // then a later attempt was launched but got superseded (started_at=200).
    // Pre-fix code's `ORDER BY started_at DESC LIMIT 1` would pick the
    // superseded session — wrong. Status filter must take precedence.
    const ir = PipelineIRSchema.parse({
      name: "retry-status-precedence",
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
      ],
      wires: [
        { from: { source: "external", port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
      ],
    });

    const db = makeDb();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const taskId = "t-precedence";

    db.prepare(
      `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at) VALUES ('h', '', 0)`,
    ).run();

    // Earlier success.
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES ('a-ok', ?, ?, 'a', 0, 100, 'success')`,
    ).run(taskId, hash);
    db.prepare(
      `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, session_id, started_at, last_heartbeat_at) VALUES ('a-ok', 'r', 'h', '', 'm', 'good-sess', 100, 100)`,
    ).run();

    // Later superseded.
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES ('a-bad', ?, ?, 'a', 1, 200, 'superseded')`,
    ).run(taskId, hash);
    db.prepare(
      `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, session_id, started_at, last_heartbeat_at) VALUES ('a-bad', 'r', 'h', '', 'm', 'bad-sess', 200, 200)`,
    ).run();

    const segments = planSegments(ir);
    const stubOpts = {
      db, ir, taskId, versionHash: hash, handlers: {},
    } as Parameters<typeof segmentContinuationFor>[0];

    const result = segmentContinuationFor(stubOpts, "b", taskId, ir, segments);
    // Must pick the success session, not the more-recent superseded one.
    expect(result?.resumeSessionId).toBe("good-sess");
    db.close();
  });

  it("retry path: ignores error/interrupted attempts even when they're the latest", () => {
    // Variant: the ONLY persisted attempt for stage `a` is one that
    // ended in error. Stage `b` should NOT resume that session — it
    // should return undefined (no upstream success session). Otherwise
    // a stage-1 crash that left a partial session_id row would let a
    // resumed stage 2 inherit a corrupt SDK conversation.
    const ir = PipelineIRSchema.parse({
      name: "retry-error-filter",
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
      ],
      wires: [
        { from: { source: "external", port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
      ],
    });

    const db = makeDb();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const taskId = "t-error-filter";

    db.prepare(
      `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at) VALUES ('h', '', 0)`,
    ).run();

    // Only attempt of stage a: error status with session_id (mid-stream
    // crash captured init message but errored later).
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES ('a-err', ?, ?, 'a', 0, 100, 'error')`,
    ).run(taskId, hash);
    db.prepare(
      `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, session_id, started_at, last_heartbeat_at) VALUES ('a-err', 'r', 'h', '', 'm', 'errored-sess', 100, 100)`,
    ).run();

    const segments = planSegments(ir);
    const stubOpts = {
      db, ir, taskId, versionHash: hash, handlers: {},
    } as Parameters<typeof segmentContinuationFor>[0];

    const result = segmentContinuationFor(stubOpts, "b", taskId, ir, segments);
    // No success session upstream → no resume.
    expect(result).toBeUndefined();
    db.close();
  });

  it("hot-update: superseded v1 session does NOT leak into v2 segment continuation", () => {
    // Hot-update invariant: when v1 stage `a` was superseded by a
    // hot-update that introduced v2 with a fresh `a`, v2 stage `b` must
    // resume v2's a session — never v1's superseded one. This is the
    // status-filter invariant applied to the cross-version path.
    //
    // Note: segmentContinuationFor's SQL is task+stage+status scoped
    // (no version_hash filter); this is intentional, since the IR
    // passed in is always the running version's IR. The hot-update
    // path's correctness depends on the v1 attempt being marked
    // 'superseded' before v2's stage `b` runs, which is exactly what
    // migration-orchestrator's supersede transaction does.
    const ir = PipelineIRSchema.parse({
      name: "hot-update-cross-version",
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
          config: { promptRef: "p/b-v2" },
        },
      ],
      wires: [
        { from: { source: "external", port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage", stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
      ],
    });

    const db = makeDb();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const taskId = "t-hot-update";
    const v1Hash = "v1-hash";
    const v2Hash = hash;

    db.prepare(
      `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at) VALUES ('h', '', 0)`,
    ).run();

    // v2 a: ran first chronologically (started_at=100), succeeded.
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES ('v2-a', ?, ?, 'a', 1, 100, 'success')`,
    ).run(taskId, v2Hash);
    db.prepare(
      `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, session_id, started_at, last_heartbeat_at) VALUES ('v2-a', 'r', 'h', '', 'm', 'v2-a-sess', 100, 100)`,
    ).run();

    // v1 a: a stale superseded attempt, started LATER (started_at=200).
    // Without the status filter, the SQL `ORDER BY started_at DESC LIMIT 1`
    // would pick this one — wrong, because the v1 session's prompt no
    // longer matches the v2 IR being executed. Status filter is the
    // only thing that prevents the leak; this row layout makes the
    // test fail if the filter is ever removed.
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES ('v1-a', ?, ?, 'a', 0, 200, 'superseded')`,
    ).run(taskId, v1Hash);
    db.prepare(
      `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, session_id, started_at, last_heartbeat_at) VALUES ('v1-a', 'r', 'h', '', 'm', 'v1-a-sess', 200, 200)`,
    ).run();

    const segments = planSegments(ir);
    const stubOpts = {
      db, ir, taskId, versionHash: v2Hash, handlers: {},
    } as Parameters<typeof segmentContinuationFor>[0];

    const result = segmentContinuationFor(stubOpts, "b", taskId, ir, segments);
    expect(result?.resumeSessionId).toBe("v2-a-sess");
    db.close();
  });

  it("hot-update: sibling-preservation diamond — D with cross_segment_resume_from='B' resumes B's session", () => {
    // Diamond IR: A → B, A → C, B → D, C → D. Hot-update with rerunFrom=B
    // supersedes B and D (wire-reachable from B), but A and C stay
    // success on v1 (B13 sibling preservation). Post-pivot, when v2
    // rerun reaches D, D opts into cross-segment resume by naming
    // cross_segment_resume_from='B' (its segment break is B's
    // termination, since B's segment ends at D's segment start).
    //
    // We assert resumeSessionId === 'sess-B-new' (the v2 success
    // session), proving:
    //   - the explicit field works
    //   - the status filter excludes the v1 superseded B session
    const ir = PipelineIRSchema.parse({
      name: "diamond-hot-update",
      session_mode: "single",
      externalInputs: [{ name: "seed", type: "string" }],
      stages: [
        {
          name: "A", type: "agent",
          inputs: [{ name: "seed", type: "string" }],
          outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "p/A" },
        },
        {
          name: "B", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "yB", type: "string" }],
          config: { promptRef: "p/B-v2" },
        },
        {
          name: "C", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "yC", type: "string" }],
          config: { promptRef: "p/C" },
        },
        {
          name: "D", type: "agent",
          inputs: [
            { name: "yB", type: "string" },
            { name: "yC", type: "string" },
          ],
          outputs: [{ name: "final", type: "string" }],
          config: { promptRef: "p/D-v2", cross_segment_resume_from: "B" },
        },
      ],
      wires: [
        { from: { source: "external", port: "seed" }, to: { stage: "A", port: "seed" } },
        { from: { source: "stage", stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
        { from: { source: "stage", stage: "A", port: "x" }, to: { stage: "C", port: "x" } },
        { from: { source: "stage", stage: "B", port: "yB" }, to: { stage: "D", port: "yB" } },
        { from: { source: "stage", stage: "C", port: "yC" }, to: { stage: "D", port: "yC" } },
      ],
    });

    const db = makeDb();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const taskId = "t-diamond-hu";
    const v1 = "v1-hash";
    const v2 = hash;

    db.prepare(
      `INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at) VALUES ('h', '', 0)`,
    ).run();

    const seed = (id: string, vhash: string, stage: string, status: string, ts: number, sess: string): void => {
      db.prepare(
        `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES (?, ?, ?, ?, 0, ?, ?)`,
      ).run(id, taskId, vhash, stage, ts, status);
      db.prepare(
        `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, session_id, started_at, last_heartbeat_at) VALUES (?, 'r', 'h', '', 'm', ?, ?, ?)`,
      ).run(id, sess, ts, ts);
    };
    // v2-B succeeds first (200); v1-B is superseded but more recent in
    // started_at (300). Status filter must reject v1-B even though it's
    // newer — the very property the original test verified.
    seed("v2-B", v2, "B", "success",    200, "sess-B-new");
    seed("v1-A", v1, "A", "success",    100, "sess-A");
    seed("v1-C", v1, "C", "success",    150, "sess-C");
    seed("v1-B", v1, "B", "superseded", 300, "sess-B-old");
    seed("v1-D", v1, "D", "superseded", 310, "sess-D-old");

    const segments = planSegments(ir);
    const stubOpts = {
      db, ir, taskId, versionHash: v2, handlers: {},
    } as Parameters<typeof segmentContinuationFor>[0];

    const result = segmentContinuationFor(stubOpts, "D", taskId, ir, segments);
    // D explicitly resumes B; status filter picks v2-B (success), not v1-B (superseded).
    expect(result?.resumeSessionId).toBe("sess-B-new");
    db.close();
  });
});
