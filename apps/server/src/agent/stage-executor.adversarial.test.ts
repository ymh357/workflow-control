import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../sse/manager.js", () => ({
  sseManager: { pushMessage: vi.fn() },
}));

vi.mock("../lib/config-loader.js", () => ({
  loadSystemSettings: vi.fn(() => ({
    paths: { claude_executable: "/usr/bin/claude", gemini_executable: "/usr/bin/gemini" },
    agent: { default_engine: "claude", default_model: "sonnet" },
  })),
  isParallelGroup: (entry: any) => entry && typeof entry === "object" && "parallel" in entry,
  flattenStages: (entries: any[]) => {
    const result: any[] = [];
    for (const e of entries) {
      if (e && typeof e === "object" && "parallel" in e) {
        result.push(...e.parallel.stages);
      } else {
        result.push(e);
      }
    }
    return result;
  },
}));

vi.mock("../lib/mcp-config.js", () => ({
  buildMcpServers: vi.fn(() => ({})),
}));

vi.mock("../lib/config/mcp.js", () => ({
  loadMcpRegistry: vi.fn(() => null),
  buildMcpFromRegistry: vi.fn(() => null),
}));

vi.mock("./context-builder.js", () => ({
  buildTier1Context: vi.fn(() => "tier1-context"),
}));

vi.mock("./gemini-executor.js", () => ({
  queryGemini: vi.fn(() => ({
    effectiveCwd: "/tmp/gemini-cwd",
    [Symbol.asyncIterator]: async function* () { yield { type: "result" }; },
    interrupt: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("./codex-executor.js", () => ({
  queryCodex: vi.fn(() => ({
    effectiveCwd: "/tmp/codex-cwd",
    [Symbol.asyncIterator]: async function* () { yield { type: "result" }; },
    interrupt: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("../lib/store-reader-mcp.js", () => ({
  createStoreReaderMcp: vi.fn(() => ({ type: "sdk", name: "__store__" })),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn(() => ({ type: "sdk", name: "__store__" })),
  query: vi.fn(() => ({
    [Symbol.asyncIterator]: async function* () { yield { type: "result" }; },
    interrupt: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("./prompt-builder.js", () => ({
  buildSystemAppendPrompt: vi.fn(async () => ({ prompt: "append-prompt", fragmentIds: [] })),
  buildEffectivePrompt: vi.fn(() => "effective-prompt"),
  buildStaticPromptPrefix: vi.fn(() => "static-prefix"),
}));

vi.mock("./query-options-builder.js", () => ({
  buildQueryOptions: vi.fn(() => ({})),
}));

vi.mock("./stream-processor.js", () => ({
  processAgentStream: vi.fn(async () => ({
    resultText: "done",
    sessionId: "sess-1",
    costUsd: 0.01,
    durationMs: 1000,
  })),
}));

vi.mock("./output-schema.js", () => ({
  outputSchemaToJsonSchema: vi.fn(() => ({ type: "object" })),
}));

vi.mock("./executor-hooks.js", () => ({
  createAskUserQuestionInterceptor: vi.fn(() => vi.fn()),
  createSpecAuditHook: vi.fn(() => vi.fn()),
  createPathRestrictionHook: vi.fn(() => vi.fn().mockResolvedValue({ decision: "approve" })),
}));

vi.mock("../machine/actor-registry.js", () => ({
  getWorkflow: vi.fn(),
}));

import { executeStage } from "./stage-executor.js";
import { queryGemini } from "./gemini-executor.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { processAgentStream } from "./stream-processor.js";
import { buildQueryOptions } from "./query-options-builder.js";
import { buildMcpServers } from "../lib/mcp-config.js";
import { sseManager } from "../sse/manager.js";
import { loadSystemSettings } from "../lib/config-loader.js";
import { loadMcpRegistry, buildMcpFromRegistry } from "../lib/config/mcp.js";
import type { WorkflowContext } from "../machine/types.js";

function makeContext(overrides?: Partial<WorkflowContext>): WorkflowContext {
  return {
    taskId: "task-1",
    status: "running",
    retryCount: 0,
    qaRetryCount: 0,
    store: {},
    stageSessionIds: {},
    config: {
      pipelineName: "test",
      pipeline: { stages: [] },
      prompts: {
        system: {},
        fragments: {},
        globalConstraints: "",
        globalClaudeMd: "",
        globalGeminiMd: "",
        globalCodexMd: "",
      },
      skills: [],
      mcps: [],
    },
    ...overrides,
  } as WorkflowContext;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────
// Scenario: Engine selection fallback chain
// ────────────────────────────────────────────────────────────

describe("engine should fall through stage → pipeline → private config → system settings", () => {
  it("uses system settings engine when all other levels are missing", async () => {
    vi.mocked(loadSystemSettings).mockReturnValue({
      paths: { claude_executable: "/usr/bin/claude", gemini_executable: "/usr/bin/gemini" },
      agent: { default_engine: "gemini" },
    } as any);

    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "build" }] } as any,
      },
    });

    await executeStage("task-1", "build", "prompt", "stage-prompt", {
      injectedContext: ctx,
    });

    expect(queryGemini).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Gemini approval mode mapping
// ────────────────────────────────────────────────────────────

describe("gemini approval mode should map from permission_mode correctly", () => {
  it("unknown permission_mode defaults to yolo", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: {
          stages: [{ name: "build", engine: "gemini", permission_mode: "unknownMode" }],
        } as any,
      },
    });

    await executeStage("task-1", "build", "prompt", "stage-prompt", {
      injectedContext: ctx,
    });

    const callArgs = vi.mocked(queryGemini).mock.calls[0][0];
    expect(callArgs.options.approvalMode).toBe("yolo");
  });

  it("'plan' permission_mode maps to 'plan'", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: {
          stages: [{ name: "build", engine: "gemini", permission_mode: "plan" }],
        } as any,
      },
    });

    await executeStage("task-1", "build", "prompt", "stage-prompt", {
      injectedContext: ctx,
    });

    const callArgs = vi.mocked(queryGemini).mock.calls[0][0];
    expect(callArgs.options.approvalMode).toBe("plan");
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: MCP services in stage config
// ────────────────────────────────────────────────────────────

describe("stage MCPs should be passed to buildMcpServers", () => {
  it("passes stage-level mcps when defined", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: {
          stages: [{ name: "build", mcps: ["stage-mcp"] }],
        } as any,
      },
    });

    await executeStage("task-1", "build", "prompt", "stage-prompt", {
      injectedContext: ctx,
    });

    expect(buildMcpServers).toHaveBeenCalledWith(["stage-mcp"], expect.any(String));
  });

  it("passes empty array when stage has no mcps", async () => {
    const ctx = makeContext();

    await executeStage("task-1", "build", "prompt", "stage-prompt", {
      injectedContext: ctx,
    });

    expect(buildMcpServers).toHaveBeenCalledWith([], expect.any(String));
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: SSE mcp_init event
// ────────────────────────────────────────────────────────────

describe("mcp_init SSE event should only fire when MCPs exist", () => {
  it("sends mcp_init when stage has MCPs", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: {
          stages: [{ name: "build", mcps: ["some-mcp"] }],
        } as any,
      },
    });

    await executeStage("task-1", "build", "prompt", "stage-prompt", { injectedContext: ctx });

    const calls = vi.mocked(sseManager.pushMessage).mock.calls;
    const mcpInit = calls.filter(([, msg]) => (msg as any).type === "agent_progress" && (msg as any).data?.phase === "mcp_init");
    expect(mcpInit.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT send mcp_init when stage has no MCPs", async () => {
    await executeStage("task-1", "build", "prompt", "stage-prompt", { injectedContext: makeContext() });

    const calls = vi.mocked(sseManager.pushMessage).mock.calls;
    const mcpInit = calls.filter(([, msg]) => (msg as any).data?.phase === "mcp_init");
    expect(mcpInit).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Gemini cwd fallback
// ────────────────────────────────────────────────────────────

describe("result.cwd should fall back to original cwd when gemini has none", () => {
  it("uses original cwd when gemini query has no effectiveCwd", async () => {
    vi.mocked(queryGemini).mockReturnValue({
      [Symbol.asyncIterator]: async function* () { yield { type: "result" }; },
      interrupt: vi.fn(),
      close: vi.fn(),
    } as any);
    vi.mocked(processAgentStream).mockResolvedValueOnce({
      resultText: "done", sessionId: "s", costUsd: 0, durationMs: 0,
    });

    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "build", engine: "gemini" }] } as any,
      },
    });

    const result = await executeStage("task-1", "build", "prompt", "stage-prompt", {
      injectedContext: ctx, cwd: "/original/cwd",
    });

    expect(result.cwd).toBe("/original/cwd");
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Gemini prompt concatenation
// ────────────────────────────────────────────────────────────

describe("gemini should receive concatenated appendPrompt + effectivePrompt", () => {
  it("concatenates with separator", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: {
          stages: [{ name: "build", engine: "gemini" }],
        } as any,
      },
    });

    await executeStage("task-1", "build", "prompt", "stage-prompt", { injectedContext: ctx });

    const callArgs = vi.mocked(queryGemini).mock.calls[0][0];
    expect(callArgs.prompt).toContain("append-prompt");
    expect(callArgs.prompt).toContain("---");
    expect(callArgs.prompt).toContain("effective-prompt");
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: processAgentStream receives correct resumeDepth
// ────────────────────────────────────────────────────────────

describe("onResume callback should preserve stageOpts and increment depth", () => {
  it("passes resumeDepth 0 on first call", async () => {
    await executeStage("task-1", "build", "prompt", "stage-prompt", {
      injectedContext: makeContext(),
      cwd: "/cwd",
    });

    expect(vi.mocked(processAgentStream).mock.calls[0][0].resumeDepth).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: PulseMCP auto-injection for analyzing stage
// ────────────────────────────────────────────────────────────

describe("analyzing stage should always have pulsemcp available", () => {
  it("injects pulsemcp when not in stage mcps", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "analyzing", mcps: ["context7"] }] } as any,
      },
    });

    await executeStage("task-1", "analyzing", "prompt", "stage-prompt", { injectedContext: ctx });

    expect(buildMcpServers).toHaveBeenCalledWith(
      expect.arrayContaining(["context7", "pulsemcp"]),
      expect.any(String),
    );
  });

  it("does not duplicate pulsemcp if already in stage mcps", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "analyzing", mcps: ["pulsemcp", "context7"] }] } as any,
      },
    });

    await executeStage("task-1", "analyzing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps.filter(m => m === "pulsemcp")).toHaveLength(1);
  });

  it("does not inject pulsemcp for non-analyzing stages", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing" }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps).not.toContain("pulsemcp");
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Dynamic MCP injection from analyzing stage output
// ────────────────────────────────────────────────────────────

describe("downstream stages should pick up MCPs recommended by analysis", () => {
  it("merges a recommended MCP that exists in registry", async () => {
    vi.mocked(loadMcpRegistry).mockReturnValue({
      "new-mcp": { command: "npx", args: ["-y", "new-mcp"] },
    } as any);
    vi.mocked(buildMcpFromRegistry).mockReturnValue({ command: "npx", args: ["-y", "new-mcp"] } as any);

    const ctx = makeContext({
      store: { analysis: { recommendedMcps: ["new-mcp"] } },
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing", mcps: ["context7"] }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    expect(buildMcpServers).toHaveBeenCalledWith(
      expect.arrayContaining(["context7", "new-mcp"]),
      expect.any(String),
    );
  });

  it("analyzing stage does NOT consume its own recommendations (it is the producer)", async () => {
    vi.mocked(loadMcpRegistry).mockReturnValue({
      "new-mcp": { command: "npx", args: ["-y", "new-mcp"] },
    } as any);
    vi.mocked(buildMcpFromRegistry).mockReturnValue({ command: "npx", args: ["-y", "new-mcp"] } as any);

    const ctx = makeContext({
      store: { analysis: { recommendedMcps: ["new-mcp"] } },
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "analyzing" }] } as any,
      },
    });

    await executeStage("task-1", "analyzing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps).not.toContain("new-mcp");
  });

  it("ignores recommended MCPs not in the registry", async () => {
    vi.mocked(loadMcpRegistry).mockReturnValue({} as any);

    const ctx = makeContext({
      store: { analysis: { recommendedMcps: ["ghost-mcp"] } },
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing" }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps).not.toContain("ghost-mcp");
  });

  it("ignores recommended MCPs that fail credential check", async () => {
    vi.mocked(loadMcpRegistry).mockReturnValue({
      "needs-key": { command: "npx", env: { KEY: "${MISSING}" } },
    } as any);
    vi.mocked(buildMcpFromRegistry).mockReturnValue(null);

    const ctx = makeContext({
      store: { analysis: { recommendedMcps: ["needs-key"] } },
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing" }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps).not.toContain("needs-key");
  });

  it("does not duplicate MCPs already in static stage config", async () => {
    vi.mocked(loadMcpRegistry).mockReturnValue({ context7: { command: "npx" } } as any);
    vi.mocked(buildMcpFromRegistry).mockReturnValue({ command: "npx" } as any);

    const ctx = makeContext({
      store: { analysis: { recommendedMcps: ["context7"] } },
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing", mcps: ["context7"] }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps.filter(m => m === "context7")).toHaveLength(1);
  });

  it("deduplicates repeated entries in recommendedMcps", async () => {
    vi.mocked(loadMcpRegistry).mockReturnValue({
      "new-mcp": { command: "npx", args: ["-y", "new-mcp"] },
    } as any);
    vi.mocked(buildMcpFromRegistry).mockReturnValue({ command: "npx", args: ["-y", "new-mcp"] } as any);

    const ctx = makeContext({
      store: { analysis: { recommendedMcps: ["new-mcp", "new-mcp", "new-mcp"] } },
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing" }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps.filter(m => m === "new-mcp")).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────
// Scenario: Poisoned / malformed recommendedMcps data
// ────────────────────────────────────────────────────────────

describe("malformed store data should not crash stage execution", () => {
  it("handles recommendedMcps as a string instead of array", async () => {
    const ctx = makeContext({
      store: { analysis: { recommendedMcps: "not-an-array" } },
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing", mcps: ["context7"] }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps).toEqual(["context7"]);
  });

  it("filters out non-string entries from recommendedMcps", async () => {
    vi.mocked(loadMcpRegistry).mockReturnValue({ valid: { command: "npx" } } as any);
    vi.mocked(buildMcpFromRegistry).mockReturnValue({ command: "npx" } as any);

    const ctx = makeContext({
      store: {
        analysis: {
          recommendedMcps: [null, undefined, 42, true, "", { name: "obj" }, "valid"],
        },
      },
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing" }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps).toEqual(["valid"]);
  });

  it("handles context.store being null", async () => {
    const ctx = makeContext({
      store: null as any,
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing", mcps: ["context7"] }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps).toEqual(["context7"]);
  });

  it("handles context.store.analysis being a non-object", async () => {
    const ctx = makeContext({
      store: { analysis: "not an object" } as any,
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing", mcps: ["context7"] }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps).toEqual(["context7"]);
  });

  it("handles empty recommendedMcps array gracefully", async () => {
    vi.mocked(loadMcpRegistry).mockReturnValue({ m: { command: "npx" } } as any);

    const ctx = makeContext({
      store: { analysis: { recommendedMcps: [] } },
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing", mcps: ["context7"] }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps).toEqual(["context7"]);
  });

  it("catches loadMcpRegistry throwing and returns static MCPs", async () => {
    vi.mocked(loadMcpRegistry).mockImplementation(() => { throw new Error("YAML parse error"); });

    const ctx = makeContext({
      store: { analysis: { recommendedMcps: ["bad-mcp"] } },
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing", mcps: ["context7"] }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps).toEqual(["context7"]);
  });

  it("catches buildMcpFromRegistry throwing and returns static MCPs", async () => {
    vi.mocked(loadMcpRegistry).mockReturnValue({ "crash-mcp": { command: "npx" } } as any);
    vi.mocked(buildMcpFromRegistry).mockImplementation(() => { throw new Error("env interpolation error"); });

    const ctx = makeContext({
      store: { analysis: { recommendedMcps: ["crash-mcp"] } },
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "implementing", mcps: ["context7"] }] } as any,
      },
    });

    await executeStage("task-1", "implementing", "prompt", "stage-prompt", { injectedContext: ctx });

    const mcps = vi.mocked(buildMcpServers).mock.calls[0][0] as string[];
    expect(mcps).toEqual(["context7"]);
  });
});
