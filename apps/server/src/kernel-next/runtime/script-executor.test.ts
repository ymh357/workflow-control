// Integration-ish tests for ScriptStageExecutor — exercised through a real
// DB + PortRuntime so lineage is observable post-run, but without the
// machine/runner (we drive a single executeStage call directly).

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { PortRuntime, type EventDispatcher } from "./port-runtime.js";
import { ScriptStageExecutor } from "./script-executor.js";
import {
  TrivialScriptModuleResolver,
  type ScriptModule,
} from "./script-module-resolver.js";
import type { PipelineIR } from "../ir/schema.js";
import type { ExecuteStageArgs } from "./executor.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function irWithOneScriptStage(moduleId: string): PipelineIR {
  return {
    name: "t",
    stages: [
      {
        name: "S",
        type: "script",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "y", type: "number" }],
        config: { moduleId },
      },
    ],
    wires: [],
  };
}

function buildArgs(
  ir: PipelineIR,
  portRuntime: PortRuntime,
  portValues: Record<string, unknown>,
): ExecuteStageArgs {
  return {
    ir,
    stageName: "S",
    taskId: "task-1",
    versionHash: "hash-1",
    portValues,
    handlers: {},
    portRuntime,
  };
}

const inertDispatcher: EventDispatcher = { send: () => { /* noop */ } };

describe("ScriptStageExecutor", () => {
  it("resolves module, runs it, writes declared outputs, finishes success", async () => {
    const db = makeDb();
    try {
      const portRuntime = new PortRuntime(db, inertDispatcher);
      const ir = irWithOneScriptStage("double");
      // Seed an upstream port_value so the gather step has something to read.
      // Since the stage has no inbound wire (wires=[]), the input gather
      // skips reading via wires and `inputs.x` is undefined at invocation
      // time. For a focused unit test, simulate the runner having already
      // placed the value in portValues and the stage declaring a wire.
      const irWithWire: PipelineIR = {
        ...ir,
        stages: [
          { name: "UP", type: "script", inputs: [], outputs: [{ name: "x", type: "number" }], config: { moduleId: "seed" } },
          ir.stages[0]!,
        ],
        wires: [{ from: { stage: "UP", port: "x" }, to: { stage: "S", port: "x" } }],
      };

      const double: ScriptModule = {
        run: (inputs) => ({ y: (inputs.x as number) * 2 }),
      };
      const seed: ScriptModule = { run: () => ({ x: 21 }) };
      const resolver = new TrivialScriptModuleResolver({
        modules: { double, seed },
      });
      const exec = new ScriptStageExecutor({ resolver });

      const args = buildArgs(irWithWire, portRuntime, { "UP.x": 21 });
      const result = await exec.executeStage(args);

      expect(result.status).toBe("success");

      // Lineage: one attempt row + one port_values in + one out.
      const attemptRows = db.prepare(
        `SELECT status FROM stage_attempts WHERE attempt_id = ?`,
      ).all(result.attemptId) as Array<{ status: string }>;
      expect(attemptRows).toEqual([{ status: "success" }]);

      const writes = portRuntime.readWritesForAttempt(result.attemptId);
      expect(writes).toEqual([{ port: "y", value: 42 }]);
    } finally {
      db.close();
    }
  });

  it("returns error + finishes attempt error when moduleId is unknown", async () => {
    const db = makeDb();
    try {
      const portRuntime = new PortRuntime(db, inertDispatcher);
      const ir = irWithOneScriptStage("missing");
      const resolver = new TrivialScriptModuleResolver({ modules: {} });
      const exec = new ScriptStageExecutor({ resolver });

      const result = await exec.executeStage(buildArgs(ir, portRuntime, {}));
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/Script module 'missing' not found/);

      const row = db.prepare(
        `SELECT status FROM stage_attempts WHERE attempt_id = ?`,
      ).get(result.attemptId) as { status: string };
      expect(row.status).toBe("error");
    } finally {
      db.close();
    }
  });

  it("returns error when the script module throws", async () => {
    const db = makeDb();
    try {
      const portRuntime = new PortRuntime(db, inertDispatcher);
      const ir = irWithOneScriptStage("boom");
      const boom: ScriptModule = {
        run: () => { throw new Error("kaboom"); },
      };
      const resolver = new TrivialScriptModuleResolver({
        modules: { boom },
      });
      const exec = new ScriptStageExecutor({ resolver });

      const result = await exec.executeStage(buildArgs(ir, portRuntime, {}));
      expect(result.status).toBe("error");
      expect(result.error).toBe("kaboom");

      // No output writes.
      const writes = portRuntime.readWritesForAttempt(result.attemptId);
      expect(writes).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("throws when asked to execute a non-script stage", async () => {
    const db = makeDb();
    try {
      const portRuntime = new PortRuntime(db, inertDispatcher);
      const ir: PipelineIR = {
        name: "bad",
        stages: [
          { name: "A", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
        ],
        wires: [],
      };
      const resolver = new TrivialScriptModuleResolver({ modules: {} });
      const exec = new ScriptStageExecutor({ resolver });

      const args: ExecuteStageArgs = {
        ir, stageName: "A", taskId: "t", versionHash: "h",
        portValues: {}, handlers: {}, portRuntime,
      };
      await expect(exec.executeStage(args)).rejects.toThrow(/type 'agent'/);
    } finally {
      db.close();
    }
  });

  it("ignores undeclared output keys returned by the module", async () => {
    const db = makeDb();
    try {
      const portRuntime = new PortRuntime(db, inertDispatcher);
      const ir = irWithOneScriptStage("noisy");
      const noisy: ScriptModule = {
        run: () => ({ y: 7, extra: "should be dropped" }),
      };
      const resolver = new TrivialScriptModuleResolver({
        modules: { noisy },
      });
      const exec = new ScriptStageExecutor({ resolver });

      const result = await exec.executeStage(buildArgs(ir, portRuntime, {}));
      expect(result.status).toBe("success");
      const writes = portRuntime.readWritesForAttempt(result.attemptId);
      expect(writes).toEqual([{ port: "y", value: 7 }]);
    } finally {
      db.close();
    }
  });

  it("awaits async module.run", async () => {
    const db = makeDb();
    try {
      const portRuntime = new PortRuntime(db, inertDispatcher);
      const ir = irWithOneScriptStage("async");
      const asyncMod: ScriptModule = {
        run: async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { y: 99 };
        },
      };
      const resolver = new TrivialScriptModuleResolver({
        modules: { async: asyncMod },
      });
      const exec = new ScriptStageExecutor({ resolver });

      const result = await exec.executeStage(buildArgs(ir, portRuntime, {}));
      expect(result.status).toBe("success");
      const writes = portRuntime.readWritesForAttempt(result.attemptId);
      expect(writes).toEqual([{ port: "y", value: 99 }]);
    } finally {
      db.close();
    }
  });
});
