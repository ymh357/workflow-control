// BUG-2 regression: the per-run wall-clock timeout must not count time
// spent waiting for a human gate answer. Before the fix the runner used
// a single setTimeout(fn, timeoutMs) whose firing time was fixed at task
// start — so a human taking longer than timeoutMs to reply would always
// time the task out even if actual pipeline work was near-zero.
//
// After the fix the runner clears its timer on gate entry and rearms it
// with the remaining budget when every in-flight gate has been answered,
// so only *active* pipeline time counts.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import { KernelService } from "../mcp/kernel.js";
import { taskRegistry } from "./task-registry.js";
import { PipelineIRSchema } from "../ir/schema.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function parseIR(raw: unknown): PipelineIR {
  return PipelineIRSchema.parse(raw) as unknown as PipelineIR;
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function gatePipeline(): PipelineIR {
  return parseIR({
    name: "gate-wall-clock",
    externalInputs: [{ name: "seed", type: "string" }],
    stages: [
      {
        name: "entry", type: "agent",
        inputs: [{ name: "seed", type: "string" }],
        outputs: [{ name: "payload", type: "string" }],
        config: { promptRef: "p" },
      },
      {
        name: "gate1", type: "gate",
        inputs: [{ name: "__gate_signal", type: "unknown" }],
        outputs: [],
        config: {
          question: { text: "?" },
          routing: { routes: { approve: "after", reject: "entry" } },
        },
      },
      {
        name: "after", type: "agent",
        inputs: [{ name: "payload", type: "string" }],
        outputs: [{ name: "done", type: "string" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { source: "external", port: "seed" }, to: { stage: "entry", port: "seed" } },
      { from: { stage: "entry", port: "payload" }, to: { stage: "gate1", port: "__gate_signal" } },
      { from: { stage: "entry", port: "payload" }, to: { stage: "after", port: "payload" } },
    ],
  });
}

function answerGateAfter({
  db, svc, taskId, answer, delayMs,
}: {
  db: DatabaseSync;
  svc: KernelService;
  taskId: string;
  answer: string;
  delayMs: number;
}): Promise<void> {
  return (async () => {
    const pollDeadline = Date.now() + 10_000;
    while (Date.now() < pollDeadline) {
      const row = db.prepare(
        `SELECT gate_id FROM gate_queue
         WHERE task_id = ? AND answered_at IS NULL
         ORDER BY created_at ASC LIMIT 1`,
      ).get(taskId) as { gate_id: string } | undefined;
      if (row) {
        // Once the gate is open, hold for `delayMs` to simulate human
        // think time before answering.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        const r = svc.answerGate(row.gate_id, answer);
        if (r.ok) {
          const dispatcher = taskRegistry.get(r.taskId);
          dispatcher?.send({
            type: "GATE_ANSWERED",
            gateId: r.gateId,
            stageName: r.stageName,
            answer: r.answer,
            targetStage: r.targetStage,
          });
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
}

describe("BUG-2: wall-clock timeout pauses during gate wait", () => {
  it("gate held longer than timeoutMs still completes when stages are fast", { timeout: 15_000 }, async () => {
    const db = makeDb();
    try {
      const ir = gatePipeline();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        entry: () => ({ payload: "data" }),
        after: () => ({ done: "yes" }),
      };

      const svc = new KernelService(db, { skipTypeCheck: true });

      // timeoutMs = 400ms; hold the gate for 900ms (> timeoutMs) before
      // answering. Active work (entry + after mock handlers) is ~0ms so
      // the task must complete naturally if the budget pauses on gate.
      const answerer = answerGateAfter({
        db, svc, taskId: "t-bug2",
        answer: "approve", delayMs: 900,
      });

      const result = await runPipeline({
        db, ir, taskId: "t-bug2", versionHash: hash,
        handlers, seedValues: { seed: "start" },
      }, 400);
      await answerer;

      expect(result.finalState).toBe("completed");

      const fin = db.prepare(
        `SELECT final_state, reason FROM task_finals WHERE task_id = 't-bug2'`,
      ).get() as { final_state: string; reason: string } | undefined;
      expect(fin).toBeDefined();
      expect(fin!.final_state).toBe("completed");
      expect(fin!.reason).toBe("natural");
    } finally {
      db.close();
    }
  });

  it("active execution time still counts: a slow non-gate stage triggers timeout", { timeout: 15_000 }, async () => {
    // Negative control. If the fix incorrectly paused the budget on
    // *any* delay (not just gate-wait), this test would spuriously pass.
    // We run the same pipeline but slow the `entry` handler past the
    // timeout budget BEFORE the gate opens, so no pause can save us.
    const db = makeDb();
    try {
      const ir = gatePipeline();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const handlers: StageHandlerMap = {
        entry: async () => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          return { payload: "data" };
        },
        after: () => ({ done: "yes" }),
      };

      // No answerer needed — entry handler exhausts the budget before
      // the gate ever opens, so there is nothing to answer. Keeping the
      // test focused on the negative control (active execution time
      // still counts) instead of racing an answerer against timeout.

      await expect(runPipeline({
        db, ir, taskId: "t-bug2-neg", versionHash: hash,
        handlers, seedValues: { seed: "start" },
      }, 200)).rejects.toThrow(/timeout/i);

      const fin = db.prepare(
        `SELECT final_state, reason FROM task_finals WHERE task_id = 't-bug2-neg'`,
      ).get() as { final_state: string; reason: string } | undefined;
      expect(fin).toBeDefined();
      expect(fin!.final_state).toBe("failed");
      expect(fin!.reason).toBe("timeout");
    } finally {
      db.close();
    }
  });
});
