// Integration test for the `run_pipeline` MCP tool. Exercises the full
// dispatch path: a submitted pipeline is resolved by name, startPipelineRun
// fires runPipeline in the background, and the tool's synchronous response
// surfaces { taskId, versionHash }. The background run is intentionally
// not awaited — this test verifies dispatch, not execution correctness.
//
// Matches server.test.ts: mock createSdkMcpServer so createKernelMcp
// returns its raw {name, version, tools} descriptor, then invoke the
// registered tool handler directly.

import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
  // Stub query: RealStageExecutor instantiates this when startPipelineRun
  // fires runPipeline in the background. The test does not await the run,
  // so the stub only needs to return an async-iterable that terminates.
  query: () => ({
    async *[Symbol.asyncIterator]() {
      // No SDK messages — the attempt will fail/time-out in the background,
      // which is acceptable: this test asserts dispatch, not execution.
    },
  }),
}));

// eslint-disable-next-line import/first
import { createKernelMcp } from "./server.js";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "./kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import type { PipelineIR } from "../ir/schema.js";

interface McpTool {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function getTools(mcp: unknown): Map<string, McpTool> {
  const toolsArray = (mcp as { tools: McpTool[] }).tools;
  const map = new Map<string, McpTool>();
  for (const t of toolsArray) map.set(t.name, t);
  return map;
}

// diamondIR has AgentStages with promptRef values; KernelService.submit
// requires a non-empty prompts map keyed by those refs.
function promptsForIR(ir: PipelineIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of ir.stages) {
    if (s.type === "agent" && s.config.promptRef) {
      out[s.config.promptRef] = s.config.promptRef;
    }
  }
  return out;
}

describe("run_pipeline MCP tool integration", () => {
  it("starts a task for a name-resolved pipeline", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = diamondIR();
    const submit = await svc.submit(ir, { prompts: promptsForIR(ir) });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const mcp = createKernelMcp(db, { surface: "external", skipTypeCheck: true });
    const tool = getTools(mcp).get("run_pipeline");
    expect(tool).toBeDefined();

    const resp = await tool!.handler({ name: "diamond" });
    const payload = JSON.parse(resp.content[0]!.text) as {
      ok: boolean;
      taskId?: string;
      versionHash?: string;
    };
    expect(payload.ok).toBe(true);
    expect(typeof payload.taskId).toBe("string");
    expect(payload.versionHash).toBe(submit.versionHash);

    db.close();
  });

  it("returns error payload for unknown pipeline name", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { surface: "external", skipTypeCheck: true });
    const tool = getTools(mcp).get("run_pipeline");
    expect(tool).toBeDefined();

    const resp = await tool!.handler({ name: "no-such-pipeline" });
    const payload = JSON.parse(resp.content[0]!.text) as {
      ok: boolean;
      code?: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("UNKNOWN_PIPELINE");

    db.close();
  });
});
