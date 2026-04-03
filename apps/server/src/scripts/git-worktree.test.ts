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
    args: overrides.args,
  };
}

describe("gitWorktreeScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateWorktreeForTask.mockResolvedValue("/tmp/wt/task-99");
  });

  it("has correct metadata id", () => {
    expect(gitWorktreeScript.metadata.id).toBe("git_worktree");
  });

  it("calls createWorktreeForTask with correct arguments", async () => {
    await gitWorktreeScript.handler(makeParams());

    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "my-repo", "feature/task-99-stuff");
  });

  it("uses inputs.repoName over context.explicitRepoName", async () => {
    await gitWorktreeScript.handler(makeParams({ inputs: { repoName: "override-repo" } }));

    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "override-repo", "feature/task-99-stuff");
  });

  it("defaults repoName to empty string when missing", async () => {
    const params = makeParams();
    delete params.context.explicitRepoName;
    params.context.branch = "b";
    await gitWorktreeScript.handler(params);

    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "", "b");
  });

  it("defaults branch to empty string when missing", async () => {
    const params = makeParams();
    delete params.context.branch;
    params.context.explicitRepoName = "r";
    await gitWorktreeScript.handler(params);

    expect(mockCreateWorktreeForTask).toHaveBeenCalledWith("task-99", "r", "");
  });

  it("returns the result from createWorktreeForTask", async () => {
    const result = await gitWorktreeScript.handler(makeParams());
    expect(result).toEqual({ worktreePath: "/tmp/wt/task-99" });
  });
});
