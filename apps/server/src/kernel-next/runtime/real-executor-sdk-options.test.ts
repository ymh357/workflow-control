import { describe, it, expect } from "vitest";
import type { SubAgentDef } from "../ir/schema.js";
import { buildSdkBaseOptions } from "./real-executor-sdk-options.js";
import type { ExpandedMcpServer } from "./mcp-servers-expander.js";

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

  it("omits agents field when subAgents is an empty array", () => {
    const opts = buildSdkBaseOptions({
      systemPromptAppend: "",
      kernelMcp: Symbol() as unknown as never,
      model: undefined,
      maxTurns: 5,
      maxBudgetUsd: undefined,
      claudePath: undefined,
      childEnv: {},
      subAgents: [],
      workspaceDir: undefined,
    });
    expect(opts.agents).toBeUndefined();
  });

  it("populates agents map when subAgents array provided", () => {
    const subAgents: SubAgentDef[] = [
      { name: "researcher", description: "does research", prompt: "you research things" },
    ];
    const opts = buildSdkBaseOptions({
      systemPromptAppend: "",
      kernelMcp: Symbol() as unknown as never,
      model: undefined,
      maxTurns: 5,
      maxBudgetUsd: undefined,
      claudePath: undefined,
      childEnv: {},
      subAgents,
      workspaceDir: undefined,
    });
    expect(opts.agents).toBeDefined();
    expect(opts.agents).toHaveProperty("researcher");
    expect(opts.agents!["researcher"]).toEqual({
      description: "does research",
      prompt: "you research things",
    });
  });

  it("passes through tools/model/maxTurns from SubAgentDef when present", () => {
    const subAgents: SubAgentDef[] = [
      {
        name: "r",
        description: "d",
        prompt: "p",
        tools: ["Read"],
        model: "sonnet",
        maxTurns: 3,
      },
    ];
    const opts = buildSdkBaseOptions({
      systemPromptAppend: "",
      kernelMcp: Symbol() as unknown as never,
      model: undefined,
      maxTurns: 5,
      maxBudgetUsd: undefined,
      claudePath: undefined,
      childEnv: {},
      subAgents,
      workspaceDir: undefined,
    });
    expect(opts.agents).toBeDefined();
    expect(opts.agents!["r"]).toEqual({
      description: "d",
      prompt: "p",
      tools: ["Read"],
      model: "sonnet",
      maxTurns: 3,
    });
  });

  it("omits absent optional fields from SubAgentDef entry (no tools/model/maxTurns keys)", () => {
    const subAgents: SubAgentDef[] = [
      { name: "writer", description: "writes things", prompt: "you write" },
    ];
    const opts = buildSdkBaseOptions({
      systemPromptAppend: "",
      kernelMcp: Symbol() as unknown as never,
      model: undefined,
      maxTurns: 5,
      maxBudgetUsd: undefined,
      claudePath: undefined,
      childEnv: {},
      subAgents,
      workspaceDir: undefined,
    });
    const entry = opts.agents!["writer"];
    expect(entry).not.toHaveProperty("tools");
    expect(entry).not.toHaveProperty("model");
    expect(entry).not.toHaveProperty("maxTurns");
  });

  it("passes childEnv through as opts.env", () => {
    const env = { FOO: "bar", BAZ: "qux" };
    const opts = buildSdkBaseOptions({
      systemPromptAppend: "",
      kernelMcp: Symbol() as unknown as never,
      model: undefined,
      maxTurns: 5,
      maxBudgetUsd: undefined,
      claudePath: undefined,
      childEnv: env,
      subAgents: undefined,
      workspaceDir: undefined,
    });
    expect(opts.env).toEqual(env);
  });

  it("merges externalMcpServers alongside __kernel_next__", () => {
    const external: Record<string, ExpandedMcpServer> = {
      github: { type: "stdio", command: "npx", args: ["-y", "@mcp/server-github"], env: { GITHUB_TOKEN: "ghp_x" } },
    };
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
      externalMcpServers: external,
    });
    expect(opts.mcpServers).toHaveProperty("__kernel_next__");
    expect(opts.mcpServers).toHaveProperty("github");
    expect(opts.mcpServers!.github).toEqual(external.github);
  });

  it("ignores absent externalMcpServers (backwards compat)", () => {
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
    expect(Object.keys(opts.mcpServers!)).toEqual(["__kernel_next__"]);
  });
});
