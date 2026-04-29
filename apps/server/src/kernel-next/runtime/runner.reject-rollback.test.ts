// Task 6 — end-to-end reject-rollback test.
//
// Pipeline: A -> G (gate, approve -> B, reject -> A) -> B
// 1. Run pauses at gate G.
// 2. Dispatch GATE_REJECTED — runner prunes state for affectedStages
//    {A, G}, publishes stage_rolled_back, rebuilds the actor.
// 3. On rebuild, A re-runs, G re-opens for a fresh answer.
// 4. Answer with "approve" this time — pipeline should complete.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash as computeVersionHash } from "../ir/canonical.js";
import { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { taskRegistry } from "./task-registry.js";
import { runPipeline } from "./runner.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./executor.js";

function rollbackIR(): PipelineIR {
  return {
    name: "rb-test",
    stages: [
      {
        name: "A",
        type: "agent",
        inputs: [],
        outputs: [{ name: "out", type: "unknown" }],
        config: { promptRef: "p" },
      },
      {
        name: "G",
        type: "gate",
        inputs: [{ name: "i", type: "unknown" }],
        outputs: [],
        config: {
          question: { text: "approve or reject?", options: [{ value: "approve" }, { value: "reject" }] },
          routing: { routes: { approve: "B", reject: "A" } },
        },
      },
      {
        name: "B",
        type: "agent",
        inputs: [],
        outputs: [{ name: "done", type: "boolean" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "G", port: "i" } },
    ],
  } as unknown as PipelineIR;
}

async function waitForOpenGate(
  db: DatabaseSync,
  taskId: string,
  stageName: string,
  excludeGateId?: string,
  timeoutMs = 5000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = db
      .prepare(
        "SELECT gate_id FROM gate_queue WHERE task_id=? AND stage_name=? AND answered_at IS NULL ORDER BY created_at DESC",
      )
      .all(taskId, stageName) as Array<{ gate_id: string }>;
    const fresh = rows.find((r) => r.gate_id !== excludeGateId);
    if (fresh) return fresh.gate_id;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `timeout waiting for open gate ${stageName} on ${taskId} (excluding ${excludeGateId ?? "<none>"})`,
  );
}

describe("runner — gate reject rollback", () => {
  it("rolls back to target, re-runs A, re-opens G, completes after second approve", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = rollbackIR();
    const vh = computeVersionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const broadcaster = new KernelNextBroadcaster();

    let aCalls = 0;
    let bCalls = 0;
    const handlers: StageHandlerMap = {
      A: () => {
        aCalls++;
        return { out: `attempt-${aCalls}` };
      },
      B: () => {
        bCalls++;
        return { done: true };
      },
    };

    const rollbackEvents: Array<{ type: string; data: unknown }> = [];
    broadcaster.subscribe("task-rb", (ev) => {
      if (ev.type === "stage_rolled_back") {
        rollbackEvents.push({ type: ev.type, data: ev.data });
      }
    });

    // Kick the run; it will block at gate G until we answer.
    const runPromise = runPipeline(
      {
        db,
        ir,
        taskId: "task-rb",
        versionHash: vh,
        handlers,
        broadcaster,
      },
      30_000,
    );

    // 1. Wait for G to open the first time.
    const firstGateId = await waitForOpenGate(db, "task-rb", "G");
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(0);

    // 2. Dispatch GATE_REJECTED with affectedStages = {A, G}.
    const dispatcher = taskRegistry.get("task-rb");
    expect(dispatcher).toBeDefined();
    dispatcher!.send({
      type: "GATE_REJECTED",
      gateId: firstGateId,
      stageName: "G",
      answer: "reject",
      targetStage: "A",
      affectedStages: ["A", "G"],
    });

    // 3. Wait for stage_rolled_back SSE event.
    const rbStart = Date.now();
    while (rollbackEvents.length === 0 && Date.now() - rbStart < 5000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(rollbackEvents).toHaveLength(1);
    const rbData = rollbackEvents[0]!.data as {
      fromGate: string;
      toStage: string;
      affectedStages: string[];
    };
    expect(rbData.fromGate).toBe("G");
    expect(rbData.toStage).toBe("A");
    expect(new Set(rbData.affectedStages)).toEqual(new Set(["A", "G"]));

    // 4. After rebuild, A should re-run and G should re-open as a NEW gate row.
    const secondGateId = await waitForOpenGate(db, "task-rb", "G", firstGateId);
    expect(secondGateId).not.toBe(firstGateId);
    expect(aCalls).toBe(2);
    expect(bCalls).toBe(0);

    // 5. Answer "approve" this time.
    const dispatcher2 = taskRegistry.get("task-rb");
    expect(dispatcher2).toBeDefined();
    dispatcher2!.send({
      type: "GATE_ANSWERED",
      gateId: secondGateId,
      stageName: "G",
      answer: "approve",
      targetStage: "B",
    });

    // 6. Pipeline should complete with B having run once.
    const result = await runPromise;
    expect(result.finalState).toBe("completed");
    expect(bCalls).toBe(1);
    expect(aCalls).toBe(2);

    db.close();
  }, 20_000);

  it("rejectFromGates cleared after approve: G answer replayed (not re-opened) on subsequent B retry rebuild", async () => {
    // Regression test for the bug where rejectFromGates was never cleared.
    //
    // Pipeline: A(agent) -> G(gate, approve->B, reject->A) -> B(script, retry backToStage=B)
    //
    // Scenario:
    //   1. G rejected  → rollback → A reruns, G reopens
    //   2. G approved  → B runs, B fails on first call
    //   3. B retry rebuild: backToStage=B → toReset={B}, so G stays in
    //      persistentFinalizedStages. G's answer must be REPLAYED.
    //
    // Before the fix: rejectFromGates still contained "G", so the replay
    // loop skipped it and G re-opened — user would have to approve again.
    // After the fix: rejectFromGates["G"] is cleared when G finalizes done,
    // so the replay loop synthesises GATE_ANSWERED and B proceeds.

    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);

    // Pipeline: A(agent) -> G(gate, approve->B, reject->A) -> B(script, retry backToStage=B)
    // B is a script stage whose backToStage=B, so toReset={B} only.
    // G stays in persistentFinalizedStages and must be replayed on retry.
    // Note: wire must include source:"stage" so gateUpstreamByGate correctly
    // identifies A as G's upstream (reject rollback target, not a forward gate target).
    const ir: PipelineIR = {
      name: "rb-retry",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [],
          outputs: [{ name: "out", type: "unknown" }],
          config: { promptRef: "p" },
        },
        {
          name: "G",
          type: "gate",
          inputs: [{ name: "i", type: "unknown" }],
          outputs: [],
          config: {
            question: { text: "approve or reject?", options: [{ value: "approve" }, { value: "reject" }] },
            routing: { routes: { approve: "B", reject: "A" } },
          },
        },
        {
          name: "B",
          type: "script",
          inputs: [],
          outputs: [{ name: "done", type: "boolean" }],
          // backToStage=B means toReset={B} only — G stays in
          // persistentFinalizedStages and G's answer should be replayed.
          config: { source: "registry", moduleId: "m", retry: { maxRetries: 1, backToStage: "B" } },
        },
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "out" }, to: { stage: "G", port: "i" } },
      ],
    } as unknown as PipelineIR;

    const vh = computeVersionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const broadcaster = new KernelNextBroadcaster();

    let aCalls = 0;
    let bCalls = 0;
    const handlers: StageHandlerMap = {
      A: () => {
        aCalls++;
        return { out: `a-${aCalls}` };
      },
      B: () => {
        bCalls++;
        // Fail on first call to trigger the retry rebuild; succeed on second.
        if (bCalls === 1) throw new Error("B first-call failure");
        return { done: true };
      },
    };

    const runPromise = runPipeline(
      { db, ir, taskId: "rb-retry", versionHash: vh, handlers, broadcaster },
      30_000,
    );
    // Step 1: Wait for G's first gate row.
    const firstGateId = await waitForOpenGate(db, "rb-retry", "G");
    expect(aCalls).toBe(1);

    // Step 2: Reject → rollback → A reruns, G reopens.
    const disp = taskRegistry.get("rb-retry");
    expect(disp).toBeDefined();
    disp!.send({
      type: "GATE_REJECTED",
      gateId: firstGateId,
      stageName: "G",
      answer: "reject",
      targetStage: "A",
      affectedStages: ["A", "G"],
    });

    // Step 3: Wait for G to reopen (a second, different gate row).
    const secondGateId = await waitForOpenGate(db, "rb-retry", "G", firstGateId);
    expect(secondGateId).not.toBe(firstGateId);
    expect(aCalls).toBe(2);

    // Step 4: Approve → B runs and fails on first call (retry rebuild).
    disp!.send({
      type: "GATE_ANSWERED",
      gateId: secondGateId,
      stageName: "G",
      answer: "approve",
      targetStage: "B",
    });

    // Step 5: Let the retry rebuild and final run complete.
    const result = await runPromise;

    expect(result.finalState).toBe("completed");
    expect(aCalls).toBe(2);
    // B ran at least twice: first call fails (retry rebuild), second succeeds.
    expect(bCalls).toBeGreaterThanOrEqual(2);

    // Critical assertion: no third gate_queue row for G (meaning the retry
    // rebuild replayed the approve answer instead of reopening the gate).
    const allGateRows = db
      .prepare("SELECT gate_id FROM gate_queue WHERE task_id='rb-retry' AND stage_name='G'")
      .all() as Array<{ gate_id: string }>;
    expect(allGateRows).toHaveLength(2); // first (rejected) + second (approved)

    db.close();
  }, 30_000);

  // Web3-tech-research dogfood (2026-04-28): a reject-rollback that
  // includes a fanout stage in affectedStages used to silently reuse
  // its prior fanout_element + fanout_aggregate outputs. Mechanism:
  // orchestrateFanoutStage's preservedByIdx query selects every
  // status='success' fanout_element row for the (task, stage) — the
  // mechanism was designed for hot-update migration where preserved
  // rows are valid. In a reject-rollback the upstream agent
  // regenerates with different inputs, so the preserved per-element
  // outputs are stale. The fix supersedes those rows on the reject
  // path so the second pass actually re-executes the executor on the
  // new input array.
  it("reject-rollback supersedes prior fanout_element + fanout_aggregate rows so the second pass actually re-executes", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    // Pipeline: producer (agent) -> verifier (script, fanout over claims)
    //           -> reviewer (gate, approve->summary, reject->producer)
    //           -> summary (agent)
    const ir: PipelineIR = {
      name: "fanout-reject",
      stages: [
        {
          name: "producer",
          type: "agent",
          inputs: [],
          outputs: [{ name: "claims", type: "string[]" }],
          config: { promptRef: "p" },
        },
        {
          name: "verifier",
          type: "script",
          inputs: [{ name: "claim", type: "string" }],
          outputs: [{ name: "verified", type: "string" }],
          fanout: { input: "claim" },
          config: {
            source: "registry",
            moduleId: "echo",
          },
        },
        {
          name: "reviewer",
          type: "gate",
          inputs: [{ name: "verifiedClaims", type: "string[]" }],
          outputs: [],
          config: {
            question: { text: "ok?", options: [{ value: "approve" }, { value: "reject" }] },
            routing: { routes: { approve: "summary", reject: "producer" } },
          },
        },
        {
          name: "summary",
          type: "agent",
          inputs: [],
          outputs: [{ name: "report", type: "string" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [
        { from: { source: "stage", stage: "producer", port: "claims" }, to: { stage: "verifier", port: "claim" } },
        { from: { source: "stage", stage: "verifier", port: "verified" }, to: { stage: "reviewer", port: "verifiedClaims" } },
      ],
    } as unknown as PipelineIR;
    const vh = computeVersionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });

    let producerCalls = 0;
    const handlers: StageHandlerMap = {
      producer: () => {
        producerCalls += 1;
        // First pass produces 3 claims; second pass produces 3 *different* claims.
        if (producerCalls === 1) return { claims: ["a1", "a2", "a3"] };
        return { claims: ["b1", "b2", "b3"] };
      },
      // Fanout element handler: the executor sees one element per call.
      verifier: (inputs: Record<string, unknown>) => ({ verified: `V(${inputs.claim as string})` }),
      summary: () => ({ report: "done" }),
    };

    const broadcaster = new KernelNextBroadcaster();
    const runPromise = runPipeline(
      { db, ir, taskId: "task-fanout-rb", versionHash: vh, handlers, broadcaster },
      30_000,
    );

    const firstGateId = await waitForOpenGate(db, "task-fanout-rb", "reviewer");
    expect(producerCalls).toBe(1);

    const fanoutAfterFirstPass = db.prepare(
      `SELECT count(*) AS n FROM stage_attempts
         WHERE task_id='task-fanout-rb' AND stage_name='verifier'
           AND kind='fanout_element' AND status='success'`,
    ).get() as { n: number };
    expect(fanoutAfterFirstPass.n).toBe(3);

    // Reject — affectedStages spans producer + verifier + reviewer + summary.
    const dispatcher = taskRegistry.get("task-fanout-rb");
    expect(dispatcher).toBeDefined();
    dispatcher!.send({
      type: "GATE_REJECTED",
      gateId: firstGateId,
      stageName: "reviewer",
      answer: "reject",
      targetStage: "producer",
      affectedStages: ["producer", "verifier", "reviewer", "summary"],
    });

    const secondGateId = await waitForOpenGate(db, "task-fanout-rb", "reviewer", firstGateId);
    expect(producerCalls).toBe(2);

    // Critical assertions:
    //   1. The 3 first-pass fanout_element rows were superseded.
    //   2. The second pass produced 3 fresh fanout_element rows (one per new claim).
    const supersededFanout = db.prepare(
      `SELECT count(*) AS n FROM stage_attempts
         WHERE task_id='task-fanout-rb' AND stage_name='verifier'
           AND kind='fanout_element' AND status='superseded'`,
    ).get() as { n: number };
    expect(supersededFanout.n).toBe(3);
    const succeededFanoutAfterSecondPass = db.prepare(
      `SELECT count(*) AS n FROM stage_attempts
         WHERE task_id='task-fanout-rb' AND stage_name='verifier'
           AND kind='fanout_element' AND status='success'`,
    ).get() as { n: number };
    expect(succeededFanoutAfterSecondPass.n).toBe(3);

    // The second-pass aggregate must reflect the NEW claims (b1/b2/b3),
    // not the old (a1/a2/a3). Read the most recent successful aggregate.
    const aggRow = db.prepare(
      `SELECT pv.value_json
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
        WHERE sa.task_id='task-fanout-rb' AND sa.stage_name='verifier'
          AND sa.kind='fanout_aggregate' AND sa.status='success'
          AND pv.port_name='verified'
        ORDER BY sa.attempt_idx DESC
        LIMIT 1`,
    ).get() as { value_json: string } | undefined;
    expect(aggRow).toBeDefined();
    const aggregated = JSON.parse(aggRow!.value_json);
    expect(aggregated).toEqual(["V(b1)", "V(b2)", "V(b3)"]);

    // Approve to let the run finish cleanly.
    dispatcher!.send({
      type: "GATE_ANSWERED",
      gateId: secondGateId,
      stageName: "reviewer",
      answer: "approve",
      targetStage: "summary",
    });
    const result = await runPromise;
    expect(result.finalState).toBe("completed");

    db.close();
  }, 30_000);
});
