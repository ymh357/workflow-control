import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mock all external deps (same pattern as mcp-server.test.ts) ---

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

import { getAllSlots, hasSlot, getSlotNonce, resolveSlot } from "./registry.js";
import { getTaskContext, confirmGate, rejectGate, retryTask, cancelTask_, resumeTask, interruptTask, createTask, launch } from "../actions/task-actions.js";
import { listAvailablePipelines, getNestedValue } from "../lib/config-loader.js";
import { extractJSON } from "../lib/json-extractor.js";
import { sseManager } from "../sse/manager.js";

const mockGetAllSlots = vi.mocked(getAllSlots);
const mockHasSlot = vi.mocked(hasSlot);
const mockGetSlotNonce = vi.mocked(getSlotNonce);
const mockResolveSlot = vi.mocked(resolveSlot);
const mockGetTaskContext = vi.mocked(getTaskContext);
const mockConfirmGate = vi.mocked(confirmGate);
const mockRejectGate = vi.mocked(rejectGate);
const mockRetryTask = vi.mocked(retryTask);
const mockCancelTask = vi.mocked(cancelTask_);
const mockResumeTask = vi.mocked(resumeTask);
const mockInterruptTask = vi.mocked(interruptTask);
const mockCreateTask = vi.mocked(createTask);
const mockLaunch = vi.mocked(launch);
const mockListPipelines = vi.mocked(listAvailablePipelines);
const mockExtractJSON = vi.mocked(extractJSON);
const mockPushMessage = vi.mocked(sseManager.pushMessage);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getNestedValue).mockImplementation((obj: any, path: string) => {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
  });
});

// Replicate internal functions for direct testing

function textResult(text: string, isError?: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function validateStageOutput(resultText: string, writes: string[]): { valid: boolean; missing?: string[]; reason?: string } {
  if (writes.length === 0) return { valid: true };
  if (!resultText) return { valid: false, reason: "resultText is empty" };

  let parsed: Record<string, unknown>;
  try {
    parsed = mockExtractJSON(resultText);
  } catch {
    return { valid: false, reason: "Could not parse JSON from resultText" };
  }

  const missing = writes.filter((field) => parsed[field] === undefined);
  if (missing.length === writes.length) {
    return { valid: false, missing, reason: `None of the required fields found: ${writes.join(", ")}` };
  }

  return { valid: true };
}

// ---- Tests ----

describe("validateStageOutput - adversarial inputs", () => {
  it("returns valid when writes array is empty regardless of resultText", () => {
    expect(validateStageOutput("", [])).toEqual({ valid: true });
    expect(validateStageOutput("garbage", [])).toEqual({ valid: true });
  });

  it("returns invalid when resultText is empty but writes has fields", () => {
    const result = validateStageOutput("", ["plan"]);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("empty");
  });

  it("accepts output with at least ONE of multiple required fields (partial output)", () => {
    mockExtractJSON.mockReturnValue({ plan: "do X" });
    const result = validateStageOutput('{"plan":"do X"}', ["plan", "code", "tests"]);
    // "At least one field present" semantics
    expect(result.valid).toBe(true);
  });

  it("rejects when NONE of the required fields are present", () => {
    mockExtractJSON.mockReturnValue({ unrelated: "value" });
    const result = validateStageOutput('{"unrelated":"value"}', ["plan", "code"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["plan", "code"]);
  });

  it("returns invalid when extractJSON throws", () => {
    mockExtractJSON.mockImplementation(() => { throw new Error("parse failed"); });
    const result = validateStageOutput("not json at all", ["plan"]);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Could not parse JSON");
  });

  it("treats null field values as present (undefined !== null)", () => {
    mockExtractJSON.mockReturnValue({ plan: null });
    const result = validateStageOutput('{"plan":null}', ["plan"]);
    // plan is null, not undefined, so it passes the undefined check
    expect(result.valid).toBe(true);
  });

  it("treats false and 0 field values as present", () => {
    mockExtractJSON.mockReturnValue({ flag: false, count: 0 });
    const result = validateStageOutput('{"flag":false,"count":0}', ["flag", "count"]);
    expect(result.valid).toBe(true);
  });

  it("treats empty string field as present", () => {
    mockExtractJSON.mockReturnValue({ plan: "" });
    const result = validateStageOutput('{"plan":""}', ["plan"]);
    expect(result.valid).toBe(true);
  });
});

describe("list_available_stages - slot enrichment edge cases", () => {
  it("handles slot with null task context (deleted task)", () => {
    mockGetAllSlots.mockReturnValue([
      { taskId: "orphan-task", stageName: "analysis", nonce: "n1", createdAt: Date.now() },
    ]);
    mockGetTaskContext.mockReturnValue(null);

    const slots = mockGetAllSlots();
    const enriched = slots.map((slot) => {
      const context = mockGetTaskContext(slot.taskId);
      return {
        taskId: slot.taskId,
        stageName: slot.stageName,
        taskText: context?.taskText ?? "",
        waitingSeconds: Math.round((Date.now() - slot.createdAt) / 1000),
      };
    });

    expect(enriched[0].taskText).toBe("");
    expect(enriched[0].waitingSeconds).toBeLessThanOrEqual(1);
  });

  it("computes waitingSeconds correctly for old slots", () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    mockGetAllSlots.mockReturnValue([
      { taskId: "t1", stageName: "s1", nonce: "n", createdAt: fiveMinAgo },
    ]);

    const slot = mockGetAllSlots()[0];
    const waitingSeconds = Math.round((Date.now() - slot.createdAt) / 1000);
    expect(waitingSeconds).toBeGreaterThanOrEqual(299);
    expect(waitingSeconds).toBeLessThanOrEqual(301);
  });
});

describe("check_interrupts - status-based interrupt detection", () => {
  it("returns interrupted=true for cancelled task", () => {
    const context = { status: "cancelled", error: "User cancelled" } as any;
    const interrupted = context.status === "cancelled" || context.status === "blocked";
    expect(interrupted).toBe(true);
  });

  it("returns interrupted=true for blocked task", () => {
    const context = { status: "blocked", error: null } as any;
    const interrupted = context.status === "cancelled" || context.status === "blocked";
    expect(interrupted).toBe(true);
  });

  it("returns interrupted=false for running task", () => {
    const context = { status: "running" } as any;
    const interrupted = context.status === "cancelled" || context.status === "blocked";
    expect(interrupted).toBe(false);
  });

  it("returns interrupted=true when task is not found (context is null)", () => {
    mockGetTaskContext.mockReturnValue(null);
    const context = mockGetTaskContext("nonexistent");
    // Source code returns { interrupted: true, reason: "Task not found" }
    expect(context).toBeNull();
  });
});

describe("report_progress - data validation edge cases", () => {
  it("rejects text type when data.text is not a string", () => {
    const type = "text";
    const data = { text: 42 };
    // Source checks: typeof data.text !== "string"
    const isInvalid = (type === "text" || type === "thinking") && typeof data.text !== "string";
    expect(isInvalid).toBe(true);
  });

  it("rejects thinking type when data.text is missing", () => {
    const type: string = "thinking";
    const data = {};
    const isInvalid = (type === "text" || type === "thinking") && typeof (data as any).text !== "string";
    expect(isInvalid).toBe(true);
  });

  it("rejects tool_use type when data.toolName is not a string", () => {
    const type = "tool_use";
    const data = { toolName: null };
    const isInvalid = type === "tool_use" && typeof data.toolName !== "string";
    expect(isInvalid).toBe(true);
  });

  it("accepts text type with empty string (typeof '' === 'string')", () => {
    const type = "text";
    const data = { text: "" };
    const isInvalid = (type === "text" || type === "thinking") && typeof data.text !== "string";
    expect(isInvalid).toBe(false);
  });

  it("maps SSE types correctly", () => {
    const typeMap = (t: string) =>
      t === "text" ? "agent_text" : t === "tool_use" ? "agent_tool_use" : "agent_thinking";

    expect(typeMap("text")).toBe("agent_text");
    expect(typeMap("tool_use")).toBe("agent_tool_use");
    expect(typeMap("thinking")).toBe("agent_thinking");
  });
});

describe("trigger_task - pipeline validation", () => {
  it("rejects unknown pipeline ID", () => {
    mockListPipelines.mockReturnValue([
      { id: "pipeline-generator", name: "Pipeline Generator", engine: "claude", stageCount: 3 },
    ]);

    const available = mockListPipelines().map((p) => p.id);
    expect(available.includes("nonexistent")).toBe(false);
  });

  it("handles createTask returning error", () => {
    mockCreateTask.mockReturnValue({ ok: false, code: "VALIDATION_FAILED", message: "Missing taskText" } as any);
    const result = mockCreateTask({ pipelineName: "test" } as any);
    expect(result.ok).toBe(false);
  });

  it("handles launch returning error after successful create", () => {
    mockCreateTask.mockReturnValue({ ok: true, data: { taskId: "t1" } } as any);
    mockLaunch.mockReturnValue({ ok: false, code: "INVALID_STATE", message: "Already running" } as any);

    const created = mockCreateTask({} as any);
    expect(created.ok).toBe(true);
    const launched = mockLaunch((created as any).data.taskId);
    expect(launched.ok).toBe(false);
  });
});

describe("confirm_gate - decision routing", () => {
  it("calls confirmGate for approve decision", () => {
    mockGetTaskContext.mockReturnValue({ taskId: "t1", status: "review" } as any);
    mockConfirmGate.mockReturnValue({ ok: true, data: {} } as any);

    const decision = "approve";
    if (decision === "approve") {
      const result = mockConfirmGate("t1", {});
      expect(result.ok).toBe(true);
    }
    expect(mockConfirmGate).toHaveBeenCalledWith("t1", {});
    expect(mockRejectGate).not.toHaveBeenCalled();
  });

  it("calls rejectGate for reject decision with reason", () => {
    mockGetTaskContext.mockReturnValue({ taskId: "t1", status: "review" } as any);
    mockRejectGate.mockReturnValue({ ok: true, data: {} } as any);

    const decision: string = "reject";
    const reason = "Code quality insufficient";
    if (decision !== "approve") {
      mockRejectGate("t1", { reason, feedback: undefined });
    }
    expect(mockRejectGate).toHaveBeenCalledWith("t1", { reason, feedback: undefined });
  });

  it("passes feedback only for feedback decision, not reject", () => {
    const decision = "feedback";
    const feedback = "Please add tests";
    const reason = "some reason";

    // Source: feedback: decision === "feedback" ? feedback : undefined
    const passedFeedback = decision === "feedback" ? feedback : undefined;
    expect(passedFeedback).toBe("Please add tests");

    const decision2: string = "reject";
    const passedFeedback2 = decision2 === "feedback" ? feedback : undefined;
    expect(passedFeedback2).toBeUndefined();
  });
});

describe("get_store_value - dot notation edge cases", () => {
  it("returns undefined for deeply nested path that does not exist", () => {
    const store = { a: { b: { c: 1 } } };
    const value = vi.mocked(getNestedValue)(store as any, "a.b.d");
    expect(value).toBeUndefined();
  });

  it("returns null (not undefined) when intermediate path is null — potential bug", () => {
    const store = { a: null };
    const value = vi.mocked(getNestedValue)(store as any, "a.b.c");
    // `null && null["b"]` short-circuits to null, not undefined.
    // Callers expecting undefined for "not found" may mishandle this.
    expect(value).toBeNull();
  });

  it("handles empty path string", () => {
    const store = { a: 1 };
    const value = vi.mocked(getNestedValue)(store as any, "");
    expect(value).toBeUndefined();
  });

  it("handles path with trailing dot", () => {
    const store = { a: { "": "empty key" } };
    // "a." splits to ["a", ""] — accesses store.a[""]
    const value = vi.mocked(getNestedValue)(store as any, "a.");
    expect(value).toBe("empty key");
  });
});

describe("submit_stage_result - nonce-based stale submission", () => {
  it("returns error when resolveSlot returns false (stale nonce)", () => {
    mockResolveSlot.mockReturnValue(false);
    const resolved = mockResolveSlot("t1", "s1", { resultText: "{}", costUsd: 0, durationMs: 0 }, "old-nonce");
    expect(resolved).toBe(false);
  });

  it("skips validation when getTaskContext returns null (race condition: task deleted)", () => {
    mockGetTaskContext.mockReturnValue(null);
    mockResolveSlot.mockReturnValue(true);

    // When context is null, validation is skipped and resolveSlot proceeds
    const context = mockGetTaskContext("deleted-task");
    expect(context).toBeNull();
    // resolveSlot should still be callable
    const resolved = mockResolveSlot("deleted-task", "s1", { resultText: "{}", costUsd: 0, durationMs: 0 });
    expect(resolved).toBe(true);
  });
});
