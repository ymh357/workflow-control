// Phase 6 bug repro: two-stage linear pipeline (greet → echoBack), where
// upstream stage has inputs: [] and downstream reads via wires. Observed
// in prod run 2026-04-23 (taskId smoke-test-1776877365350-d4192d2a):
// run returned finalState=completed, but only 1 stage executed.
// See docs/phase6-usage-log.md Bug #1.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

// Mirror of builtin-pipelines/smoke-test/pipeline.ir.json.
function smokeIR(): PipelineIR {
  return {
    name: "smoke-test-repro",
    stages: [
      {
        name: "echoBack", type: "agent",
        inputs: [{ name: "note", type: "string" }, { name: "subject", type: "string" }],
        outputs: [{ name: "message", type: "string" }],
        config: { promptRef: "system/echo-back" },
      },
      {
        name: "greet", type: "agent",
        inputs: [],
        outputs: [{ name: "note", type: "string" }, { name: "subject", type: "string" }],
        config: { promptRef: "system/greet" },
      },
    ],
    wires: [
      { from: { stage: "greet", port: "note" }, to: { stage: "echoBack", port: "note" } },
      { from: { stage: "greet", port: "subject" }, to: { stage: "echoBack", port: "subject" } },
    ],
  };
}

describe("Phase 6 bug repro: linear two-stage greet → echoBack", () => {
  it("both stages execute when greet has inputs: [] and echoBack reads via wires", async () => {
    const db = makeDb();
    try {
      const ir = smokeIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      let greetCalls = 0;
      let echoCalls = 0;
      const handlers: StageHandlerMap = {
        greet: () => {
          greetCalls++;
          return { note: "hello", subject: "world" };
        },
        echoBack: (inputs) => {
          echoCalls++;
          return { message: `${inputs.note} / ${inputs.subject}` };
        },
      };

      const result = await runPipeline({
        db, ir, taskId: "t1", versionHash: hash, handlers,
      });

      expect(result.finalState).toBe("completed");
      expect(greetCalls).toBe(1);
      // THE BUG: echoBack never ran.
      expect(echoCalls).toBe(1);
      expect(result.portValues["echoBack.message"]).toBe("hello / world");
    } finally {
      db.close();
    }
  });
});
