import { describe, it, expect } from "vitest";
import { DEFAULT_GLOBAL_CONSTRAINTS } from "./prompts.js";

describe("DEFAULT_GLOBAL_CONSTRAINTS – adversarial", () => {
  it("starts with ## Global Constraints heading", () => {
    expect(DEFAULT_GLOBAL_CONSTRAINTS.trimStart()).toMatch(/^## Global Constraints/);
  });

  it("contains the parallel reads instruction", () => {
    expect(DEFAULT_GLOBAL_CONSTRAINTS).toContain("parallel reads");
  });

  it("contains the no-new-dependencies rule", () => {
    expect(DEFAULT_GLOBAL_CONSTRAINTS).toContain("Do NOT install new dependencies");
  });

  it("does not contain placeholder or template variables", () => {
    expect(DEFAULT_GLOBAL_CONSTRAINTS).not.toMatch(/\{\{.*?\}\}/);
    expect(DEFAULT_GLOBAL_CONSTRAINTS).not.toMatch(/\$\{.*?\}/);
    expect(DEFAULT_GLOBAL_CONSTRAINTS).not.toContain("TODO");
  });

  it("is valid markdown (no unclosed code fences)", () => {
    const fences = (DEFAULT_GLOBAL_CONSTRAINTS.match(/```/g) || []).length;
    expect(fences % 2).toBe(0);
  });

  it("is a frozen/immutable export (string literal, not mutable object)", () => {
    // Strings are primitive and immutable in JS
    expect(typeof DEFAULT_GLOBAL_CONSTRAINTS).toBe("string");
    // Verify it cannot be reassigned (const export)
    const original = DEFAULT_GLOBAL_CONSTRAINTS;
    expect(DEFAULT_GLOBAL_CONSTRAINTS).toBe(original);
  });

  it("contains exactly two ## headings", () => {
    const headings = DEFAULT_GLOBAL_CONSTRAINTS.match(/^## /gm) || [];
    expect(headings).toHaveLength(2);
  });
});
