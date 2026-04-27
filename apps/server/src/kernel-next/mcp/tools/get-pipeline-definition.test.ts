import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
}));

import { createKernelMcp } from "../server.js";
import { initKernelNextSchema } from "../../ir/sql.js";
import { KernelService } from "../kernel.js";

function getTools(mcp: any): Map<string, { name: string; handler: (args: any) => Promise<unknown> }> {
  return new Map(mcp.tools.map((t: any) => [t.name, t]));
}

async function seedTinyPipeline(db: DatabaseSync, name: string): Promise<{ versionHash: string }> {
  const svc = new KernelService(db, { skipTypeCheck: true });
  const ir = {
    name,
    externalInputs: [{ name: "input1", type: "string" }],
    stages: [
      {
        type: "agent" as const,
        name: "s1",
        config: { promptRef: "system/p1" },
        inputs: [{ name: "input1", type: "string" }],
        outputs: [{ name: "result", type: "string" }],
      },
    ],
    wires: [
      { from: { source: "external" as const, port: "input1" }, to: { stage: "s1", port: "input1" } },
    ],
  };
  const prompts = { "system/p1": "# Test prompt content for s1" };
  const res = await svc.submit(ir, { prompts });
  if (!res.ok) throw new Error("seed failed");
  return { versionHash: res.versionHash };
}

describe("get_pipeline_definition MCP tool", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
  });

  it("returns IR + prompts when name is given", async () => {
    const { versionHash } = await seedTinyPipeline(db, "test-pipeline");
    const mcp = createKernelMcp(db, { surface: "combined", skipTypeCheck: true });
    const tool = getTools(mcp).get("get_pipeline_definition");
    expect(tool).toBeDefined();

    const resp = await tool!.handler({ name: "test-pipeline" });
    const data = JSON.parse((resp as any).content[0].text);

    expect(data.ok).toBe(true);
    expect(data.versionHash).toBe(versionHash);
    expect(data.ir.name).toBe("test-pipeline");
    expect(data.prompts["system/p1"]).toBe("# Test prompt content for s1\n");
  });

  it("returns IR + prompts when versionHash is given (overrides name)", async () => {
    const { versionHash } = await seedTinyPipeline(db, "test-pipeline-v");
    const mcp = createKernelMcp(db, { surface: "combined", skipTypeCheck: true });
    const tool = getTools(mcp).get("get_pipeline_definition");
    const resp = await tool!.handler({ versionHash });
    const data = JSON.parse((resp as any).content[0].text);
    expect(data.ok).toBe(true);
    expect(data.versionHash).toBe(versionHash);
    expect(Object.keys(data.prompts).length).toBeGreaterThan(0);
  });

  it("returns ok=false with diagnostic when name not found", async () => {
    const mcp = createKernelMcp(db, { surface: "combined", skipTypeCheck: true });
    const tool = getTools(mcp).get("get_pipeline_definition");
    const resp = await tool!.handler({ name: "nonexistent-pipeline" });
    const data = JSON.parse((resp as any).content[0].text);
    expect(data.ok).toBe(false);
    expect(Array.isArray(data.diagnostics)).toBe(true);
    expect(data.diagnostics.length).toBeGreaterThan(0);
  });

  it("returns ok=false when neither name nor versionHash provided", async () => {
    const mcp = createKernelMcp(db, { surface: "combined", skipTypeCheck: true });
    const tool = getTools(mcp).get("get_pipeline_definition");
    const resp = await tool!.handler({});
    const data = JSON.parse((resp as any).content[0].text);
    expect(data.ok).toBe(false);
  });
});
