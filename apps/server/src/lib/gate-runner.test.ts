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
import { getGatePath, CONFIG_DIR } from "./config-loader.js";

const mockGetGatePath = vi.mocked(getGatePath);

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// --------------- Gate not found ---------------

describe("gate not found", () => {
  it("returns passed=true with empty checks when gate file is missing", async () => {
    mockGetGatePath.mockReturnValue(null);

    const result = await runGate("nonexistent", "/tmp/worktree");

    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([]);
  });
});

// --------------- Path traversal ---------------

describe("path traversal protection", () => {
  it("rejects gate path outside config directory (../)", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/../../../etc/passwd");

    const result = await runGate("evil", "/tmp/worktree");

    expect(result.passed).toBe(false);
    expect(result.checks[0].detail).toContain("outside allowed directory");
  });

  it("rejects gate path that resolves to sibling directory", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/other/gate.ts");

    const result = await runGate("sibling", "/tmp/worktree");

    expect(result.passed).toBe(false);
    expect(result.checks[0].detail).toContain("outside allowed directory");
  });

  it("rejects gate path that is exactly the config directory (no trailing /)", async () => {
    // resolve(CONFIG_DIR) without trailing slash means startsWith(configBase + "/") is false
    mockGetGatePath.mockReturnValue("/fake/project/config");

    const result = await runGate("configroot", "/tmp/worktree");

    expect(result.passed).toBe(false);
    expect(result.checks[0].detail).toContain("outside allowed directory");
  });
});

// --------------- Module without run export ---------------

describe("gate module without run export", () => {
  it("returns passed=false when module has no run function", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/bad-gate.ts");

    vi.doMock("/fake/project/config/gates/bad-gate.ts", () => ({
      something: "else",
    }));

    const result = await runGate("bad-gate", "/tmp/worktree");

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0].passed).toBe(false);
  });
});

// --------------- Gate throws exception ---------------

describe("gate that throws exception", () => {
  it("returns passed=false with error detail when gate throws", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/crasher.ts");

    vi.doMock("/fake/project/config/gates/crasher.ts", () => ({
      run: () => {
        throw new Error("Intentional test explosion");
      },
    }));

    const result = await runGate("crasher", "/tmp/worktree");

    expect(result.passed).toBe(false);
    expect(result.checks[0].detail).toContain("Intentional test explosion");
  });

  it("returns passed=false when gate rejects with a promise", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/async-fail.ts");

    vi.doMock("/fake/project/config/gates/async-fail.ts", () => ({
      run: async () => {
        throw new Error("Async failure");
      },
    }));

    const result = await runGate("async-fail", "/tmp/worktree");

    expect(result.passed).toBe(false);
    expect(result.checks[0].detail).toContain("Async failure");
  });

  it("stringifies non-Error thrown values", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/string-throw.ts");

    vi.doMock("/fake/project/config/gates/string-throw.ts", () => ({
      run: () => {
        throw "raw string error";
      },
    }));

    const result = await runGate("string-throw", "/tmp/worktree");

    expect(result.passed).toBe(false);
    expect(result.checks[0].detail).toBe("raw string error");
  });
});

// --------------- Normal gate execution ---------------

describe("normal gate execution", () => {
  it("returns the gate result when all checks pass", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/quality.ts");

    vi.doMock("/fake/project/config/gates/quality.ts", () => ({
      run: (_path: string) => ({
        passed: true,
        checks: [
          { name: "tsc", passed: true },
          { name: "lint", passed: true },
        ],
      }),
    }));

    const result = await runGate("quality", "/tmp/worktree");

    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it("returns failed result with failing checks intact", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/strict.ts");

    vi.doMock("/fake/project/config/gates/strict.ts", () => ({
      run: (_path: string) => ({
        passed: false,
        checks: [
          { name: "tsc", passed: true },
          { name: "no-console", passed: false, detail: "Found console.log at line 42" },
        ],
      }),
    }));

    const result = await runGate("strict", "/tmp/worktree");

    expect(result.passed).toBe(false);
    expect(result.checks).toHaveLength(2);
    expect(result.checks[1].detail).toContain("console.log");
  });

  it("passes worktreePath argument to the gate run function", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/echo.ts");

    const runSpy = vi.fn().mockReturnValue({ passed: true, checks: [] });
    vi.doMock("/fake/project/config/gates/echo.ts", () => ({
      run: runSpy,
    }));

    await runGate("echo", "/my/custom/worktree");

    expect(runSpy).toHaveBeenCalledWith("/my/custom/worktree");
  });

  it("handles async gate run function correctly", async () => {
    mockGetGatePath.mockReturnValue("/fake/project/config/gates/async-gate.ts");

    vi.doMock("/fake/project/config/gates/async-gate.ts", () => ({
      run: async (_path: string) => ({
        passed: true,
        checks: [{ name: "async-check", passed: true }],
      }),
    }));

    const result = await runGate("async-gate", "/tmp/worktree");

    expect(result.passed).toBe(true);
    expect(result.checks[0].name).toBe("async-check");
  });
});
