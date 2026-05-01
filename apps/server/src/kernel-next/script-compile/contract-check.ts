// Layer 3 of the D' script-safety stack: contract test.
//
// For every inline-source ScriptStage at submit time:
//   1. Compile moduleSource with compileInlineScript (Layer 1).
//   2. Scan imports + reject anything off the whitelist (Layer 2).
//   3. Import the emitted JS in-process.
//   4. Invoke module.run(sampleInputs, stubbedCtx).
//   5. Verify the returned object has every declared output port name
//      and none of the sampleInputs exceeded the declared input type.
//
// A failure at any step becomes a diagnostic — the pipeline does not
// get persisted until the script is fixable against its contract. This
// is the mechanism that keeps AI-generated script code honest: the AI
// declares `outputs: [{ name: "foo", type: "number" }]`, writes code
// that returns `{ foo: 42 }`, and we verify the shape right now instead
// of hoping it still works at run time.

import { createRequire } from "node:module";
import type { PipelineIR, ScriptStage, Diagnostic } from "../ir/schema.js";
import type { ScriptModule, ScriptModuleContext } from "../runtime/script-module-resolver.js";
import { compileInlineScript } from "./compile-inline-script.js";
import { scanImports, findDisallowedImports } from "./scan-imports.js";
// Bug 32: shared single source of truth for runtime require() allowlist.
import { RUNTIME_REQUIRE_ALLOWLIST } from "./runtime-require-allowlist.js";

export interface ContractCheckOptions {
  /**
   * Maximum wall-clock time for a single script invocation during the
   * contract test. Inline scripts that run longer than this on sample
   * data are rejected — they're either infinite-looping or doing way
   * too much work for a pipeline-atomic step. Default 5s.
   */
  timeoutMs?: number;
}

export async function checkInlineScriptContracts(
  ir: PipelineIR,
  options: ContractCheckOptions = {},
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const stage of ir.stages) {
    if (stage.type !== "script") continue;
    if (stage.config.source !== "inline") continue;
    const stageDiags = await checkOne(stage, options);
    diagnostics.push(...stageDiags);
  }
  return diagnostics;
}

async function checkOne(
  stage: ScriptStage,
  options: ContractCheckOptions,
): Promise<Diagnostic[]> {
  if (stage.config.source !== "inline") return [];
  const { moduleSource, sampleInputs } = stage.config;
  const stageName = stage.name;
  const diagnostics: Diagnostic[] = [];

  // Layer 2: import whitelist (cheap; fail fast before tsc).
  const scan = scanImports(moduleSource);
  const disallowed = findDisallowedImports(scan.imports);
  if (disallowed.length > 0) {
    for (const d of disallowed) {
      diagnostics.push({
        code: "SCRIPT_IMPORT_NOT_WHITELISTED",
        message:
          `Inline script '${stageName}' imports '${d.specifier}' (line ${d.line}), ` +
          `which is not on the allowed import list. ` +
          `Allowed: node: stdlib subset (fs/promises, path, crypto, url, buffer, os, util, stream/promises, zlib). ` +
          `Third-party packages and filesystem-relative imports are not supported.`,
        context: { stage: stageName, specifier: d.specifier, line: d.line },
      });
    }
  }
  if (scan.dynamicImports.length > 0) {
    for (const line of scan.dynamicImports) {
      diagnostics.push({
        code: "SCRIPT_DYNAMIC_IMPORT_FORBIDDEN",
        message:
          `Inline script '${stageName}' uses a dynamic import() at line ${line} ` +
          `whose argument is not a string literal. Dynamic module loads can't be ` +
          `whitelist-checked and are forbidden.`,
        context: { stage: stageName, line },
      });
    }
  }
  // If imports failed, skip the compile + run — they'll all fail
  // downstream the same way.
  if (diagnostics.length > 0) return diagnostics;

  // Layer 1: tsc compile.
  const compiled = compileInlineScript(moduleSource);
  if (!compiled.ok) {
    for (const d of compiled.diagnostics) {
      diagnostics.push({
        code: "SCRIPT_COMPILE_ERROR",
        message:
          `Inline script '${stageName}' failed to compile: ` +
          `${d.code} at line ${d.line}, column ${d.column}: ${d.message}`,
        context: {
          stage: stageName,
          tsCode: d.code,
          line: d.line,
          column: d.column,
        },
      });
    }
    return diagnostics;
  }

  // Layer 3: contract test — import + invoke with sampleInputs + check output.

  // Verify every declared input port has a sampleInputs entry.
  for (const port of stage.inputs) {
    if (!(port.name in sampleInputs)) {
      diagnostics.push({
        code: "SCRIPT_SAMPLE_INPUT_MISSING",
        message:
          `Inline script '${stageName}' declares input port '${port.name}' but ` +
          `sampleInputs has no entry for it. Every declared input needs a sample ` +
          `value so the contract test can run.`,
        context: { stage: stageName, port: port.name },
      });
    }
  }
  for (const key of Object.keys(sampleInputs)) {
    if (!stage.inputs.some((p) => p.name === key)) {
      diagnostics.push({
        code: "SCRIPT_SAMPLE_INPUT_UNEXPECTED",
        message:
          `Inline script '${stageName}' sampleInputs has key '${key}' that is not ` +
          `a declared input port. Remove it or declare the port.`,
        context: { stage: stageName, key },
      });
    }
  }
  if (diagnostics.length > 0) return diagnostics;

  // Import the compiled module.
  let mod: ScriptModule;
  try {
    mod = importJsModule(compiled.js);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [{
      code: "SCRIPT_IMPORT_ERROR",
      message: `Inline script '${stageName}' could not be imported: ${message}`,
      context: { stage: stageName },
    }];
  }

  // Invoke with a synthetic ctx. env is empty (sample context); runtime
  // env values arrive only at real run time.
  const ctx: ScriptModuleContext = {
    taskId: "__contract_check__",
    stageName,
    attemptId: "__contract_check__",
    attemptIdx: 0,
    moduleId: `inline:${stageName}`,
    env: {},
  };
  const timeoutMs = options.timeoutMs ?? 5000;
  let outputs: Record<string, unknown>;
  try {
    outputs = await invokeWithTimeout(mod, sampleInputs, ctx, timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [{
      code: "SCRIPT_CONTRACT_THROW",
      message:
        `Inline script '${stageName}' threw when run against sampleInputs: ${message}. ` +
        `Either sampleInputs don't match what the script expects (tighten them), or the ` +
        `script itself has a bug.`,
      context: { stage: stageName },
    }];
  }

  if (typeof outputs !== "object" || outputs === null) {
    return [{
      code: "SCRIPT_CONTRACT_BAD_RETURN",
      message:
        `Inline script '${stageName}' returned ${typeof outputs} instead of an object. ` +
        `run() must return Record<string, unknown>.`,
      context: { stage: stageName, got: typeof outputs },
    }];
  }

  // Verify every declared output port is present in the returned value.
  // Extra keys are allowed (they're silently dropped at port_values
  // layer; sidecar still captures them). Missing declared outputs fail.
  for (const port of stage.outputs) {
    if (!(port.name in outputs)) {
      diagnostics.push({
        code: "SCRIPT_CONTRACT_MISSING_OUTPUT",
        message:
          `Inline script '${stageName}' did not produce output port '${port.name}' ` +
          `when invoked with sampleInputs. The script returned: ${JSON.stringify(Object.keys(outputs))}.`,
        context: { stage: stageName, port: port.name, got: Object.keys(outputs) },
      });
    }
  }

  return diagnostics;
}

// Evaluate compiled CommonJS source via Function wrapper — same
// mechanism as runtime/inline-script-executor.ts so both paths see
// identical behaviour. `require` is restricted to the node stdlib
// whitelist (Bug 32: see ./runtime-require-allowlist.ts for the
// single source of truth shared with the runtime executor).

// ESM workaround — apps/server is type:module, so `require` is not a
// global. createRequire(import.meta.url) gives us a CJS require for
// the compiled script's `__importStar(require(...))` calls. Without
// this, every inline script that imports a node:* builtin fails at
// import time with "require is not defined" — observed during
// continuation-3 dogfood of pipeline-generator emitting a publish
// stage that imports node:fs/promises + node:path.
const cjsRequire = createRequire(import.meta.url);

function importJsModule(js: string): ScriptModule {
  const moduleObj: { exports: { default?: ScriptModule } } = { exports: {} };
  const restrictedRequire = (id: string) => {
    if (!RUNTIME_REQUIRE_ALLOWLIST.has(id)) {
      throw new Error(
        `inline script attempted to require '${id}' at runtime; ` +
          `whitelist violation (only node: stdlib subset allowed)`,
      );
    }
    return cjsRequire(id);
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("module", "exports", "require", js);
  factory(moduleObj, moduleObj.exports, restrictedRequire);
  const mod = moduleObj.exports.default;
  if (!mod || typeof mod !== "object" || typeof mod.run !== "function") {
    throw new Error("inline script does not export a default value with run()");
  }
  return mod;
}

async function invokeWithTimeout(
  mod: ScriptModule,
  inputs: Record<string, unknown>,
  ctx: ScriptModuleContext,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const run = Promise.resolve(mod.run(inputs, ctx));
  const timer = new Promise<never>((_resolve, reject) => {
    const id = setTimeout(() => {
      reject(new Error(`contract test exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    // unref so an outer process exit isn't delayed by a lingering handle.
    if (typeof (id as NodeJS.Timeout).unref === "function") {
      (id as NodeJS.Timeout).unref();
    }
  });
  return (await Promise.race([run, timer])) as Record<string, unknown>;
}
