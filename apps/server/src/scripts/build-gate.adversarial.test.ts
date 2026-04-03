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

describe("buildGateScript – adversarial", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to process.cwd() when both inputs.worktreePath and context.worktreePath are undefined", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());

    const params = makeParams();
    params.context = { store: {} } as any;
    params.inputs = undefined;

    await buildGateScript.handler(params);
    expect(mockSpawnWithTimeout.mock.calls[0][2].cwd).toBe(process.cwd());
  });

  it("truncates very long build output to last 2000 chars", async () => {
    const longOutput = "x".repeat(5000);
    mockSpawnWithTimeout.mockResolvedValueOnce({ exitCode: 0, timedOut: false, stdout: "", stderr: "", combined: longOutput });
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());

    const result = await buildGateScript.handler(makeParams());
    expect(result.buildOutput.length).toBe(2000);
  });

  it("truncates very long test output to last 3000 chars", async () => {
    const longOutput = "y".repeat(6000);
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());
    mockSpawnWithTimeout.mockResolvedValueOnce({ exitCode: 0, timedOut: false, stdout: "", stderr: "", combined: longOutput });

    const result = await buildGateScript.handler(makeParams());
    expect(result.testOutput.length).toBe(3000);
  });

  it("still runs tests even when build fails (both outputs captured)", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(failResult("build err"));
    mockSpawnWithTimeout.mockResolvedValueOnce(failResult("test err"));
    const result = await buildGateScript.handler(makeParams());
    expect(mockSpawnWithTimeout).toHaveBeenCalledTimes(2);
    expect(result.buildOutput).toBe("build err");
    expect(result.testOutput).toBe("test err");
    expect(result.passed).toBe(false);
  });

  it("handles exitCode 0 with timedOut true as failure (edge: conflicting signals)", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce({ exitCode: 0, timedOut: true, stdout: "", stderr: "", combined: "" });
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());
    const result = await buildGateScript.handler(makeParams());
    expect(result.passed).toBe(false);
    expect(result.buildPassed).toBe(false);
    expect(result.failureSummary).toContain("Build timed out");
  });

  it("handles spawnWithTimeout rejecting (propagates unhandled spawn errors)", async () => {
    mockSpawnWithTimeout.mockRejectedValueOnce(new Error("spawn ENOENT"));

    await expect(buildGateScript.handler(makeParams())).rejects.toThrow("spawn ENOENT");
  });

  it("result contains correct PASS/FAIL summary when only tests time out", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult("build ok"));
    mockSpawnWithTimeout.mockResolvedValueOnce({ exitCode: null, timedOut: true, stdout: "", stderr: "", combined: "..." });
    const result = await buildGateScript.handler(makeParams());
    expect(result.buildPassed).toBe(true);
    expect(result.testsPassed).toBe(false);
    expect(result.failureSummary).toContain("Tests timed out");
    expect(result.passed).toBe(false);
  });

  it("appends EXTRA_PATH to process.env.PATH in the env passed to spawn", async () => {
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());
    mockSpawnWithTimeout.mockResolvedValueOnce(okResult());

    await buildGateScript.handler(makeParams());

    const envPassed = mockSpawnWithTimeout.mock.calls[0][2].env;
    expect(envPassed.PATH).toContain("/opt/homebrew/bin");
    expect(envPassed.PATH).toContain("/usr/local/bin");
  });
});
