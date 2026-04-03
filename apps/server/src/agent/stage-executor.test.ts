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
  sseManager: {
    pushMessage: vi.fn(),
  },
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
  buildSystemAppendPrompt: vi.fn(async () => "append-prompt"),
  buildEffectivePrompt: vi.fn(({ isResume, resumeSync, resumePrompt }) => {
    if (isResume && resumeSync) return "SYNC_RESUME_PROMPT";
    if (isResume && resumePrompt) return `RESUME: ${resumePrompt}`;
    return "effective-prompt";
  }),
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
}));

vi.mock("../machine/actor-registry.js", () => ({
  getWorkflow: vi.fn(),
}));

import { executeStage, type StageOpts } from "./stage-executor.js";
import { queryGemini } from "./gemini-executor.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildEffectivePrompt } from "./prompt-builder.js";
import { processAgentStream } from "./stream-processor.js";
import { sseManager } from "../sse/manager.js";
import { loadSystemSettings } from "../lib/config-loader.js";
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

describe("executeStage - engine routing", () => {
  it("routes to claude query() when engine is claude", async () => {
    const ctx = makeContext();
    await executeStage("task-1", "build", "do stuff", "stage-prompt", {
      injectedContext: ctx,
    });

    expect(query).toHaveBeenCalled();
    expect(queryGemini).not.toHaveBeenCalled();
  });

  it("routes to queryGemini when stage engine is gemini", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: {
          stages: [{ name: "build", engine: "gemini" }],
        } as any,
      },
    });
    await executeStage("task-1", "build", "do stuff", "stage-prompt", {
      injectedContext: ctx,
    });

    expect(queryGemini).toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("falls back to pipeline-level engine when stage has no engine", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: {
          engine: "gemini",
          stages: [{ name: "build" }],
        } as any,
      },
    });
    await executeStage("task-1", "build", "do stuff", "stage-prompt", {
      injectedContext: ctx,
    });

    expect(queryGemini).toHaveBeenCalled();
  });

  it("falls back to agent.default_engine from private config", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "build" }] } as any,
        agent: { default_engine: "gemini" },
      },
    });
    await executeStage("task-1", "build", "do stuff", "stage-prompt", {
      injectedContext: ctx,
    });

    expect(queryGemini).toHaveBeenCalled();
  });
});

describe("executeStage - resume prompt construction", () => {
  it("passes resumeSync=true to buildEffectivePrompt for sync resume", async () => {
    const ctx = makeContext();
    await executeStage("task-1", "build", "do stuff", "stage-prompt", {
      injectedContext: ctx,
      resumeSessionId: "sess-old",
      resumeSync: true,
    });

    expect(buildEffectivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        isResume: true,
        resumeSync: true,
      }),
    );
  });

  it("passes resumePrompt as feedback for normal resume", async () => {
    const ctx = makeContext();
    await executeStage("task-1", "build", "do stuff", "stage-prompt", {
      injectedContext: ctx,
      resumeSessionId: "sess-old",
      resumePrompt: "please fix the tests",
    });

    expect(buildEffectivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        isResume: true,
        resumePrompt: "please fix the tests",
      }),
    );
  });

  it("does not set isResume when resumeSessionId is missing", async () => {
    const ctx = makeContext();
    await executeStage("task-1", "build", "do stuff", "stage-prompt", {
      injectedContext: ctx,
    });

    expect(buildEffectivePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ isResume: false }),
    );
  });
});

describe("executeStage - missing context", () => {
  it("throws when no workflow context and actor registry returns nothing", async () => {
    const { getWorkflow } = await import("../machine/actor-registry.js");
    vi.mocked(getWorkflow).mockReturnValue(undefined as any);

    await expect(
      executeStage("task-missing", "build", "do stuff", "stage-prompt"),
    ).rejects.toThrow("No workflow context available for task task-missing");
  });

  it("throws when actor exists but snapshot has no context", async () => {
    const { getWorkflow } = await import("../machine/actor-registry.js");
    vi.mocked(getWorkflow).mockReturnValue({
      getSnapshot: () => ({ context: undefined }),
    } as any);

    await expect(
      executeStage("task-no-ctx", "build", "do stuff", "stage-prompt"),
    ).rejects.toThrow("No workflow context available");
  });
});

describe("executeStage - SSE events", () => {
  it("pushes stage_change SSE when not resuming", async () => {
    const ctx = makeContext();
    await executeStage("task-1", "build", "do stuff", "stage-prompt", {
      injectedContext: ctx,
    });

    expect(sseManager.pushMessage).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({ type: "stage_change" }),
    );
  });

  it("does NOT push stage_change SSE when resuming", async () => {
    const ctx = makeContext();
    await executeStage("task-1", "build", "do stuff", "stage-prompt", {
      injectedContext: ctx,
      resumeSessionId: "sess-old",
    });

    const calls = vi.mocked(sseManager.pushMessage).mock.calls;
    const stageChangeCalls = calls.filter(([, msg]) => (msg as any).type === "stage_change");
    expect(stageChangeCalls).toHaveLength(0);
  });
});

describe("executeStage - gemini cwd propagation", () => {
  it("returns effectiveCwd from gemini query in result", async () => {
    const ctx = makeContext({
      config: {
        ...makeContext().config!,
        pipeline: { stages: [{ name: "build", engine: "gemini" }] } as any,
      },
    });

    vi.mocked(processAgentStream).mockResolvedValueOnce({
      resultText: "done",
      sessionId: "s",
      costUsd: 0,
      durationMs: 0,
    });

    const result = await executeStage("task-1", "build", "do stuff", "stage-prompt", {
      injectedContext: ctx,
      cwd: "/original",
    });

    // effectiveCwd from gemini query (/tmp/gemini-cwd) should override cwd
    expect(result.cwd).toBe("/tmp/gemini-cwd");
  });
});
