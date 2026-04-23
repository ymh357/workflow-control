// Tests for the resolveMonorepoTscPath singleton.
//
// The real on-disk tsc binary MUST exist for these to be meaningful; the
// same assumption is made by validator/types.test.ts and all passing
// suites in this repo. If it doesn't, these tests fail fast with a
// clear message rather than silently returning undefined.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolveMonorepoTscPath, __resetMonorepoTscPathCacheForTests } from "./monorepo-tsc-path.js";

describe("resolveMonorepoTscPath", () => {
  it("returns a real, existing tsc binary path", () => {
    __resetMonorepoTscPathCacheForTests();
    const p = resolveMonorepoTscPath();
    expect(p).toBeDefined();
    expect(existsSync(p!)).toBe(true);
    expect(p!.endsWith("/node_modules/.bin/tsc")).toBe(true);
  });

  it("caches the resolved path (singleton)", () => {
    __resetMonorepoTscPathCacheForTests();
    const a = resolveMonorepoTscPath();
    const b = resolveMonorepoTscPath();
    expect(a).toBe(b);
  });
});
