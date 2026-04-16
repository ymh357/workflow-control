import { describe, it, expect, vi } from "vitest";
import { stableHash } from "../lib/stable-hash.js";

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

import { buildTier1Context, estimateTokens } from "./context-builder.js";
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
    expect(result).toContain("```json");
    expect(result).toContain('"summary": "looks good"');
    expect(result).toContain('"score": 95');
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
    expect(result).toContain('"summary": "looks good"');
    expect(result).toContain('"score": 95');
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
    expect(result).toContain('"summary": "nested value"');
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

  it("renders arrays within JSON objects", () => {
    const ctx = makeContext({
      store: { data: { items: ["a", "b", "c", "d", "e", "f", "g"] } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("```json");
    expect(result).toContain('"a"');
    expect(result).toContain('"g"');
  });

  it("renders small arrays within JSON objects", () => {
    const ctx = makeContext({
      store: { data: { items: ["a", "b"] } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain('"a"');
    expect(result).toContain('"b"');
  });

  it("preserves nested object structure in JSON", () => {
    const ctx = makeContext({
      store: { data: { nested: { foo: "bar" } } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("```json");
    expect(result).toContain('"foo": "bar"');
  });

  it("renders non-object values as strings", () => {
    const ctx = makeContext({
      store: { data: "plain string value" },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("plain string value");
  });

  it("summarizes large reads values when token budget exceeded", () => {
    const hugeObj: Record<string, string> = {};
    for (let i = 0; i < 100; i++) hugeObj[`field_${i}`] = "x".repeat(200);
    const ctx = makeContext({
      store: { huge: hugeObj, small: { ok: "yes" } },
    });
    const runtime = { reads: { "Huge": "huge", "Small": "small" } } as any;
    const result = buildTier1Context(ctx, runtime, 500);
    expect(result).toContain("summarized");
    expect(result).toContain('get_store_value("huge")');
    expect(result).toContain("### Small");
    expect(result).toContain('"ok": "yes"');
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

describe("estimateTokens (CJK-aware)", () => {
  it("estimates Latin text at ~4 chars per token", () => {
    expect(estimateTokens("hello")).toBe(2);
  });

  it("estimates CJK text at ~2 chars per token", () => {
    expect(estimateTokens("你好世界")).toBe(2);
  });

  it("handles mixed CJK and Latin text", () => {
    expect(estimateTokens("hello你好")).toBe(3);
  });
});

describe("buildTier1Context - large value preview", () => {
  it("shows summary with MCP reference for very large store values", () => {
    const hugeObj: Record<string, string> = {};
    for (let i = 0; i < 200; i++) hugeObj[`field_${i}`] = "x".repeat(100);
    const ctx = makeContext({ store: { huge: hugeObj } });
    const runtime = { reads: { "Huge Data": "huge" } } as any;
    const result = buildTier1Context(ctx, runtime, 500);
    expect(result).toContain("summarized");
    expect(result).toContain('get_store_value("huge")');
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
    expect(result).toContain("needs contrast fix");
    expect(result).toContain("medium");
    expect(result).toContain("## Code Review");
    expect(result).toContain("lint error");
    expect(result).toContain("false");
  });
});

describe("buildTier1Context - compact summary preference", () => {
  it("uses compact summary for large store values when __summary exists", () => {
    const ctx = makeContext({
      store: {
        analysis: { plan: "x".repeat(5000), details: "y".repeat(5000) },
        "analysis.__summary": "[object] plan, details (10200 chars)",
      },
    });
    const runtime = { reads: { "Analysis": "analysis" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("compact summary");
    expect(result).toContain("get_store_value");
    expect(result).not.toContain("x".repeat(100));
  });

  it("renders full value when __summary exists but value is small", () => {
    const ctx = makeContext({
      store: {
        analysis: { plan: "short plan" },
        "analysis.__summary": "[object] plan (20 chars)",
      },
    });
    const runtime = { reads: { "Analysis": "analysis" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("short plan");
    expect(result).not.toContain("compact summary");
  });
});

describe("buildTier1Context - semantic summary preference", () => {
  it("uses __semantic_summary when value exceeds MAX_INLINE_CHARS", () => {
    const ctx = makeContext({
      store: {
        plan: { tasks: "x".repeat(5000), approach: "y".repeat(5000) },
        "plan.__summary": "[object] tasks, approach (12345 chars)",
        "plan.__semantic_summary": "5 tasks using TDD approach, starting with unit tests",
      },
    });
    const runtime = { reads: { "Plan": "plan" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("5 tasks using TDD approach");
    expect(result).toContain("semantic summary");
  });

  it("falls back to __summary when __semantic_summary not available", () => {
    const ctx = makeContext({
      store: {
        plan: { tasks: Array(100).fill("task"), approach: "TDD", details: "x".repeat(10000) },
        "plan.__summary": "[object] tasks, approach, details (15000 chars)",
      },
    });
    const runtime = { reads: { "Plan": "plan" } } as any;
    const result = buildTier1Context(ctx, runtime, 50);
    expect(result).toContain("[object] tasks, approach, details");
  });
});

describe("buildTier1Context - incremental diff on resume", () => {
  it("shows unchanged for reads matching checkpoint", () => {
    const ctx = makeContext({
      store: {
        requirements: { summary: "build a todo app" },
        design: { architecture: "React + Node" },
      },
      resumeInfo: { sessionId: "sess-1", feedback: "fix the bug" },
      stageCheckpoints: {
        execute: {
          startedAt: "2026-04-13T00:00:00Z",
          readsSnapshot: {
            requirements: stableHash({ summary: "build a todo app" }),
            design: stableHash({ architecture: "React + Node" }),
          },
        },
      },
    });
    const runtime = {
      reads: { "Requirements": "requirements", "Design": "design" },
    } as any;
    const result = buildTier1Context(ctx, runtime, 8000, "execute");
    expect(result).toContain("Context unchanged from previous attempt: Requirements, Design");
    expect(result).not.toContain("build a todo app");
  });

  it("shows full value when read changed since checkpoint", () => {
    const ctx = makeContext({
      store: {
        requirements: { summary: "build a todo app v2" },
        design: { architecture: "React + Node" },
      },
      resumeInfo: { sessionId: "sess-1", feedback: "fix the bug" },
      stageCheckpoints: {
        execute: {
          startedAt: "2026-04-13T00:00:00Z",
          readsSnapshot: {
            requirements: stableHash({ summary: "build a todo app" }),
            design: stableHash({ architecture: "React + Node" }),
          },
        },
      },
    });
    const runtime = {
      reads: { "Requirements": "requirements", "Design": "design" },
    } as any;
    const result = buildTier1Context(ctx, runtime, 8000, "execute");
    expect(result).toContain("build a todo app v2");
    expect(result).toContain("Context unchanged from previous attempt: Design");
  });

  it("shows full value when no checkpoint exists", () => {
    const ctx = makeContext({
      store: { requirements: { summary: "build a todo app" } },
      resumeInfo: { sessionId: "sess-1" },
    });
    const runtime = { reads: { "Requirements": "requirements" } } as any;
    const result = buildTier1Context(ctx, runtime, 8000, "execute");
    expect(result).toContain("build a todo app");
  });

  it("shows full value when no currentStage provided", () => {
    const ctx = makeContext({
      store: { requirements: { summary: "build a todo app" } },
      resumeInfo: { sessionId: "sess-1" },
      stageCheckpoints: {
        execute: {
          startedAt: "2026-04-13T00:00:00Z",
          readsSnapshot: {
            requirements: stableHash({ summary: "build a todo app" }),
          },
        },
      },
    });
    const runtime = { reads: { "Requirements": "requirements" } } as any;
    const result = buildTier1Context(ctx, runtime, 8000);
    expect(result).toContain("build a todo app");
    expect(result).not.toContain("Unchanged");
  });

  it("shows full value when no resumeInfo", () => {
    const ctx = makeContext({
      store: { requirements: { summary: "build a todo app" } },
      stageCheckpoints: {
        execute: {
          startedAt: "2026-04-13T00:00:00Z",
          readsSnapshot: {
            requirements: stableHash({ summary: "build a todo app" }),
          },
        },
      },
    });
    const runtime = { reads: { "Requirements": "requirements" } } as any;
    const result = buildTier1Context(ctx, runtime, 8000, "execute");
    expect(result).toContain("build a todo app");
    expect(result).not.toContain("Unchanged");
  });
});
