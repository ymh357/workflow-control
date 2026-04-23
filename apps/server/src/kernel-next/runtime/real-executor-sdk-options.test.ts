import { describe, it, expect } from "vitest";
import { buildSdkBaseOptions } from "./real-executor-sdk-options.js";

describe("real-executor-sdk-options: buildSdkBaseOptions", () => {
  it("wires kernel-next MCP under the __kernel_next__ key", () => {
    const mockMcp = Symbol("mock") as unknown as never;
    const opts = buildSdkBaseOptions({
      systemPromptAppend: "sys",
      kernelMcp: mockMcp,
      model: "claude-sonnet-4-6",
      maxTurns: 10,
      maxBudgetUsd: 1,
      claudePath: "/bin/claude",
      childEnv: {},
      subAgents: undefined,
      workspaceDir: undefined,
    });
    expect(opts.mcpServers).toHaveProperty("__kernel_next__");
    expect(opts.mcpServers!.__kernel_next__).toBe(mockMcp);
    expect(opts.model).toBe("claude-sonnet-4-6");
    expect(opts.disallowedTools).toEqual(["ToolSearch", "mcp__claude_ai_*"]);
    expect(opts.permissionMode).toBe("bypassPermissions");
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.settingSources).toEqual([]);
    expect(opts.maxTurns).toBe(10);
    expect(opts.maxBudgetUsd).toBe(1);
  });

  it("uses preset claude_code system prompt with the given append", () => {
    const opts = buildSdkBaseOptions({
      systemPromptAppend: "hello",
      kernelMcp: Symbol() as unknown as never,
      model: undefined,
      maxTurns: 5,
      maxBudgetUsd: undefined,
      claudePath: undefined,
      childEnv: {},
      subAgents: undefined,
      workspaceDir: undefined,
    });
    expect(opts.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "hello",
    });
  });

  it("omits agents field when subAgents empty or undefined", () => {
    const opts = buildSdkBaseOptions({
      systemPromptAppend: "",
      kernelMcp: Symbol() as unknown as never,
      model: undefined,
      maxTurns: 5,
      maxBudgetUsd: undefined,
      claudePath: undefined,
      childEnv: {},
      subAgents: undefined,
      workspaceDir: undefined,
    });
    expect(opts.agents).toBeUndefined();
  });

  it("omits cwd when workspaceDir undefined", () => {
    const opts = buildSdkBaseOptions({
      systemPromptAppend: "",
      kernelMcp: Symbol() as unknown as never,
      model: undefined,
      maxTurns: 5,
      maxBudgetUsd: undefined,
      claudePath: undefined,
      childEnv: {},
      subAgents: undefined,
      workspaceDir: undefined,
    });
    expect(opts.cwd).toBeUndefined();
  });

  it("sets cwd when workspaceDir provided", () => {
    const opts = buildSdkBaseOptions({
      systemPromptAppend: "",
      kernelMcp: Symbol() as unknown as never,
      model: undefined,
      maxTurns: 5,
      maxBudgetUsd: undefined,
      claudePath: undefined,
      childEnv: {},
      subAgents: undefined,
      workspaceDir: "/tmp/wd",
    });
    expect(opts.cwd).toBe("/tmp/wd");
  });
});
