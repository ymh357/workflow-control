import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config-loader.js", () => ({
  getGatePath: vi.fn(),
  CONFIG_DIR: "/fake/project/config",
}));
vi.mock("./logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import { runGate } from "./gate-runner.js";
import { getGatePath } from "./config-loader.js";

const mockGetGatePath = vi.mocked(getGatePath);

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("gate-runner adversarial", () => {
  it("gate path with symlink-like traversal that resolves inside config dir passes", async () => {
    // Path that looks traversed but resolves within config dir
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/../gates/good.ts");

    vi.doMock("/fake/project/config/gates/good.ts", () => ({
      run: () => ({ passed: true, checks: [] }),
    }));

    const result = await runGate("good", "/tmp/wt");
    expect(result.passed).toBe(true);
  });

  it("gate at exact config dir boundary (config/x) is allowed", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gate.ts");

    vi.doMock("/fake/project/config/gate.ts", () => ({
      run: () => ({ passed: true, checks: [{ name: "t", passed: true }] }),
    }));

    const result = await runGate("boundary", "/tmp/wt");
    expect(result.passed).toBe(true);
  });

  it("gate module that exports run as a non-function returns failure", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/not-func.ts");

    vi.doMock("/fake/project/config/gates/not-func.ts", () => ({
      run: "I am a string, not a function",
    }));

    const result = await runGate("not-func", "/tmp/wt");
    expect(result.passed).toBe(false);
    expect(result.checks[0].detail).toContain("does not export a run() function");
  });

  it("gate returning result with empty checks array", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/empty-checks.ts");

    vi.doMock("/fake/project/config/gates/empty-checks.ts", () => ({
      run: () => ({ passed: true, checks: [] }),
    }));

    const result = await runGate("empty-checks", "/tmp/wt");
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(0);
  });

  it("gate returning passed=true but with failing checks (inconsistent)", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/inconsistent.ts");

    vi.doMock("/fake/project/config/gates/inconsistent.ts", () => ({
      run: () => ({
        passed: true, // says passed
        checks: [
          { name: "lint", passed: false, detail: "3 errors" }, // but has failures
        ],
      }),
    }));

    const result = await runGate("inconsistent", "/tmp/wt");
    // gate-runner trusts the passed field, doesn't verify against checks
    expect(result.passed).toBe(true);
  });

  it("gate run() returning undefined/null triggers error path", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/null-return.ts");

    vi.doMock("/fake/project/config/gates/null-return.ts", () => ({
      run: () => undefined,
    }));

    const result = await runGate("null-return", "/tmp/wt");
    // Accessing result.checks.filter on undefined will throw -> caught by outer catch
    expect(result.passed).toBe(false);
    expect(result.checks[0].passed).toBe(false);
  });

  it("gate path with null byte in name is handled", async () => {
    mockGetGatePath.mockReturnValue(null);

    const result = await runGate("gate\0name", "/tmp/wt");
    // getGatePath returns null -> passed by default
    expect(result.passed).toBe(true);
  });

  it("worktreePath with spaces is passed correctly to gate run()", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/space-path.ts");

    const runSpy = vi.fn().mockReturnValue({ passed: true, checks: [] });
    vi.doMock("/fake/project/config/gates/space-path.ts", () => ({
      run: runSpy,
    }));

    await runGate("space-path", "/tmp/my worktree/path with spaces");

    expect(runSpy).toHaveBeenCalledWith("/tmp/my worktree/path with spaces");
  });
});
