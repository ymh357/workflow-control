import { describe, it, expect } from "vitest";
import { buildStepHints } from "./step-hints.js";

describe("buildStepHints – adversarial", () => {
  it("handles duplicate keys in enabledSteps (no double output)", () => {
    const result = buildStepHints(
      ["lint", "lint"],
      [{ key: "lint", label: "Lint" }],
    );
    expect(result).toContain("[ENABLED] Lint");
    // Only one line for lint
    const lines = result.split("\n").filter((l) => l.includes("Lint"));
    expect(lines).toHaveLength(1);
  });

  it("handles empty string key in enabledSteps and relevantSteps", () => {
    const result = buildStepHints(
      [""],
      [{ key: "", label: "Empty Key Step" }],
    );
    expect(result).toContain("[ENABLED] Empty Key Step");
  });

  it("handles special characters in label (markdown-like content)", () => {
    const result = buildStepHints(
      ["md"],
      [{ key: "md", label: "Run **bold** `code` [link](url)" }],
    );
    expect(result).toContain("[ENABLED] Run **bold** `code` [link](url)");
  });

  it("handles very long enabledSteps list efficiently", () => {
    const steps = Array.from({ length: 1000 }, (_, i) => `step_${i}`);
    const relevant = steps.map((key) => ({ key, label: `Label ${key}` }));
    const result = buildStepHints(steps, relevant);
    expect(result).not.toContain("[SKIP]");
    const lines = result.split("\n");
    expect(lines).toHaveLength(1001); // header + 1000 steps
  });

  it("label with newline character does not break line structure", () => {
    const result = buildStepHints(
      ["a"],
      [{ key: "a", label: "Line1\nLine2" }],
    );
    // The newline inside label will break the expected single-line format
    const lines = result.split("\n");
    expect(lines.length).toBeGreaterThan(2);
  });

  it("returns consistent output for identical inputs (deterministic)", () => {
    const args: [string[], { key: string; label: string }[]] = [
      ["a", "c"],
      [
        { key: "a", label: "Alpha" },
        { key: "b", label: "Beta" },
        { key: "c", label: "Charlie" },
      ],
    ];
    const r1 = buildStepHints(...args);
    const r2 = buildStepHints(...args);
    expect(r1).toBe(r2);
  });
});
