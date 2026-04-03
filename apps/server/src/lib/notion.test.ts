import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./logger.js", () => ({
  taskLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockWithRetry = vi.fn();

vi.mock("./slack.js", () => ({
  withRetry: (fn: any) => mockWithRetry(fn),
}));

import { updateNotionPageStatus } from "./notion.js";

describe("updateNotionPageStatus", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, NOTION_TOKEN: "ntn_secret_test" };
    // By default, withRetry executes the callback immediately
    mockWithRetry.mockImplementation(async (fn: () => Promise<void>) => fn());
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("skips update when NOTION_TOKEN is not set", async () => {
    delete process.env.NOTION_TOKEN;

    await updateNotionPageStatus("t1", "page-1", "In Progress");

    expect(mockWithRetry).not.toHaveBeenCalled();
  });

  it("skips update when notionPageId is empty", async () => {
    await updateNotionPageStatus("t1", "", "In Progress");

    expect(mockWithRetry).not.toHaveBeenCalled();
  });

  it("calls fetch with correct URL and headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await updateNotionPageStatus("t1", "page-123", "Done");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.notion.com/v1/pages/page-123");
    expect(opts.method).toBe("PATCH");
    expect(opts.headers["Authorization"]).toBe("Bearer ntn_secret_test");
    expect(opts.headers["Notion-Version"]).toBe("2022-06-28");

    vi.unstubAllGlobals();
  });

  it("sends correct body with status property", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await updateNotionPageStatus("t1", "page-123", "In Review");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.properties.Status.select.name).toBe("In Review");

    vi.unstubAllGlobals();
  });

  it("delegates to withRetry for retry logic", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await updateNotionPageStatus("t1", "page-1", "Done");

    expect(mockWithRetry).toHaveBeenCalledTimes(1);
    expect(typeof mockWithRetry.mock.calls[0][0]).toBe("function");

    vi.unstubAllGlobals();
  });

  it("does not throw when withRetry throws (catches errors)", async () => {
    mockWithRetry.mockRejectedValue(new Error("network error"));

    // Should not throw — error is caught internally
    await expect(updateNotionPageStatus("t1", "page-1", "Done")).resolves.toBeUndefined();
  });

  it("handles non-ok response without throwing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: "bad request" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    // Should not throw — error is logged but not rethrown
    await expect(updateNotionPageStatus("t1", "page-1", "Done")).resolves.toBeUndefined();

    vi.unstubAllGlobals();
  });
});
