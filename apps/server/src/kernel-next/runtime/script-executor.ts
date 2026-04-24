// Script stage executor — runs ScriptStage-typed stages via a
// userland-supplied script-module resolver.
//
// Contract (terminal design §3.2):
//   1. Start a stage_attempt.
//   2. Gather inputs + record reads (same as mock/real).
//   3. Resolve config.moduleId to a ScriptModule (userland).
//   4. Invoke module.run(inputs, ctx); await result.
//   5. For each declared output port whose name appears in the result,
//      writePort (lineage + PORT_WRITTEN). Extra keys are ignored.
//   6. Finish attempt success / error.
//
// Stage-type narrowing: this executor throws at step 1 if given anything
// other than a ScriptStage. Callers should route via CompositeStageExecutor
// rather than this directly.

import type { ScriptStage } from "../ir/schema.js";
import type {
  ExecuteStageArgs,
  ExecuteStageResult,
  StageExecutor,
} from "./executor.js";
import type { ScriptModuleResolver } from "./script-module-resolver.js";
import { openScriptExecutionRecordWriter } from "./script-execution-record-writer.js";
import { loadTaskEnvValues } from "./task-env-values.js";

export interface ScriptStageExecutorOptions {
  resolver: ScriptModuleResolver;
}

export class ScriptStageExecutor implements StageExecutor {
  private readonly resolver: ScriptModuleResolver;

  constructor(options: ScriptStageExecutorOptions) {
    this.resolver = options.resolver;
  }

  async executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult> {
    const { ir, stageName, taskId, versionHash, portValues, portRuntime, fanoutElementIdx } = args;

    const stage = ir.stages.find((s) => s.name === stageName);
    if (!stage) throw new Error(`Stage '${stageName}' not in IR`);
    if (stage.type !== "script") {
      throw new Error(
        `ScriptStageExecutor received stage '${stageName}' of type '${stage.type}'. ` +
          `Route via CompositeStageExecutor (see runtime/composite-executor.ts).`,
      );
    }
    const scriptStage: ScriptStage = stage;

    // 1. Start attempt. Forward fanoutElementIdx (B17 full) so fanout_element
    //    rows get their idx populated; no-op on non-fanout attempts.
    const { attemptId, attemptIdx } = portRuntime.startAttempt({
      taskId, versionHash, stageName, fanoutElementIdx,
    });

    // 2. Gather inputs from wire sources; record reads.
    const inputs: Record<string, unknown> = {};
    for (const p of scriptStage.inputs) {
      const wire = ir.wires.find(
        (w) => w.to.stage === stageName && w.to.port === p.name,
      );
      if (!wire) continue;
      // Bridge: Task 1.2 introduced WireSource. Task 1.3+ will resolve
      // external sources against the externalInputs namespace.
      const fromStage = wire.from.source === "external" ? "__external__" : wire.from.stage;
      const srcKey = `${fromStage}.${wire.from.port}`;
      const value = portValues[srcKey];
      inputs[p.name] = value;
      portRuntime.recordRead({ attemptId, stageName, portName: p.name, value });
    }

    // 2b. Sidecar: open the script_execution_details writer BEFORE module
    //     resolution so even a module-not-found failure leaves a row for
    //     post-mortem tooling. Never throws; returns a no-op on DB error.
    const moduleId = scriptStage.config.moduleId;
    const writer = openScriptExecutionRecordWriter(portRuntime.getDb(), {
      attemptId,
      moduleId,
      inputs,
    });

    // 3. Resolve the script module.
    const mod = this.resolver.resolve(moduleId);
    if (!mod) {
      const message = `Script module '${moduleId}' not found for stage '${stageName}'`;
      writer.close({
        terminationReason: "module_not_found",
        errorMessage: message,
      });
      portRuntime.finishAttempt(attemptId, "error", message);
      return { attemptId, attemptIdx, status: "error", error: message };
    }

    // 4. Invoke; catch and record errors. Pass task env values so builtin
    //    scripts (http_fetch, http_request) can resolve ${VAR} tokens the
    //    caller supplied at run_pipeline time without the script having to
    //    reach into process.env directly.
    const env = loadTaskEnvValues(portRuntime.getDb(), taskId);
    let outputs: Record<string, unknown>;
    try {
      outputs = await mod.run(inputs, {
        taskId, stageName, attemptId, attemptIdx, moduleId, env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack ?? null : null;
      writer.close({
        terminationReason: "error",
        errorMessage: message,
        errorStack: stack,
      });
      portRuntime.finishAttempt(attemptId, "error", message);
      return { attemptId, attemptIdx, status: "error", error: message };
    }

    // 5. Write declared outputs. Undeclared keys are silently ignored at
    //    the port_values level but the full outputs object is captured in
    //    the sidecar so tooling can observe dropped keys.
    const declaredOutPorts = new Set(scriptStage.outputs.map((p) => p.name));
    for (const [key, value] of Object.entries(outputs)) {
      if (!declaredOutPorts.has(key)) continue;
      portRuntime.writePort({ attemptId, stageName, portName: key, value });
    }

    // 6. Finish success.
    writer.close({
      terminationReason: "natural_completion",
      outputs,
    });
    portRuntime.finishAttempt(attemptId, "success");
    return { attemptId, attemptIdx, status: "success" };
  }
}
