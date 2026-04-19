// Smoke test for the real-SDK diamond harness.
//
// Default-skipped so CI never burns Anthropic API credits. Opt in by
// setting both RUN_REAL_SDK=1 and ANTHROPIC_API_KEY=... in the env.
//
// The assertion is intentionally loose: we only verify that runOnce()
// completes a single run without throwing, and that the resulting
// finalState is one of the two legitimate terminal values. Compliance
// rate measurement is the job of the CLI harness, not this smoke test.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runOnce } from "./diamond-real.js";

const RUN_REAL = process.env.RUN_REAL_SDK === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

function resolveBin(name: string): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const cand = join(dir, "node_modules", ".bin", name);
    if (existsSync(cand)) return cand;
    dir = dirname(dir);
  }
  return undefined;
}

describe("diamond-real smoke (opt-in)", () => {
  it.skipIf(!RUN_REAL)(
    "runs one diamond via the real Claude SDK and terminates in completed or failed",
    { timeout: 180_000 },
    async () => {
      const result = await runOnce({
        runIdx: 0,
        model: "claude-haiku-4-5",
        tscPath: resolveBin("tsc"),
        claudePath: resolveBin("claude"),
        timeoutMs: 120_000,
      });
      expect(["completed", "failed"]).toContain(result.finalState);
      expect(result.stageAttempts.length).toBe(4);
    },
  );
});
