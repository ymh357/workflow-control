import { describe, it, expect } from "vitest";
import { spawnWithTimeout } from "./spawn-utils.js";

describe("spawnWithTimeout adversarial — Bug 7: maxOutputBytes buffer overflow", () => {
  it("truncates stdout to exactly maxOutputBytes when single chunk exceeds limit", async () => {
    const maxBytes = 100;
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("x".repeat(200))`],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stdout.length).toBe(maxBytes);
    expect(result.stdout).toBe("x".repeat(maxBytes));
  });

  it("truncates stdout to exactly maxOutputBytes with two chunks that together exceed limit", async () => {
    const maxBytes = 100;
    // Write 50 bytes, then 80 bytes — total 130, should cap at 100
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("A".repeat(50)); process.stdout.write("B".repeat(80));`],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stdout.length).toBe(maxBytes);
    // First 50 chars are 'A', next 50 chars are 'B' (truncated from 80)
    expect(result.stdout.slice(0, 50)).toBe("A".repeat(50));
    expect(result.stdout.slice(50)).toBe("B".repeat(50));
  });

  it("does not truncate stdout when output is under maxOutputBytes", async () => {
    const maxBytes = 100;
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("y".repeat(50))`],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stdout.length).toBe(50);
    expect(result.stdout).toBe("y".repeat(50));
  });

  it("truncates stderr to exactly maxOutputBytes when single chunk exceeds limit", async () => {
    const maxBytes = 100;
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stderr.write("e".repeat(200))`],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stderr.length).toBe(maxBytes);
    expect(result.stderr).toBe("e".repeat(maxBytes));
  });

  it("truncates stderr to exactly maxOutputBytes with two chunks that together exceed limit", async () => {
    const maxBytes = 100;
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stderr.write("C".repeat(50)); process.stderr.write("D".repeat(80));`],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stderr.length).toBe(maxBytes);
    expect(result.stderr.slice(0, 50)).toBe("C".repeat(50));
    expect(result.stderr.slice(50)).toBe("D".repeat(50));
  });

  it("handles stdout and stderr both exceeding maxOutputBytes independently", async () => {
    const maxBytes = 100;
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("O".repeat(200)); process.stderr.write("E".repeat(200));`],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stdout.length).toBe(maxBytes);
    expect(result.stderr.length).toBe(maxBytes);
    expect(result.stdout).toBe("O".repeat(maxBytes));
    expect(result.stderr).toBe("E".repeat(maxBytes));
  });

  it("truncates at exact boundary when chunk lands exactly on maxOutputBytes", async () => {
    const maxBytes = 100;
    // Write exactly 100 bytes, then 50 more — should be exactly 100
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("Z".repeat(100)); process.stdout.write("Q".repeat(50));`],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stdout.length).toBe(maxBytes);
    expect(result.stdout).toBe("Z".repeat(maxBytes));
  });
});

// ---------------------------------------------------------------------------
// Bug 7 extended — truncation edge cases
// ---------------------------------------------------------------------------
describe("spawnWithTimeout adversarial — Bug 7 extended: truncation edge cases", () => {
  it("maxOutputBytes=0 captures nothing", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("hello"); process.stderr.write("world");`],
      { timeoutMs: 5000, maxOutputBytes: 0 },
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("maxOutputBytes=1 captures only the first byte", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("abcdef");`],
      { timeoutMs: 5000, maxOutputBytes: 1 },
    );
    expect(result.stdout).toBe("a");
    expect(result.stdout.length).toBe(1);
  });

  it("very large output (1 MB) with maxOutputBytes=1024 truncates to exactly 1024", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("X".repeat(1024 * 1024));`],
      { timeoutMs: 10000, maxOutputBytes: 1024 },
    );
    expect(result.stdout.length).toBe(1024);
    expect(result.stdout).toBe("X".repeat(1024));
  }, 15000);

  it("truncation in the middle of a multi-byte UTF-8 character does not crash", async () => {
    // Each emoji is 2 JS chars (surrogate pair). Write many of them and truncate mid-sequence.
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("\\u{1F600}".repeat(100));`],
      { timeoutMs: 5000, maxOutputBytes: 5 },
    );
    // Should not throw — length should be at most 5 chars
    expect(result.stdout.length).toBeLessThanOrEqual(5);
  });

  it("empty output yields empty strings regardless of maxOutputBytes", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", ``],
      { timeoutMs: 5000, maxOutputBytes: 9999 },
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.combined).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Timeout behavior
// ---------------------------------------------------------------------------
describe("spawnWithTimeout adversarial — Timeout behavior", () => {
  it("process completes before timeout — timedOut=false with correct exitCode", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.exit(0);`],
      { timeoutMs: 5000 },
    );
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("process exceeds timeout — timedOut=true", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `setTimeout(() => {}, 60000);`],
      { timeoutMs: 200 },
    );
    expect(result.timedOut).toBe(true);
    // SIGKILL yields exit code that is non-zero (typically null → 1 via fallback)
    expect(result.exitCode).not.toBe(0);
  }, 10000);

  it("very short timeout (1 ms) kills the process quickly", async () => {
    const start = Date.now();
    const result = await spawnWithTimeout(
      "node",
      ["-e", `setTimeout(() => {}, 60000);`],
      { timeoutMs: 1 },
    );
    const elapsed = Date.now() - start;
    expect(result.timedOut).toBe(true);
    // Should resolve well within 10 seconds (grace period + overhead)
    expect(elapsed).toBeLessThan(10000);
  }, 15000);

  it("process exits with non-zero code — exitCode matches", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.exit(42);`],
      { timeoutMs: 5000 },
    );
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  it("process exits with code 0 — exitCode=0, timedOut=false", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("done"); process.exit(0);`],
      { timeoutMs: 5000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Combined output
// ---------------------------------------------------------------------------
describe("spawnWithTimeout adversarial — Combined output", () => {
  it("stdout + stderr both populated — combined has both trimmed", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("out\\n"); process.stderr.write("err\\n");`],
      { timeoutMs: 5000 },
    );
    expect(result.stdout).toBe("out\n");
    expect(result.stderr).toBe("err\n");
    // combined is (stdout + stderr).trim()
    expect(result.combined).toBe("out\nerr");
  });

  it("only stdout — combined equals stdout.trim()", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("  hello  ");`],
      { timeoutMs: 5000 },
    );
    expect(result.stderr).toBe("");
    expect(result.combined).toBe("hello");
  });

  it("only stderr — combined equals stderr.trim()", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stderr.write("  oops  ");`],
      { timeoutMs: 5000 },
    );
    expect(result.stdout).toBe("");
    expect(result.combined).toBe("oops");
  });

  it("neither stdout nor stderr — combined is empty string", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", ``],
      { timeoutMs: 5000 },
    );
    expect(result.combined).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
describe("spawnWithTimeout adversarial — Error handling", () => {
  it("invalid command (not found) rejects with error", async () => {
    await expect(
      spawnWithTimeout(
        "this_command_does_not_exist_xyz_abc_123",
        [],
        { timeoutMs: 5000 },
      ),
    ).rejects.toThrow();
  });

  it("invalid cwd (directory does not exist) rejects with error", async () => {
    await expect(
      spawnWithTimeout(
        "node",
        ["-e", `process.exit(0);`],
        { timeoutMs: 5000, cwd: "/tmp/__nonexistent_dir_test_12345__" },
      ),
    ).rejects.toThrow();
  });

  it("process writes to both stdout and stderr simultaneously — both captured", async () => {
    const result = await spawnWithTimeout(
      "node",
      [
        "-e",
        `
        for (let i = 0; i < 20; i++) {
          process.stdout.write("o" + i + " ");
          process.stderr.write("e" + i + " ");
        }
        `,
      ],
      { timeoutMs: 5000 },
    );
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    // Verify some content from each stream
    expect(result.stdout).toContain("o0");
    expect(result.stderr).toContain("e0");
  });
});

// ---------------------------------------------------------------------------
// Kill strategy
// ---------------------------------------------------------------------------
describe("spawnWithTimeout adversarial — Kill strategy", () => {
  it("long-running process killed by timeout — stdout captured up to kill point", async () => {
    // Write chunks repeatedly so data events fire before kill.
    // Use a longer timeout to avoid race between Node startup and kill.
    const result = await spawnWithTimeout(
      "node",
      [
        "-e",
        `
        let i = 0;
        const t = setInterval(() => { process.stdout.write("chunk" + (i++) + "\\n"); }, 10);
        setTimeout(() => { clearInterval(t); process.stdout.write("after_timeout"); }, 60000);
        `,
      ],
      { timeoutMs: 1000 },
    );
    expect(result.timedOut).toBe(true);
    // At least some chunks should have been captured before kill
    expect(result.stdout).toContain("chunk");
    expect(result.stdout).not.toContain("after_timeout");
  }, 15000);

  it("process that forks children (detached with process group kill) — parent killed", async () => {
    // Spawn a child that sleeps, but parent should still be killed by timeout.
    // Write chunks repeatedly to ensure data events fire before kill.
    const result = await spawnWithTimeout(
      "node",
      [
        "-e",
        `
        const { spawn } = require("child_process");
        spawn("node", ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
        let i = 0;
        const t = setInterval(() => { process.stdout.write("alive" + (i++) + "\\n"); }, 10);
        setTimeout(() => { clearInterval(t); }, 60000);
        `,
      ],
      { timeoutMs: 1500 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain("alive");
  }, 15000);
});
