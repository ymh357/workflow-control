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
import { setCachedSummary, clearTaskSummaries } from "./semantic-summary-cache.js";
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

describe("buildTier1Context - no reads declared (Phase 3.6: keys index only)", () => {
  it("emits Available Store Keys index when runtime.reads is absent", () => {
    const ctx = makeContext({
      store: { analysis: { summary: "ok" }, plan: { steps: [] } },
    });
    const result = buildTier1Context(ctx);
    expect(result).toContain("## Available Store Keys");
    expect(result).toContain("- analysis");
    expect(result).toContain("- plan");
    // Full content is NOT injected — agents pull via get_store_value.
    expect(result).not.toContain("summary: ok");
  });

  it("filters __-prefixed store keys from the index", () => {
    const ctx = makeContext({
      store: { public: "v", __private: "secret" },
    });
    const result = buildTier1Context(ctx);
    expect(result).toContain("- public");
    expect(result).not.toContain("__private");
  });

  it("omits the keys index when store is empty", () => {
    const ctx = makeContext({ store: {} });
    const result = buildTier1Context(ctx);
    expect(result).not.toContain("Available Store Keys");
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

describe("buildTier1Context - semantic summary via cache", () => {
  it("uses cached semantic summary when value exceeds MAX_INLINE_CHARS", () => {
    setCachedSummary("test-id", "plan", "5 tasks using TDD approach, starting with unit tests");
    try {
      const ctx = makeContext({
        store: {
          plan: { tasks: "x".repeat(5000), approach: "y".repeat(5000) },
        },
      });
      const runtime = { reads: { "Plan": "plan" } } as any;
      const result = buildTier1Context(ctx, runtime);
      expect(result).toContain("5 tasks using TDD approach");
      expect(result).toContain("semantic summary");
    } finally {
      clearTaskSummaries("test-id");
    }
  });

  it("falls back to object key preview when no summary available and budget exceeded", () => {
    const ctx = makeContext({
      store: {
        plan: { tasks: Array(100).fill("task"), approach: "TDD", details: "x".repeat(10000) },
      },
    });
    const runtime = { reads: { "Plan": "plan" } } as any;
    const result = buildTier1Context(ctx, runtime, 50);
    expect(result).toContain("Object with");
    expect(result).toContain("get_store_value");
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
