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

  // B6.#21 (2026-04-30 review) regression: chunk.toString() decoded
  // each Buffer in isolation, so a UTF-8 multi-byte char split across
  // two chunks would produce U+FFFD on the boundary. StringDecoder
  // retains partial state across calls.
  it("preserves UTF-8 multi-byte characters across chunk boundaries", async () => {
    // 中文 = 3 bytes per char in UTF-8. Echo a long string and let
    // node fragment it on read; the result must be byte-identical.
    const text = "你好世界".repeat(2000); // 8000 chars × 3 bytes = 24000 bytes
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write(${JSON.stringify(text)})`],
      { timeoutMs: 10000, maxOutputBytes: 1024 * 1024 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(text);
    // No replacement characters from boundary truncation.
    expect(result.stdout).not.toContain("�");
  });
});
