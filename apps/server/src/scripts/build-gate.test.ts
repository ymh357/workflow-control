import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSpawnWithTimeout = vi.fn();

vi.mock("../lib/spawn-utils.js", () => ({
  spawnWithTimeout: (...args: any[]) => mockSpawnWithTimeout(...args),
}));

import { buildGateScript } from "./build-gate.js";

function makeParams(overrides: Record<string, any> = {}) {
  return {
    taskId: "task-1",
    context: { worktreePath: "/tmp/wt", store: {} } as any,
    settings: {} as any,
    inputs: overrides.inputs,
    args: overrides.args,
  };
}

function okResult(combined = "ok") {
  return { exitCode: 0, timedOut: false, stdout: combined, stderr: "", combined };
}

function failResult(combined = "error output") {
  return { exitCode: 1, timedOut: false, stdout: "", stderr: combined, combined };
}

function timedOutResult() {
  return { exitCode: null, timedOut: true, stdout: "", stderr: "", combined: "..." };
}

describe("buildGateScript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("has correct metadata id", () => {
    expect(buildGateScript.metadata.id).toBe("build_gate");
  });

  it("returns pass result when build and tests succeed", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult("build ok"));
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult("test ok"));

    const result = await buildGateScript.handler(makeParams());
    expect(result.buildPassed).toBe(true);
    expect(result.testsPassed).toBe(true);
    expect(result.failureSummary).toBe("");
  });

  it("calls pnpm build then pnpm test with correct cwd", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());

    await buildGateScript.handler(makeParams());

    expect(mockSpawnWithTimeout).toHaveBeenCalledTimes(2);
    expect(mockSpawnWithTimeout.mock.calls[0][0]).toBe("pnpm");
    expect(mockSpawnWithTimeout.mock.calls[0][1]).toEqual(["build"]);
    expect(mockSpawnWithTimeout.mock.calls[0][2]).toMatchObject({ cwd: "/tmp/wt" });
    expect(mockSpawnWithTimeout.mock.calls[1][0]).toBe("pnpm");
    expect(mockSpawnWithTimeout.mock.calls[1][1]).toEqual(["test"]);
  });

  it("returns failure result when build fails", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(failResult("compile error"));
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult("tests ok"));
    const result = await buildGateScript.handler(makeParams());
    expect(result.passed).toBe(false);
    expect(result.buildPassed).toBe(false);
    expect(result.testsPassed).toBe(true);
    expect(result.blockers).toEqual(expect.arrayContaining([expect.stringContaining("Build failed")]));
  });

  it("returns failure result when tests fail", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult("build ok"));
    mockSpawnWithTimeout.mockResolvedValueOnce(failResult("assertion error"));
    const result = await buildGateScript.handler(makeParams());
    expect(result.passed).toBe(false);
    expect(result.buildPassed).toBe(true);
    expect(result.testsPassed).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([expect.stringContaining("Tests failed")]));
  });

  it("returns failure result with both blockers when both fail", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(failResult());
    mockSpawnWithTimeout.mockResolvedValueOnce(failResult());
    const result = await buildGateScript.handler(makeParams());
    expect(result.passed).toBe(false);
    expect(result.buildPassed).toBe(false);
    expect(result.testsPassed).toBe(false);
    expect(result.blockers.length).toBe(2);
  });

  it("reports timeout for build", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce({ exitCode: null, timedOut: true, stdout: "", stderr: "", combined: "..." });
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());
    const result = await buildGateScript.handler(makeParams());
    expect(result.passed).toBe(false);
    expect(result.buildPassed).toBe(false);
    expect(result.failureSummary).toContain("Build timed out");
  });

  it("uses inputs.worktreePath over context.worktreePath", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());

    await buildGateScript.handler(makeParams({ inputs: { worktreePath: "/custom/path" } }));
    expect(mockSpawnWithTimeout.mock.calls[0][2].cwd).toBe("/custom/path");
  });

  it("strips ANSI escape codes from build output", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(failResult("\x1b[31merror\x1b[0m TS2345: Argument of type"));
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());
    const result = await buildGateScript.handler(makeParams());
    expect(result.buildOutput).toBe("error TS2345: Argument of type");
    expect(result.buildOutput).not.toContain("\x1b[");
  });

  it("strips ANSI escape codes from test output", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());
    mockSpawnWithTimeout.mockResolvedValueOnce(failResult("\x1b[1m\x1b[31mFAIL\x1b[0m src/foo.test.ts"));
    const result = await buildGateScript.handler(makeParams());
    expect(result.testOutput).toBe("FAIL src/foo.test.ts");
    expect(result.testOutput).not.toContain("\x1b[");
  });

  it("returns structured result object on failure", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(failResult("err"));
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());
    const result = await buildGateScript.handler(makeParams());
    expect(result.buildPassed).toBe(false);
    expect(result.testsPassed).toBe(true);
    expect(result.passed).toBe(false);
  });
});
