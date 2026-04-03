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

describe("createBranchScript – adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildBranchName.mockReturnValue("feature/task-42-slug");
  });

  it("coerces numeric title to string via String()", async () => {
    await createBranchScript.handler(makeParams({ inputs: { title: 12345 } }));
    expect(mockBuildBranchName).toHaveBeenCalledWith("task-42", "12345");
  });

  it("coerces boolean false title to string 'false'", async () => {
    await createBranchScript.handler(makeParams({ inputs: { title: false } }));
    expect(mockBuildBranchName).toHaveBeenCalledWith("task-42", "false");
  });

  it("null title falls through ?? to getNestedValue", async () => {
    // null triggers ??, so it falls through to getNestedValue
    mockGetNestedValue.mockReturnValue("from-nested");
    await createBranchScript.handler(makeParams({ inputs: { title: null } }));
    expect(mockGetNestedValue).toHaveBeenCalled();
    expect(mockBuildBranchName).toHaveBeenCalledWith("task-42", "from-nested");
  });

  it("empty string title does NOT fall through ?? (coerced to 'empty string')", async () => {
    // "" is falsy but ?? only skips null/undefined, so "" is kept
    await createBranchScript.handler(makeParams({ inputs: { title: "" } }));
    expect(mockBuildBranchName).toHaveBeenCalledWith("task-42", "");
  });

  it("handles undefined context.config entirely (no pipeline property)", async () => {
    mockGetNestedValue.mockReturnValue(undefined);
    await createBranchScript.handler(
      makeParams({ context: { store: {}, config: undefined } }),
    );
    // config?.pipeline?.display?.title_path => undefined => ?? "" => getNestedValue(store, "")
    expect(mockGetNestedValue).toHaveBeenCalledWith({}, "");
  });

  it("handles missing config.pipeline.display (partial config)", async () => {
    mockGetNestedValue.mockReturnValue(undefined);
    await createBranchScript.handler(
      makeParams({ context: { store: {}, config: { pipeline: {} } } }),
    );
    expect(mockGetNestedValue).toHaveBeenCalledWith({}, "");
  });

  it("propagates errors from buildBranchName", async () => {
    mockBuildBranchName.mockImplementation(() => {
      throw new Error("invalid chars");
    });
    await expect(
      createBranchScript.handler(makeParams({ inputs: { title: "test" } })),
    ).rejects.toThrow("invalid chars");
  });

  it("getNestedValue returning 0 does NOT fall through ?? (0 is kept and coerced to '0')", async () => {
    mockGetNestedValue.mockReturnValue(0);
    await createBranchScript.handler(makeParams());
    // 0 is not null/undefined, so ?? keeps it; String(0) => "0"
    expect(mockBuildBranchName).toHaveBeenCalledWith("task-42", "0");
  });
});
