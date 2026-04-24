import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
  query: () => ({
    async *[Symbol.asyncIterator]() { /* no messages */ },
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
  inputSchema: Record<string, unknown>;
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

function promptsForIR(ir: PipelineIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of ir.stages) {
    if (s.type === "agent" && s.config.promptRef) {
      out[s.config.promptRef] = s.config.promptRef;
    }
  }
  return out;
}

describe("run_pipeline MCP tool — checkpointConfig", () => {
  it("inputSchema exposes checkpointConfig at the top level", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { surface: "external", skipTypeCheck: true });
    const tool = getTools(mcp).get("run_pipeline");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toHaveProperty("checkpointConfig");
    db.close();
  });

  it("handler forwards checkpointConfig and the run produces zero stage_checkpoints rows when enabled=false", async () => {
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

    const resp = await tool!.handler({
      name: "diamond",
      checkpointConfig: { enabled: false },
    });
    const payload = JSON.parse(resp.content[0]!.text) as {
      ok: boolean;
      taskId?: string;
    };
    expect(payload.ok).toBe(true);

    // The mocked SDK returns no messages so the stubbed query's
    // async iterator exits immediately. RealStageExecutor will
    // treat that as a run without completion, but the background
    // runPipeline still registers attempts — and since checkpointConfig
    // has enabled=false, no stage_checkpoints rows should ever be
    // written regardless of attempt count. Give the background run a
    // generous moment to record any would-be rows before asserting.
    await new Promise((r) => setTimeout(r, 500));
    const count = (db
      .prepare(`SELECT COUNT(*) AS c FROM stage_checkpoints`)
      .get() as { c: number }).c;
    expect(count).toBe(0);

    db.close();
  });
});
