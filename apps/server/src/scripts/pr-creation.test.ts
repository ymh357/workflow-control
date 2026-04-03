import { describe, it, expect, vi, beforeEach } from "vitest";

const mockScriptPRCreation = vi.fn();

vi.mock("../lib/scripts.js", () => ({
  scriptPRCreation: (...args: any[]) => mockScriptPRCreation(...args),
}));

import { prCreationScript } from "./pr-creation.js";

function makeParams(overrides: Record<string, any> = {}) {
  return {
    taskId: "task-20",
    context: {
      worktreePath: "/tmp/wt",
      branch: "feature/task-20-pr",
      store: {},
      ...overrides.context,
    } as any,
    settings: { github: { org: "myorg" } } as any,
    inputs: overrides.inputs,
    args: overrides.args,
  };
}

describe("prCreationScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScriptPRCreation.mockResolvedValue({ prUrl: "https://github.com/pr/1" });
  });

  it("has correct metadata id and requiredSettings", () => {
    expect(prCreationScript.metadata.id).toBe("pr_creation");
    expect(prCreationScript.metadata.requiredSettings).toContain("github.org");
  });

  it("passes all expected fields to scriptPRCreation", async () => {
    await prCreationScript.handler(makeParams());

    expect(mockScriptPRCreation).toHaveBeenCalledWith({
      taskId: "task-20",
      worktreePath: "/tmp/wt",
      branch: "feature/task-20-pr",
      analysis: {},
      qaResult: {},
      settings: { github: { org: "myorg" } },
    });
  });

  it("uses inputs.analysis and inputs.qaResult when provided", async () => {
    const analysis = { title: "Add feature" };
    const qaResult = { passed: true };
    await prCreationScript.handler(makeParams({ inputs: { analysis, qaResult } }));

    expect(mockScriptPRCreation).toHaveBeenCalledWith(
      expect.objectContaining({ analysis, qaResult }),
    );
  });

  it("defaults worktreePath and branch to empty strings when missing", async () => {
    const params = makeParams();
    delete params.context.worktreePath;
    delete params.context.branch;
    await prCreationScript.handler(params);

    expect(mockScriptPRCreation).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: "", branch: "" }),
    );
  });

  it("returns the result from scriptPRCreation", async () => {
    const result = await prCreationScript.handler(makeParams());
    expect(result).toEqual({ prUrl: "https://github.com/pr/1" });
  });

});
