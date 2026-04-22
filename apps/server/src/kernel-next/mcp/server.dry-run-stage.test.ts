import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
  // Stub query so if the tool accidentally invokes the real SDK it
  // terminates without network.
  query: () => ({
    async *[Symbol.asyncIterator]() { /* no messages */ },
  }),
}));

// eslint-disable-next-line import/first
import { createKernelMcp } from "./server.js";
import { initKernelNextSchema } from "../ir/sql.js";

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

describe("dry_run_stage MCP tool", () => {
  it("exposes tool with pipelineVersion / stageName / inputs schema", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { surface: "external", skipTypeCheck: true });
    const tool = getTools(mcp).get("dry_run_stage");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toHaveProperty("pipelineVersion");
    expect(tool!.inputSchema).toHaveProperty("stageName");
    expect(tool!.inputSchema).toHaveProperty("inputs");
    db.close();
  });

  it("returns PIPELINE_VERSION_NOT_FOUND for unknown version", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { surface: "external", skipTypeCheck: true });
    const tool = getTools(mcp).get("dry_run_stage");
    const resp = await tool!.handler({
      pipelineVersion: "does-not-exist",
      stageName: "X",
      inputs: {},
    });
    const payload = JSON.parse(resp.content[0]!.text) as {
      ok: boolean; code: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("PIPELINE_VERSION_NOT_FOUND");
    db.close();
  });
});
