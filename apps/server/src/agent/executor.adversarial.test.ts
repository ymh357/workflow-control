import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { runAgent, runScript, createWorktreeForTask, _resetMockState } from "./executor.js";
import { executeStage } from "./stage-executor.js";
import { scriptRegistry } from "../scripts/index.js";
import { loadSystemSettings } from "../lib/config-loader.js";
import { resolveRepoPath, createWorktree, installDepsInWorktree } from "../lib/git.js";
import { injectWorktreeConfig } from "../lib/worktree-injector.js";
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
  vi.mocked(executeStage).mockClear();
  vi.mocked(scriptRegistry.getOrLoadDynamic).mockClear();
  vi.mocked(resolveRepoPath).mockClear();
  vi.mocked(loadSystemSettings).mockReturnValue({
    paths: { worktrees_base: "/tmp/worktrees" },
  } as any);
});

describe("adversarial: runAgent passes injectedContext correctly", () => {
  it("injects context from input.context into executeStage", async () => {
    const ctx = makeContext({ taskId: "ctx-task" });
    await runAgent("task-1", {
      stageName: "build",
      worktreePath: "/wt",
      tier1Context: "ctx",
      attempt: 1,
      runtime: { system_prompt: "p" } as AgentRuntimeConfig,
      context: ctx,
    });

    expect(executeStage).toHaveBeenCalledWith(
      "task-1", "build", "ctx", "p",
      expect.objectContaining({ injectedContext: ctx }),
    );
  });
});

describe("adversarial: runScript deep store reads", () => {
  it("resolves nested store paths using dot notation", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    vi.mocked(scriptRegistry.getOrLoadDynamic).mockResolvedValue({
      metadata: { id: "s", description: "test" },
      handler,
    } as any);

    const ctx = makeContext({
      store: {
        analysis: { details: { score: 95 } },
      },
    });

    await runScript("task-1", {
      stageName: "custom",
      context: ctx,
      runtime: {
        script_id: "s",
        reads: { score: "analysis.details.score" },
      } as unknown as ScriptRuntimeConfig,
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: { score: 95 } }),
    );
  });

  it("passes undefined for non-existent nested paths", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    vi.mocked(scriptRegistry.getOrLoadDynamic).mockResolvedValue({
      metadata: { id: "s", description: "test" },
      handler,
    } as any);

    const ctx = makeContext({ store: {} });

    await runScript("task-1", {
      stageName: "custom",
      context: ctx,
      runtime: {
        script_id: "s",
        reads: { missing: "a.b.c.d" },
      } as unknown as ScriptRuntimeConfig,
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: { missing: undefined } }),
    );
  });
});

describe("adversarial: runScript handler errors propagate", () => {
  it("propagates handler errors to caller", async () => {
    vi.mocked(scriptRegistry.getOrLoadDynamic).mockResolvedValue({
      metadata: { id: "boom", description: "test" },
      handler: vi.fn(async () => { throw new Error("script exploded"); }),
    } as any);

    await expect(
      runScript("task-1", {
        stageName: "s",
        context: makeContext(),
        runtime: { script_id: "boom" } as unknown as ScriptRuntimeConfig,
      }),
    ).rejects.toThrow("script exploded");
  });
});

describe("adversarial: runScript multiple required settings", () => {
  it("throws on first missing setting when multiple are required", async () => {
    vi.mocked(scriptRegistry.getOrLoadDynamic).mockResolvedValue({
      metadata: {
        id: "needs-many",
        description: "test",
        requiredSettings: ["slack.token", "notion.token"],
      },
      handler: vi.fn(),
    } as any);

    vi.mocked(loadSystemSettings).mockReturnValue({
      slack: { token: "ok" },
      // notion.token is missing
    } as any);

    await expect(
      runScript("task-1", {
        stageName: "s",
        context: makeContext(),
        runtime: { script_id: "needs-many" } as unknown as ScriptRuntimeConfig,
      }),
    ).rejects.toThrow('requires system setting path "notion.token"');
  });
});

describe("adversarial: createWorktreeForTask uses HOME fallback for worktrees_base", () => {
  it("uses $HOME/wfc-worktrees when worktrees_base is not configured", async () => {
    vi.mocked(loadSystemSettings).mockReturnValue({ paths: {} } as any);
    vi.mocked(resolveRepoPath).mockReturnValue("/repos/r");

    await createWorktreeForTask("task-1", "repo", "branch");

    expect(createWorktree).toHaveBeenCalledWith(
      "/repos/r",
      "branch",
      expect.stringContaining("wfc-worktrees"),
    );
  });
});

describe("adversarial: createWorktreeForTask calls all setup steps in order", () => {
  it("calls createWorktree, installDeps, injectConfig in sequence", async () => {
    vi.mocked(resolveRepoPath).mockReturnValue("/repos/r");

    const callOrder: string[] = [];
    vi.mocked(createWorktree).mockImplementation(async () => {
      callOrder.push("createWorktree");
      return "/tmp/worktrees/branch";
    });
    vi.mocked(installDepsInWorktree).mockImplementation(async () => {
      callOrder.push("installDeps");
    });
    vi.mocked(injectWorktreeConfig).mockImplementation((_worktreePath: string, _pipeline?: any) => {
      callOrder.push("injectConfig");
      return [];
    });

    await createWorktreeForTask("task-1", "repo", "branch");

    expect(callOrder).toEqual(["createWorktree", "installDeps", "injectConfig"]);
  });
});

// ── MOCK_EXECUTOR branch tests ─────────────────────────────────────────────
// These tests exercise the MOCK_EXECUTOR=true code paths added to executor.ts.
// They do NOT call executeStage or scriptRegistry — the mock branch short-circuits.

describe("MOCK_EXECUTOR: runAgent happy_path returns mock AgentResult", () => {
  beforeEach(() => {
    _resetMockState();
    process.env.MOCK_EXECUTOR = "true";
    process.env.MOCK_EXECUTOR_DELAY_MS = "0";
  });
  afterEach(() => {
    delete process.env.MOCK_EXECUTOR;
    delete process.env.MOCK_EXECUTOR_DELAY_MS;
  });

  it("returns resultText containing all write fields", async () => {
    const result = await runAgent("t1", {
      stageName: "analyzing",
      worktreePath: "/wt",
      tier1Context: "ctx",
      attempt: 0,
      runtime: { system_prompt: "p", writes: ["analysis", "repoName"] } as AgentRuntimeConfig,
      context: makeContext({ taskText: "plain task" }),
    });

    const parsed = JSON.parse(result.resultText);
    expect(parsed).toHaveProperty("analysis");
    expect(parsed).toHaveProperty("repoName");
    expect(result.costUsd).toBe(0.001);
    expect(result.sessionId).toMatch(/^mock-t1-analyzing-/);
  });

  it("does NOT call executeStage when MOCK_EXECUTOR=true", async () => {
    vi.mocked(executeStage).mockClear();
    await runAgent("t1", {
      stageName: "analyzing",
      worktreePath: "/wt",
      tier1Context: "ctx",
      attempt: 0,
      runtime: { system_prompt: "p", writes: ["out"] } as AgentRuntimeConfig,
      context: makeContext(),
    });
    expect(executeStage).not.toHaveBeenCalled();
  });

  it("returns empty writes array gracefully (no writes field)", async () => {
    const result = await runAgent("t1", {
      stageName: "analyzing",
      worktreePath: "/wt",
      tier1Context: "ctx",
      attempt: 0,
      runtime: { system_prompt: "p" } as AgentRuntimeConfig,
      context: makeContext(),
    });
    expect(JSON.parse(result.resultText)).toEqual({});
  });
});

describe("MOCK_EXECUTOR: runAgent scenario=blocked throws on every call", () => {
  beforeEach(() => {
    _resetMockState();
    process.env.MOCK_EXECUTOR = "true";
    process.env.MOCK_EXECUTOR_DELAY_MS = "0";
  });
  afterEach(() => {
    delete process.env.MOCK_EXECUTOR;
    delete process.env.MOCK_EXECUTOR_DELAY_MS;
  });

  it("throws for blocked scenario", async () => {
    await expect(
      runAgent("t-blocked", {
        stageName: "analyzing",
        worktreePath: "/wt",
        tier1Context: "ctx",
        attempt: 0,
        runtime: { system_prompt: "p", writes: ["out"] } as AgentRuntimeConfig,
        context: makeContext({ taskText: "[SCENARIO:blocked] test" }),
      }),
    ).rejects.toThrow("Mock executor: forced failure for blocked scenario");
  });

  it("throws on repeated calls for blocked scenario (never succeeds)", async () => {
    const ctx = makeContext({ taskText: "[SCENARIO:blocked] repeated" });
    const input = {
      stageName: "s",
      worktreePath: "/wt",
      tier1Context: "ctx",
      attempt: 0,
      runtime: { system_prompt: "p", writes: ["out"] } as AgentRuntimeConfig,
      context: ctx,
    };
    await expect(runAgent("t-blocked2", input)).rejects.toThrow();
    await expect(runAgent("t-blocked2", input)).rejects.toThrow();
    await expect(runAgent("t-blocked2", input)).rejects.toThrow();
  });
});

describe("MOCK_EXECUTOR: runAgent scenario=missing_output returns empty for first 3 calls", () => {
  beforeEach(() => {
    _resetMockState();
    process.env.MOCK_EXECUTOR = "true";
    process.env.MOCK_EXECUTOR_DELAY_MS = "0";
  });
  afterEach(() => {
    delete process.env.MOCK_EXECUTOR;
    delete process.env.MOCK_EXECUTOR_DELAY_MS;
  });

  it("returns {} for first 3 calls, then returns real data on call 4", async () => {
    // _mockCallCounts is keyed by taskId:stageName — must use the SAME taskId+stageName
    // to increment the counter across calls.
    const ctx = makeContext({ taskText: "[SCENARIO:missing_output] test" });
    const input = (attempt: number) => ({
      stageName: "qa",
      worktreePath: "/wt",
      tier1Context: "ctx",
      attempt,
      runtime: { system_prompt: "p", writes: ["result"] } as AgentRuntimeConfig,
      context: ctx,
    });

    // calls 1-3 return {}
    for (let i = 0; i < 3; i++) {
      const r = await runAgent("t-missing", input(i));
      expect(JSON.parse(r.resultText)).toEqual({});
    }

    // call 4 (count > 3) returns real mock data
    const r4 = await runAgent("t-missing", input(3));
    expect(JSON.parse(r4.resultText)).toHaveProperty("result");
  });
});

describe("MOCK_EXECUTOR: runScript returns plausible values", () => {
  beforeEach(() => {
    _resetMockState();
    process.env.MOCK_EXECUTOR = "true";
    process.env.MOCK_EXECUTOR_DELAY_MS = "0";
  });
  afterEach(() => {
    delete process.env.MOCK_EXECUTOR;
    delete process.env.MOCK_EXECUTOR_DELAY_MS;
  });

  it("returns worktreePath=cwd() and branch='mock-branch' for known fields", async () => {
    const result = await runScript("t1", {
      stageName: "setup",
      context: makeContext(),
      runtime: { script_id: "s", writes: ["worktreePath", "branch"] } as unknown as ScriptRuntimeConfig,
    });

    expect(result.worktreePath).toBe(process.cwd());
    expect(result.branch).toBe("mock-branch");
  });

  it("returns { _mock: true } for unknown write fields", async () => {
    const result = await runScript("t1", {
      stageName: "setup",
      context: makeContext(),
      runtime: { script_id: "s", writes: ["customField"] } as unknown as ScriptRuntimeConfig,
    });

    expect(result.customField).toEqual({ _mock: true });
  });

  it("does NOT call scriptRegistry when MOCK_EXECUTOR=true", async () => {
    vi.mocked(scriptRegistry.getOrLoadDynamic).mockClear();
    await runScript("t1", {
      stageName: "setup",
      context: makeContext(),
      runtime: { script_id: "s", writes: ["worktreePath"] } as unknown as ScriptRuntimeConfig,
    });
    expect(scriptRegistry.getOrLoadDynamic).not.toHaveBeenCalled();
  });
});

describe("MOCK_EXECUTOR: _getMockScenario extracts scenario from taskText", () => {
  beforeEach(() => {
    _resetMockState();
    process.env.MOCK_EXECUTOR = "true";
    process.env.MOCK_EXECUTOR_DELAY_MS = "0";
  });
  afterEach(() => {
    delete process.env.MOCK_EXECUTOR;
    delete process.env.MOCK_EXECUTOR_DELAY_MS;
  });

  it("defaults to happy_path when no [SCENARIO:...] tag in taskText", async () => {
    const result = await runAgent("t1", {
      stageName: "s",
      worktreePath: "/wt",
      tier1Context: "ctx",
      attempt: 0,
      runtime: { system_prompt: "p", writes: ["out"] } as AgentRuntimeConfig,
      context: makeContext({ taskText: "just a normal task" }),
    });
    // happy_path => returns mock data, not throws
    expect(result.resultText).toBeDefined();
  });

  it("defaults to happy_path when context is undefined", async () => {
    const result = await runAgent("t1", {
      stageName: "s",
      worktreePath: "/wt",
      tier1Context: "ctx",
      attempt: 0,
      runtime: { system_prompt: "p", writes: ["out"] } as AgentRuntimeConfig,
    });
    expect(result.resultText).toBeDefined();
  });
});
