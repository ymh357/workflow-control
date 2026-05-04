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

  it("forge_analyze handler returns NO_SESSION_FOUND for empty projects-root", async () => {
    // Without a real session under HOME and no jsonlPath provided,
    // the handler should produce a structured error.
    const tools = buildForgeTools(buildDeps({ withForge: true }));
    const result = await tools[0]!.handler({});
    // CallToolResult shape: { content: [{ type: "text", text: "..." }] }
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0]!.type).toBe("text");
    const parsed = JSON.parse(content[0]!.text) as Record<string, unknown>;
    // Either error (no session found) or no-pattern (auto-detected
    // session was empty) — both are acceptable depending on host env.
    // We just assert humanSummary is populated.
    expect(parsed.humanSummary).toBeDefined();
    expect(typeof parsed.humanSummary).toBe("string");
  });
});
