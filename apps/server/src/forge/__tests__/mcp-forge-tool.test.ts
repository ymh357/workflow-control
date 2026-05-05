// Test the forge_analyze MCP tool factory directly. The tool wraps
// `analyze` with humanSummary formatting; we verify the wrapping
// without invoking the full MCP transport layer.

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

describe("buildForgeTools", () => {
  it("returns no tools when forgeDb is absent", () => {
    const tools = buildForgeTools(buildDeps({ withForge: false }));
    expect(tools).toEqual([]);
  });

  it("returns the forge_analyze tool when forgeDb is present", () => {
    const tools = buildForgeTools(buildDeps({ withForge: true }));
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("forge_analyze");
    expect(tools[0]!.description).toContain("automation candidates");
  });

  it("forge_analyze handler returns LOAD_FAILED for a missing jsonlPath", async () => {
    // Pass an explicit non-existent path so the handler short-circuits
    // before calling forge-distill — keeps the test fast and
    // deterministic regardless of what's under $HOME.
    const tools = buildForgeTools(buildDeps({ withForge: true }));
    const result = await tools[0]!.handler({ jsonlPath: "/definitely/does/not/exist.jsonl" });
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0]!.type).toBe("text");
    const parsed = JSON.parse(content[0]!.text) as Record<string, unknown>;
    expect(parsed.kind).toBe("error");
    expect(parsed.code).toBe("LOAD_FAILED");
    expect(parsed.humanSummary).toBeDefined();
    expect(typeof parsed.humanSummary).toBe("string");
  });
});
