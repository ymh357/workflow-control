// End-to-end test for InlineScriptStageExecutor: submit a pipeline
// that contains an inline-source script stage, run it, and verify
// the port_values row reflects the script's actual return value.
//
// This exercises the D'-3 integration: submit-time contract check
// accepts the inline source AND the runtime executor compiles +
// imports + invokes it with real wire-delivered inputs.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { runPipeline } from "./runner.js";
import { CompositeStageExecutor } from "./composite-executor.js";
import { InlineScriptStageExecutor } from "./inline-script-executor.js";
import { ScriptStageExecutor } from "./script-executor.js";
import { TrivialScriptModuleResolver } from "./script-module-resolver.js";
import { MockStageExecutor, type StageHandlerMap } from "./mock-executor.js";
import type { PipelineIR } from "../ir/schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function irWithInlineScript(moduleSource: string, sampleInputs: Record<string, unknown>): PipelineIR {
  return {
    name: "inline-script-e2e",
    externalInputs: [{ name: "seedValue", type: "string" }],
    stages: [
      {
        name: "seed",
        type: "agent",
        inputs: [{ name: "seed", type: "string" }],
        outputs: [{ name: "raw", type: "string" }],
        config: { promptRef: "seed-prompt" },
      },
      {
        name: "shape",
        type: "script",
        inputs: [{ name: "raw", type: "string" }],
        outputs: [{ name: "shaped", type: "string" }, { name: "length", type: "number" }],
        config: {
          source: "inline",
          moduleSource,
          sampleInputs,
        },
      },
    ],
    wires: [
      { from: { source: "external", port: "seedValue" }, to: { stage: "seed", port: "seed" } },
      { from: { stage: "seed", port: "raw" }, to: { stage: "shape", port: "raw" } },
    ],
  } as unknown as PipelineIR;
}

describe("InlineScriptStageExecutor — submit + run end-to-end (D'-3)", () => {
  it("compiles, imports, and runs an inline script against real wire inputs", { timeout: 30_000 }, async () => {
    const db = makeDb();
    const moduleSource = `
      const mod: ScriptModule = {
        async run(inputs, _ctx) {
          const raw = String(inputs.raw);
          return {
            shaped: raw.toUpperCase(),
            length: raw.length,
          };
        },
      };
      export default mod;
    `;
    const sampleInputs = { raw: "sample" };
    const ir = irWithInlineScript(moduleSource, sampleInputs);

    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = await svc.submit(ir, { prompts: { "seed-prompt": "dummy" } });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    // Agent mock writes a known raw value; inline script processes it.
    const handlers: StageHandlerMap = {
      seed: () => ({ raw: "hello world" }),
    };
    const executor = new CompositeStageExecutor({
      agent: new MockStageExecutor({ handlers }),
      script: new ScriptStageExecutor({
        resolver: new TrivialScriptModuleResolver({ modules: {} }),
      }),
      inlineScript: new InlineScriptStageExecutor(),
    });

    const result = await runPipeline({
      db, ir, taskId: "t-inline",
      versionHash: submit.versionHash,
      executor,
      // MockStageExecutor's constructor hold of `handlers` is used only
      // when `args.handlers` is falsy; runner forwards `opts.handlers`
      // verbatim, so we need to also pass them here.
      handlers,
      seedValues: { seedValue: "hello world" },
    }, 5_000);
    expect(result.finalState).toBe("completed");

    // Read back the script's output port from port_values.
    const shaped = db.prepare(
      `SELECT pv.value_json
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
        WHERE sa.task_id = 't-inline' AND pv.stage_name = 'shape' AND pv.port_name = 'shaped'`,
    ).get() as { value_json: string } | undefined;
    expect(shaped).toBeDefined();
    expect(JSON.parse(shaped!.value_json)).toBe("HELLO WORLD");

    const length = db.prepare(
      `SELECT pv.value_json
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
        WHERE sa.task_id = 't-inline' AND pv.stage_name = 'shape' AND pv.port_name = 'length'`,
    ).get() as { value_json: string } | undefined;
    expect(JSON.parse(length!.value_json)).toBe(11);
    db.close();
  });

  it("submit rejects an inline script whose contract test throws", async () => {
    const db = makeDb();
    const moduleSource = `
      const mod: ScriptModule = {
        async run(inputs, _ctx) {
          throw new Error("always throws");
        },
      };
      export default mod;
    `;
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = await svc.submit(
      irWithInlineScript(moduleSource, { raw: "sample" }),
      { prompts: { "seed-prompt": "dummy" } },
    );
    expect(submit.ok).toBe(false);
    if (submit.ok) return;
    expect(submit.diagnostics.some((d) => d.code === "SCRIPT_CONTRACT_THROW")).toBe(true);
    db.close();
  });

  it("submit rejects an inline script that doesn't produce declared outputs", async () => {
    const db = makeDb();
    const moduleSource = `
      const mod: ScriptModule = {
        async run(inputs, _ctx) {
          // Declared outputs are { shaped, length } but we return { shaped } only.
          return { shaped: String(inputs.raw).toUpperCase() };
        },
      };
      export default mod;
    `;
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = await svc.submit(
      irWithInlineScript(moduleSource, { raw: "sample" }),
      { prompts: { "seed-prompt": "dummy" } },
    );
    expect(submit.ok).toBe(false);
    if (submit.ok) return;
    expect(
      submit.diagnostics.some((d) => d.code === "SCRIPT_CONTRACT_MISSING_OUTPUT"),
    ).toBe(true);
    db.close();
  });

  it("submit rejects an inline script importing off-whitelist modules", async () => {
    const db = makeDb();
    const moduleSource = `
      import { spawn } from "node:child_process";
      const mod: ScriptModule = {
        async run(inputs) {
          return { shaped: "x", length: 0 };
        },
      };
      export default mod;
    `;
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = await svc.submit(
      irWithInlineScript(moduleSource, { raw: "sample" }),
      { prompts: { "seed-prompt": "dummy" } },
    );
    expect(submit.ok).toBe(false);
    if (submit.ok) return;
    expect(
      submit.diagnostics.some((d) => d.code === "SCRIPT_IMPORT_NOT_WHITELISTED"),
    ).toBe(true);
    db.close();
  });

  it("submit rejects an inline script with a syntax error", async () => {
    const db = makeDb();
    const moduleSource = `const mod = { run(inputs {}; export default mod;`;
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = await svc.submit(
      irWithInlineScript(moduleSource, { raw: "sample" }),
      { prompts: { "seed-prompt": "dummy" } },
    );
    expect(submit.ok).toBe(false);
    if (submit.ok) return;
    expect(
      submit.diagnostics.some((d) => d.code === "SCRIPT_COMPILE_ERROR"),
    ).toBe(true);
    db.close();
  });

  it("submit rejects when sampleInputs is missing a declared input port", async () => {
    const db = makeDb();
    const moduleSource = `
      const mod: ScriptModule = {
        async run(inputs) { return { shaped: "", length: 0 }; },
      };
      export default mod;
    `;
    const svc = new KernelService(db, { skipTypeCheck: true });
    // Declare input "raw" but don't give it in sampleInputs.
    const ir = irWithInlineScript(moduleSource, {});
    const submit = await svc.submit(ir, { prompts: { "seed-prompt": "dummy" } });
    expect(submit.ok).toBe(false);
    if (submit.ok) return;
    expect(
      submit.diagnostics.some((d) => d.code === "SCRIPT_SAMPLE_INPUT_MISSING"),
    ).toBe(true);
    db.close();
  });

  // Continuation-3 dogfood regression: inline scripts that import
  // node:* builtins compile to `require("node:*")` calls. apps/server
  // is type:module so the `require` global is undefined; without
  // createRequire(import.meta.url), every such script fails the
  // submit-time contract test with `SCRIPT_IMPORT_ERROR: require is
  // not defined`. Discovered when pipeline-generator emitted a
  // publish stage that imported node:fs/promises + node:path.
  //
  // We can't test the happy path under vitest (module resolution for
  // @types/node fails when vitest cwd ≠ apps/server, the TS compile
  // step inside compileInlineScript rejects the import with TS2307
  // before the runtime require is ever exercised). What we CAN test:
  // any failure must NOT be the ESM "require is not defined"
  // ReferenceError — that one is the bug we fixed. Acceptable
  // failures are TS2307 (compile-time, environment-specific) or
  // SCRIPT_IMPORT_VIOLATION (runtime, off-whitelist module). A
  // ReferenceError on `require` would surface as
  // `SCRIPT_IMPORT_ERROR: require is not defined` and is what we
  // forbid here.
  it("inline script importing node:* never fails with ESM 'require is not defined'", async () => {
    const db = makeDb();
    const moduleSource = `
      import { createHash } from "node:crypto";
      const mod: ScriptModule = {
        async run(inputs) {
          const raw = inputs.raw as string;
          const hash = createHash("sha1").update(raw).digest("hex");
          return { shaped: hash, length: raw.length };
        },
      };
      export default mod;
    `;
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = irWithInlineScript(moduleSource, { raw: "hello" });
    const submit = await svc.submit(ir, { prompts: { "seed-prompt": "dummy" } });
    if (!submit.ok) {
      const messages = submit.diagnostics.map((d) => d.message ?? "").join(" | ");
      // Pre-fix: would surface 'require is not defined' from new
      // Function('module', 'exports', 'require', js) when js contains
      // synthesized `require("node:crypto")` and `require` global is
      // absent (ESM `type: module`).
      expect(messages).not.toMatch(/require is not defined/);
    }
    db.close();
  });
});
