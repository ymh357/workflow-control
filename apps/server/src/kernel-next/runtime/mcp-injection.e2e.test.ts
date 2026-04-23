// mcp-injection.e2e.test.ts
//
// End-to-end regression for D1 (external MCP injection). Validates that
// the full chain closes without running the real Claude Agent SDK:
//
//   run_pipeline envValues
//       -> startPipelineRun persists to task_env_values
//       -> loadTaskEnvValues recovers the map
//       -> expandMcpServers produces ExpandedMcpServer records
//       -> buildSdkBaseOptions merges them alongside __kernel_next__
//
// Also verifies MCP_ENV_MISSING semantics when envValues are absent.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { startPipelineRun } from "./start-pipeline-run.js";
import { loadTaskEnvValues } from "./task-env-values.js";
import { expandMcpServers, McpEnvExpansionError } from "./mcp-servers-expander.js";
import { buildSdkBaseOptions } from "./real-executor-sdk-options.js";
import type { AgentStage, McpServerDecl, PipelineIR } from "../ir/schema.js";
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

function irWithGithubMcp(name: string): PipelineIR {
  return {
    name,
    stages: [
      {
        name: "fetch",
        type: "agent",
        inputs: [],
        outputs: [{ name: "result", type: "string" }],
        config: {
          promptRef: "p",
          mcpServers: [
            {
              name: "github",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
              envKeys: ["GITHUB_TOKEN"],
            },
          ],
        },
      },
    ],
    wires: [],
    externalInputs: [],
  } as PipelineIR;
}

describe("D1 external MCP injection: end-to-end", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
  });

  it("envValues flow from run_pipeline through task_env_values into expanded MCP server and SDK options", async () => {
    const ir = irWithGithubMcp("mcp-e2e");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitResult = svc.submit(ir, { prompts: { p: "test" } });
    if (!submitResult.ok) {
      throw new Error(`submit failed: ${JSON.stringify(submitResult.diagnostics)}`);
    }

    const runResult = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "mcp-e2e",
      seedValues: {},
      envValues: { GITHUB_TOKEN: "ghp_testsecret" },
      workspaceDir: null,
    });
    if (!runResult.ok) {
      throw new Error(`startPipelineRun failed: ${JSON.stringify(runResult)}`);
    }

    // DB persistence round-trip
    const loaded = loadTaskEnvValues(db, runResult.taskId);
    expect(loaded).toEqual({ GITHUB_TOKEN: "ghp_testsecret" });

    // Expander produces the expected SDK-shaped record
    const agentStage = ir.stages[0] as AgentStage;
    // Pass empty processEnv to prove the value really came from taskEnv.
    const expanded = expandMcpServers(agentStage.config.mcpServers!, loaded, {});
    expect(expanded.github).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_testsecret" },
    });

    // buildSdkBaseOptions merges external MCP alongside __kernel_next__
    const kernelMarker = Symbol("kernel") as unknown as never;
    const opts = buildSdkBaseOptions({
      systemPromptAppend: "",
      kernelMcp: kernelMarker,
      model: undefined,
      maxTurns: 5,
      maxBudgetUsd: undefined,
      claudePath: undefined,
      childEnv: {},
      subAgents: undefined,
      workspaceDir: undefined,
      externalMcpServers: expanded,
    });
    expect(opts.mcpServers).toHaveProperty("__kernel_next__");
    expect(opts.mcpServers).toHaveProperty("github");
    expect(opts.mcpServers!.__kernel_next__).toBe(kernelMarker);
    expect(opts.mcpServers!.github).toEqual(expanded.github);
  });

  it("missing envValue causes expansion to throw McpEnvExpansionError with MCP_ENV_MISSING semantics", () => {
    const decls: McpServerDecl[] = [
      {
        name: "github",
        command: "npx",
        args: [],
        env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
        envKeys: ["GITHUB_TOKEN"],
      },
    ];

    // Empty taskEnv + empty processEnv -> expansion must fail
    expect(() => expandMcpServers(decls, {}, {})).toThrow(McpEnvExpansionError);

    try {
      expandMcpServers(decls, {}, {});
      throw new Error("should have thrown");
    } catch (e) {
      if (!(e instanceof McpEnvExpansionError)) throw e;
      expect(e.server).toBe("github");
      expect(e.fieldKey).toBe("env.GITHUB_TOKEN");
      expect(e.variable).toBe("GITHUB_TOKEN");
      expect(e.message).toContain("GITHUB_TOKEN");
    }
  });

  it("stage without mcpServers skips expansion entirely (backwards compat)", async () => {
    const ir: PipelineIR = {
      name: "no-mcp",
      stages: [
        {
          name: "s",
          type: "agent",
          inputs: [],
          outputs: [{ name: "o", type: "string" }],
          config: { promptRef: "p" },
        },
      ],
      wires: [],
      externalInputs: [],
    } as PipelineIR;

    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitResult = svc.submit(ir, { prompts: { p: "test" } });
    if (!submitResult.ok) {
      throw new Error(`submit failed: ${JSON.stringify(submitResult.diagnostics)}`);
    }

    const runResult = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "no-mcp",
      seedValues: {},
      workspaceDir: null,
    });
    expect(runResult.ok).toBe(true);
    if (!runResult.ok) return;

    // No envValues were supplied -> task_env_values untouched
    expect(loadTaskEnvValues(db, runResult.taskId)).toEqual({});

    // Stage's mcpServers is undefined, so the executor's guard would
    // short-circuit before calling expandMcpServers at all.
    const agentStage = ir.stages[0] as AgentStage;
    expect(agentStage.config.mcpServers).toBeUndefined();
  });

  it("multiple MCPs in one stage expand independently and all merge into SDK options", () => {
    const decls: McpServerDecl[] = [
      {
        name: "github",
        command: "npx",
        args: [],
        env: { GITHUB_TOKEN: "${GH}" },
        envKeys: ["GH"],
      },
      {
        name: "notion",
        command: "npx",
        args: [],
        env: { NOTION_TOKEN: "${NT}" },
        envKeys: ["NT"],
      },
    ];
    const expanded = expandMcpServers(decls, { GH: "gha", NT: "nta" }, {});
    expect(Object.keys(expanded).sort()).toEqual(["github", "notion"]);
    expect(expanded.github.env!.GITHUB_TOKEN).toBe("gha");
    expect(expanded.notion.env!.NOTION_TOKEN).toBe("nta");

    const opts = buildSdkBaseOptions({
      systemPromptAppend: "",
      kernelMcp: Symbol("kernel") as unknown as never,
      model: undefined,
      maxTurns: 5,
      maxBudgetUsd: undefined,
      claudePath: undefined,
      childEnv: {},
      subAgents: undefined,
      workspaceDir: undefined,
      externalMcpServers: expanded,
    });
    expect(Object.keys(opts.mcpServers!).sort()).toEqual([
      "__kernel_next__",
      "github",
      "notion",
    ]);
    expect(opts.mcpServers!.github).toEqual(expanded.github);
    expect(opts.mcpServers!.notion).toEqual(expanded.notion);
  });
});
