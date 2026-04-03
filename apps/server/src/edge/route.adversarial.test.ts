import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const mockMcpServer = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
  sendResourceListChanged: vi.fn(),
}));

const mockAddSlotListener = vi.hoisted(() => vi.fn().mockReturnValue(vi.fn()));

const transportHandleRequest = vi.hoisted(() => vi.fn());
const transportSessionIdRef = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock("./mcp-server.js", () => ({
  createEdgeMcpServer: () => mockMcpServer,
}));

vi.mock("./registry.js", () => ({
  addSlotListener: (...args: unknown[]) => mockAddSlotListener(...args),
}));

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => ({
  WebStandardStreamableHTTPServerTransport: class {
    sessionId: string | null = null;
    constructor() {
      this.sessionId = transportSessionIdRef.value;
    }
    handleRequest(...args: unknown[]) {
      return transportHandleRequest(...args);
    }
  },
}));

import { edgeMcpRoute } from "./route.js";

describe("edge MCP route — adversarial", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    transportSessionIdRef.value = null;
    transportHandleRequest.mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", result: {} }), { status: 200 }),
    );
    app = new Hono();
    app.route("/mcp", edgeMcpRoute);
  });

  it("POST /mcp with invalid JSON body returns error", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all",
    });

    // c.req.json() will throw, resulting in 500
    expect(res.status).toBe(500);
  });

  it("POST /mcp with forged session ID that doesn't exist creates new session", async () => {
    transportSessionIdRef.value = "new-session-id";

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-session-id": "forged-nonexistent-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    // The forged session ID is not in sessions map, so it creates a new session
    expect(res.status).toBe(200);
    expect(mockMcpServer.connect).toHaveBeenCalled();
  });

  it("GET /mcp with empty mcp-session-id header returns 404", async () => {
    const res = await app.request("/mcp", {
      headers: { "mcp-session-id": "" },
    });

    // Empty string is falsy, so condition !sessionId is true
    expect(res.status).toBe(404);
  });

  it("DELETE /mcp without session header returns 204 (no-op)", async () => {
    const res = await app.request("/mcp", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("DELETE /mcp handles server.close() rejection gracefully", async () => {
    transportSessionIdRef.value = "session-close-err";
    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    mockMcpServer.close.mockRejectedValueOnce(new Error("close failed"));

    const res = await app.request("/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": "session-close-err" },
    });

    // .catch(() => {}) in the source should swallow the error
    expect(res.status).toBe(204);
  });

  it("POST /mcp server.connect failure propagates as 500", async () => {
    mockMcpServer.connect.mockRejectedValueOnce(new Error("connect failed"));

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    expect(res.status).toBe(500);
  });

  it("multiple DELETE on same session — second is no-op", async () => {
    transportSessionIdRef.value = "session-double-del";
    const mockUnsub = vi.fn();
    mockAddSlotListener.mockReturnValue(mockUnsub);

    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    const res1 = await app.request("/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": "session-double-del" },
    });
    const res2 = await app.request("/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": "session-double-del" },
    });

    expect(res1.status).toBe(204);
    expect(res2.status).toBe(204);
    // Unsubscribe only called once
    expect(mockUnsub).toHaveBeenCalledTimes(1);
  });
});
