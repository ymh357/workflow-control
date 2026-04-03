import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSandboxOptions, buildQueryOptions } from "./query-options-builder.js";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

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

describe("adversarial: buildSandboxOptions partial filesystem config", () => {
  it("includes only populated filesystem sub-keys", () => {
    const result = buildSandboxOptions({
      enabled: true,
      filesystem: {
        allow_write: ["/tmp"],
        deny_write: [],
        // deny_read is undefined
      },
    } as any);
    const fs = (result as any).sandbox.filesystem;
    expect(fs.allowWrite).toEqual(["/tmp"]);
    expect(fs).not.toHaveProperty("denyWrite");
    expect(fs).not.toHaveProperty("denyRead");
  });

  it("does not include filesystem key when filesystem is undefined", () => {
    const result = buildSandboxOptions({ enabled: true });
    expect((result as any).sandbox).not.toHaveProperty("filesystem");
  });
});

describe("adversarial: buildSandboxOptions boolean edge cases", () => {
  it("allow_unsandboxed_commands defaults to true", () => {
    const result = buildSandboxOptions({ enabled: true });
    expect((result as any).sandbox.allowUnsandboxedCommands).toBe(true);
  });

  it("explicit allow_unsandboxed_commands=false is respected", () => {
    const result = buildSandboxOptions({ enabled: true, allow_unsandboxed_commands: false });
    expect((result as any).sandbox.allowUnsandboxedCommands).toBe(false);
  });
});

describe("adversarial: buildQueryOptions env always includes process.env", () => {
  it("includes existing process.env variables in output env", () => {
    const opts = buildQueryOptions(baseParams() as any);
    const env = opts.env as Record<string, string>;
    // process.env.PATH should be inherited
    expect(env.PATH).toBeDefined();
  });

  it("CLAUDECODE is always empty string regardless of process.env", () => {
    const originalClaudeCode = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "should-be-overwritten";
    try {
      const opts = buildQueryOptions(baseParams() as any);
      expect((opts.env as any).CLAUDECODE).toBe("");
    } finally {
      if (originalClaudeCode === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = originalClaudeCode;
    }
  });
});

describe("adversarial: buildQueryOptions sandbox overrides other keys", () => {
  it("sandbox options merge at top level and can coexist with other keys", () => {
    const opts = buildQueryOptions(baseParams({
      sandboxConfig: { enabled: true, network: { allowed_domains: ["api.com"] } },
      cwd: "/workspace",
      resumeSessionId: "sess-1",
    }) as any);

    expect((opts as any).sandbox.enabled).toBe(true);
    expect(opts.cwd).toBe("/workspace");
    expect(opts.resume).toBe("sess-1");
  });
});

describe("adversarial: buildQueryOptions disallowedTools edge cases", () => {
  it("handles runtime.disallowed_tools being an empty array", () => {
    const opts = buildQueryOptions(baseParams({
      runtime: { engine: "llm", system_prompt: "", disallowed_tools: [] },
    }) as any);
    expect(opts.disallowedTools).toEqual(["ToolSearch", "mcp__claude_ai_*"]);
  });

  it("handles runtime being undefined — only ToolSearch + claude_ai block in disallowed", () => {
    const opts = buildQueryOptions(baseParams({ runtime: undefined }) as any);
    expect(opts.disallowedTools).toEqual(["ToolSearch", "mcp__claude_ai_*"]);
  });

  it("deduplication is NOT performed — duplicate ToolSearch if in runtime list too", () => {
    const opts = buildQueryOptions(baseParams({
      runtime: { engine: "llm", system_prompt: "", disallowed_tools: ["ToolSearch"] },
    }) as any);
    // The code does: ["ToolSearch", "mcp__claude_ai_*", ...(runtime?.disallowed_tools ?? [])]
    expect((opts.disallowedTools as string[]).filter(t => t === "ToolSearch")).toHaveLength(2);
  });
});

describe("adversarial: buildQueryOptions thinking and effort", () => {
  it("includes effort only when defined (not empty string)", () => {
    const opts = buildQueryOptions(baseParams({
      stageConfig: {
        thinking: { type: "enabled" },
        permissionMode: "default",
        debug: false,
        maxTurns: 10,
        maxBudgetUsd: 1,
        mcpServices: [],
        effort: "",
      },
    }) as any);
    // Empty string is falsy, so effort should NOT be included
    expect(opts).not.toHaveProperty("effort");
  });
});

describe("adversarial: buildQueryOptions agents passthrough", () => {
  it("passes agents object directly without transformation", () => {
    const agentDefs = {
      researcher: { description: "Research agent", prompt: "research stuff", model: "opus" },
    };
    const opts = buildQueryOptions(baseParams({ agents: agentDefs }) as any);
    expect(opts.agents).toBe(agentDefs);
  });

  it("does not include agents key when agents is undefined", () => {
    const opts = buildQueryOptions(baseParams({ agents: undefined }) as any);
    expect(opts).not.toHaveProperty("agents");
  });
});
