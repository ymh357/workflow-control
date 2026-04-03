import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSandboxOptions, buildQueryOptions } from "./query-options-builder.js";
import type { SandboxConfig } from "../lib/config-loader.js";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Helper to build minimal valid params for buildQueryOptions
const baseParams = (overrides: Record<string, unknown> = {}) => ({
  taskId: "t1",
  stageName: "stage1",
  appendPrompt: "do stuff",
  stageConfig: {
    thinking: { type: "enabled" },
    permissionMode: "default",
    debug: false,
    maxTurns: 10,
    maxBudgetUsd: 1,
    mcpServices: [],
  },
  localMcp: {} as Record<string, unknown>,
  claudePath: "/usr/bin/claude",
  ...overrides,
});

// ─── buildSandboxOptions ────────────────────────────────────────────

describe("buildSandboxOptions", () => {
  it("returns empty object when config is undefined", () => {
    expect(buildSandboxOptions(undefined)).toEqual({});
  });

  it("returns empty object when config.enabled is false", () => {
    expect(buildSandboxOptions({ enabled: false })).toEqual({});
  });

  it("returns empty object when config.enabled is missing (falsy)", () => {
    expect(buildSandboxOptions({} as SandboxConfig)).toEqual({});
  });

  it("returns sandbox with defaults when enabled=true and no other fields", () => {
    const result = buildSandboxOptions({ enabled: true });
    expect(result).toEqual({
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
      },
    });
  });

  it("respects explicit auto_allow_bash=false", () => {
    const result = buildSandboxOptions({ enabled: true, auto_allow_bash: false });
    expect((result as any).sandbox.autoAllowBashIfSandboxed).toBe(false);
  });

  it("does not inject network key when allowed_domains is empty array", () => {
    const result = buildSandboxOptions({
      enabled: true,
      network: { allowed_domains: [] },
    });
    expect((result as any).sandbox).not.toHaveProperty("network");
  });

  it("injects network.allowedDomains when domains are provided", () => {
    const result = buildSandboxOptions({
      enabled: true,
      network: { allowed_domains: ["example.com"] },
    });
    expect((result as any).sandbox.network).toEqual({ allowedDomains: ["example.com"] });
  });

  it("omits filesystem sub-keys when their arrays are empty", () => {
    const result = buildSandboxOptions({
      enabled: true,
      filesystem: { allow_write: [], deny_write: [], deny_read: [] },
    });
    // filesystem key is present but all sub-keys omitted
    expect((result as any).sandbox.filesystem).toEqual({});
  });

  it("maps all filesystem sub-keys correctly", () => {
    const result = buildSandboxOptions({
      enabled: true,
      filesystem: {
        allow_write: ["/tmp"],
        deny_write: ["/etc"],
        deny_read: ["/secret"],
      },
    });
    const fs = (result as any).sandbox.filesystem;
    expect(fs.allowWrite).toEqual(["/tmp"]);
    expect(fs.denyWrite).toEqual(["/etc"]);
    expect(fs.denyRead).toEqual(["/secret"]);
  });

  it("handles network key being undefined inside config", () => {
    const result = buildSandboxOptions({ enabled: true, network: undefined });
    expect((result as any).sandbox).not.toHaveProperty("network");
  });
});

// ─── buildQueryOptions ──────────────────────────────────────────────

describe("buildQueryOptions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns base fields with minimal params", () => {
    const opts = buildQueryOptions(baseParams() as any);
    expect(opts.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "do stuff",
    });
    expect(opts.maxTurns).toBe(10);
    expect(opts.maxBudgetUsd).toBe(1);
    expect(opts.permissionMode).toBe("default");
    expect(opts.includePartialMessages).toBe(true);
    expect(opts.pathToClaudeCodeExecutable).toBe("/usr/bin/claude");
  });

  it("does not inject mcpServers when localMcp is empty", () => {
    const opts = buildQueryOptions(baseParams() as any);
    expect(opts).not.toHaveProperty("mcpServers");
  });

  it("injects mcpServers when localMcp has entries", () => {
    const opts = buildQueryOptions(baseParams({ localMcp: { myServer: { url: "x" } } }) as any);
    expect(opts.mcpServers).toEqual({ myServer: { url: "x" } });
  });

  it("sets allowDangerouslySkipPermissions when permissionMode=bypassPermissions", () => {
    const opts = buildQueryOptions(baseParams({
      stageConfig: {
        thinking: { type: "enabled" },
        permissionMode: "bypassPermissions",
        debug: false,
        maxTurns: 5,
        maxBudgetUsd: 1,
        mcpServices: [],
      },
    }) as any);
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect(opts.permissionMode).toBe("bypassPermissions");
  });

  it("does not set allowDangerouslySkipPermissions for other permission modes", () => {
    const opts = buildQueryOptions(baseParams() as any);
    expect(opts).not.toHaveProperty("allowDangerouslySkipPermissions");
  });

  it("sets canUseTool only when both interactive and canUseTool are provided", () => {
    const mockFn = vi.fn();
    const opts = buildQueryOptions(baseParams({
      interactive: true,
      canUseTool: mockFn,
    }) as any);
    expect(opts.canUseTool).toBe(mockFn);
  });

  it("does not set canUseTool when interactive is false", () => {
    const opts = buildQueryOptions(baseParams({
      interactive: false,
      canUseTool: vi.fn(),
    }) as any);
    expect(opts).not.toHaveProperty("canUseTool");
  });

  it("does not set canUseTool when canUseTool callback is missing", () => {
    const opts = buildQueryOptions(baseParams({ interactive: true }) as any);
    expect(opts).not.toHaveProperty("canUseTool");
  });

  it("always includes ToolSearch in disallowedTools", () => {
    const opts = buildQueryOptions(baseParams() as any);
    expect((opts.disallowedTools as string[])).toContain("ToolSearch");
  });

  it("merges runtime.disallowed_tools into disallowedTools", () => {
    const opts = buildQueryOptions(baseParams({
      runtime: { engine: "llm", system_prompt: "", disallowed_tools: ["Bash", "Edit"] },
    }) as any);
    const list = opts.disallowedTools as string[];
    expect(list).toContain("ToolSearch");
    expect(list).toContain("Bash");
    expect(list).toContain("Edit");
  });

  it("handles runtime with no disallowed_tools (undefined)", () => {
    const opts = buildQueryOptions(baseParams({
      runtime: { engine: "llm", system_prompt: "" },
    }) as any);
    expect(opts.disallowedTools).toEqual(["ToolSearch", "mcp__claude_ai_*"]);
  });

  it("conditionally includes optional spread fields", () => {
    const opts = buildQueryOptions(baseParams({
      stageConfig: {
        model: "opus",
        thinking: { type: "enabled" },
        effort: "high",
        permissionMode: "default",
        debug: true,
        maxTurns: 3,
        maxBudgetUsd: 5,
        mcpServices: [],
      },
      cwd: "/workspace",
      resumeSessionId: "sess-123",
      outputFormat: { type: "json_schema", schema: { x: 1 } },
      agents: { helper: { description: "d", prompt: "p" } },
    }) as any);
    expect(opts.model).toBe("opus");
    expect(opts.effort).toBe("high");
    expect(opts.debug).toBe(true);
    expect(opts.cwd).toBe("/workspace");
    expect(opts.resume).toBe("sess-123");
    expect(opts.outputFormat).toEqual({ type: "json_schema", schema: { x: 1 } });
    expect(opts.agents).toHaveProperty("helper");
  });

  it("omits effort, model, cwd, resume, debug when not provided", () => {
    const opts = buildQueryOptions(baseParams() as any);
    expect(opts).not.toHaveProperty("effort");
    expect(opts).not.toHaveProperty("model");
    expect(opts).not.toHaveProperty("cwd");
    expect(opts).not.toHaveProperty("resume");
    expect(opts).not.toHaveProperty("debug");
  });

  it("merges sandbox options into the result when sandbox is enabled", () => {
    const opts = buildQueryOptions(baseParams({
      sandboxConfig: { enabled: true, network: { allowed_domains: ["api.com"] } },
    }) as any);
    expect((opts as any).sandbox.enabled).toBe(true);
    expect((opts as any).sandbox.network.allowedDomains).toEqual(["api.com"]);
  });

  it("does not include hooks key when hooks object is empty", () => {
    const opts = buildQueryOptions(baseParams({ hooks: {} }) as any);
    expect(opts).not.toHaveProperty("hooks");
  });

  it("includes hooks when hooks object has entries", () => {
    const hookObj = { preToolUse: [{ hooks: [vi.fn()] }] };
    const opts = buildQueryOptions(baseParams({ hooks: hookObj }) as any);
    expect(opts.hooks).toBe(hookObj);
  });

  it("sets env with CLAUDECODE and CI fields", () => {
    const opts = buildQueryOptions(baseParams() as any);
    const env = opts.env as Record<string, string>;
    expect(env.CLAUDECODE).toBe("");
    expect(env.CI).toBe("true");
  });
});
