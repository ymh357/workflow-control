import { describe, it, expect, vi } from "vitest";
import type { ScratchPadEntry } from "../machine/types.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn(({ tools }) => {
    // Return the tool handlers so we can test them directly
    return { type: "sdk", name: "__store__", _tools: tools };
  }),
}));

vi.mock("./config-loader.js", () => ({
  getNestedValue: vi.fn((obj: Record<string, any>, path: string) => {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: any, part: string) => {
      if (acc == null || !Object.hasOwn(acc, part)) return undefined;
      return acc[part];
    }, obj);
  }),
}));

import { createStoreReaderMcp } from "./store-reader-mcp.js";

function getHandler(store: Record<string, unknown>) {
  const result = createStoreReaderMcp(store) as any;
  return result._tools[0].handler;
}

function getToolByName(
  store: Record<string, unknown>,
  scratchPad: ScratchPadEntry[],
  currentStage: string,
  toolName: string,
) {
  const result = createStoreReaderMcp(store, scratchPad, currentStage) as any;
  const tool = result._tools.find((t: any) => t.name === toolName);
  if (!tool) throw new Error(`Tool "${toolName}" not found`);
  return tool.handler;
}

describe("store-reader-mcp", () => {
  it("returns value for a valid top-level path", async () => {
    const handler = getHandler({ analysis: { summary: "hello" } });
    const result = await handler({ path: "analysis" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ summary: "hello" });
  });

  it("returns value for a nested dot-notation path", async () => {
    const handler = getHandler({ analysis: { modules: ["a", "b"] } });
    const result = await handler({ path: "analysis.modules" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual(["a", "b"]);
  });

  it("returns error with available keys for missing path", async () => {
    const handler = getHandler({ analysis: {}, planning: {} });
    const result = await handler({ path: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("analysis");
    expect(result.content[0].text).toContain("planning");
  });

  it("truncates values larger than 50KB with structural summary", async () => {
    const largeObj: Record<string, string> = {};
    for (let i = 0; i < 500; i++) largeObj[`key_${i}`] = "x".repeat(200);
    const handler = getHandler({ big: largeObj });
    const result = await handler({ path: "big" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Object with 500 keys");
    expect(result.content[0].text).toContain("truncated");
    expect(result.content[0].text).toContain("dot notation");
    expect(result.content[0].text.length).toBeLessThan(60 * 1024);
  });

  it("truncates large arrays with count summary", async () => {
    const largeArray = Array.from({ length: 5000 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const handler = getHandler({ items: largeArray });
    const result = await handler({ path: "items" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Array with 5000 items");
    expect(result.content[0].text).toContain("truncated");
  });

  it("truncates large strings at line boundary", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}: ${"x".repeat(20)}`).join("\n");
    const handler = getHandler({ text: lines });
    const result = await handler({ path: "text" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("truncated");
    // Should not contain partial lines (cut at newline boundary)
    const preview = result.content[0].text;
    const lastLine = preview.split("\n").filter((l: string) => l.startsWith("line ")).pop();
    if (lastLine) {
      expect(lastLine).toMatch(/^line \d+: x+$/);
    }
  });

  it("truncates plain large strings without newlines", async () => {
    const largeString = "x".repeat(60 * 1024);
    const handler = getHandler({ big: largeString });
    const result = await handler({ path: "big" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("truncated");
    expect(result.content[0].text.length).toBeLessThan(60 * 1024);
  });

  it("returns error for empty store", async () => {
    const handler = getHandler({});
    const result = await handler({ path: "anything" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("empty");
  });

  it("handles circular references gracefully", async () => {
    const obj: any = { name: "test" };
    obj.self = obj;
    const handler = getHandler({ circular: obj });

    // getNestedValue returns the circular object; JSON.stringify will throw
    const result = await handler({ path: "circular" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("circular reference");
  });

  it("returns error when path is empty", async () => {
    const handler = getHandler({ a: 1 });
    const result = await handler({ path: "" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("path is required");
  });
});

describe("scratch pad tools", () => {
  it("append_scratch_pad adds an entry to the array", async () => {
    const pad: ScratchPadEntry[] = [];
    const handler = getToolByName({}, pad, "stage_a", "append_scratch_pad");

    const result = await handler({ category: "discovery", content: "Found something interesting" });
    expect(result.content[0].text).toContain("1 total entries");
    expect(pad).toHaveLength(1);
    expect(pad[0].stage).toBe("stage_a");
    expect(pad[0].category).toBe("discovery");
    expect(pad[0].content).toBe("Found something interesting");
    expect(pad[0].timestamp).toBeTruthy();
  });

  it("read_scratch_pad returns all entries when no filter", async () => {
    const pad: ScratchPadEntry[] = [
      { stage: "stage_a", timestamp: "2026-01-01T00:00:00.000Z", category: "discovery", content: "First note" },
      { stage: "stage_b", timestamp: "2026-01-01T00:01:00.000Z", category: "caveat", content: "Second note" },
    ];
    const handler = getToolByName({}, pad, "stage_c", "read_scratch_pad");

    const result = await handler({});
    expect(result.content[0].text).toContain("[stage_a]");
    expect(result.content[0].text).toContain("First note");
    expect(result.content[0].text).toContain("[stage_b]");
    expect(result.content[0].text).toContain("Second note");
  });

  it("read_scratch_pad filters by category", async () => {
    const pad: ScratchPadEntry[] = [
      { stage: "stage_a", timestamp: "2026-01-01T00:00:00.000Z", category: "discovery", content: "Discovery note" },
      { stage: "stage_a", timestamp: "2026-01-01T00:01:00.000Z", category: "caveat", content: "Caveat note" },
    ];
    const handler = getToolByName({}, pad, "stage_b", "read_scratch_pad");

    const result = await handler({ category: "caveat" });
    expect(result.content[0].text).toContain("Caveat note");
    expect(result.content[0].text).not.toContain("Discovery note");
  });

  it("read_scratch_pad filters by stage", async () => {
    const pad: ScratchPadEntry[] = [
      { stage: "stage_a", timestamp: "2026-01-01T00:00:00.000Z", category: "discovery", content: "Stage A note" },
      { stage: "stage_b", timestamp: "2026-01-01T00:01:00.000Z", category: "discovery", content: "Stage B note" },
    ];
    const handler = getToolByName({}, pad, "stage_c", "read_scratch_pad");

    const result = await handler({ stage: "stage_a" });
    expect(result.content[0].text).toContain("Stage A note");
    expect(result.content[0].text).not.toContain("Stage B note");
  });

  it("read_scratch_pad returns empty message when pad has no entries", async () => {
    const pad: ScratchPadEntry[] = [];
    const handler = getToolByName({}, pad, "stage_a", "read_scratch_pad");

    const result = await handler({});
    expect(result.content[0].text).toContain("empty");
  });

  it("get_store_value still works when scratchPad is provided (backward compat)", async () => {
    const pad: ScratchPadEntry[] = [];
    const store = { myKey: { value: 42 } };
    const result = createStoreReaderMcp(store, pad, "stage_a") as any;
    const getStoreHandler = result._tools.find((t: any) => t.name === "get_store_value")?.handler;
    expect(getStoreHandler).toBeDefined();

    const r = await getStoreHandler({ path: "myKey" });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content[0].text)).toEqual({ value: 42 });
  });

  it("scratch pad tools are absent when scratchPad is not provided", () => {
    const result = createStoreReaderMcp({ key: "value" }) as any;
    const toolNames: string[] = result._tools.map((t: any) => t.name);
    expect(toolNames).not.toContain("append_scratch_pad");
    expect(toolNames).not.toContain("read_scratch_pad");
    expect(toolNames).toContain("get_store_value");
  });

  it("read_scratch_pad returns no-match message when filters yield no entries", async () => {
    const pad: ScratchPadEntry[] = [
      { stage: "stage_a", timestamp: "2026-01-01T00:00:00.000Z", category: "discovery", content: "Some note" },
    ];
    const handler = getToolByName({}, pad, "stage_b", "read_scratch_pad");

    const result = await handler({ stage: "nonexistent_stage" });
    expect(result.content[0].text).toContain("No scratch pad entries matching filters");
  });
});
