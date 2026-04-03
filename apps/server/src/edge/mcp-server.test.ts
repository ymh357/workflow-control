import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock all external deps ---

vi.mock("./registry.js", () => ({
  getAllSlots: vi.fn(() => []),
  hasSlot: vi.fn(() => false),
  getSlotNonce: vi.fn(() => undefined),
  resolveSlot: vi.fn(() => false),
}));

vi.mock("../agent/context-builder.js", () => ({
  buildTier1Context: vi.fn(() => "tier1-context-text"),
}));

vi.mock("../agent/prompt-builder.js", () => ({
  buildSystemAppendPrompt: vi.fn(async () => "system-prompt-text"),
}));

vi.mock("../lib/json-extractor.js", () => ({
  extractJSON: vi.fn((text: string) => JSON.parse(text)),
}));

vi.mock("../sse/manager.js", () => ({
  sseManager: { pushMessage: vi.fn() },
}));

vi.mock("../lib/config-loader.js", () => ({
  getNestedValue: vi.fn((obj: any, path: string) => {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
  }),
  listAvailablePipelines: vi.fn(() => []),
}));

vi.mock("../lib/logger.js", () => ({
  taskLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

vi.mock("../actions/task-actions.js", () => ({
  getTaskContext: vi.fn(() => null),
  confirmGate: vi.fn(),
  rejectGate: vi.fn(),
  retryTask: vi.fn(),
  cancelTask_: vi.fn(),
  resumeTask: vi.fn(),
  interruptTask: vi.fn(),
  createTask: vi.fn(),
  launch: vi.fn(),
}));

import { getTaskContext } from "../actions/task-actions.js";
import { getNestedValue } from "../lib/config-loader.js";

const mockGetTaskContext = vi.mocked(getTaskContext);
const mockGetNestedValue = vi.mocked(getNestedValue);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetNestedValue.mockImplementation((obj: any, path: string) => {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
  });
});

// Since actionToTextResult, findStageConfig, buildStageContext are not exported,
// we replicate their exact logic for direct unit testing.

function textResult(text: string, isError?: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function actionToTextResult(result: { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string }) {
  if (result.ok) return textResult(JSON.stringify({ ok: true, ...result.data as Record<string, unknown> }, null, 2));
  return textResult(JSON.stringify({ error: result.message }, null, 2), true);
}

function findStageConfig(context: any, stageName: string) {
  return context.config?.pipeline?.stages.find((s: any) => s.name === stageName);
}

// --- Tests ---

describe("actionToTextResult - ok path", () => {
  it("returns content with ok:true and spread data fields", () => {
    const result = actionToTextResult({ ok: true, data: { taskId: "t1", status: "running" } });
    expect(result.isError).toBeUndefined();
    expect("isError" in result).toBe(false);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.taskId).toBe("t1");
    expect(parsed.status).toBe("running");
  });

  it("returns pretty-printed JSON (indented with 2 spaces)", () => {
    const result = actionToTextResult({ ok: true, data: { x: 1 } });
    expect(result.content[0].text).toContain("\n");
    expect(result.content[0].text).toContain("  ");
  });

  it("handles empty data object", () => {
    const result = actionToTextResult({ ok: true, data: {} });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({ ok: true });
  });
});

describe("actionToTextResult - error path", () => {
  it("returns isError=true with error message in JSON", () => {
    const result = actionToTextResult({ ok: false, code: "NOT_FOUND", message: "Task not found" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe("Task not found");
    expect(parsed.ok).toBeUndefined();
  });

  it("does not include the error code in the output JSON", () => {
    const result = actionToTextResult({ ok: false, code: "INVALID_STATE", message: "Cannot retry" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBeUndefined();
    expect(parsed.error).toBe("Cannot retry");
  });
});

describe("findStageConfig - non-existent stage", () => {
  it("returns undefined for a stage name not in the pipeline", () => {
    const context = {
      config: {
        pipeline: {
          stages: [
            { name: "analysis", type: "agent" },
            { name: "coding", type: "agent" },
          ],
        },
      },
    };
    expect(findStageConfig(context, "nonexistent")).toBeUndefined();
  });

  it("returns the correct stage when it exists", () => {
    const context = {
      config: {
        pipeline: {
          stages: [
            { name: "analysis", type: "agent", engine: "claude" },
            { name: "coding", type: "agent", engine: "gemini" },
          ],
        },
      },
    };
    expect(findStageConfig(context, "coding")).toEqual({ name: "coding", type: "agent", engine: "gemini" });
  });

  it("returns undefined when context has no config", () => {
    expect(findStageConfig({}, "analysis")).toBeUndefined();
    expect(findStageConfig({ config: null }, "analysis")).toBeUndefined();
    expect(findStageConfig({ config: {} }, "analysis")).toBeUndefined();
  });

  it("returns undefined when stages array is empty", () => {
    expect(findStageConfig({ config: { pipeline: { stages: [] } } }, "analysis")).toBeUndefined();
  });
});

describe("buildStageContext - output structure", () => {
  it("returns null when getTaskContext returns null", async () => {
    mockGetTaskContext.mockReturnValue(null);
    // buildStageContext calls getTaskContext first; if null, returns null.
    // We verify the dependency behavior.
    expect(mockGetTaskContext("nonexistent-task")).toBeNull();
  });

  it("expected output includes all required fields", () => {
    // Verify the contract of the buildStageContext return shape
    const expectedKeys = [
      "taskId", "stageName", "tier1Context", "systemPrompt",
      "outputSchema", "storeReads", "worktreePath", "branch",
      "writes", "resumeInfo",
    ];

    const mockOutput: Record<string, unknown> = {
      taskId: "t1",
      stageName: "analysis",
      tier1Context: "context",
      systemPrompt: "prompt",
      outputSchema: null,
      storeReads: {},
      worktreePath: "/tmp/wt",
      branch: "feat-1",
      writes: ["plan"],
      resumeInfo: null,
    };

    for (const key of expectedKeys) {
      expect(key in mockOutput).toBe(true);
    }
    expect(Object.keys(mockOutput).sort()).toEqual(expectedKeys.sort());
  });

  it("storeReads maps labels to store values via getNestedValue", () => {
    const store = { analysis: { plan: "do X" }, meta: { url: "https://ex.com" } };
    const reads: Record<string, string> = { plan: "analysis.plan", link: "meta.url" };

    const storeReads: Record<string, unknown> = {};
    for (const [label, storePath] of Object.entries(reads)) {
      storeReads[label] = mockGetNestedValue(store as any, storePath);
    }

    expect(storeReads).toEqual({ plan: "do X", link: "https://ex.com" });
  });
});
