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

vi.mock("../lib/config-loader.js", () => ({
  loadSystemSettings: vi.fn(() => ({
    paths: { worktrees_base: "/tmp/worktrees" },
  })),
  getNestedValue(obj: Record<string, any> | undefined | null, path: string): any {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: any, part: string) => acc?.[part], obj);
  },
}));

vi.mock("../lib/git.js", () => ({
  createWorktree: vi.fn(async () => "/tmp/worktrees/my-branch"),
  installDepsInWorktree: vi.fn(async () => {}),
  resolveRepoPath: vi.fn(() => "/repos/my-repo"),
  initRepo: vi.fn(async () => "/repos/new-repo"),
  resolveHeadRef: vi.fn(async () => null),
  captureStageDiff: vi.fn(async () => null),
  WORKTREE_DIFF_MAX_BYTES: 1024,
}));

vi.mock("../lib/worktree-injector.js", () => ({
  injectWorktreeConfig: vi.fn(),
}));

vi.mock("./stage-executor.js", () => ({
  executeStage: vi.fn(async () => ({
    resultText: "stage-done",
    sessionId: "sess-1",
    costUsd: 0.05,
    durationMs: 2000,
    cwd: "/tmp/worktrees/my-branch",
  })),
}));

vi.mock("../scripts/index.js", () => ({
  scriptRegistry: {
    getOrLoadDynamic: vi.fn(),
  },
}));

vi.mock("./context-builder.js", () => ({
  buildTier1Context: vi.fn(() => "tier1"),
}));

// Phase 1 / A1: mock the writer module so we can assert the runAgent wiring
// without touching SQLite. createExecutionRecordWriter returns a stub that
// records every method call.
const writerStub = vi.hoisted(() => ({
  attemptId: "att-test",
  isNoop: false,
  appendToolCall: vi.fn(),
  completeToolCall: vi.fn(),
  appendAgentStream: vi.fn(),
  recordPrecompact: vi.fn(),
  updateCost: vi.fn(),
  updateSessionId: vi.fn(),
  heartbeat: vi.fn(),
  close: vi.fn(),
  __flushForTests: vi.fn(),
}));
const createWriterSpy = vi.hoisted(() => vi.fn(() => writerStub));
vi.mock("../lib/execution-record/writer.js", () => ({
  createExecutionRecordWriter: createWriterSpy,
}));

vi.mock("../lib/config/stage-lookup.js", () => ({
  findStageConfig: vi.fn(() => undefined),
}));

// Mock the session-manager registry so runAgentSingleSession tests don't
// actually spin up a Claude SDK session. The stub's executeStage returns
// a canned result; individual tests override via mockResolvedValueOnce.
const sessionMgrStub = vi.hoisted(() => ({
  executeStage: vi.fn(async () => ({
    resultText: '{"done":true}',
    sessionId: "sess-single",
    costUsd: 0.1,
    durationMs: 500,
    tokenUsage: { inputTokens: 10, outputTokens: 20 },
    cwd: "/tmp/wt",
  })),
}));
vi.mock("./session-manager-registry.js", () => ({
  getOrCreateSessionManager: vi.fn(() => sessionMgrStub),
}));

import { runAgent, runAgentSingleSession, runScript, createWorktreeForTask } from "./executor.js";
import { executeStage } from "./stage-executor.js";
import { scriptRegistry } from "../scripts/index.js";
import { loadSystemSettings, getNestedValue } from "../lib/config-loader.js";
import { resolveRepoPath, initRepo } from "../lib/git.js";
import type { WorkflowContext } from "../machine/types.js";
import type { AgentRuntimeConfig, ScriptRuntimeConfig } from "../lib/config-loader.js";

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
  // Clear call history but preserve implementations
  vi.mocked(executeStage).mockClear();
  vi.mocked(scriptRegistry.getOrLoadDynamic).mockClear();
  vi.mocked(resolveRepoPath).mockClear();
  vi.mocked(initRepo).mockClear();
  // Restore loadSystemSettings default
  vi.mocked(loadSystemSettings).mockReturnValue({
    paths: { worktrees_base: "/tmp/worktrees" },
  } as any);
});

describe("runAgent - resume parameters", () => {
  it("passes resumeSessionId from resumeInfo", async () => {
    await runAgent("task-1", {
      stageName: "build",
      worktreePath: "/tmp/wt",
      tier1Context: "ctx",
      attempt: 1,
      resumeInfo: { sessionId: "sess-resume", feedback: "fix bug" },
      runtime: { system_prompt: "do things" } as AgentRuntimeConfig,
      context: makeContext(),
    });

    expect(executeStage).toHaveBeenCalledWith(
      "task-1",
      "build",
      "ctx",
      "do things",
      expect.objectContaining({
        resumeSessionId: "sess-resume",
        resumePrompt: "fix bug",
      }),
    );
  });

  it("passes resumeSync when resumeInfo has sync=true", async () => {
    await runAgent("task-1", {
      stageName: "build",
      worktreePath: "/tmp/wt",
      tier1Context: "ctx",
      attempt: 1,
      resumeInfo: { sessionId: "s-1", sync: true },
      runtime: { system_prompt: "prompt" } as AgentRuntimeConfig,
      context: makeContext(),
    });

    expect(executeStage).toHaveBeenCalledWith(
      "task-1",
      "build",
      "ctx",
      "prompt",
      expect.objectContaining({
        resumeSync: true,
      }),
    );
  });

  it("does not pass resume fields when resumeInfo is undefined", async () => {
    await runAgent("task-1", {
      stageName: "build",
      worktreePath: "/tmp/wt",
      tier1Context: "ctx",
      attempt: 1,
      runtime: { system_prompt: "prompt" } as AgentRuntimeConfig,
      context: makeContext(),
    });

    expect(executeStage).toHaveBeenCalledWith(
      "task-1",
      "build",
      "ctx",
      "prompt",
      expect.objectContaining({
        resumeSessionId: undefined,
        resumePrompt: undefined,
        resumeSync: undefined,
      }),
    );
  });

  it("forwards enabledSteps to executeStage", async () => {
    await runAgent("task-1", {
      stageName: "impl",
      worktreePath: "/tmp/wt",
      tier1Context: "ctx",
      attempt: 1,
      enabledSteps: ["step-a", "step-b"],
      runtime: { system_prompt: "p" } as AgentRuntimeConfig,
      context: makeContext(),
    });

    expect(executeStage).toHaveBeenCalledWith(
      "task-1",
      "impl",
      "ctx",
      "p",
      expect.objectContaining({ enabledSteps: ["step-a", "step-b"] }),
    );
  });

  it("injects worktreePath as cwd", async () => {
    await runAgent("task-1", {
      stageName: "build",
      worktreePath: "/some/path",
      tier1Context: "ctx",
      attempt: 1,
      runtime: { system_prompt: "p" } as AgentRuntimeConfig,
      context: makeContext(),
    });

    expect(executeStage).toHaveBeenCalledWith(
      "task-1", "build", "ctx", "p",
      expect.objectContaining({ cwd: "/some/path" }),
    );
  });
});

describe("runScript - context extraction and registry", () => {
  it("calls script handler with correct inputs from store reads", async () => {
    const handler = vi.fn(async () => ({ result: "ok" }));
    vi.mocked(scriptRegistry.getOrLoadDynamic).mockResolvedValue({
      metadata: { id: "my-script", description: "test" },
      handler,
    } as any);

    const ctx = makeContext({
      store: { analysis: { title: "Fix bug" } },
    });

    await runScript("task-1", {
      stageName: "custom",
      context: ctx,
      runtime: {
        script_id: "my-script",
        reads: { analysis: "analysis" },
        args: { extra: true },
      } as unknown as ScriptRuntimeConfig,
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-1",
        context: ctx,
        args: { extra: true },
        inputs: { analysis: { title: "Fix bug" } },
      }),
    );
  });

  it("throws for unknown script_id", async () => {
    vi.mocked(scriptRegistry.getOrLoadDynamic).mockResolvedValue(undefined as any);

    await expect(
      runScript("task-1", {
        stageName: "s",
        context: makeContext(),
        runtime: { script_id: "nonexistent" } as unknown as ScriptRuntimeConfig,
      }),
    ).rejects.toThrow("Unknown script_id: nonexistent");
  });

  it("throws when required system setting is missing", async () => {
    vi.mocked(scriptRegistry.getOrLoadDynamic).mockResolvedValue({
      metadata: {
        id: "needs-setting",
        description: "test",
        requiredSettings: ["notion.token"],
      },
      handler: vi.fn(),
    } as any);

    vi.mocked(loadSystemSettings).mockReturnValue({} as any);

    await expect(
      runScript("task-1", {
        stageName: "s",
        context: makeContext(),
        runtime: { script_id: "needs-setting" } as unknown as ScriptRuntimeConfig,
      }),
    ).rejects.toThrow('requires system setting path "notion.token"');
  });

  it("passes empty inputs when runtime.reads is undefined", async () => {
    const handler = vi.fn(async () => ({}));
    vi.mocked(scriptRegistry.getOrLoadDynamic).mockResolvedValue({
      metadata: { id: "s", description: "test" },
      handler,
    } as any);

    await runScript("task-1", {
      stageName: "s",
      context: makeContext(),
      runtime: { script_id: "s" } as unknown as ScriptRuntimeConfig,
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: {} }),
    );
  });
});

describe("createWorktreeForTask", () => {
  it("initializes repo when resolveRepoPath returns null", async () => {
    vi.mocked(resolveRepoPath).mockReturnValue(undefined as any);
    vi.mocked(initRepo).mockResolvedValue("/repos/new-repo");

    await createWorktreeForTask("task-1", "my-repo", "feat/branch");

    expect(initRepo).toHaveBeenCalledWith("my-repo");
  });

  it("skips initRepo when resolveRepoPath finds the repo", async () => {
    vi.mocked(resolveRepoPath).mockReturnValue("/repos/my-repo");

    await createWorktreeForTask("task-1", "my-repo", "feat/branch");

    expect(initRepo).not.toHaveBeenCalled();
  });
});

// ---------- runAgent — ExecutionRecordWriter lifecycle (Phase 1 / 1.3b) ----------

describe("runAgent — ExecutionRecordWriter lifecycle", () => {
  beforeEach(() => {
    createWriterSpy.mockClear();
    writerStub.close.mockClear();
    writerStub.appendAgentStream.mockClear();
    writerStub.updateCost.mockClear();
    vi.mocked(executeStage).mockResolvedValue({
      resultText: '{"analysis":{"title":"T"}}',
      sessionId: "sess-1",
      costUsd: 0.07,
      durationMs: 1234,
      cwd: "/tmp/wt",
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 250,
        cacheReadTokens: 0,
        totalTokens: 350,
      } as any,
    } as any);
  });

  it("opens a writer with resolved reads + promptBlob, passes it to executeStage, closes on success", async () => {
    const ctx = makeContext({
      store: { analysis: { title: "existing-title", count: 3 } },
    });

    await runAgent("task-1", {
      stageName: "implement",
      worktreePath: "/tmp/wt",
      tier1Context: "TIER1-CONTENT",
      attempt: 2,
      runtime: {
        engine: "llm",
        system_prompt: "You are an agent",
        reads: { title: "analysis.title" },
      } as unknown as AgentRuntimeConfig,
      context: ctx,
    });

    expect(createWriterSpy).toHaveBeenCalledTimes(1);
    const openInput = (createWriterSpy.mock.calls as any[])[0][0];
    expect(openInput.taskId).toBe("task-1");
    expect(openInput.stageName).toBe("implement");
    expect(openInput.attemptIndex).toBe(2);
    expect(openInput.pipelineVersionHash).toBeNull();
    expect(openInput.engine).toBe("claude");
    expect(openInput.readsSnapshot).toEqual({ title: "existing-title" });
    expect(openInput.promptBlob.tier1).toBe("TIER1-CONTENT");
    expect(openInput.promptBlob.stagePrompt).toBe("You are an agent");

    // executeStage received the writer
    const stageOpts = vi.mocked(executeStage).mock.calls[0]![4]! as any;
    expect(stageOpts.executionRecordWriter).toBe(writerStub);

    // writer.close called with parsed writes + cost
    expect(writerStub.close).toHaveBeenCalledTimes(1);
    const closeArg = writerStub.close.mock.calls[0]![0] as any;
    expect(closeArg.terminationReason).toBe("natural_completion");
    expect(closeArg.writesParsed).toEqual({ analysis: { title: "T" } });
    expect(closeArg.costUsd).toBe(0.07);
    expect(closeArg.tokenInput).toBe(100);
    expect(closeArg.tokenOutput).toBe(250);
    expect(closeArg.durationMs).toBe(1234);
    expect(closeArg.sessionId).toBe("sess-1");
  });

  it("closes writer with error_exceeded_retries and rethrows when executeStage throws", async () => {
    const boom = new Error("stage exploded");
    vi.mocked(executeStage).mockRejectedValueOnce(boom);

    const ctx = makeContext();
    await expect(
      runAgent("task-1", {
        stageName: "implement",
        worktreePath: "/tmp/wt",
        tier1Context: "t",
        attempt: 1,
        runtime: {
          engine: "llm",
          system_prompt: "p",
        } as unknown as AgentRuntimeConfig,
        context: ctx,
      }),
    ).rejects.toThrow("stage exploded");

    expect(writerStub.close).toHaveBeenCalledTimes(1);
    expect(writerStub.close.mock.calls[0]![0]).toMatchObject({
      terminationReason: "error_exceeded_retries",
    });
  });

  it("writesParsed is null when resultText is not JSON", async () => {
    vi.mocked(executeStage).mockResolvedValue({
      resultText: "just prose, no JSON",
      sessionId: "sess-1",
      costUsd: 0.01,
      durationMs: 100,
      cwd: "/tmp/wt",
    } as any);

    await runAgent("task-1", {
      stageName: "implement",
      worktreePath: "/tmp/wt",
      tier1Context: "t",
      attempt: 1,
      runtime: {
        engine: "llm",
        system_prompt: "p",
      } as unknown as AgentRuntimeConfig,
      context: makeContext(),
    });

    expect(writerStub.close.mock.calls[0]![0]).toMatchObject({
      writesParsed: null,
    });
  });

  it("picks up engine from pipeline config when stage-level engine is absent", async () => {
    const ctx = makeContext();
    (ctx.config as any).pipeline.engine = "gemini";

    await runAgent("task-1", {
      stageName: "implement",
      worktreePath: "/tmp/wt",
      tier1Context: "t",
      attempt: 1,
      runtime: {
        engine: "llm",
        system_prompt: "p",
      } as unknown as AgentRuntimeConfig,
      context: ctx,
    });

    expect(((createWriterSpy.mock.calls as any[])[0][0] as any).engine).toBe("gemini");
  });

  it("skips resolveHeadRef/captureStageDiff when writer is a no-op", async () => {
    const git = await import("../lib/git.js");
    const resolveHead = vi.mocked(git.resolveHeadRef);
    const capture = vi.mocked(git.captureStageDiff);
    resolveHead.mockClear();
    capture.mockClear();

    // Flip writer to no-op for this test (flag-off shape).
    (writerStub as any).isNoop = true;
    try {
      await runAgent("task-1", {
        stageName: "implement",
        worktreePath: "/tmp/wt",
        tier1Context: "t",
        attempt: 1,
        runtime: { engine: "llm", system_prompt: "p" } as unknown as AgentRuntimeConfig,
        context: makeContext(),
      });
      expect(resolveHead).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
    } finally {
      (writerStub as any).isNoop = false;
    }
  });

  it("captures worktree diff and passes it into writer.close on success", async () => {
    const git = await import("../lib/git.js");
    const resolveHead = vi.mocked(git.resolveHeadRef);
    const capture = vi.mocked(git.captureStageDiff);
    resolveHead.mockResolvedValueOnce("deadbeef1234");
    capture.mockResolvedValueOnce({ text: "diff --git a b\n+x", truncated: false });

    await runAgent("task-1", {
      stageName: "implement",
      worktreePath: "/tmp/wt",
      tier1Context: "t",
      attempt: 1,
      runtime: { engine: "llm", system_prompt: "p" } as unknown as AgentRuntimeConfig,
      context: makeContext(),
    });

    expect(resolveHead).toHaveBeenCalledWith("/tmp/wt");
    expect(capture).toHaveBeenCalledWith("/tmp/wt", "deadbeef1234");
    const closeArg = writerStub.close.mock.calls.at(-1)![0] as any;
    expect(closeArg.worktreeDiff).toEqual({
      text: "diff --git a b\n+x",
      truncated: false,
    });
  });

  it("passes through context.config.pipelineVersionHash to writer.open", async () => {
    const ctx = makeContext();
    (ctx.config as any).pipelineVersionHash = "hash-abc-123";

    await runAgent("task-1", {
      stageName: "implement",
      worktreePath: "/tmp/wt",
      tier1Context: "t",
      attempt: 1,
      runtime: { engine: "llm", system_prompt: "p" } as unknown as AgentRuntimeConfig,
      context: ctx,
    });

    const openInput = (createWriterSpy.mock.calls as any[]).at(-1)![0] as any;
    expect(openInput.pipelineVersionHash).toBe("hash-abc-123");
  });

  it("captures worktree diff even on executeStage failure", async () => {
    const git = await import("../lib/git.js");
    const resolveHead = vi.mocked(git.resolveHeadRef);
    const capture = vi.mocked(git.captureStageDiff);
    resolveHead.mockResolvedValueOnce("base-sha");
    capture.mockResolvedValueOnce({ text: "partial diff", truncated: true });
    vi.mocked(executeStage).mockRejectedValueOnce(new Error("mid-stage crash"));

    await expect(
      runAgent("task-1", {
        stageName: "implement",
        worktreePath: "/tmp/wt",
        tier1Context: "t",
        attempt: 1,
        runtime: { engine: "llm", system_prompt: "p" } as unknown as AgentRuntimeConfig,
        context: makeContext(),
      }),
    ).rejects.toThrow("mid-stage crash");

    const closeArg = writerStub.close.mock.calls.at(-1)![0] as any;
    expect(closeArg.terminationReason).toBe("error_exceeded_retries");
    expect(closeArg.worktreeDiff).toEqual({
      text: "partial diff",
      truncated: true,
    });
  });
});

// ---------- runAgentSingleSession — ExecutionRecordWriter lifecycle (Phase 1 / 1.3c) ----------

describe("runAgentSingleSession — ExecutionRecordWriter lifecycle", () => {
  beforeEach(() => {
    createWriterSpy.mockClear();
    writerStub.close.mockClear();
    sessionMgrStub.executeStage.mockClear();
    sessionMgrStub.executeStage.mockResolvedValue({
      resultText: '{"impl":"done"}',
      sessionId: "sess-single",
      costUsd: 0.25,
      durationMs: 2_000,
      tokenUsage: {
        inputTokens: 50,
        outputTokens: 75,
        cacheReadTokens: 0,
        totalTokens: 125,
      } as any,
      cwd: "/tmp/wt",
    } as any);
  });

  it("opens writer and forwards to session manager, closes on success", async () => {
    const ctx = makeContext({
      store: { analysis: { plan: "P" } },
    });
    // The single-session path reads pipeline.stages to find privateStage.
    (ctx.config as any).pipeline.stages = [
      { name: "implement", type: "agent", engine: "claude" },
    ];

    await runAgentSingleSession("task-1", {
      stageName: "implement",
      worktreePath: "/tmp/wt",
      tier1Context: "TIER1",
      attempt: 1,
      runtime: {
        engine: "llm",
        system_prompt: "do it",
        reads: { plan: "analysis.plan" },
      } as unknown as AgentRuntimeConfig,
      context: ctx,
    });

    expect(createWriterSpy).toHaveBeenCalledTimes(1);
    const openInput = (createWriterSpy.mock.calls as any[])[0][0] as any;
    expect(openInput.taskId).toBe("task-1");
    expect(openInput.stageName).toBe("implement");
    expect(openInput.engine).toBe("claude");
    expect(openInput.readsSnapshot).toEqual({ plan: "P" });

    // session manager received the writer
    const mgrParams = (sessionMgrStub.executeStage.mock.calls as any[])[0][0] as any;
    expect(mgrParams.executionRecordWriter).toBe(writerStub);

    expect(writerStub.close).toHaveBeenCalledTimes(1);
    const closeArg = writerStub.close.mock.calls[0]![0] as any;
    expect(closeArg.terminationReason).toBe("natural_completion");
    expect(closeArg.writesParsed).toEqual({ impl: "done" });
    expect(closeArg.costUsd).toBe(0.25);
    expect(closeArg.tokenInput).toBe(50);
    expect(closeArg.tokenOutput).toBe(75);
    expect(closeArg.sessionId).toBe("sess-single");
  });

  it("closes with error_exceeded_retries and rethrows when session manager throws", async () => {
    const boom = new Error("single-session crashed");
    sessionMgrStub.executeStage.mockRejectedValueOnce(boom);

    const ctx = makeContext();
    await expect(
      runAgentSingleSession("task-1", {
        stageName: "s",
        worktreePath: "/tmp/wt",
        tier1Context: "t",
        attempt: 1,
        runtime: { engine: "llm", system_prompt: "p" } as unknown as AgentRuntimeConfig,
        context: ctx,
      }),
    ).rejects.toThrow("single-session crashed");

    expect(writerStub.close).toHaveBeenCalledTimes(1);
    expect(writerStub.close.mock.calls[0]![0]).toMatchObject({
      terminationReason: "error_exceeded_retries",
    });
  });

  it("forwards context.scratchPad entries into close's scratchPadSnapshot", async () => {
    const ctx = makeContext({
      scratchPad: [
        {
          stage: "analyze",
          timestamp: "2026-04-18T00:00:00Z",
          category: "note",
          content: "one",
        },
      ] as any,
    });
    await runAgentSingleSession("task-1", {
      stageName: "s",
      worktreePath: "/tmp/wt",
      tier1Context: "t",
      attempt: 1,
      runtime: { engine: "llm", system_prompt: "p" } as unknown as AgentRuntimeConfig,
      context: ctx,
    });
    const closeArg = writerStub.close.mock.calls.at(-1)![0] as any;
    expect(closeArg.scratchPadSnapshot).not.toBeNull();
    expect(closeArg.scratchPadSnapshot.finalNote).toContain("analyze/note");
    expect(closeArg.scratchPadSnapshot.precompactEvents).toEqual([]);
  });

  it("forwards scratchPadSnapshot even when the session throws", async () => {
    sessionMgrStub.executeStage.mockRejectedValueOnce(new Error("boom"));
    const ctx = makeContext({
      scratchPad: [
        {
          stage: "analyze",
          timestamp: "t0",
          category: "note",
          content: "preserved-across-failure",
        },
      ] as any,
    });
    await expect(
      runAgentSingleSession("task-1", {
        stageName: "s",
        worktreePath: "/tmp/wt",
        tier1Context: "t",
        attempt: 1,
        runtime: { engine: "llm", system_prompt: "p" } as unknown as AgentRuntimeConfig,
        context: ctx,
      }),
    ).rejects.toThrow("boom");
    const closeArg = writerStub.close.mock.calls.at(-1)![0] as any;
    expect(closeArg.terminationReason).toBe("error_exceeded_retries");
    expect(closeArg.scratchPadSnapshot.finalNote).toContain(
      "preserved-across-failure",
    );
  });
});
