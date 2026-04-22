// P6-10 regression: gate-approve activates downstream stage.
//
// Phase 6 runs #5 and #6 observed awaitingConfirm->gate answer but
// downstream (genSkeleton) never activated. Turned out to be
// environment-specific (tsx watch reload dropping taskRegistry, not
// a compiler or runtime bug); this test nails down the happy-path
// compilation + execution shape so the same mis-categorisation can't
// silently reappear.
//
// Lesson encoded by this test: hand-built PipelineIR fixtures MUST go
// through PipelineIRSchema.parse(). Without it, wire.from lacks the
// default source='stage' that the compiler's gateUpstreamByGate map
// relies on — and every gate route target (including rollback targets
// that should be excluded from gateRoutedTargets) gets classified as
// gateRouted=true, starving the forward execution path.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import { KernelService } from "../mcp/kernel.js";
import { taskRegistry } from "./task-registry.js";
import { compileIRToMachine } from "../compiler/ir-to-machine.js";
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
    name: "gate-resume",
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
          // reject->entry classifies entry as a rollback target (gate
          // upstream), so entry is NOT added to gateRoutedTargets. Only
          // `after` is gate-routed.
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

describe("P6-10 compile-time shape", () => {
  it("entry is forward (gateRouted=false), after is gate target (gateRouted=true)", () => {
    const ir = gatePipeline();
    const compiled = compileIRToMachine(ir, { taskId: "t-diag" });
    const meta = compiled.stageMeta;
    expect(meta.get("entry")?.gateRouted).toBe(false);
    expect(meta.get("after")?.gateRouted).toBe(true);
    expect(meta.get("gate1")?.gateRouted).toBe(false);
  });
});

describe("P6-10 single-stage pre-check (external -> one agent)", () => {
  it("entry activates on seed write", async () => {
    const db = makeDb();
    try {
      const ir = parseIR({
        name: "tiny",
        externalInputs: [{ name: "seed", type: "string" }],
        stages: [
          {
            name: "entry", type: "agent",
            inputs: [{ name: "seed", type: "string" }],
            outputs: [{ name: "payload", type: "string" }],
            config: { promptRef: "p" },
          },
        ],
        wires: [
          { from: { source: "external", port: "seed" }, to: { stage: "entry", port: "seed" } },
        ],
      }) as PipelineIR;
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
      let ran = false;
      const handlers: StageHandlerMap = {
        entry: (inputs) => { ran = true; return { payload: String(inputs.seed) }; },
      };
      const r = await runPipeline({
        db, ir, taskId: "t-tiny", versionHash: hash, handlers,
        seedValues: { seed: "hello" },
      }, 5_000);
      expect(r.finalState).toBe("completed");
      expect(ran).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("P6-10 end-to-end: gate approve activates downstream stage", () => {
  it("runPipeline with an approve-answered gate completes both pre- and post-gate stages", { timeout: 15_000 }, async () => {
    const db = makeDb();
    try {
      const ir = gatePipeline();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      let afterRan = false;
      const handlers: StageHandlerMap = {
        entry: () => ({ payload: "data" }),
        after: () => { afterRan = true; return { done: "yes" }; },
      };

      const svc = new KernelService(db, { skipTypeCheck: true });

      // Mirror the HTTP /gates/:id/answer route: persist answer via
      // svc.answerGate, then dispatch GATE_ANSWERED into the machine
      // via taskRegistry. Without the dispatch step the machine never
      // transitions past the gate.
      const autoApprover = (async () => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const row = db.prepare(
            `SELECT gate_id FROM gate_queue
             WHERE task_id = 't-gate1' AND answered_at IS NULL
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
            }
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })();

      const result = await runPipeline({
        db, ir, taskId: "t-gate1", versionHash: hash,
        handlers, seedValues: { seed: "start" },
      }, 12_000);
      await autoApprover;

      expect(result.finalState).toBe("completed");
      expect(afterRan).toBe(true);

      const fin = db.prepare(
        `SELECT final_state, reason FROM task_finals WHERE task_id = 't-gate1'`,
      ).get() as { final_state: string; reason: string } | undefined;
      expect(fin).toBeDefined();
      expect(fin!.final_state).toBe("completed");
      expect(fin!.reason).toBe("natural");
    } finally {
      db.close();
    }
  });
});
