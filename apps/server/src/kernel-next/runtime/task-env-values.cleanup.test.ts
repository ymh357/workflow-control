// P3.6 regression: task_env_values rows are deleted when a task reaches a
// terminal state (task_finals row written with completed / failed / cancelled).

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import { storeTaskEnvValues, loadTaskEnvValues } from "./task-env-values.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function singleStageIR(): PipelineIR {
  return {
    name: "single",
    stages: [
      {
        name: "a", type: "agent",
        inputs: [],
        outputs: [{ name: "out", type: "string" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [],
  };
}

describe("P3.6: task_env_values cleanup on termination", () => {
  it("deletes task_env_values when task completes (completed terminal state)", async () => {
    const db = makeDb();
    const ir = singleStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    storeTaskEnvValues(db, "task-c", { GITHUB_TOKEN: "ghp_x", API_KEY: "sk_abc" });
    expect(loadTaskEnvValues(db, "task-c")).toEqual({ GITHUB_TOKEN: "ghp_x", API_KEY: "sk_abc" });

    const handlers: StageHandlerMap = {
      a: () => ({ out: "done" }),
    };

    await runPipeline({ db, ir, taskId: "task-c", versionHash: hash, handlers });

    expect(loadTaskEnvValues(db, "task-c")).toEqual({});
  });

  it("deletes task_env_values when task fails (failed terminal state)", async () => {
    const db = makeDb();
    const ir = singleStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    storeTaskEnvValues(db, "task-f", { SECRET: "top-secret" });
    expect(loadTaskEnvValues(db, "task-f")).toEqual({ SECRET: "top-secret" });

    const handlers: StageHandlerMap = {
      a: () => { throw new Error("stage failed"); },
    };

    // runPipeline resolves (not throws) even on failure; finalState = 'failed'
    const result = await runPipeline({ db, ir, taskId: "task-f", versionHash: hash, handlers });
    expect(result.finalState).toBe("failed");

    expect(loadTaskEnvValues(db, "task-f")).toEqual({});
  });

  it("does NOT delete task_env_values when task has not yet terminated", () => {
    const db = makeDb();
    // Seed env values but perform no finalization.
    storeTaskEnvValues(db, "task-active", { STILL_HERE: "yes" });
    expect(loadTaskEnvValues(db, "task-active")).toEqual({ STILL_HERE: "yes" });
  });

  it("cleanup is a no-op for tasks that never had env values (no error)", async () => {
    const db = makeDb();
    const ir = singleStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    // No storeTaskEnvValues call — task has no env values.
    const handlers: StageHandlerMap = {
      a: () => ({ out: "done" }),
    };

    await expect(
      runPipeline({ db, ir, taskId: "task-noop", versionHash: hash, handlers }),
    ).resolves.not.toThrow();

    expect(loadTaskEnvValues(db, "task-noop")).toEqual({});
  });
});
