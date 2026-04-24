// Minimal reproduction for C6's pipeline-generator E2E timeout.
// Strategy: add one layer at a time to find what combination deadlocks.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function makeDb() { const db = new DatabaseSync(":memory:"); initKernelNextSchema(db); return db; }

describe("retry debug", () => {
  // Layer 1: single agent + script with retry. No gate. Already covered
  // by C5 tests but re-verify here as baseline.
  it("L1: A(agent) -> S(script,retry) - already covered", async () => {
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "L1",
        externalInputs: [],
        stages: [
          { name: "A", type: "agent", inputs: [],
            outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
          { name: "S", type: "script",
            inputs: [{ name: "x", type: "number" }],
            outputs: [{ name: "r", type: "boolean" }],
            config: { moduleId: "m", retry: { maxRetries: 1, backToStage: "A" } } },
        ],
        wires: [{ from: { source: "stage", stage: "A", port: "x" }, to: { stage: "S", port: "x" } }],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
      let sCalls = 0;
      const handlers: StageHandlerMap = {
        A: () => ({ x: 10 }),
        S: () => { sCalls++; if (sCalls === 1) throw new Error("boom"); return { r: true }; },
      };
      const result = await runPipeline(
        { db, ir, taskId: "L1", versionHash: hash, handlers },
        10_000,
      );
      expect(result.finalState).toBe("completed");
      expect(sCalls).toBeGreaterThanOrEqual(2);
    } finally { db.close(); }
  }, 15_000);

  // Layer 2: add a gate UPSTREAM of both A and S.
  // G -> A -> S(retry backTo=A). Gate upstream of the retry closure.
  // Question: does retry work when a gate is in the run's history but
  // NOT in the retry closure?
  // L1.5: print contextAtRetry and observe what happens after rebuild
  // when there's NO gate but an extra upstream stage.
  it("L1.5: UP -> A -> S(retry) - two upstream stages, one of which has to survive rebuild", async () => {
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "L1_5",
        externalInputs: [],
        stages: [
          { name: "UP", type: "agent", inputs: [],
            outputs: [{ name: "k", type: "number" }], config: { promptRef: "p" } },
          { name: "A", type: "agent",
            inputs: [{ name: "k", type: "number" }],
            outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
          { name: "S", type: "script",
            inputs: [{ name: "x", type: "number" }],
            outputs: [{ name: "r", type: "boolean" }],
            config: { moduleId: "m", retry: { maxRetries: 1, backToStage: "A" } } },
        ],
        wires: [
          { from: { source: "stage", stage: "UP", port: "k" }, to: { stage: "A", port: "k" } },
          { from: { source: "stage", stage: "A", port: "x" }, to: { stage: "S", port: "x" } },
        ],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
      let sCalls = 0;
      let upCalls = 0;
      let aCalls = 0;
      const handlers: StageHandlerMap = {
        UP: () => { upCalls++; return { k: 7 }; },
        A: () => { aCalls++; return { x: 10 }; },
        S: () => { sCalls++; if (sCalls === 1) throw new Error("boom"); return { r: true }; },
      };
      const result = await runPipeline(
        { db, ir, taskId: "L1_5", versionHash: hash, handlers },
        10_000,
      );
      console.log(`upCalls=${upCalls} aCalls=${aCalls} sCalls=${sCalls}`);
      expect(result.finalState).toBe("completed");
      expect(sCalls).toBeGreaterThanOrEqual(2);
      // UP is upstream of backToStage=A, so UP is NOT in the retry closure.
      // UP should run exactly once (its output carries into rebuild).
      // A should run twice (initial + retry re-run).
      expect(upCalls).toBe(1);  // critical: UP must NOT re-run
      expect(aCalls).toBeGreaterThanOrEqual(2);
    } finally { db.close(); }
  }, 15_000);

  it("L2: G(gate) -> A -> S(retry) - gate upstream, not in retry closure", async () => {
    const db = makeDb();
    try {
      const ir: PipelineIR = {
        name: "L2",
        externalInputs: [],
        stages: [
          { name: "SRC", type: "agent", inputs: [],
            outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
          { name: "G", type: "gate",
            inputs: [{ name: "x", type: "number" }], outputs: [],
            config: {
              question: { text: "go?", options: [{ value: "yes" }] },
              routing: { routes: { yes: "A" } },
            } },
          { name: "A", type: "agent", inputs: [],
            outputs: [{ name: "y", type: "number" }], config: { promptRef: "p" } },
          { name: "S", type: "script",
            inputs: [{ name: "y", type: "number" }],
            outputs: [{ name: "r", type: "boolean" }],
            config: { moduleId: "m", retry: { maxRetries: 1, backToStage: "A" } } },
        ],
        wires: [
          { from: { source: "stage", stage: "SRC", port: "x" }, to: { stage: "G", port: "x" } },
          { from: { source: "stage", stage: "A", port: "y" }, to: { stage: "S", port: "y" } },
        ],
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
      let sCalls = 0;
      const handlers: StageHandlerMap = {
        SRC: () => ({ x: 1 }),
        A: () => ({ y: 2 }),
        S: () => { sCalls++; if (sCalls === 1) throw new Error("boom"); return { r: true }; },
      };

      const { KernelService } = await import("../mcp/kernel.js");
      const { taskRegistry } = await import("./task-registry.js");

      const runPromise = runPipeline(
        { db, ir, taskId: "L2", versionHash: hash, handlers },
        10_000,
      );

      const kernel = new KernelService(db, { skipTypeCheck: true });
      let gateId: string | undefined;
      for (let i = 0; i < 100 && !gateId; i++) {
        const gates = kernel.listGates({ taskId: "L2", answered: false });
        if (gates.length > 0) gateId = gates[0]!.gateId;
        else await new Promise(r => setTimeout(r, 20));
      }
      expect(gateId).toBeDefined();

      const answer = kernel.answerGate(gateId!, "yes");
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;

      const dispatcher = taskRegistry.get("L2");
      expect(dispatcher).toBeDefined();
      dispatcher!.send({
        type: "GATE_ANSWERED",
        gateId: answer.gateId, stageName: answer.stageName,
        answer: answer.answer, targetStage: answer.targetStage,
      });

      const result = await runPromise;
      expect(result.finalState).toBe("completed");
      expect(sCalls).toBeGreaterThanOrEqual(2);
    } finally { db.close(); }
  }, 15_000);
});
