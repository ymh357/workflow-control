import { describe, it, expect } from "vitest";
import { DEFAULT_GLOBAL_CONSTRAINTS } from "./prompts.js";

describe("DEFAULT_GLOBAL_CONSTRAINTS", () => {
  it("contains expected constraint keywords", () => {
    expect(DEFAULT_GLOBAL_CONSTRAINTS).toContain("Global Constraints");
    expect(DEFAULT_GLOBAL_CONSTRAINTS).toContain("Dependency Management");
    expect(DEFAULT_GLOBAL_CONSTRAINTS).toContain(".workflow/");
  });
});
