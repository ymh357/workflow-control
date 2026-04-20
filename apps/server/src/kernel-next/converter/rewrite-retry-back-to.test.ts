import { describe, it, expect } from "vitest";
import { rewriteRetryBackTo } from "./rewrite-retry-back-to.js";
import type { StageIR } from "../ir/schema.js";

const script = (name: string, backToStage: string): StageIR => ({
  name, type: "script",
  inputs: [], outputs: [{ name: "r", type: "boolean" }],
  config: { moduleId: "m", retry: { maxRetries: 1, backToStage } },
});

const agent = (name: string): StageIR => ({
  name, type: "agent",
  inputs: [], outputs: [{ name: "x", type: "number" }],
  config: { promptRef: "p" },
});

describe("rewriteRetryBackTo", () => {
  it("leaves direct-stage back_to unchanged", () => {
    const stages = [agent("A"), script("P", "A")];
    const r = rewriteRetryBackTo(stages, new Map(), new Set(["A", "P"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.stages[1] as any).config.retry.backToStage).toBe("A");
    expect(r.warnings).toHaveLength(0);
  });

  it("redirects block-name back_to to the block's first inner stage and warns", () => {
    const stages = [agent("A1"), agent("A2"), script("P", "group")];
    const blockMap = new Map([["group", "A1"]]);
    const r = rewriteRetryBackTo(stages, blockMap, new Set(["A1", "A2", "P"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.stages[2] as any).config.retry.backToStage).toBe("A1");
    expect(r.warnings[0]!.code).toBe("RETRY_BACK_TO_REDIRECTED");
    expect(r.warnings[0]!.context).toMatchObject({
      original: "group",
      rewritten: "A1",
    });
  });

  it("fails when back_to references an unknown name", () => {
    const stages = [agent("A"), script("P", "ghost")];
    const r = rewriteRetryBackTo(stages, new Map(), new Set(["A", "P"]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("RETRY_BACK_TO_UNKNOWN");
  });

  it("is a no-op on stages without retry", () => {
    const stages = [agent("A"), agent("B")];
    const r = rewriteRetryBackTo(stages, new Map(), new Set(["A", "B"]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toHaveLength(0);
  });
});
