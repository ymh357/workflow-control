// B3.F17 (2026-04-30 review) regression: pg.ts pipeline-generator IR
// cache must invalidate when pipeline.ir.json or any prompts file
// changes on disk. Pre-fix the cache was a one-shot module-level load
// that never refreshed; post-fix it re-stats the directory tree and
// reloads when any file's mtime advances past the cached value.
//
// Test strategy: invoke the (test-only) loader twice with a forced
// mtime bump in between, count reload events.

import { describe, it, expect } from "vitest";
import { existsSync, statSync, utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  __getPipelineGeneratorReloadCountForTests__,
  __triggerPipelineGeneratorLoadForTests__,
} from "./pg.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PIPELINE_GENERATOR_IR_JSON = join(
  __dirname, "..", "..", "..", "builtin-pipelines", "pipeline-generator", "pipeline.ir.json",
);

describe("pg.ts pipeline-generator IR cache invalidation (B3.F17)", () => {
  it("first load populates cache; second load with no change is cached", () => {
    if (!existsSync(PIPELINE_GENERATOR_IR_JSON)) return; // env-dependent
    __triggerPipelineGeneratorLoadForTests__();
    const c1 = __getPipelineGeneratorReloadCountForTests__();
    __triggerPipelineGeneratorLoadForTests__();
    const c2 = __getPipelineGeneratorReloadCountForTests__();
    expect(c2).toBe(c1); // no reload — disk unchanged
  });

  it("touching pipeline.ir.json forces a cache reload on next access", () => {
    if (!existsSync(PIPELINE_GENERATOR_IR_JSON)) return;
    __triggerPipelineGeneratorLoadForTests__();
    const before = __getPipelineGeneratorReloadCountForTests__();

    const originalMtime = statSync(PIPELINE_GENERATOR_IR_JSON).mtimeMs;
    // Advance well past any other prompt file's mtime — the cache
    // tracks the directory tree's max, so the touched file must
    // exceed every other entry to trigger a reload.
    const advanced = new Date(Date.now() + 24 * 60 * 60 * 1000);
    utimesSync(PIPELINE_GENERATOR_IR_JSON, advanced, advanced);
    try {
      __triggerPipelineGeneratorLoadForTests__();
      const after = __getPipelineGeneratorReloadCountForTests__();
      expect(after).toBe(before + 1); // reload observed
    } finally {
      utimesSync(
        PIPELINE_GENERATOR_IR_JSON,
        new Date(originalMtime),
        new Date(originalMtime),
      );
    }
  });
});
