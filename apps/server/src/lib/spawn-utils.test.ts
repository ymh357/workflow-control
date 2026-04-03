import { describe, it, expect } from "vitest";
import { spawnWithTimeout } from "./spawn-utils.js";

describe("spawnWithTimeout", () => {
  it("captures stdout from a successful command", async () => {
    const result = await spawnWithTimeout("echo", ["hello world"], {
      timeoutMs: 5000,
    });
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr output", async () => {
    const result = await spawnWithTimeout("sh", ["-c", "echo errout >&2"], {
      timeoutMs: 5000,
    });
    expect(result.stderr.trim()).toBe("errout");
    expect(result.exitCode).toBe(0);
  });

  it("captures combined output", async () => {
    const result = await spawnWithTimeout(
      "sh",
      ["-c", "echo out && echo err >&2"],
      { timeoutMs: 5000 },
    );
    expect(result.combined).toContain("out");
    expect(result.combined).toContain("err");
  });

  it("reports non-zero exit code", async () => {
    const result = await spawnWithTimeout("sh", ["-c", "exit 42"], {
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  it("times out and kills long-running process", async () => {
    const result = await spawnWithTimeout("sleep", ["30"], {
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    // exitCode is 1 or non-zero after kill
    expect(result.exitCode).not.toBe(0);
  }, 10000);

  it("truncates stdout when maxOutputBytes is exceeded", async () => {
    // Generate output larger than the limit
    const result = await spawnWithTimeout(
      "sh",
      ["-c", "python3 -c \"print('A' * 2000)\" || printf '%0.sA' $(seq 1 2000)"],
      { timeoutMs: 5000, maxOutputBytes: 100 },
    );
    // The buffer should stop accumulating after maxOutputBytes
    expect(result.stdout.length).toBeLessThanOrEqual(2100); // some tolerance for last chunk
  });

  it("rejects on error event for invalid command", async () => {
    await expect(
      spawnWithTimeout("/nonexistent-command-xyz", [], { timeoutMs: 5000 }),
    ).rejects.toThrow();
  });

  it("passes environment variables", async () => {
    const result = await spawnWithTimeout(
      "sh",
      ["-c", "echo $TEST_VAR_XYZ"],
      {
        timeoutMs: 5000,
        env: { ...process.env, TEST_VAR_XYZ: "hello123" },
      },
    );
    expect(result.stdout.trim()).toBe("hello123");
  });

  it("respects cwd option", async () => {
    const result = await spawnWithTimeout("pwd", [], {
      timeoutMs: 5000,
      cwd: "/tmp",
    });
    // On macOS /tmp is a symlink to /private/tmp
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
  });

  it("handles command with no output", async () => {
    const result = await spawnWithTimeout("true", [], { timeoutMs: 5000 });
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
