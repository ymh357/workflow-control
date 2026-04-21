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
          question: { text: "approve or reject?", options: ["approve", "reject"] },
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
});
