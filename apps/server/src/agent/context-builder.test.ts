import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock getNestedValue to use real implementation inline
vi.mock("../lib/config-loader.js", () => ({
  getNestedValue(obj: Record<string, any> | undefined | null, path: string): any {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: any, part: string) => acc && acc[part], obj);
  },
  isParallelGroup: (entry: any) => entry && typeof entry === "object" && "parallel" in entry,
  flattenStages: (entries: any[]) => {
    const result: any[] = [];
    for (const e of entries) {
      if (e && typeof e === "object" && "parallel" in e) {
        result.push(...e.parallel.stages);
      } else {
        result.push(e);
      }
    }
    return result;
  },
}));

import { buildTier1Context } from "./context-builder.js";
import type { WorkflowContext } from "../machine/types.js";

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

describe("buildTier1Context - core identification", () => {
  it("includes task ID and taskText", () => {
    const result = buildTier1Context(makeContext());
    expect(result).toContain("Task ID: test-id");
    expect(result).toContain("## Task Description (provided by user)");
    expect(result).toContain("do something");
  });

  it("includes branch and worktreePath when present", () => {
    const result = buildTier1Context(
      makeContext({ branch: "feature/test", worktreePath: "/tmp/wt" }),
    );
    expect(result).toContain("Branch: feature/test");
    expect(result).toContain("Worktree: /tmp/wt");
  });

  it("omits branch and worktreePath when empty", () => {
    const result = buildTier1Context(makeContext());
    expect(result).not.toContain("Branch:");
    expect(result).not.toContain("Worktree:");
  });
});

describe("buildTier1Context - selective reads (runtime.reads)", () => {
  it("injects selected store values by label", () => {
    const ctx = makeContext({
      store: {
        analysis: { summary: "looks good", score: 95 },
      },
    });
    const runtime = { reads: { "Analysis Result": "analysis" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("### Analysis Result");
    expect(result).toContain("summary: looks good");
    expect(result).toContain("score: 95");
  });

  it("strips store. prefix from reads paths", () => {
    const ctx = makeContext({
      store: {
        analysis: { summary: "looks good", score: 95 },
      },
    });
    const runtime = { reads: { "Analysis Result": "store.analysis" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("### Analysis Result");
    expect(result).toContain("summary: looks good");
    expect(result).toContain("score: 95");
  });

  it("strips store. prefix for nested paths", () => {
    const ctx = makeContext({
      store: {
        analysis: { detail: { summary: "nested value" } },
      },
    });
    const runtime = { reads: { "Detail": "store.analysis.detail" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("### Detail");
    expect(result).toContain("summary: nested value");
  });

  it("skips undefined store paths", () => {
    const ctx = makeContext({ store: {} });
    const runtime = { reads: { "Missing": "nonexistent.path" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).not.toContain("### Missing");
  });

  it("does not truncate strings within token budget", () => {
    const longStr = "x".repeat(500);
    const ctx = makeContext({
      store: { data: { content: longStr } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("x".repeat(500));
  });

  it("shows arrays up to 20 elements", () => {
    const ctx = makeContext({
      store: { data: { items: ["a", "b", "c", "d", "e", "f", "g"] } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("a; b; c; d; e; f; g");
  });

  it("renders arrays with 5 or fewer elements without ellipsis", () => {
    const ctx = makeContext({
      store: { data: { items: ["a", "b"] } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("items: a; b");
    expect(result).not.toContain("...");
  });

  it("JSON.stringifies nested objects", () => {
    const ctx = makeContext({
      store: { data: { nested: { foo: "bar" } } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain('nested: {"foo":"bar"}');
  });

  it("renders non-object values as strings", () => {
    const ctx = makeContext({
      store: { data: "plain string value" },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("plain string value");
  });

  it("truncates large reads values into per-field summaries when token budget is exceeded", () => {
    const hugeObj: Record<string, string> = {};
    for (let i = 0; i < 100; i++) hugeObj[`field_${i}`] = "x".repeat(200);
    const ctx = makeContext({
      store: { huge: hugeObj, small: { ok: "yes" } },
    });
    const runtime = { reads: { "Huge": "huge", "Small": "small" } } as any;
    const result = buildTier1Context(ctx, runtime, 500);
    // Huge should be summarized — each field truncated to 80 chars
    expect(result).toContain("(summarized)");
    expect(result).toContain("field_0: " + "x".repeat(80) + "...");
    // Small should still be rendered fully
    expect(result).toContain("### Small");
    expect(result).toContain("ok: yes");
  });

  it("lists un-injected store keys as Tier 2 references", () => {
    const ctx = makeContext({
      store: {
        analysis: { summary: "ok" },
        plan: { steps: [] },
        extra: "data",
      },
    });
    const runtime = { reads: { "Analysis": "analysis" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("## Other Available Context");
    expect(result).toContain("- plan");
    expect(result).toContain("- extra");
    expect(result).not.toContain("- analysis");
  });
});

describe("buildTier1Context - legacy fallback (no runtime.reads)", () => {
  it("renders store data using stage output schemas", () => {
    const ctx = makeContext({
      store: {
        analysis: { summary: "great", items: ["a", "b", "c", "d", "e", "f"] },
      },
      config: {
        pipeline: {
          stages: [
            {
              outputs: {
                analysis: {
                  label: "Analysis Output",
                  fields: [
                    { key: "summary", type: "string", description: "" },
                    { key: "items", type: "string[]", description: "" },
                  ],
                },
              },
            },
          ],
        },
      },
    });
    const result = buildTier1Context(ctx);
    expect(result).toContain("## Analysis Output");
    expect(result).toContain("summary: great");
    // Legacy also slices arrays to 5
    expect(result).toContain("items: a; b; c; d; e");
  });

  it("falls back to store key as header when no label", () => {
    const ctx = makeContext({
      store: { analysis: { summary: "ok" } },
      config: {
        pipeline: {
          stages: [
            {
              outputs: {
                analysis: {
                  fields: [{ key: "summary", type: "string", description: "" }],
                },
              },
            },
          ],
        },
      },
    });
    const result = buildTier1Context(ctx);
    expect(result).toContain("## analysis");
  });

  it("renders un-schematized store keys at the end", () => {
    const ctx = makeContext({
      store: {
        extra: "some extra data",
        nested: { a: 1 },
      },
      config: { pipeline: { name: "", stages: [] } },
    });
    const result = buildTier1Context(ctx);
    expect(result).toContain("## extra");
    expect(result).toContain("some extra data");
    expect(result).toContain("## nested");
    expect(result).toContain(JSON.stringify({ a: 1 }));
  });

  it("handles non-object store values in legacy mode", () => {
    const ctx = makeContext({
      store: { analysis: "plain text" },
      config: {
        pipeline: {
          stages: [
            {
              outputs: {
                analysis: {
                  label: "Analysis",
                  fields: [{ key: "summary", type: "string", description: "" }],
                },
              },
            },
          ],
        },
      },
    });
    const result = buildTier1Context(ctx);
    expect(result).toContain("## Analysis");
    expect(result).toContain("plain text");
  });

  it("skips null/undefined field values", () => {
    const ctx = makeContext({
      store: { analysis: { summary: null, detail: undefined, name: "test" } },
      config: {
        pipeline: {
          stages: [
            {
              outputs: {
                analysis: {
                  fields: [{ key: "summary", type: "string", description: "" }, { key: "detail", type: "string", description: "" }, { key: "name", type: "string", description: "" }],
                },
              },
            },
          ],
        },
      },
    });
    const result = buildTier1Context(ctx);
    expect(result).toContain("name: test");
    expect(result).not.toMatch(/summary:/);
    expect(result).not.toMatch(/detail:/);
  });
});

describe("buildTier1Context - parallel group stages", () => {
  it("renders store data from parallel group child stage outputs", () => {
    const ctx = makeContext({
      store: {
        designReview: { feedback: "needs contrast fix", severity: "medium" },
        codeReview: { issues: ["lint error", "missing type"], passed: false },
      },
      config: {
        pipeline: {
          stages: [
            {
              parallel: {
                stages: [
                  {
                    name: "design-review",
                    outputs: {
                      designReview: {
                        label: "Design Review",
                        fields: [{ key: "feedback", type: "string", description: "" }, { key: "severity", type: "string", description: "" }],
                      },
                    },
                  },
                  {
                    name: "code-review",
                    outputs: {
                      codeReview: {
                        label: "Code Review",
                        fields: [{ key: "issues", type: "string[]", description: "" }, { key: "passed", type: "boolean", description: "" }],
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    });
    const result = buildTier1Context(ctx);
    expect(result).toContain("## Design Review");
    expect(result).toContain("feedback: needs contrast fix");
    expect(result).toContain("severity: medium");
    expect(result).toContain("## Code Review");
    expect(result).toContain("issues: lint error; missing type");
    expect(result).toContain("passed: false");
  });
});
