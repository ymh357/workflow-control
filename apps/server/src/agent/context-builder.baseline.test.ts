// Phase 3.7 baseline: lock current tier1 token + shape output for typical
// scenarios BEFORE the tier1 rewrite (Phase 3.6). Any diff in these numbers
// during 3.6 is a deliberate trade-off that must be justified — not a silent
// regression.
//
// These are NOT unit tests in the behavioral sense. They are byte / token
// budgets. When 3.6 lands, update the snapshots with explicit before/after
// figures in the commit message and in docs/store-schema-design.md §3.6.

import { describe, it, expect } from "vitest";
import type { WorkflowContext } from "../machine/types.js";
import { buildTier1Context, estimateTokens } from "./context-builder.js";

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    taskId: "baseline-task",
    taskText: "do something",
    branch: "",
    worktreePath: "",
    store: {},
    config: { pipeline: { name: "baseline", stages: [] } },
    status: "running",
    ...overrides,
  } as unknown as WorkflowContext;
}

// Typical read scenarios for the baseline. Keep them small, concrete, and
// representative of what pipeline-generator's 5 schema entries actually look
// like in production — we want measurable numbers, not synthetic worst-case.

const SMALL_STORE = {
  analysis: {
    title: "Fix login redirect loop",
    risk: "medium",
    files: ["src/auth/login.ts", "src/auth/session.ts"],
    summary: "Session cookie not cleared on logout, causing redirect loop.",
  },
};

const NESTED_STORE = {
  pipelineDesign: {
    pipelineName: "Sample Pipeline",
    pipelineId: "sample",
    description: "Does stuff",
    engine: "claude",
    stageDesign: "## Stage 1: analyze\n- Type: agent\n- Writes: [analysis]",
    dataFlowSummary: "analyze → [analysis]",
    stageContracts: [
      { name: "analyze", type: "agent", systemPrompt: "analyze", writes: ["analysis"] },
    ],
    summary: "Pipeline summary.",
  },
};

const LARGE_ARRAY_STORE = {
  files: Array.from({ length: 30 }, (_, i) => ({
    path: `src/m${i}.ts`,
    size: 1000 + i,
  })),
};

describe("Phase 3.7 baseline — tier1 token counts", () => {
  it("core identification only (no reads, empty store): ≤ 50 tokens", () => {
    const result = buildTier1Context(makeContext());
    const tokens = estimateTokens(result);
    // Baseline locked 2026-04-19: 8 tokens for the "Task ID + Task Description"
    // preamble. Guard against future bloat — anything above 50 is a regression
    // we should investigate.
    expect(tokens).toBeLessThanOrEqual(50);
  });

  it("small reads scenario (single key, 4 fields): ≤ 150 tokens", () => {
    const ctx = makeContext({ store: SMALL_STORE });
    const runtime = { reads: { Analysis: "analysis" } } as any;
    const result = buildTier1Context(ctx, runtime);
    const tokens = estimateTokens(result);
    // Baseline locked 2026-04-19: ~90 tokens (JSON inline rendering).
    expect(tokens).toBeLessThanOrEqual(150);
  });

  it("nested reads with markdown + object[] field: ≤ 400 tokens", () => {
    const ctx = makeContext({ store: NESTED_STORE });
    const runtime = { reads: { Design: "pipelineDesign" } } as any;
    const result = buildTier1Context(ctx, runtime);
    const tokens = estimateTokens(result);
    // Baseline locked 2026-04-19: ~230 tokens. Large because inline JSON
    // preserves every key — 3.6 is expected to reduce this via schema-typed
    // rendering (string fields one-line, markdown as-is, object[] truncated).
    expect(tokens).toBeLessThanOrEqual(400);
  });

  it("array truncation at 20 items: ≤ 800 tokens even with 30-item input", () => {
    const ctx = makeContext({ store: LARGE_ARRAY_STORE });
    const runtime = { reads: { Files: "files" } } as any;
    const result = buildTier1Context(ctx, runtime);
    const tokens = estimateTokens(result);
    // Context-builder truncates arrays > 20 items, so 30 items → 20 + marker.
    // Baseline locked 2026-04-19: the JSON inline representation fits under
    // 800 tokens despite 20 object entries. Beyond that, the next tier
    // (semantic summary / keys preview) kicks in.
    expect(tokens).toBeLessThanOrEqual(800);
    // And must actually report the truncation — not silently drop items.
    expect(result).toContain("... (30 total items)");
  });

  it("subpath reads (store.analysis.summary) inject only the requested field: ≤ 80 tokens", () => {
    const ctx = makeContext({ store: SMALL_STORE });
    const runtime = { reads: { Summary: "analysis.summary" } } as any;
    const result = buildTier1Context(ctx, runtime);
    const tokens = estimateTokens(result);
    // Subpath reads are the efficient pattern — they should NOT balloon
    // when the parent object is large. Baseline locked 2026-04-19: ~35 tokens.
    expect(tokens).toBeLessThanOrEqual(80);
    // And the summary string must appear, not the other fields.
    expect(result).toContain("Session cookie not cleared");
    expect(result).not.toContain("login redirect loop");
  });

  it("Other Available Context index lists un-read store keys: compact", () => {
    const ctx = makeContext({
      store: {
        analysis: { title: "t" },
        plan: { steps: [] },
        report: { body: "r" },
        __internal: { skip: true },
      },
    });
    const runtime = { reads: { Analysis: "analysis" } } as any;
    const result = buildTier1Context(ctx, runtime);
    // Listed: plan, report (NOT analysis, NOT __internal).
    expect(result).toContain("## Other Available Context");
    expect(result).toContain("- plan");
    expect(result).toContain("- report");
    expect(result).not.toMatch(/^- analysis$/m);
    expect(result).not.toContain("__internal");
  });
});

// Shape snapshots lock the structural contract, independent of exact
// token counts. If 3.6 restructures the output, these are the properties
// that must still hold (or be consciously renamed).
describe("Phase 3.7 baseline — tier1 structural contract", () => {
  it("always starts with Task ID line", () => {
    const result = buildTier1Context(makeContext());
    expect(result.split("\n")[0]).toBe("Task ID: baseline-task");
  });

  it("Task Description section renders with user-provided taskText", () => {
    const result = buildTier1Context(makeContext({ taskText: "hello world" }));
    expect(result).toContain("## Task Description (provided by user)");
    expect(result).toContain("hello world");
  });

  it("reads section uses '## Required Context (Tier 1)' heading", () => {
    const ctx = makeContext({ store: { x: "y" } });
    const runtime = { reads: { X: "x" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("## Required Context (Tier 1)");
  });

  it("each reads entry becomes '### {label}' heading", () => {
    const ctx = makeContext({ store: { a: { v: 1 }, b: { v: 2 } } });
    const runtime = { reads: { First: "a", Second: "b" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("### First");
    expect(result).toContain("### Second");
  });

  it("object reads are rendered as fenced ```json blocks", () => {
    const ctx = makeContext({ store: { a: { v: 1 } } });
    const runtime = { reads: { A: "a" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("```json");
    expect(result).toContain('"v": 1');
  });

  it("scalar reads are rendered inline without fences", () => {
    const ctx = makeContext({ store: { msg: "hello" } });
    const runtime = { reads: { Msg: "msg" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("### Msg");
    expect(result).toContain("hello");
    // Scalars do not get a json fence.
    const msgIdx = result.indexOf("### Msg");
    const afterMsg = result.slice(msgIdx);
    expect(afterMsg).not.toContain("```json");
  });

  it("store keys starting with __ are excluded from Other Available Context", () => {
    const ctx = makeContext({
      store: { public: "x", __private: "y" },
    });
    const runtime = { reads: {} } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("- public");
    expect(result).not.toContain("__private");
  });
});
