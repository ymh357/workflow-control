import { describe, it, expect } from "vitest";
import { buildStepHints } from "./step-hints.js";

describe("buildStepHints", () => {
  it("marks enabled steps as ENABLED and others as SKIP", () => {
    const result = buildStepHints(
      ["lint", "test"],
      [
        { key: "lint", label: "Run linter" },
        { key: "test", label: "Run tests" },
        { key: "deploy", label: "Deploy to prod" },
      ],
    );
    expect(result).toContain("[ENABLED] Run linter");
    expect(result).toContain("[ENABLED] Run tests");
    expect(result).toContain("[SKIP] Deploy to prod");
  });

  it("starts with the header line", () => {
    const result = buildStepHints([], [{ key: "a", label: "A" }]);
    expect(result).toMatch(/^Steps for this stage/);
  });

  it("marks all steps as SKIP when enabledSteps is empty", () => {
    const result = buildStepHints(
      [],
      [
        { key: "lint", label: "Lint" },
        { key: "test", label: "Test" },
      ],
    );
    expect(result).toContain("[SKIP] Lint");
    expect(result).toContain("[SKIP] Test");
    expect(result).not.toContain("ENABLED");
  });

  it("marks all steps as ENABLED when all are enabled", () => {
    const result = buildStepHints(
      ["a", "b"],
      [
        { key: "a", label: "Alpha" },
        { key: "b", label: "Beta" },
      ],
    );
    expect(result).toContain("[ENABLED] Alpha");
    expect(result).toContain("[ENABLED] Beta");
    expect(result).not.toContain("[SKIP]");
  });

  it("returns only the header when relevantSteps is empty", () => {
    const result = buildStepHints(["lint"], []);
    expect(result).toBe("Steps for this stage (SKIP means do NOT perform this step):\n");
  });

  it("handles enabled steps that are not in relevantSteps (no crash)", () => {
    const result = buildStepHints(
      ["lint", "extra-step"],
      [{ key: "lint", label: "Lint" }],
    );
    expect(result).toContain("[ENABLED] Lint");
  });

  it("handles partial matches correctly", () => {
    const result = buildStepHints(
      ["test"],
      [
        { key: "lint", label: "Lint code" },
        { key: "test", label: "Run tests" },
        { key: "build", label: "Build artifacts" },
      ],
    );
    expect(result).toContain("[SKIP] Lint code");
    expect(result).toContain("[ENABLED] Run tests");
    expect(result).toContain("[SKIP] Build artifacts");
  });

  it("joins lines with newline characters", () => {
    const result = buildStepHints(
      [],
      [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ],
    );
    const lines = result.split("\n");
    expect(lines).toHaveLength(3); // header + 2 steps
    expect(lines[1]).toBe("- [SKIP] A");
    expect(lines[2]).toBe("- [SKIP] B");
  });
});
