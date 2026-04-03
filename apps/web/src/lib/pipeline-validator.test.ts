import { describe, it, expect, vi } from "vitest";

// Mock the shared library — we test the wrapper logic, not the shared implementation
vi.mock("@workflow-control/shared", () => ({
  validatePipelineLogic: vi.fn(() => []),
}));

import { validatePipeline, getStageIssues, getIssueSummary } from "./pipeline-validator";
import { validatePipelineLogic } from "@workflow-control/shared";

const mockValidate = vi.mocked(validatePipelineLogic);

const baseState = {
  pipeline: { name: "test", stages: [{ name: "s1" }] },
  prompts: {},
};

// ── validatePipeline ──

describe("validatePipeline", () => {
  it("calls validatePipelineLogic with pipeline stages", () => {
    validatePipeline(baseState);
    expect(mockValidate).toHaveBeenCalledWith(
      baseState.pipeline.stages,
      expect.any(Set),
      undefined,
    );
  });

  it("passes knownMcps when provided", () => {
    vi.clearAllMocks();
    const mcps = new Set(["notion", "github"]);
    validatePipeline(baseState, mcps);
    expect(mockValidate).toHaveBeenCalledWith(
      baseState.pipeline.stages,
      expect.any(Set),
      mcps,
    );
  });

  it("passes normalized prompt keys as a Set", () => {
    vi.clearAllMocks();
    const state = { ...baseState, prompts: { myPrompt: "content", "other.md": "c2" } };
    validatePipeline(state);
    const passedSet = mockValidate.mock.calls[0][1] as Set<string>;
    // "myPrompt" → normalizePromptKey → "my-prompt"
    expect(passedSet.has("my-prompt")).toBe(true);
    // "other.md" → strips .md → "other"
    expect(passedSet.has("other")).toBe(true);
  });

  it("returns the array from validatePipelineLogic", () => {
    const issues = [{ severity: "error" as const, message: "bad", stageIndex: 0 }];
    mockValidate.mockReturnValueOnce(issues as any);
    const result = validatePipeline(baseState);
    expect(result).toBe(issues);
  });

  it("empty prompts — passes empty Set", () => {
    vi.clearAllMocks();
    validatePipeline({ ...baseState, prompts: {} });
    const passedSet = mockValidate.mock.calls[0][1] as Set<string>;
    expect(passedSet.size).toBe(0);
  });
});

// ── normalizePromptKey (tested via validatePipeline's Set argument) ──

describe("normalizePromptKey (via validatePipeline)", () => {
  function getPassedKeys(prompts: Record<string, string>): Set<string> {
    vi.clearAllMocks();
    validatePipeline({ ...baseState, prompts });
    return mockValidate.mock.calls[0][1] as Set<string>;
  }

  it("camelCase key → kebab-case", () => {
    expect(getPassedKeys({ myPromptKey: "c" }).has("my-prompt-key")).toBe(true);
  });

  it(".md extension is stripped", () => {
    expect(getPassedKeys({ "analysis.md": "c" }).has("analysis")).toBe(true);
  });

  it("already kebab-case key is unchanged", () => {
    expect(getPassedKeys({ "my-prompt": "c" }).has("my-prompt")).toBe(true);
  });

  it("all-lowercase key with no separators is passed through", () => {
    expect(getPassedKeys({ analysis: "c" }).has("analysis")).toBe(true);
  });

  it("camelCase with .md extension — converted and stripped", () => {
    expect(getPassedKeys({ "myPrompt.md": "c" }).has("my-prompt")).toBe(true);
  });
});

// ── getStageIssues ──

describe("getStageIssues", () => {
  const issues = [
    { severity: "error" as const, message: "e1", stageIndex: 0 },
    { severity: "warning" as const, message: "w1", stageIndex: 1 },
    { severity: "error" as const, message: "e2", stageIndex: 0 },
    { severity: "info" as const, message: "i1", stageIndex: 2 },
  ];

  it("returns issues for matching stageIndex", () => {
    const result = getStageIssues(issues as any, 0);
    expect(result).toHaveLength(2);
    expect(result.map(i => i.message)).toEqual(["e1", "e2"]);
  });

  it("returns empty array for stageIndex with no issues", () => {
    expect(getStageIssues(issues as any, 5)).toEqual([]);
  });

  it("empty issues array returns empty array", () => {
    expect(getStageIssues([], 0)).toEqual([]);
  });

  it("returns single issue for stageIndex with one issue", () => {
    expect(getStageIssues(issues as any, 1)).toHaveLength(1);
  });
});

// ── getIssueSummary ──

describe("getIssueSummary", () => {
  it("empty array returns all zeros", () => {
    expect(getIssueSummary([])).toEqual({ errors: 0, warnings: 0, infos: 0 });
  });

  it("counts errors correctly", () => {
    const issues = [
      { severity: "error" as const, message: "e1", stageIndex: 0 },
      { severity: "error" as const, message: "e2", stageIndex: 0 },
    ];
    expect(getIssueSummary(issues as any).errors).toBe(2);
  });

  it("counts warnings correctly", () => {
    const issues = [
      { severity: "warning" as const, message: "w", stageIndex: 0 },
    ];
    expect(getIssueSummary(issues as any).warnings).toBe(1);
  });

  it("counts infos correctly (anything not error or warning)", () => {
    const issues = [
      { severity: "info" as const, message: "i", stageIndex: 0 },
    ];
    expect(getIssueSummary(issues as any).infos).toBe(1);
  });

  it("mixed issues — counts all three categories", () => {
    const issues = [
      { severity: "error" as const, message: "e", stageIndex: 0 },
      { severity: "warning" as const, message: "w", stageIndex: 0 },
      { severity: "info" as const, message: "i", stageIndex: 0 },
      { severity: "error" as const, message: "e2", stageIndex: 0 },
    ];
    expect(getIssueSummary(issues as any)).toEqual({ errors: 2, warnings: 1, infos: 1 });
  });

  it("unknown severity falls into infos bucket", () => {
    const issues = [{ severity: "unknown" as any, message: "u", stageIndex: 0 }];
    expect(getIssueSummary(issues as any).infos).toBe(1);
  });
});
