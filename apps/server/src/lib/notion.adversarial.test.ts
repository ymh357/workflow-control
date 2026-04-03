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

describe("notion adversarial", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, NOTION_TOKEN: "ntn_secret_test" };
    mockWithRetry.mockImplementation(async (fn: () => Promise<void>) => fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("page ID with special characters is used directly in URL (no encoding)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await updateNotionPageStatus("t1", "page/with/slashes", "Done");

    const [url] = mockFetch.mock.calls[0];
    // No URL encoding applied - potential issue
    expect(url).toBe("https://api.notion.com/v1/pages/page/with/slashes");
  });

  it("status with Unicode characters is sent correctly", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await updateNotionPageStatus("t1", "page-1", "执行中");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.properties.Status.select.name).toBe("执行中");
  });

  it("non-ok response where json() throws is handled", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error("not json"); },
    });
    vi.stubGlobal("fetch", mockFetch);

    // The code calls response.json() without try/catch inside withRetry callback
    // This will throw, which withRetry will catch, then outer catch handles it
    mockWithRetry.mockImplementation(async (fn: () => Promise<void>) => {
      await fn();
    });

    // Should not throw because outer try/catch handles it
    await expect(updateNotionPageStatus("t1", "page-1", "Done")).resolves.toBeUndefined();
  });

  it("empty string token is falsy and skips the update", async () => {
    process.env.NOTION_TOKEN = "";
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    await updateNotionPageStatus("t1", "page-1", "Done");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockWithRetry).not.toHaveBeenCalled();
  });

  it("reads NOTION_TOKEN from process.env on each call (not cached)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await updateNotionPageStatus("t1", "page-1", "Done");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Remove token
    delete process.env.NOTION_TOKEN;
    mockFetch.mockClear();

    await updateNotionPageStatus("t2", "page-2", "Done");
    // Should skip since token is gone
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("very long status string is sent without truncation", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const longStatus = "S".repeat(5000);
    await updateNotionPageStatus("t1", "page-1", longStatus);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.properties.Status.select.name).toBe(longStatus);
  });

  it("withRetry rejection is caught without propagating", async () => {
    mockWithRetry.mockRejectedValue(new TypeError("fetch is not a function"));

    await expect(updateNotionPageStatus("t1", "page-1", "Done")).resolves.toBeUndefined();
  });
});
