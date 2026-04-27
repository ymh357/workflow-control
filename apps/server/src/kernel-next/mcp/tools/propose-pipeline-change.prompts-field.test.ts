import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
}));

import { createKernelMcp } from "../server.js";
import { initKernelNextSchema, getPromptsByVersion } from "../../ir/sql.js";
import { KernelService } from "../kernel.js";
import type { PipelineIR } from "../../ir/schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getTools(mcp: any): Map<string, { name: string; handler: (args: any) => Promise<unknown> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Map((mcp.tools as Array<{ name: string; handler: any }>).map((t) => [t.name, t]));
}

function tinyIr(promptRef: string): PipelineIR {
  return {
    name: "t",
    stages: [
      {
        name: "A",
        type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "string" }],
        config: { promptRef },
      },
    ],
    wires: [],
  };
}

describe("propose_pipeline_change MCP tool: prompts field", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
  });

  it("accepts a prompts map and persists it on the proposed version", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const baseSubmit = await svc.submit(tinyIr("system/p-old"), {
      prompts: { "system/p-old": "old body" },
    });
    if (!baseSubmit.ok) throw new Error("seed failed");

    const mcp = createKernelMcp(db, { surface: "combined", skipTypeCheck: true });
    const tool = getTools(mcp).get("propose_pipeline_change");
    expect(tool).toBeDefined();

    const patch = {
      ops: [
        {
          op: "update_stage_config" as const,
          stage: "A",
          configPatch: { promptRef: "system/p-new" },
        },
      ],
    };
    const newPromptBody = "new body for p-new";
    const resp = await tool!.handler({
      currentVersion: baseSubmit.versionHash,
      patch,
      actor: "test-actor",
      autoApprove: true,
      prompts: { "system/p-new": newPromptBody },
    });
    const data = JSON.parse((resp as { content: Array<{ text: string }> }).content[0]!.text) as {
      ok: boolean;
      proposedVersion?: string;
      diagnostics?: unknown[];
    };
    expect(data.ok).toBe(true);
    expect(data.proposedVersion).toBeTruthy();

    const persisted = getPromptsByVersion(db, data.proposedVersion!);
    expect(persisted["system/p-new"]).toBe(newPromptBody + "\n");
  });

  it("rejects unrelated extra fields without crashing", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const baseSubmit = await svc.submit(tinyIr("system/p"), {
      prompts: { "system/p": "body" },
    });
    if (!baseSubmit.ok) throw new Error("seed failed");

    const mcp = createKernelMcp(db, { surface: "combined", skipTypeCheck: true });
    const tool = getTools(mcp).get("propose_pipeline_change");

    const resp = await tool!.handler({
      currentVersion: baseSubmit.versionHash,
      patch: { ops: [] },
      actor: "test-actor",
      prompts: { "system/p": "body" },
    });
    const data = JSON.parse((resp as { content: Array<{ text: string }> }).content[0]!.text) as {
      ok: boolean;
    };
    expect(typeof data.ok).toBe("boolean");
  });
});
