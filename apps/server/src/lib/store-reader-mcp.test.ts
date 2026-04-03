import { describe, it, expect, vi } from "vitest";

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

  it("truncates values larger than 50KB", async () => {
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
