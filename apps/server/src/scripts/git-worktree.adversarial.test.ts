import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateWorktreeForTask = vi.fn();

vi.mock("../agent/executor.js", () => ({
  createWorktreeForTask: (...args: any[]) => mockCreateWorktreeForTask(...args),
}));

import { gitWorktreeScript } from "./git-worktree.js";

function makeParams(overrides: Record<string, any> = {}) {
  return {
    taskId: "task-99",
    context: {
      branch: "feature/task-99-stuff",
      explicitRepoName: "my-repo",
      store: {},
      ...overrides.context,
    } as any,
    settings: {} as any,
    inputs: overrides.inputs,
    args: overrides.args ?? {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCreateWorktreeForTask.mockResolvedValue("/tmp/wt/task-99");
});

// ── Error propagation ──

describe("error propagation", () => {
  it("createWorktreeForTask throws — error propagates to caller", async () => {
    mockCreateWorktreeForTask.mockRejectedValue(new Error("Git error: worktree already exists"));
    await expect(
      gitWorktreeScript.handler(makeParams()),
    ).rejects.toThrow("Git error: worktree already exists");
  });

  it("createWorktreeForTask throws non-Error — propagates as-is", async () => {
    mockCreateWorktreeForTask.mockRejectedValue("string rejection");
    await expect(
      gitWorktreeScript.handler(makeParams()),
    ).rejects.toBe("string rejection");
  });

  it("createWorktreeForTask rejects with ENOENT — propagates without swallowing", async () => {
    const fsError = Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    mockCreateWorktreeForTask.mockRejectedValue(fsError);
    await expect(
      gitWorktreeScript.handler(makeParams()),
    ).rejects.toThrow("ENOENT");
  });
});

// ── Extreme inputs ──

describe("extreme and boundary inputs", () => {
  it("empty repoName (no inputs, no context.explicitRepoName) — passes empty string to createWorktreeForTask", async () => {
    const params = makeParams();
    delete params.context.explicitRepoName;
    await gitWorktreeScript.handler(params);
    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "", "feature/task-99-stuff");
  });

  it("empty branch (no context.branch) — passes empty string to createWorktreeForTask", async () => {
    const params = makeParams();
    delete params.context.branch;
    await gitWorktreeScript.handler(params);
    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "my-repo", "");
  });

  it("inputs.repoName with path separators — passed as-is to createWorktreeForTask (not sanitized here)", async () => {
    await gitWorktreeScript.handler(makeParams({ inputs: { repoName: "../../evil" } }));
    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "../../evil", "feature/task-99-stuff");
  });

  it("very long taskId — passed through without truncation", async () => {
    const longTaskId = "task-" + "x".repeat(500);
    const params = { ...makeParams(), taskId: longTaskId };
    await gitWorktreeScript.handler(params);
    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith(longTaskId, "my-repo", "feature/task-99-stuff");
  });

  it("very long branch name — passed through without modification", async () => {
    const longBranch = "feature/" + "a".repeat(200);
    const params = makeParams({ context: { branch: longBranch, explicitRepoName: "repo" } });
    await gitWorktreeScript.handler(params);
    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "repo", longBranch);
  });

  it("repoName with special characters — passed as-is", async () => {
    await gitWorktreeScript.handler(makeParams({ inputs: { repoName: "my-org/my-repo.git" } }));
    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "my-org/my-repo.git", "feature/task-99-stuff");
  });

  it("inputs object with irrelevant fields — repoName still extracted correctly", async () => {
    await gitWorktreeScript.handler(makeParams({ inputs: { repoName: "correct-repo", extra: "ignored" } }));
    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "correct-repo", "feature/task-99-stuff");
  });
});

// ── Priority: inputs.repoName over context ──

describe("input precedence", () => {
  it("inputs.repoName takes precedence over context.explicitRepoName", async () => {
    await gitWorktreeScript.handler(makeParams({
      inputs: { repoName: "inputs-repo" },
      context: { explicitRepoName: "context-repo", branch: "b" },
    }));
    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "inputs-repo", "b");
  });

  it("null inputs.repoName falls back to context.explicitRepoName", async () => {
    await gitWorktreeScript.handler(makeParams({
      inputs: { repoName: null as any },
      context: { explicitRepoName: "context-repo", branch: "b" },
    }));
    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "context-repo", "b");
  });

  it("undefined inputs falls back to context.explicitRepoName", async () => {
    const params = makeParams();
    params.inputs = undefined;
    await gitWorktreeScript.handler(params);
    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "my-repo", "feature/task-99-stuff");
  });
});

// ── Return value edge cases ──

describe("return value", () => {
  it("returns { worktreePath } matching the resolved path", async () => {
    mockCreateWorktreeForTask.mockResolvedValue("/workspace/task-99");
    const result = await gitWorktreeScript.handler(makeParams());
    expect(result).toEqual({ worktreePath: "/workspace/task-99" });
  });

  it("returns { worktreePath: null } if createWorktreeForTask resolves null", async () => {
    mockCreateWorktreeForTask.mockResolvedValue(null);
    const result = await gitWorktreeScript.handler(makeParams());
    expect(result).toEqual({ worktreePath: null });
  });

  it("returns { worktreePath: '' } if createWorktreeForTask resolves empty string", async () => {
    mockCreateWorktreeForTask.mockResolvedValue("");
    const result = await gitWorktreeScript.handler(makeParams());
    expect(result).toEqual({ worktreePath: "" });
  });
});
