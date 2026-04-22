import { describe, it, expect } from "vitest";
import type { AgentStage } from "../ir/schema.js";
import { buildSystemPromptAppend } from "./real-executor.js";
import type { MigrationHint } from "../hot-update/migration-hints.js";

function mkStage(): AgentStage {
  return {
    name: "s1",
    type: "agent",
    inputs: [{ name: "p", type: "string" }],
    outputs: [{ name: "out", type: "string" }],
    config: { promptRef: "p" },
  };
}

const baseCtx = { taskId: "t-A", attemptId: "a-A" };

function mkHint(overrides: Partial<MigrationHint> = {}): MigrationHint {
  return {
    hintId: "h1",
    taskId: "t-A",
    stageName: "s1",
    fromVersion: "v1",
    toVersion: "v2",
    previousAttemptId: "a-old",
    previousDiffText: "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n",
    previousDiffBytes: 48,
    note: "diff from superseded attempt a-old",
    createdAt: 1000,
    consumedAt: 2000,
    ...overrides,
  };
}

describe("buildSystemPromptAppend — migration hint integration", () => {
  it("no hint → no Migration note section", () => {
    const result = buildSystemPromptAppend(
      mkStage(), "task", { p: "v" }, baseCtx, null,
    );
    expect(result).not.toContain("Migration note");
  });

  it("hint with diff_text → inlines diff + migration heading", () => {
    const hint = mkHint();
    const result = buildSystemPromptAppend(
      mkStage(), "task", { p: "v" }, baseCtx, hint,
    );
    expect(result).toContain("### Migration note (B9)");
    expect(result).toContain("hot-update migration from pipeline");
    expect(result).toContain("version v1 → v2");
    expect(result).toContain("Context: diff from superseded attempt a-old");
    expect(result).toContain("```diff");
    expect(result).toContain("--- a/file");
    expect(result).toContain("+new");
  });

  it("hint without diff_text → includes note but states diff is unavailable", () => {
    const hint = mkHint({ previousDiffText: null, note: "checkpoint capture disabled" });
    const result = buildSystemPromptAppend(
      mkStage(), "task", { p: "v" }, baseCtx, hint,
    );
    expect(result).toContain("### Migration note (B9)");
    expect(result).toContain("Context: checkpoint capture disabled");
    expect(result).toContain("No diff available");
    expect(result).not.toContain("```diff");
  });

  it("hint with empty diff_text treated as unavailable", () => {
    const hint = mkHint({ previousDiffText: "", note: null });
    const result = buildSystemPromptAppend(
      mkStage(), "task", { p: "v" }, baseCtx, hint,
    );
    expect(result).toContain("No diff available");
    expect(result).not.toContain("```diff");
  });

  it("large diff is truncated in-prompt with pointer to full record", () => {
    const diff = "+".repeat(20_000);
    const hint = mkHint({ previousDiffText: diff });
    const result = buildSystemPromptAppend(
      mkStage(), "task", { p: "v" }, baseCtx, hint,
    );
    expect(result).toContain("diff truncated in prompt");
    // Inlined content cap applied.
    // Full 20_000 of '+' should NOT all appear.
    expect(result).not.toContain("+".repeat(20_000));
  });

  it("no hint passed → result identical to legacy call signature", () => {
    // Legacy call (no migrationHint arg) must still compile and not
    // include a migration block.
    const result = buildSystemPromptAppend(
      mkStage(), "task", { p: "v" }, baseCtx,
    );
    expect(result).not.toContain("Migration note");
  });

  it("migration block comes AFTER the Task/prompt section", () => {
    const hint = mkHint();
    const result = buildSystemPromptAppend(
      mkStage(), "task body goes here", { p: "v" }, baseCtx, hint,
    );
    const taskIdx = result.indexOf("task body goes here");
    const migIdx = result.indexOf("### Migration note");
    const outputIdx = result.indexOf("### Output protocol");
    expect(taskIdx).toBeGreaterThan(-1);
    expect(migIdx).toBeGreaterThan(taskIdx);
    expect(migIdx).toBeLessThan(outputIdx);
  });
});
