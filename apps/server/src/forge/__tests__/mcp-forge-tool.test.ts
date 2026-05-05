// Test the forge_analyze_start / forge_analyze_result MCP tool factory.
// Async pair (2026-05-05) replaced the original single forge_analyze
// because MCP tool calls have a ~60s timeout but forge-distill takes
// 60-180s. Tests assert the start tool short-circuits fast and the
// result tool decodes analysisIds correctly.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { initForgeSchema } from "../db/schema.js";
import { buildForgeTools } from "../../kernel-next/mcp/tools/forge.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";
import type { ToolsDeps } from "../../kernel-next/mcp/tool-types.js";

let kernelDb: DatabaseSync;
let forgeDb: DatabaseSync;

beforeEach(() => {
  kernelDb = new DatabaseSync(":memory:");
  initKernelNextSchema(kernelDb);
  forgeDb = new DatabaseSync(":memory:");
  initForgeSchema(forgeDb);
});

function buildDeps(opts: { withForge: boolean }): ToolsDeps {
  return {
    db: kernelDb,
    kernel: new KernelService(kernelDb, { skipTypeCheck: true }),
    maxBytesDefault: 1024 * 1024,
    forgeDb: opts.withForge ? forgeDb : undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createMcpServer: (() => ({} as any)),
  };
}

function parseToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  expect(content[0]!.type).toBe("text");
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("buildForgeTools", () => {
  it("returns no tools when forgeDb is absent", () => {
    const tools = buildForgeTools(buildDeps({ withForge: false }));
    expect(tools).toEqual([]);
  });

  it("exposes forge_analyze_{start,result,recent} when forgeDb is present", () => {
    const tools = buildForgeTools(buildDeps({ withForge: true }));
    expect(tools).toHaveLength(3);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "forge_analyze_recent",
      "forge_analyze_result",
      "forge_analyze_start",
    ]);
  });

  it("forge_analyze_start returns LOAD_FAILED for a missing jsonlPath", async () => {
    const tools = buildForgeTools(buildDeps({ withForge: true }));
    const startTool = tools.find((t) => t.name === "forge_analyze_start")!;
    const result = await startTool.handler({ jsonlPath: "/definitely/does/not/exist.jsonl" });
    const parsed = parseToolResult(result);
    expect(parsed.kind).toBe("error");
    expect(parsed.code).toBe("LOAD_FAILED");
    expect(parsed.humanSummary).toBeDefined();
  });

  it("forge_analyze_result returns INVALID_ANALYSIS_ID for garbage input", async () => {
    const tools = buildForgeTools(buildDeps({ withForge: true }));
    const resultTool = tools.find((t) => t.name === "forge_analyze_result")!;
    const result = await resultTool.handler({ analysisId: "not-a-real-id" });
    const parsed = parseToolResult(result);
    expect(parsed.kind).toBe("error");
    expect(parsed.code).toBe("INVALID_ANALYSIS_ID");
  });
});
