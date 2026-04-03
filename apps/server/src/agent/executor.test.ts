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

import { runAgent, runScript, createWorktreeForTask } from "./executor.js";
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
