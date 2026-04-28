// Stage-level integration test for the Bug 8b kernel guard.
//
// Drives the pipeline-modifier IR's `validatePatch` script stage
// directly via ScriptStageExecutor + the real BUILTIN_SCRIPT_MODULES
// registry. This is the layer between pure-unit tests on the script
// module (builtin-scripts/index.test.ts) and the full e2e harness
// (e2e.happy-path.test.ts).
//
// Why not a runner-level e2e? When validatePatch enters its `error`
// final, the parallel pipeline machine's `applying` region keeps
// waiting for inbound wires that the failed region never wrote, so
// `parallel.onDone` does not fire. That is a known property of the
// runner's parallel-region semantics (see runner.test.ts comment at
// L195-198: "XState parallel onDone fires even when a region ends in
// its `error` final — so the XState value transitions to 'completed'");
// it works in unit-runner tests where the failed stage has no
// downstream stages, but pipeline-modifier's `applying` is downstream
// of `validatePatch`. End-to-end behaviour gates on cross-region
// cancellation that the runner does not yet provide; for this
// session's "fix Bug 8b" scope we lock the contract at the stage
// integration layer.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { PortRuntime, type EventDispatcher } from "../../kernel-next/runtime/port-runtime.js";
import { ScriptStageExecutor } from "../../kernel-next/runtime/script-executor.js";
import { TrivialScriptModuleResolver } from "../../kernel-next/runtime/script-module-resolver.js";
import { BUILTIN_SCRIPT_MODULES } from "../../kernel-next/builtin-scripts/index.js";
import { loadBuiltinPipelineIR } from "../../kernel-next/runtime/load-builtin-pipeline.js";
import type { ExecuteStageArgs } from "../../kernel-next/runtime/executor.js";

const inert: EventDispatcher = { send: () => { /* noop */ } };

function buildArgs(
  taskId: string,
  portRuntime: PortRuntime,
  portValues: Record<string, unknown>,
): ExecuteStageArgs {
  const modifier = loadBuiltinPipelineIR("pipeline-modifier");
  return {
    ir: modifier.ir,
    stageName: "validatePatch",
    taskId,
    versionHash: "vh-test",
    portValues,
    handlers: {},
    portRuntime,
  };
}

describe("pipeline-modifier validatePatch stage (Bug 8b kernel guard)", () => {
  it("FAILS when genPatch's outputs match the silent-no-op pattern", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    try {
      const portRuntime = new PortRuntime(db, inert);
      const exec = new ScriptStageExecutor({
        resolver: new TrivialScriptModuleResolver({ modules: { ...BUILTIN_SCRIPT_MODULES } }),
      });

      // Wire upstream port_values exactly as the pipeline machine would
      // place them after analyzeGap + genPatch. The keys mirror the IR
      // wires defined in pipeline.ir.json:
      //   analyzeGap.gapAnalysis  -> validatePatch.gapAnalysis
      //   genPatch.patch          -> validatePatch.patch
      //   genPatch.dryRunVerdict  -> validatePatch.dryRunVerdict
      const args = buildArgs("t-bug8b-1", portRuntime, {
        "analyzeGap.gapAnalysis": {
          intendedChanges: [
            { stage: "X", kind: "modify", description: "rename promptRef" },
          ],
        },
        "genPatch.patch": { ops: [] },
        "genPatch.dryRunVerdict": "safe",
      });
      const result = await exec.executeStage(args);

      expect(result.status).toBe("error");
      if (result.status !== "error") throw new Error("expected error result");
      expect(result.error).toMatch(/Bug 8b guard:/);

      // No output port writes leaked through.
      const writes = portRuntime.readWritesForAttempt(result.attemptId);
      expect(writes).toEqual([]);

      // Stage attempt row is recorded with status='error'. This is the
      // signal `applying` would key off if it could subscribe to upstream
      // failure (today it cannot — see file header).
      const row = db
        .prepare(`SELECT status FROM stage_attempts WHERE attempt_id = ?`)
        .get(result.attemptId) as { status: string };
      expect(row.status).toBe("error");

      // The full guard message is captured in script_execution_details.
      const sed = db
        .prepare(
          `SELECT termination_reason, error_message FROM script_execution_details
           WHERE attempt_id = ?`,
        )
        .get(result.attemptId) as
        | { termination_reason: string; error_message: string | null }
        | undefined;
      expect(sed).toBeDefined();
      expect(sed!.termination_reason).toBe("error");
      expect(sed!.error_message ?? "").toMatch(/Bug 8b guard:/);
    } finally {
      db.close();
    }
  });

  it("PASSES through the pipeline-modifier IR when genPatch produces a real patch", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    try {
      const portRuntime = new PortRuntime(db, inert);
      const exec = new ScriptStageExecutor({
        resolver: new TrivialScriptModuleResolver({ modules: { ...BUILTIN_SCRIPT_MODULES } }),
      });

      const realPatch = {
        ops: [
          {
            op: "update_stage_config",
            stage: "X",
            configPatch: { promptRef: "system/x-v2" },
          },
        ],
      };
      const args = buildArgs("t-bug8b-pass", portRuntime, {
        "analyzeGap.gapAnalysis": {
          intendedChanges: [{ stage: "X", kind: "modify", description: "rename" }],
        },
        "genPatch.patch": realPatch,
        "genPatch.dryRunVerdict": "safe",
      });
      const result = await exec.executeStage(args);

      expect(result.status).toBe("success");

      // Stage wrote both passthrough output ports.
      const writes = portRuntime.readWritesForAttempt(result.attemptId);
      const byPort = new Map(writes.map((w) => [w.port, w.value]));
      expect(byPort.get("patch")).toEqual(realPatch);
      expect(byPort.get("dryRunVerdict")).toBe("safe");
    } finally {
      db.close();
    }
  });

  it("PASSES through when intent is empty (legitimate description-only no-op)", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    try {
      const portRuntime = new PortRuntime(db, inert);
      const exec = new ScriptStageExecutor({
        resolver: new TrivialScriptModuleResolver({ modules: { ...BUILTIN_SCRIPT_MODULES } }),
      });

      const args = buildArgs("t-bug8b-noop", portRuntime, {
        "analyzeGap.gapAnalysis": { intendedChanges: [] },
        "genPatch.patch": { ops: [] },
        "genPatch.dryRunVerdict": "safe",
      });
      const result = await exec.executeStage(args);

      expect(result.status).toBe("success");
      const writes = portRuntime.readWritesForAttempt(result.attemptId);
      const byPort = new Map(writes.map((w) => [w.port, w.value]));
      expect(byPort.get("patch")).toEqual({ ops: [] });
      expect(byPort.get("dryRunVerdict")).toBe("safe");
    } finally {
      db.close();
    }
  });

  it("PASSES through when verdict is unsafe (agent surfaced the failure)", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    try {
      const portRuntime = new PortRuntime(db, inert);
      const exec = new ScriptStageExecutor({
        resolver: new TrivialScriptModuleResolver({ modules: { ...BUILTIN_SCRIPT_MODULES } }),
      });

      const args = buildArgs("t-bug8b-unsafe", portRuntime, {
        "analyzeGap.gapAnalysis": {
          intendedChanges: [{ stage: "X", kind: "modify", description: "rename" }],
        },
        "genPatch.patch": { ops: [] },
        "genPatch.dryRunVerdict": "unsafe",
      });
      const result = await exec.executeStage(args);

      expect(result.status).toBe("success");
      const writes = portRuntime.readWritesForAttempt(result.attemptId);
      const byPort = new Map(writes.map((w) => [w.port, w.value]));
      expect(byPort.get("dryRunVerdict")).toBe("unsafe");
    } finally {
      db.close();
    }
  });
});
