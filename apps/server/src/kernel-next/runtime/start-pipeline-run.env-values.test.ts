import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { startPipelineRun } from "./start-pipeline-run.js";
import { loadTaskEnvValues } from "./task-env-values.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";

function noopBroadcaster(): KernelNextBroadcaster {
  return {
    publish: () => {},
    subscribe: () => () => {},
    historyFor: () => [],
    clearTask: () => {},
    subscriberCount: () => 0,
  } as unknown as KernelNextBroadcaster;
}

// Minimal valid pipeline IR with a single agent stage
function minimalIR(name: string) {
  return {
    name,
    stages: [
      {
        name: "s",
        type: "agent" as const,
        inputs: [],
        outputs: [{ name: "o", type: "string" as const }],
        config: { promptRef: "p" },
      },
    ],
    wires: [],
    externalInputs: [],
  };
}

describe("startPipelineRun: envValues persistence", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
  });

  it("persists envValues to task_env_values when provided", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = minimalIR("env-test");
    const submitResult = svc.submit(ir, { prompts: { p: "test" } });
    if (!submitResult.ok) throw new Error(`submit failed: ${JSON.stringify(submitResult.diagnostics)}`);

    const result = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "env-test",
      seedValues: {},
      envValues: { GITHUB_TOKEN: "ghp_x", NOTION_TOKEN: "ntn_y" },
      workspaceDir: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = loadTaskEnvValues(db, result.taskId);
    expect(stored).toEqual({ GITHUB_TOKEN: "ghp_x", NOTION_TOKEN: "ntn_y" });
  });

  it("does not write to task_env_values when envValues omitted", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = minimalIR("no-env");
    const submitResult = svc.submit(ir, { prompts: { p: "test" } });
    if (!submitResult.ok) throw new Error(`submit failed`);

    const result = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "no-env",
      seedValues: {},
      workspaceDir: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(loadTaskEnvValues(db, result.taskId)).toEqual({});
  });

  it("does not write when envValues is an empty object", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = minimalIR("empty-env");
    const submitResult = svc.submit(ir, { prompts: { p: "test" } });
    if (!submitResult.ok) throw new Error(`submit failed`);

    const result = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "empty-env",
      seedValues: {},
      envValues: {},
      workspaceDir: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(loadTaskEnvValues(db, result.taskId)).toEqual({});
  });
});
