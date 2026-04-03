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

describe("prCreationScript – adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockScriptPRCreation.mockResolvedValue({ prUrl: "https://github.com/pr/1" });
  });

  it("propagates rejection from scriptPRCreation", async () => {
    mockScriptPRCreation.mockRejectedValue(new Error("gh CLI not found"));
    await expect(prCreationScript.handler(makeParams())).rejects.toThrow("gh CLI not found");
  });

  it("handles null inputs gracefully (defaults analysis and qaResult to {})", async () => {
    const params = makeParams();
    params.inputs = null as any;
    await prCreationScript.handler(params);

    expect(mockScriptPRCreation).toHaveBeenCalledWith(
      expect.objectContaining({ analysis: {}, qaResult: {} }),
    );
  });

  it("passes null worktreePath as empty string (null ?? '')", async () => {
    await prCreationScript.handler(
      makeParams({ context: { store: {}, worktreePath: null, branch: "b" } }),
    );

    expect(mockScriptPRCreation).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: "" }),
    );
  });

  it("passes null branch as empty string (null ?? '')", async () => {
    await prCreationScript.handler(
      makeParams({ context: { store: {}, worktreePath: "/wt", branch: null } }),
    );

    expect(mockScriptPRCreation).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "" }),
    );
  });

  it("inputs with only analysis but no qaResult defaults qaResult to {}", async () => {
    await prCreationScript.handler(
      makeParams({ inputs: { analysis: { title: "Fix" } } }),
    );

    expect(mockScriptPRCreation).toHaveBeenCalledWith(
      expect.objectContaining({ analysis: { title: "Fix" }, qaResult: {} }),
    );
  });

  it("inputs with only qaResult but no analysis defaults analysis to {}", async () => {
    await prCreationScript.handler(
      makeParams({ inputs: { qaResult: { passed: true } } }),
    );

    expect(mockScriptPRCreation).toHaveBeenCalledWith(
      expect.objectContaining({ analysis: {}, qaResult: { passed: true } }),
    );
  });
});
