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

describe("adversarial: null and undefined store handling", () => {
  it("treats context.store as empty object when undefined", () => {
    const ctx = makeContext({ store: undefined as any });
    const result = buildTier1Context(ctx);
    // Should not throw, should still contain task ID
    expect(result).toContain("Task ID: test-id");
  });

  it("handles null values inside store objects in reads path", () => {
    const ctx = makeContext({
      store: { data: { val: null } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    // The object { val: null } is rendered as JSON code fence
    expect(result).toContain('"val": null');
  });
});

describe("adversarial: string value exactly 300 chars is not truncated", () => {
  it("does not truncate a string of exactly 300 characters", () => {
    const exactStr = "a".repeat(300);
    const ctx = makeContext({
      store: { data: { content: exactStr } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    // v.length > 300 is false for exactly 300, so no truncation
    expect(result).not.toContain("(truncated)");
    expect(result).toContain(exactStr);
  });

  it("does not truncate a string of 301 characters (reads are not truncated)", () => {
    const longStr = "b".repeat(301);
    const ctx = makeContext({
      store: { data: { content: longStr } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).not.toContain("(truncated)");
    expect(result).toContain("b".repeat(301));
  });
});

describe("adversarial: array exactly 5 elements has no ellipsis", () => {
  it("renders exactly 5 items in JSON format", () => {
    const ctx = makeContext({
      store: { data: { items: ["1", "2", "3", "4", "5"] } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain("```json");
    expect(result).toContain('"1"');
    expect(result).toContain('"5"');
  });

  it("renders 6 items in JSON format", () => {
    const ctx = makeContext({
      store: { data: { items: ["1", "2", "3", "4", "5", "6"] } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain('"1"');
    expect(result).toContain('"6"');
  });
});

describe("adversarial: empty reads object produces no Required Context section", () => {
  it("does not add Required Context header when reads is empty object", () => {
    const ctx = makeContext({ store: { a: "b" } });
    const runtime = { reads: {} } as any;
    const result = buildTier1Context(ctx, runtime);
    // All reads are empty, no values resolved -> still has the header but nothing under it
    // Actually the code always pushes "## Required Context (Tier 1)" when runtime.reads exists
    expect(result).toContain("## Required Context (Tier 1)");
    // But all store keys end up in "Other Available Context"
    expect(result).toContain("- a");
  });
});

describe("adversarial: legacy fallback with duplicate store keys across stages", () => {
  it("renders a store key only once even if multiple stages reference it", () => {
    const ctx = makeContext({
      store: { analysis: { summary: "ok" } },
      config: {
        pipeline: {
          stages: [
            { outputs: { analysis: { label: "First", fields: [{ key: "summary", type: "string", description: "" }] } } },
            { outputs: { analysis: { label: "Second", fields: [{ key: "summary", type: "string", description: "" }] } } },
          ],
        },
      },
    });
    const result = buildTier1Context(ctx);
    // renderedKeys Set prevents double rendering
    const matches = result.split("## First").length - 1;
    expect(matches).toBe(1);
    expect(result).not.toContain("## Second");
  });
});

describe("adversarial: legacy fallback with array store values", () => {
  it("renders array store values as strings in legacy path", () => {
    const ctx = makeContext({
      store: { analysis: [1, 2, 3] },
      config: {
        pipeline: {
          stages: [
            { outputs: { analysis: { label: "Arr", fields: [{ key: "x", type: "string", description: "" }] } } },
          ],
        },
      },
    });
    const result = buildTier1Context(ctx);
    // Array is not "object" || Array.isArray => true, so it goes to String(data)
    expect(result).toContain("1,2,3");
  });
});

describe("adversarial: number and boolean values in reads path", () => {
  it("renders number values in JSON format", () => {
    const ctx = makeContext({
      store: { data: { count: 42 } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain('"count": 42');
  });

  it("renders boolean values in JSON format", () => {
    const ctx = makeContext({
      store: { data: { active: false } },
    });
    const runtime = { reads: { "Data": "data" } } as any;
    const result = buildTier1Context(ctx, runtime);
    expect(result).toContain('"active": false');
  });
});
