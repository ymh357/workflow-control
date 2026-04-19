// Phase 3.6 token measurement: side-by-side comparison of tier1 output size
// with and without storeSchema on identical scenarios. This replaces the
// aspirational "≤X tokens" budgets with measured with/without ratios, so we
// can call out exactly where the rewrite wins and where it doesn't move the
// needle.
//
// If any ratio regresses in the future, this test fails — the numbers are
// locked in commit message and in docs/product-roadmap.md Phase 3.6 section.

import { describe, it, expect } from "vitest";
import type { WorkflowContext } from "../machine/types.js";
import type { StoreSchema } from "../lib/config/types.js";
import { buildTier1Context, estimateTokens } from "./context-builder.js";

function makeContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return {
    taskId: "measure-task",
    taskText: "do something",
    branch: "",
    worktreePath: "",
    store: {},
    config: { pipeline: { name: "measure", stages: [] } },
    status: "running",
    ...overrides,
  } as unknown as WorkflowContext;
}

interface Measurement {
  name: string;
  without: number;
  with: number;
  deltaPct: number;
}

const measurements: Measurement[] = [];

function measure(
  name: string,
  ctx: WorkflowContext,
  runtime: any,
  schema: StoreSchema,
): Measurement {
  const without = estimateTokens(buildTier1Context(ctx, runtime));
  const withSchema = estimateTokens(buildTier1Context(ctx, runtime, 8000, undefined, schema));
  const deltaPct = without === 0 ? 0 : Math.round(((without - withSchema) / without) * 100);
  const m: Measurement = { name, without, with: withSchema, deltaPct };
  measurements.push(m);
  return m;
}

describe("Phase 3.6 — measured token reduction with storeSchema", () => {
  it("small scalar entry: schema renders without JSON fence", () => {
    const ctx = makeContext({
      store: {
        analysis: {
          title: "Fix login redirect loop",
          risk: "medium",
          summary: "Session cookie not cleared on logout.",
        },
      },
    });
    const runtime = { reads: { Analysis: "analysis" } } as any;
    const schema: StoreSchema = {
      analysis: {
        produced_by: "analyze",
        fields: {
          title: { type: "string" },
          risk: { type: "string" },
          summary: { type: "string" },
        },
      },
    };
    const m = measure("small scalar entry", ctx, runtime, schema);
    // Schema render should be smaller (no JSON fence overhead).
    expect(m.with).toBeLessThan(m.without);
    expect(m.deltaPct).toBeGreaterThanOrEqual(10);
  });

  it("markdown-heavy entry: biggest win (no JSON escape)", () => {
    const stageDesign = [
      "## Stage 1: analyze",
      "- Type: agent",
      "- Writes: [analysis]",
      "- Reads: {}",
      "",
      "## Stage 2: implement",
      "- Type: agent",
      "- Writes: [result]",
      "- Reads: { analysis: analysis }",
    ].join("\n");

    const ctx = makeContext({
      store: {
        pipelineDesign: {
          pipelineName: "Sample Pipeline",
          pipelineId: "sample",
          description: "Does stuff",
          engine: "claude",
          stageDesign,
          dataFlowSummary: "analyze → [analysis] → implement",
          summary: "Pipeline summary.",
        },
      },
    });
    const runtime = { reads: { Design: "pipelineDesign" } } as any;
    const schema: StoreSchema = {
      pipelineDesign: {
        produced_by: "analyze",
        fields: {
          pipelineName: { type: "string" },
          pipelineId: { type: "string" },
          description: { type: "string" },
          engine: { type: "string" },
          stageDesign: { type: "markdown" },
          dataFlowSummary: { type: "markdown" },
          summary: { type: "markdown" },
        },
      },
    };
    const m = measure("markdown-heavy entry", ctx, runtime, schema);
    // Measured: -10% (modest; JSON escape overhead scales with content size,
    // so longer markdown content shows larger relative wins). Lock the
    // floor at -5% so any future regression flips this test.
    expect(m.with).toBeLessThan(m.without);
    expect(m.deltaPct).toBeGreaterThanOrEqual(5);
  });

  it("object[] entry: truncated list rendering", () => {
    const stageContracts = Array.from({ length: 8 }, (_, i) => ({
      name: `stage-${i}`,
      type: "agent",
      systemPrompt: `prompt-${i}`,
      writes: [`key${i}`],
    }));
    const ctx = makeContext({
      store: {
        pipelineDesign: {
          pipelineName: "Sample",
          stageContracts,
        },
      },
    });
    const runtime = { reads: { Design: "pipelineDesign" } } as any;
    const schema: StoreSchema = {
      pipelineDesign: {
        produced_by: "analyze",
        fields: {
          pipelineName: { type: "string" },
          stageContracts: {
            type: "object[]",
            fields: {
              name: { type: "string" },
              type: { type: "string" },
              systemPrompt: { type: "string" },
              writes: { type: "string[]" },
            },
          },
        },
      },
    };
    const m = measure("object[] entry", ctx, runtime, schema);
    expect(m.with).toBeLessThan(m.without);
  });

  it("string[] entry: compact comma-joined line", () => {
    const ctx = makeContext({
      store: {
        analysis: {
          title: "x",
          files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
        },
      },
    });
    const runtime = { reads: { Analysis: "analysis" } } as any;
    const schema: StoreSchema = {
      analysis: {
        produced_by: "analyze",
        fields: {
          title: { type: "string" },
          files: { type: "string[]" },
        },
      },
    };
    const m = measure("string[] entry", ctx, runtime, schema);
    expect(m.with).toBeLessThan(m.without);
  });

  it("subpath read is unchanged (schema bypassed)", () => {
    const ctx = makeContext({
      store: {
        analysis: { title: "t", summary: "x".repeat(40) },
      },
    });
    const runtime = { reads: { Summary: "analysis.summary" } } as any;
    const schema: StoreSchema = {
      analysis: {
        produced_by: "analyze",
        fields: { title: { type: "string" }, summary: { type: "string" } },
      },
    };
    const m = measure("subpath read", ctx, runtime, schema);
    // Sub-path reads intentionally bypass schema — the two numbers should
    // be identical (same JSON rendering path).
    expect(m.with).toBe(m.without);
  });

  it("prints the measurement table (runs last)", () => {
    // Surface numbers in the test log so they can be copied into the roadmap.
    const lines = [
      "",
      "Phase 3.6 tier1 token measurements (with vs without storeSchema):",
      "| scenario | without | with | delta |",
      "|---|---:|---:|---:|",
      ...measurements.map(
        (m) => `| ${m.name} | ${m.without} | ${m.with} | ${m.deltaPct >= 0 ? "-" : "+"}${Math.abs(m.deltaPct)}% |`,
      ),
      "",
    ];
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));
    expect(measurements.length).toBeGreaterThanOrEqual(5);
  });
});
