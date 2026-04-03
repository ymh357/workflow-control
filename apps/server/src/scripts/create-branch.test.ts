import { describe, it, expect, vi, beforeEach } from "vitest";

const mockBuildBranchName = vi.fn();
const mockGetNestedValue = vi.fn();

vi.mock("../lib/git.js", () => ({
  buildBranchName: (...args: any[]) => mockBuildBranchName(...args),
}));

vi.mock("../lib/config-loader.js", () => ({
  getNestedValue: (...args: any[]) => mockGetNestedValue(...args),
}));

import { createBranchScript } from "./create-branch.js";

function makeParams(overrides: Record<string, any> = {}) {
  return {
    taskId: "task-42",
    context: {
      store: {},
      config: { pipeline: { display: { title_path: "analysis.title" } } },
      ...overrides.context,
    } as any,
    settings: {} as any,
    inputs: overrides.inputs,
    args: overrides.args,
  };
}

describe("createBranchScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildBranchName.mockReturnValue("feature/task-42-foo");
  });

  it("has correct metadata id", () => {
    expect(createBranchScript.metadata.id).toBe("create_branch");
  });

  it("uses inputs.title when provided", async () => {
    const result = await createBranchScript.handler(makeParams({ inputs: { title: "My Feature" } }));

    expect(mockBuildBranchName).toHaveBeenCalledWith("task-42", "My Feature");
    expect(result).toEqual({ branch: "feature/task-42-foo" });
  });

  it("falls back to getNestedValue when no inputs.title", async () => {
    mockGetNestedValue.mockReturnValue("Nested Title");

    await createBranchScript.handler(makeParams());

    expect(mockGetNestedValue).toHaveBeenCalledWith({}, "analysis.title");
    expect(mockBuildBranchName).toHaveBeenCalledWith("task-42", "Nested Title");
  });

  it("falls back to taskId when getNestedValue returns falsy", async () => {
    mockGetNestedValue.mockReturnValue(undefined);

    await createBranchScript.handler(makeParams());

    expect(mockBuildBranchName).toHaveBeenCalledWith("task-42", "task-42");
  });

  it("uses empty title_path when config is missing", async () => {
    mockGetNestedValue.mockReturnValue(undefined);

    await createBranchScript.handler(makeParams({ context: { store: {}, config: {} } }));

    expect(mockGetNestedValue).toHaveBeenCalledWith({}, "");
  });

  it("returns an object with branch key", async () => {
    mockBuildBranchName.mockReturnValue("feature/abc-hello");
    const result = await createBranchScript.handler(makeParams({ inputs: { title: "Hello" } }));
    expect(result).toHaveProperty("branch", "feature/abc-hello");
  });
});
