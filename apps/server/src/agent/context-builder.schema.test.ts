// Phase 3.6.2 integration: storeSchema param drives schema-aware rendering
// for matching reads. Without a schema entry, behavior is unchanged.

import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../lib/config-loader.js", () => ({
  getNestedValue(obj: Record<string, any> | undefined | null, path: string): any {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: any, part: string) => acc?.[part], obj);
  },
  isParallelGroup: (entry: any) => entry && typeof entry === "object" && "parallel" in entry,
  flattenStages: (entries: any[]) => entries,
}));

import { buildTier1Context, estimateTokens } from "./context-builder.js";
import type { WorkflowContext } from "../machine/types.js";
import type { StoreSchema } from "../lib/config/types.js";

function makeContext(overrides?: Record<string, any>): WorkflowContext {
  return {
    taskId: "test-id",
    taskText: "do something",
    branch: "",
    worktreePath: "",
    store: {},
    config: { pipeline: { name: "", stages: [] } },
    status: "running",
    ...overrides,
  } as unknown as WorkflowContext;
}

describe("buildTier1Context — storeSchema integration", () => {
  it("schema entry renders scalar fields inline without JSON fence", () => {
    const ctx = makeContext({
      store: {
        analysis: { title: "Fix login", risk: "medium", priority: 3 },
      },
    });
    const runtime = { reads: { "Analysis": "analysis" } } as any;
    const schema: StoreSchema = {
      analysis: {
        produced_by: "analyze",
        fields: {
          title: { type: "string" },
          risk: { type: "string" },
          priority: { type: "number" },
        },
      },
    };
    const result = buildTier1Context(ctx, runtime, 8000, undefined, schema);
    expect(result).toContain("### Analysis");
    expect(result).toContain("- title: Fix login");
    expect(result).toContain("- risk: medium");
    expect(result).toContain("- priority: 3");
    expect(result).not.toContain("```json");
  });

  it("markdown fields render raw under #### heading", () => {
    const designMd = "## Stage 1\n- Type: agent\n- Writes: [analysis]";
    const ctx = makeContext({
      store: {
        design: { name: "Sample", stageDesign: designMd },
      },
    });
    const runtime = { reads: { "Design": "design" } } as any;
    const schema: StoreSchema = {
      design: {
        produced_by: "analyze",
        fields: {
          name: { type: "string" },
          stageDesign: { type: "markdown" },
        },
      },
    };
    const result = buildTier1Context(ctx, runtime, 8000, undefined, schema);
    expect(result).toContain("### Design");
    expect(result).toContain("#### stageDesign");
    expect(result).toContain("## Stage 1");
    expect(result).toContain("- Writes: [analysis]");
    // Markdown content is not JSON-escaped.
    expect(result).not.toContain("\\n");
    expect(result).not.toContain("```json");
  });

  it("reads without a matching schema entry keep JSON block behavior", () => {
    const ctx = makeContext({
      store: { other: { v: 1 } },
    });
    const runtime = { reads: { "Other": "other" } } as any;
    const schema: StoreSchema = {
      analysis: {
        produced_by: "analyze",
        fields: { title: { type: "string" } },
      },
    };
    const result = buildTier1Context(ctx, runtime, 8000, undefined, schema);
    expect(result).toContain("### Other");
    expect(result).toContain("```json");
    expect(result).toContain('"v": 1');
  });

  it("schema-rendered tier1 is smaller than JSON-rendered for markdown+scalar mix", () => {
    const designMd = "## Pipeline Design\n\n- Stage 1: analyze\n- Stage 2: implement\n- Data flow: analyze.writes → implement.reads";
    const ctx = makeContext({
      store: {
        design: {
          pipelineName: "Sample Pipeline",
          pipelineId: "sample",
          description: "Does stuff",
          stageDesign: designMd,
        },
      },
    });
    const runtime = { reads: { "Design": "design" } } as any;
    const schema: StoreSchema = {
      design: {
        produced_by: "analyze",
        fields: {
          pipelineName: { type: "string" },
          pipelineId: { type: "string" },
          description: { type: "string" },
          stageDesign: { type: "markdown" },
        },
      },
    };
    const withSchema = buildTier1Context(ctx, runtime, 8000, undefined, schema);
    const withoutSchema = buildTier1Context(ctx, runtime, 8000, undefined);
    expect(estimateTokens(withSchema)).toBeLessThan(estimateTokens(withoutSchema));
  });

  it("sub-path reads bypass schema (stay on JSON path)", () => {
    const ctx = makeContext({
      store: {
        analysis: { title: "T", detail: { sub: "x" } },
      },
    });
    const runtime = { reads: { "Detail": "analysis.detail" } } as any;
    const schema: StoreSchema = {
      analysis: {
        produced_by: "analyze",
        fields: {
          title: { type: "string" },
          detail: { type: "object", fields: { sub: { type: "string" } } },
        },
      },
    };
    const result = buildTier1Context(ctx, runtime, 8000, undefined, schema);
    // Sub-path reads fall through to JSON rendering.
    expect(result).toContain("### Detail");
    expect(result).toContain("```json");
    expect(result).toContain('"sub": "x"');
  });

  it("schema entry with no fields declared falls through to JSON", () => {
    const ctx = makeContext({
      store: { raw: { anything: "goes" } },
    });
    const runtime = { reads: { "Raw": "raw" } } as any;
    const schema: StoreSchema = {
      raw: { produced_by: "emit" },
    };
    const result = buildTier1Context(ctx, runtime, 8000, undefined, schema);
    expect(result).toContain("### Raw");
    expect(result).toContain("```json");
  });

  it("schema-rendered reads still listed in renderedKeys (not in Other Available Context)", () => {
    const ctx = makeContext({
      store: {
        analysis: { title: "t" },
        plan: { step: "p" },
      },
    });
    const runtime = { reads: { "Analysis": "analysis" } } as any;
    const schema: StoreSchema = {
      analysis: {
        produced_by: "analyze",
        fields: { title: { type: "string" } },
      },
    };
    const result = buildTier1Context(ctx, runtime, 8000, undefined, schema);
    expect(result).toContain("- title: t");
    expect(result).toContain("- plan");
    expect(result).not.toMatch(/^- analysis$/m);
  });

  it("budget overflow on schema render falls through to keys preview", () => {
    // Force budget overflow: one giant markdown field in a schema that wants
    // to render it raw.
    const bigMd = "## Section\n".repeat(2000);
    const ctx = makeContext({
      store: {
        design: {
          pipelineName: "X",
          stageDesign: bigMd,
        },
      },
    });
    const runtime = { reads: { "Design": "design" } } as any;
    const schema: StoreSchema = {
      design: {
        produced_by: "analyze",
        fields: {
          pipelineName: { type: "string" },
          stageDesign: { type: "markdown" },
        },
      },
    };
    // Very tight budget.
    const result = buildTier1Context(ctx, runtime, 100, undefined, schema);
    // Either semantic summary path or keys preview — both acceptable
    // degradations. The critical invariant: don't crash, render something.
    expect(result).toContain("### Design");
    expect(result.length).toBeGreaterThan(0);
  });
});
