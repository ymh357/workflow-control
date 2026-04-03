import { describe, it, expect } from "vitest";
import { spawnWithTimeout } from "./spawn-utils.js";

// ---------------------------------------------------------------------------
// maxOutputBytes boundary precision
// ---------------------------------------------------------------------------
describe("spawnWithTimeout new-adversarial — maxOutputBytes boundary precision", () => {
  it("output of exactly maxOutputBytes is kept in full (boundary)", async () => {
    const maxBytes = 256;
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("A".repeat(${maxBytes}))`],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stdout.length).toBe(maxBytes);
    expect(result.stdout).toBe("A".repeat(maxBytes));
  });

  it("output of maxOutputBytes + 1 is truncated to exactly maxOutputBytes", async () => {
    const maxBytes = 256;
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("B".repeat(${maxBytes + 1}))`],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stdout.length).toBe(maxBytes);
    expect(result.stdout).toBe("B".repeat(maxBytes));
  });

  it("many small chunks totaling more than maxOutputBytes are capped correctly", async () => {
    const maxBytes = 100;
    // Write 50 chunks of 5 bytes each = 250 bytes total, cap at 100
    const result = await spawnWithTimeout(
      "node",
      [
        "-e",
        `for (let i = 0; i < 50; i++) process.stdout.write("abcde");`,
      ],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stdout.length).toBe(maxBytes);
    // All captured content should be the repeating pattern
    expect(result.stdout).toBe("abcde".repeat(20));
  });

  it("stderr is also truncated to exactly maxOutputBytes (parity with stdout fix)", async () => {
    const maxBytes = 64;
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stderr.write("E".repeat(200))`],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stderr.length).toBe(maxBytes);
    expect(result.stderr).toBe("E".repeat(maxBytes));
  });

  it("stdout AND stderr both independently capped when both exceed limit simultaneously", async () => {
    const maxBytes = 80;
    const result = await spawnWithTimeout(
      "node",
      [
        "-e",
        `
        // Interleave stdout and stderr writes to stress concurrent truncation
        for (let i = 0; i < 30; i++) {
          process.stdout.write("OOOOO");
          process.stderr.write("EEEEE");
        }
        `,
      ],
      { timeoutMs: 5000, maxOutputBytes: maxBytes },
    );
    expect(result.stdout.length).toBe(maxBytes);
    expect(result.stderr.length).toBe(maxBytes);
  });

  it("single 1MB chunk is truncated to maxOutputBytes without crashing", async () => {
    const maxBytes = 512;
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("X".repeat(1024 * 1024))`],
      { timeoutMs: 10000, maxOutputBytes: maxBytes },
    );
    expect(result.stdout.length).toBe(maxBytes);
    expect(result.stdout).toBe("X".repeat(maxBytes));
  }, 15000);
});

// ---------------------------------------------------------------------------
// Extreme timeout values
// ---------------------------------------------------------------------------
describe("spawnWithTimeout new-adversarial — extreme timeout values", () => {
  it("timeoutMs=0 kills the process almost immediately", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `setTimeout(() => {}, 60000);`],
      { timeoutMs: 0 },
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  }, 15000);

  it("timeoutMs=1 kills the process before it can produce output", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", `setTimeout(() => process.stdout.write("late"), 500); setTimeout(() => {}, 60000);`],
      { timeoutMs: 1 },
    );
    expect(result.timedOut).toBe(true);
    // The delayed write should not have happened
    expect(result.stdout).not.toContain("late");
  }, 15000);
});

// ---------------------------------------------------------------------------
// Process exits immediately with no output
// ---------------------------------------------------------------------------
describe("spawnWithTimeout new-adversarial — immediate exit / no output", () => {
  it("process that exits immediately with code 0 and no output", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", ""],
      { timeoutMs: 5000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.combined).toBe("");
  });

  it("process that exits immediately with non-zero code and no output", async () => {
    const result = await spawnWithTimeout(
      "node",
      ["-e", "process.exit(7)"],
      { timeoutMs: 5000 },
    );
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("process killed mid-stream does not cause unhandled errors", async () => {
    // Write continuously in a tight loop; timeout will kill it mid-write
    const result = await spawnWithTimeout(
      "node",
      [
        "-e",
        `
        const buf = "Z".repeat(4096);
        function flood() { process.stdout.write(buf, flood); }
        flood();
        `,
      ],
      { timeoutMs: 50, maxOutputBytes: 1024 },
    );
    expect(result.timedOut).toBe(true);
    // Should have captured some output without crashing
    expect(result.stdout.length).toBeLessThanOrEqual(1024);
  }, 15000);

  it("default maxOutputBytes (5MB) allows moderate output through", async () => {
    // Write 100KB with default maxOutputBytes (should not be truncated)
    const size = 100 * 1024;
    const result = await spawnWithTimeout(
      "node",
      ["-e", `process.stdout.write("D".repeat(${size}))`],
      { timeoutMs: 10000 },
    );
    expect(result.stdout.length).toBe(size);
  }, 15000);
});
