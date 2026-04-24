// Inline-source script executor (D'-3). Handles ScriptStage variants
// whose implementation travels in the IR as config.moduleSource instead
// of through the builtin registry.
//
// Flow:
//   1. Start a stage_attempt (mirrors ScriptStageExecutor).
//   2. Compile config.moduleSource with the in-process tsc
//      (compile-inline-script). If submit-time validation was thorough
//      this shouldn't fail here; we still catch it and record
//      terminationReason="compile_error" on the sidecar for post-mortem.
//   3. Import the emitted JS via data: URL so the module lives entirely
//      in process memory without hitting the filesystem. The module
//      must export a default value conforming to ScriptModule.
//   4. Invoke module.run(inputs, ctx) — same contract as registry
//      scripts — and write declared output ports.
//
// Security boundary: submit-time validation (compile + import whitelist
// + sample-input contract) is the authoritative gate. At runtime the
// script runs in the server process. Inputs come from the live wire
// graph, not from anywhere the AI can influence outside the pipeline
// contract.

import type { ScriptStage } from "../ir/schema.js";
import type {
  ExecuteStageArgs,
  ExecuteStageResult,
  StageExecutor,
} from "./executor.js";
import type { ScriptModule } from "./script-module-resolver.js";
import { openScriptExecutionRecordWriter } from "./script-execution-record-writer.js";
import { loadTaskEnvValues } from "./task-env-values.js";
import { compileInlineScript } from "../script-compile/compile-inline-script.js";

export class InlineScriptStageExecutor implements StageExecutor {
  // Cache compiled modules by versionHash+stageName: the same inline
  // source is immutable within one pipeline version, so a retry of the
  // same stage does not require recompiling.
  private readonly cache = new Map<string, ScriptModule>();

  async executeStage(args: ExecuteStageArgs): Promise<ExecuteStageResult> {
    const { ir, stageName, taskId, versionHash, portValues, portRuntime, fanoutElementIdx } = args;

    const stage = ir.stages.find((s) => s.name === stageName);
    if (!stage) throw new Error(`Stage '${stageName}' not in IR`);
    if (stage.type !== "script") {
      throw new Error(
        `InlineScriptStageExecutor received stage '${stageName}' of type '${stage.type}'.`,
      );
    }
    const scriptStage: ScriptStage = stage;
    if (scriptStage.config.source !== "inline") {
      throw new Error(
        `InlineScriptStageExecutor received registry-source ScriptStage '${stageName}'. ` +
          `Route registry scripts via ScriptStageExecutor.`,
      );
    }

    const { attemptId, attemptIdx } = portRuntime.startAttempt({
      taskId, versionHash, stageName, fanoutElementIdx,
    });

    // Gather inputs from wires (mirrors ScriptStageExecutor).
    const inputs: Record<string, unknown> = {};
    for (const p of scriptStage.inputs) {
      const wire = ir.wires.find(
        (w) => w.to.stage === stageName && w.to.port === p.name,
      );
      if (!wire) continue;
      const fromStage = wire.from.source === "external" ? "__external__" : wire.from.stage;
      const srcKey = `${fromStage}.${wire.from.port}`;
      const value = portValues[srcKey];
      inputs[p.name] = value;
      portRuntime.recordRead({ attemptId, stageName, portName: p.name, value });
    }

    const writer = openScriptExecutionRecordWriter(portRuntime.getDb(), {
      attemptId,
      moduleId: `inline:${stageName}`,
      inputs,
    });

    // Resolve (compile + import) lazily, cached per version+stage.
    const cacheKey = `${versionHash}::${stageName}`;
    let mod = this.cache.get(cacheKey);
    if (!mod) {
      const compiled = compileInlineScript(scriptStage.config.moduleSource);
      if (!compiled.ok) {
        const message =
          `Inline script compile failed for stage '${stageName}': ` +
          compiled.diagnostics.map((d) => `${d.code}@${d.line}:${d.column}: ${d.message}`).join("; ");
        writer.close({
          terminationReason: "compile_error",
          errorMessage: message,
        });
        portRuntime.finishAttempt(attemptId, "error", message);
        return { attemptId, attemptIdx, status: "error", error: message };
      }
      try {
        mod = await importJsModule(compiled.js);
      } catch (err) {
        const message = `Inline script import failed for stage '${stageName}': ${err instanceof Error ? err.message : String(err)}`;
        writer.close({
          terminationReason: "module_not_found",
          errorMessage: message,
        });
        portRuntime.finishAttempt(attemptId, "error", message);
        return { attemptId, attemptIdx, status: "error", error: message };
      }
      this.cache.set(cacheKey, mod);
    }

    const env = loadTaskEnvValues(portRuntime.getDb(), taskId);
    let outputs: Record<string, unknown>;
    try {
      outputs = await mod.run(inputs, {
        taskId, stageName, attemptId, attemptIdx,
        moduleId: `inline:${stageName}`,
        env,
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

    const declaredOutPorts = new Set(scriptStage.outputs.map((p) => p.name));
    for (const [key, value] of Object.entries(outputs)) {
      if (!declaredOutPorts.has(key)) continue;
      portRuntime.writePort({ attemptId, stageName, portName: key, value });
    }

    writer.close({
      terminationReason: "natural_completion",
      outputs,
    });
    portRuntime.finishAttempt(attemptId, "success");
    return { attemptId, attemptIdx, status: "success" };
  }
}

/**
 * Import the emitted JS source via a data: URL. Node's ESM loader
 * resolves data: URLs in-memory — no filesystem touch, no tempdir
 * cleanup. The script's import specifiers (already whitelisted at
 * submit time) are resolved by node's standard loader against the
 * server's node_modules, which is what we want: node: builtins come
 * from the runtime, the script itself has no private module graph.
 *
 * Returns the default export coerced to ScriptModule. Caller handles
 * the case where the module doesn't conform (run throws on invocation).
 */
async function importJsModule(js: string): Promise<ScriptModule> {
  const url = `data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`;
  const ns = (await import(/* @vite-ignore */ url)) as { default?: ScriptModule };
  const mod = ns.default;
  if (!mod || typeof mod !== "object" || typeof mod.run !== "function") {
    throw new Error(
      "inline script does not export a default value with a run() method",
    );
  }
  return mod;
}
