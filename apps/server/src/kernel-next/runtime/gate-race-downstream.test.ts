// P6-10 redux: reproduce the genuine race between a gate answer and
// the upstream stage still writing later output ports.
//
// Observed in Phase 6 run #8-#9 (Pipeline Generator):
//   - analyzing writes ~16 output ports via successive write_port tool
//     calls. The first write triggers the gate (whose __gate_signal
//     wire only reads analyzing.pipelineName).
//   - user approves the gate BEFORE analyzing has written every port.
//   - genSkeleton has inbound wires on more analyzing ports than just
//     pipelineName. When GATE_ANSWERED reaches genSkeleton's waiting
//     state, wireDelivers(all inbound) is false → priority-2 transition
//     guard false → descendant transition does NOT fire.
//   - XState v5 consumes the event at the descendant region, so the
//     root-level on.GATE_ANSWERED assign NEVER runs.
//   - gateAuthorizedTargets stays empty. Later PORT_WRITTEN events
//     (analyzing's remaining ports) re-evaluate always.executing
//     guard, which requires gateAuthorizedTargets.includes('genSkeleton')
//     — false → genSkeleton stays waiting forever.
//
// The mock MockStageExecutor doesn't exhibit this because it writes
// all ports atomically after handler return. This test uses a custom
// StageExecutor that writes the "gate trigger" port first, waits for
// an external "gate answered" signal, then writes remaining ports.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import { KernelService } from "../mcp/kernel.js";
import { taskRegistry } from "./task-registry.js";
import { PipelineIRSchema } from "../ir/schema.js";
import type { PipelineIR } from "../ir/schema.js";
import type {
  StageExecutor,
  ExecuteStageArgs,
  ExecuteStageResult,
} from "./executor.js";

function parseIR(raw: unknown): PipelineIR {
  return PipelineIRSchema.parse(raw) as unknown as PipelineIR;
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

// Shape mirrors pipeline-generator awaitingConfirm: upstream `A` has
// TWO outputs (trigger + payload); the gate's __gate_signal wire
// only reads `A.trigger`; the downstream post-gate stage reads
// `A.payload`. Gate approve happens AFTER A.trigger is written but
// BEFORE A.payload is written.
function raceIR(): PipelineIR {
  return parseIR({
    name: "gate-race",
    externalInputs: [{ name: "seed", type: "string" }],
    stages: [
      {
        name: "A", type: "agent",
        inputs: [{ name: "seed", type: "string" }],
        outputs: [
          { name: "trigger", type: "string" },
          { name: "payload", type: "string" },
        ],
        config: { promptRef: "p" },
      },
      {
        name: "gate1", type: "gate",
        inputs: [{ name: "__gate_signal", type: "unknown" }],
        outputs: [],
        config: {
          question: { text: "?" },
          routing: { routes: { approve: "after", reject: "A" } },
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
      { from: { source: "external", port: "seed" }, to: { stage: "A", port: "seed" } },
      { from: { stage: "A", port: "trigger" }, to: { stage: "gate1", port: "__gate_signal" } },
      { from: { stage: "A", port: "payload" }, to: { stage: "after", port: "payload" } },
    ],
  });
}

/**
 * Custom executor that models the race:
 *   - For stage A: write trigger port, wait for externalSignal, then
 *     write payload port. This splits A's port writes across the gate
 *     approve timeline.
 *   - For stage `after`: write done trivially.
 */
class RaceExecutor implements StageExecutor {
  private afterRan = false;

  constructor(private readonly gateApprovedPromise: Promise<void>) {}

  get didRunAfter(): boolean { return this.afterRan; }

  async executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult> {
    const { ir, stageName, taskId, versionHash: vh, portRuntime } = args;
    const stage = ir.stages.find((s) => s.name === stageName);
    if (!stage || stage.type === "gate") {
      throw new Error(`RaceExecutor: unexpected stage ${stageName}`);
    }
    const { attemptId, attemptIdx } = portRuntime.startAttempt({
      taskId, versionHash: vh, stageName,
    });

    if (stageName === "A") {
      // 1) write trigger (fires the gate).
      portRuntime.writePort({ attemptId, stageName, portName: "trigger", value: "go" });
      // 2) wait for external approve.
      await this.gateApprovedPromise;
      // 3) write payload (genSkeleton/after now has all inputs).
      portRuntime.writePort({ attemptId, stageName, portName: "payload", value: "done" });
      portRuntime.finishAttempt(attemptId, "success");
      return { attemptId, attemptIdx, status: "success" };
    }

    if (stageName === "after") {
      this.afterRan = true;
      portRuntime.writePort({ attemptId, stageName, portName: "done", value: "yes" });
      portRuntime.finishAttempt(attemptId, "success");
      return { attemptId, attemptIdx, status: "success" };
    }

    portRuntime.finishAttempt(attemptId, "error", `unknown stage ${stageName}`);
    return { attemptId, attemptIdx, status: "error", error: `unknown stage ${stageName}` };
  }
}

describe("P6-10 race: gate approve before upstream finishes writing all ports", () => {
  it("downstream stage must still activate when analyzing keeps writing after GATE_ANSWERED", { timeout: 15_000 }, async () => {
    const db = makeDb();
    try {
      const ir = raceIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      let approveResolve!: () => void;
      const approved = new Promise<void>((res) => { approveResolve = res; });
      const executor = new RaceExecutor(approved);

      const svc = new KernelService(db, { skipTypeCheck: true });

      // Auto-approve loop. Mirrors the HTTP /gates/:id/answer route:
      // persist answer + dispatch GATE_ANSWERED into the machine via
      // taskRegistry. Then RELEASE the upstream executor so it keeps
      // writing remaining ports.
      const autoApprover = (async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const row = db.prepare(
            `SELECT gate_id FROM gate_queue
             WHERE task_id = 't-race' AND answered_at IS NULL
             ORDER BY created_at ASC LIMIT 1`,
          ).get() as { gate_id: string } | undefined;
          if (row) {
            const r = svc.answerGate(row.gate_id, "approve");
            if (r.ok) {
              const dispatcher = taskRegistry.get(r.taskId);
              dispatcher?.send({
                type: "GATE_ANSWERED",
                gateId: r.gateId,
                stageName: r.stageName,
                answer: r.answer,
                targetStage: r.targetStage,
              });
              // Now unblock A so it writes `payload`.
              approveResolve();
            }
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })();

      const result = await runPipeline({
        db, ir, taskId: "t-race", versionHash: hash,
        executor,
        handlers: {}, // unused — executor supersedes handler lookup
        seedValues: { seed: "go" },
      }, 12_000);
      await autoApprover;

      expect(result.finalState).toBe("completed");
      expect(executor.didRunAfter).toBe(true);

      const fin = db.prepare(
        `SELECT final_state FROM task_finals WHERE task_id = 't-race'`,
      ).get() as { final_state: string } | undefined;
      expect(fin?.final_state).toBe("completed");
    } finally {
      db.close();
    }
  });
});
