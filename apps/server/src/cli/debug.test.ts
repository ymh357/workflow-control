import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const analyzeMock = vi.hoisted(() => vi.fn());
const recordMock = vi.hoisted(() => vi.fn());
const diffMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/debug-queries.js", () => ({
  analyzeTaskFailure: analyzeMock,
  getStageExecutionRecord: recordMock,
  diffExecutions: diffMock,
  listTaskRecords: listMock,
}));

import { runAnalyze, runDiff, runList, runRecord } from "./debug.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  analyzeMock.mockReset();
  recordMock.mockReset();
  diffMock.mockReset();
  listMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAnalyze", () => {
  it("rejects missing taskId", async () => {
    const code = await runAnalyze([], { pretty: false });
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("defaults to JSON output", async () => {
    analyzeMock.mockReturnValue({ taskId: "t1", found: false, totalAttempts: 0, totalCostUsd: 0, firstStartedAt: null, lastHeartbeatAt: null, stages: [], failingStages: [], hints: [] });
    const code = await runAnalyze(["t1"], { pretty: false });
    expect(code).toBe(0);
    const firstCall = logSpy.mock.calls[0]![0] as string;
    expect(() => JSON.parse(firstCall)).not.toThrow();
    const parsed = JSON.parse(firstCall);
    expect(parsed.taskId).toBe("t1");
  });

  it("pretty mode prints human text not JSON", async () => {
    analyzeMock.mockReturnValue({
      taskId: "t1",
      found: true,
      totalAttempts: 2,
      totalCostUsd: 0.1,
      firstStartedAt: "s",
      lastHeartbeatAt: "h",
      stages: [{ stageName: "a", attempts: 1, lastAttemptIndex: 0, lastTerminationReason: "natural_completion", lastTerminatedAt: "t", lastDurationMs: 100, totalCostUsd: 0.05, totalTokenInput: 10, totalTokenOutput: 5, isStuckOpen: false }],
      failingStages: [],
      hints: [],
    });
    await runAnalyze(["t1"], { pretty: true });
    const joined = logSpy.mock.calls.flat().join("\n");
    expect(joined).toContain("Task t1");
    expect(joined).toContain("Stages:");
    // not JSON
    expect(joined.startsWith("{")).toBe(false);
  });
});

describe("runRecord", () => {
  it("rejects missing args", async () => {
    expect(await runRecord([], { pretty: false }, {})).toBe(1);
    expect(await runRecord(["t1"], { pretty: false }, {})).toBe(1);
  });

  it("rejects non-integer --attempt", async () => {
    const code = await runRecord(["t1", "s"], { pretty: false }, { attempt: "abc" });
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("passes integer --attempt through", async () => {
    recordMock.mockReturnValue({ taskId: "t1", stageName: "s", attempt: 2, found: false, record: null, availableAttempts: [] });
    const code = await runRecord(["t1", "s"], { pretty: false }, { attempt: "2" });
    expect(code).toBe(0);
    expect(recordMock).toHaveBeenCalledWith("t1", "s", { attempt: 2 });
  });

  it("defaults to latest when --attempt omitted", async () => {
    recordMock.mockReturnValue({ taskId: "t1", stageName: "s", attempt: null, found: false, record: null, availableAttempts: [] });
    await runRecord(["t1", "s"], { pretty: false }, {});
    expect(recordMock).toHaveBeenCalledWith("t1", "s", {});
  });
});

describe("runList", () => {
  it("rejects missing taskId", async () => {
    expect(await runList([], { pretty: false })).toBe(1);
  });

  it("JSON by default", async () => {
    listMock.mockReturnValue({ taskId: "t1", found: true, total: 0, records: [] });
    const code = await runList(["t1"], { pretty: false });
    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(parsed.taskId).toBe("t1");
  });

  it("pretty mode prints row summary with [OPEN] flag", async () => {
    listMock.mockReturnValue({
      taskId: "t1", found: true, total: 2,
      records: [
        {
          attemptId: "a1", stageName: "analyze", attemptIndex: 0,
          startedAt: "s1", terminatedAt: "t1", status: "success",
          terminationReason: "natural_completion",
          model: "sonnet", pipelineVersionHash: "v1",
          costUsd: 0.01, tokenInput: 10, tokenOutput: 5, durationMs: 100,
          isOpen: false,
        },
        {
          attemptId: "a2", stageName: "implement", attemptIndex: 0,
          startedAt: "s2", terminatedAt: null, status: "running",
          terminationReason: null,
          model: "sonnet", pipelineVersionHash: "v1",
          costUsd: null, tokenInput: null, tokenOutput: null, durationMs: null,
          isOpen: true,
        },
      ],
    });
    await runList(["t1"], { pretty: true });
    const joined = logSpy.mock.calls.flat().join("\n");
    expect(joined).toContain("Task t1");
    expect(joined).toContain("2 attempt(s)");
    expect(joined).toContain("a1");
    expect(joined).toContain("[OPEN]");
  });
});

describe("runDiff", () => {
  it("rejects missing args", async () => {
    expect(await runDiff([], { pretty: false })).toBe(1);
    expect(await runDiff(["a1"], { pretty: false })).toBe(1);
  });

  it("JSON by default", async () => {
    diffMock.mockReturnValue({ found: false, missing: ["a1"], a: null, b: null, identical: false, differences: null });
    const code = await runDiff(["a1", "a2"], { pretty: false });
    expect(code).toBe(0);
    const parsed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(parsed.found).toBe(false);
  });

  it("pretty mode prints diff summary", async () => {
    diffMock.mockReturnValue({
      found: true,
      missing: [],
      a: { attemptId: "a1", taskId: "t", stageName: "s", attemptIndex: 0 },
      b: { attemptId: "a2", taskId: "t", stageName: "s", attemptIndex: 1 },
      identical: false,
      differences: {
        prompt: [{ field: "promptContent", a: "x", b: "y" }],
        toolCalls: {
          aCount: 1, bCount: 0,
          countByName: { onlyInA: { Read: 1 }, onlyInB: {}, shared: {} },
        },
        termination: [],
        cost: { a: null, b: null, deltaUsd: null },
        tokens: { a: { input: null, output: null }, b: { input: null, output: null } },
        durationMs: { a: null, b: null, deltaMs: null },
      },
    });
    await runDiff(["a1", "a2"], { pretty: true });
    const joined = logSpy.mock.calls.flat().join("\n");
    expect(joined).toContain("A: a1");
    expect(joined).toContain("B: a2");
    expect(joined).toContain("prompt changes");
    expect(joined).toContain("only A: Read x1");
  });
});
