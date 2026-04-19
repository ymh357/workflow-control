// M5 acceptance tests — runs the demo script end-to-end against real tsc
// and asserts all 8 steps (§8.2 #1–#7 + diff_runs bonus) pass.
//
// This is the spike's official "pass/fail" gate: if this test passes,
// docs/kernel-next-design.md §8.2 is satisfied and M6 post-spike review
// can begin.

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runDemo } from "./diamond.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveTscPath(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const cand = join(dir, "node_modules", ".bin", "tsc");
    if (existsSync(cand)) return cand;
    dir = dirname(dir);
  }
  throw new Error("tsc not found");
}
const TSC_PATH = resolveTscPath();

describe("M5 acceptance: diamond demo", () => {
  beforeAll(() => {
    expect(existsSync(TSC_PATH)).toBe(true);
  });

  it("runs full demo end-to-end with tsc, all 8 steps pass", { timeout: 30_000 }, async () => {
    const result = await runDemo({ tscPath: TSC_PATH });

    // Per-step assertions so failures point at the specific §8.2 criterion.
    const by = new Map(result.steps.map((s) => [s.step, s]));
    expect(by.get("1. submit_pipeline")?.ok,                       "§8.2#1 Pipeline submitted").toBe(true);
    expect(by.get("2. tsc codegen")?.ok,                           "§8.2#2 tsc codegen").toBe(true);
    expect(by.get("3. run diamond")?.ok,                           "§8.2#3 diamond execution order").toBe(true);
    expect(by.get("4. query_lineage")?.ok,                         "§8.2#4 lineage discoverable").toBe(true);
    expect(by.get("5. propose_pipeline_change (valid)")?.ok,       "§8.2#5 AI propose accepted + pending").toBe(true);
    expect(by.get("6. propose_pipeline_change (reject)")?.ok,      "§8.2#6 tsc reject precise diagnostic").toBe(true);
    expect(by.get("7. retry / multi-attempt")?.ok,                 "§8.2#7 attempt_idx increments").toBe(true);
    expect(by.get("8. diff_runs (bonus)")?.ok,                     "diff_runs bonus").toBe(true);

    expect(result.ok, "every step passed").toBe(true);
  });

  it("demo without tsc (skipTypeCheck) still passes the non-tsc steps", async () => {
    // Running the demo without tsc means step 6 (reject test) can't validate
    // the tsc path. The demo's step-6 handler notes "SKIPPED tsc path" and
    // reports ok=false in that mode. We only check non-tsc steps here.
    const result = await runDemo({ skipTypeCheck: true });
    const by = new Map(result.steps.map((s) => [s.step, s]));
    expect(by.get("1. submit_pipeline")?.ok).toBe(true);
    expect(by.get("3. run diamond")?.ok).toBe(true);
    expect(by.get("4. query_lineage")?.ok).toBe(true);
    expect(by.get("5. propose_pipeline_change (valid)")?.ok).toBe(true);
    expect(by.get("7. retry / multi-attempt")?.ok).toBe(true);
    // Step 6 ok=false is expected under skipTypeCheck.
    expect(by.get("6. propose_pipeline_change (reject)")?.ok).toBe(false);
  });
});
