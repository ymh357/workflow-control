// Phase 4 / A4 — __debug__ MCP server tests.
//
// Exercises the tool wiring + JSON response envelope. Core query
// logic is covered by debug-queries.test.ts, so we mock the queries
// here and focus on: tool registration, arg validation, JSON
// envelope, truncation, and error propagation.

import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
}));

vi.mock("./debug-queries.js", () => ({
  analyzeTaskFailure: vi.fn(),
  getStageExecutionRecord: vi.fn(),
  diffExecutions: vi.fn(),
  listTaskRecords: vi.fn(),
}));

import { createDebugMcp } from "./debug-mcp.js";
import {
  analyzeTaskFailure,
  diffExecutions,
  getStageExecutionRecord,
  listTaskRecords,
} from "./debug-queries.js";

function getTool(mcp: { tools: unknown[] }, name: string): {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>;
} {
  const tool = (mcp.tools as Array<{ name: string; handler: unknown }>).find(
    (t) => t.name === name,
  );
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool as {
    name: string;
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>;
  };
}

describe("createDebugMcp", () => {
  it("registers the four debug tools", () => {
    const mcp = createDebugMcp() as unknown as { name: string; tools: Array<{ name: string }> };
    expect(mcp.name).toBe("__debug__");
    expect(mcp.tools.map((t) => t.name).sort()).toEqual([
      "analyze_task_failure",
      "diff_executions",
      "get_stage_execution_record",
      "list_task_records",
    ]);
  });

  it("list_task_records returns JSON envelope", async () => {
    vi.mocked(listTaskRecords).mockReturnValue({
      taskId: "t1",
      found: true,
      total: 1,
      records: [{
        attemptId: "a1", stageName: "s", attemptIndex: 0,
        startedAt: "t", terminatedAt: "t", terminationReason: "natural_completion",
        engine: "claude", model: "sonnet", pipelineVersionHash: null,
        costUsd: 0.01, tokenInput: 10, tokenOutput: 5, durationMs: 100,
        isOpen: false,
      }],
    });
    const mcp = createDebugMcp() as unknown as { tools: unknown[] };
    const tool = getTool(mcp, "list_task_records");
    const res = await tool.handler({ taskId: "t1" });
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.total).toBe(1);
    expect(parsed.records[0].attemptId).toBe("a1");
  });

  it("list_task_records rejects empty taskId", async () => {
    const mcp = createDebugMcp() as unknown as { tools: unknown[] };
    const tool = getTool(mcp, "list_task_records");
    const res = await tool.handler({ taskId: "" });
    expect(res.isError).toBe(true);
  });

  it("analyze_task_failure returns JSON envelope", async () => {
    vi.mocked(analyzeTaskFailure).mockReturnValue({
      taskId: "t1",
      found: true,
      totalAttempts: 2,
      totalCostUsd: 0.05,
      firstStartedAt: "t",
      lastHeartbeatAt: "t",
      stages: [],
      failingStages: [],
      hints: [],
    });
    const mcp = createDebugMcp() as unknown as { tools: unknown[] };
    const tool = getTool(mcp, "analyze_task_failure");
    const res = await tool.handler({ taskId: "t1" });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.taskId).toBe("t1");
    expect(parsed.found).toBe(true);
  });

  it("analyze_task_failure rejects empty taskId", async () => {
    const mcp = createDebugMcp() as unknown as { tools: unknown[] };
    const tool = getTool(mcp, "analyze_task_failure");
    const res = await tool.handler({ taskId: "" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("taskId is required");
  });

  it("get_stage_execution_record requires both taskId and stageName", async () => {
    const mcp = createDebugMcp() as unknown as { tools: unknown[] };
    const tool = getTool(mcp, "get_stage_execution_record");
    const res = await tool.handler({ taskId: "t1" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("taskId and stageName");
  });

  it("get_stage_execution_record passes attempt when provided", async () => {
    vi.mocked(getStageExecutionRecord).mockReturnValue({
      taskId: "t1",
      stageName: "s",
      attempt: 2,
      found: true,
      record: null,
      availableAttempts: [0, 1, 2],
    });
    const mcp = createDebugMcp() as unknown as { tools: unknown[] };
    const tool = getTool(mcp, "get_stage_execution_record");
    await tool.handler({ taskId: "t1", stageName: "s", attempt: 2 });
    expect(getStageExecutionRecord).toHaveBeenCalledWith("t1", "s", { attempt: 2 });
  });

  it("diff_executions requires both ids", async () => {
    const mcp = createDebugMcp() as unknown as { tools: unknown[] };
    const tool = getTool(mcp, "diff_executions");
    const res = await tool.handler({ attemptIdA: "x", attemptIdB: "" });
    expect(res.isError).toBe(true);
  });

  it("diff_executions returns JSON envelope", async () => {
    vi.mocked(diffExecutions).mockReturnValue({
      found: true,
      missing: [],
      a: { attemptId: "a1", taskId: "t", stageName: "s", attemptIndex: 0 },
      b: { attemptId: "a2", taskId: "t", stageName: "s", attemptIndex: 1 },
      identical: true,
      differences: {
        promptBlob: [],
        readsSnapshot: { onlyInA: [], onlyInB: [], changed: [], unchanged: [] },
        writesCommitted: { onlyInA: [], onlyInB: [], changed: [], unchanged: [] },
        decisions: { aCount: 0, bCount: 0, onlyInA: [], onlyInB: [] },
        toolCalls: {
          aCount: 0, bCount: 0,
          countByName: { onlyInA: {}, onlyInB: {}, shared: {} },
        },
        termination: [],
        cost: { a: null, b: null, deltaUsd: null },
        tokens: { a: { input: null, output: null }, b: { input: null, output: null } },
        durationMs: { a: null, b: null, deltaMs: null },
      },
    });
    const mcp = createDebugMcp() as unknown as { tools: unknown[] };
    const tool = getTool(mcp, "diff_executions");
    const res = await tool.handler({ attemptIdA: "a1", attemptIdB: "a2" });
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.identical).toBe(true);
  });

  it("truncates huge responses", async () => {
    const big = "x".repeat(300 * 1024);
    vi.mocked(analyzeTaskFailure).mockReturnValue({
      taskId: "t1",
      found: true,
      totalAttempts: 0,
      totalCostUsd: 0,
      firstStartedAt: null,
      lastHeartbeatAt: null,
      stages: [],
      failingStages: [],
      hints: [{ kind: "zero_attempts", stageName: "", detail: big }],
    });
    const mcp = createDebugMcp() as unknown as { tools: unknown[] };
    const tool = getTool(mcp, "analyze_task_failure");
    const res = await tool.handler({ taskId: "t1" });
    expect(res.content[0]!.text).toContain("[truncated");
    expect(res.content[0]!.text.length).toBeLessThan(300 * 1024);
  });

  it("propagates query errors as isError", async () => {
    vi.mocked(analyzeTaskFailure).mockImplementation(() => {
      throw new Error("database locked");
    });
    const mcp = createDebugMcp() as unknown as { tools: unknown[] };
    const tool = getTool(mcp, "analyze_task_failure");
    const res = await tool.handler({ taskId: "t1" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("database locked");
  });
});
