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

describe("edge MCP route", () => {
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

  it("POST /mcp creates a new session on initialize", async () => {
    transportSessionIdRef.value = "session-abc";

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    expect(res.status).toBe(200);
    expect(mockMcpServer.connect).toHaveBeenCalled();
    expect(mockAddSlotListener).toHaveBeenCalled();
  });

  it("POST /mcp routes to existing session when session ID matches", async () => {
    transportSessionIdRef.value = "session-existing";
    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "mcp-session-id": "session-existing",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });

    expect(res.status).toBe(200);
    expect(transportHandleRequest).toHaveBeenCalledTimes(2);
  });

  it("POST /mcp closes server when transport has no sessionId", async () => {
    transportSessionIdRef.value = null;

    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    expect(mockMcpServer.close).toHaveBeenCalled();
  });

  it("GET /mcp returns 404 when no session header", async () => {
    const res = await app.request("/mcp");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toContain("Session not found");
  });

  it("GET /mcp returns 404 for unknown session", async () => {
    const res = await app.request("/mcp", {
      headers: { "mcp-session-id": "nonexistent" },
    });
    expect(res.status).toBe(404);
  });

  it("GET /mcp routes to existing session transport", async () => {
    transportSessionIdRef.value = "session-sse";
    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    transportHandleRequest.mockResolvedValue(
      new Response("data: test\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await app.request("/mcp", {
      headers: { "mcp-session-id": "session-sse" },
    });

    expect(res.status).toBe(200);
    expect(transportHandleRequest).toHaveBeenCalledTimes(2);
  });

  it("DELETE /mcp returns 204 and cleans up session", async () => {
    transportSessionIdRef.value = "session-del";
    const mockUnsub = vi.fn();
    mockAddSlotListener.mockReturnValue(mockUnsub);

    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    const res = await app.request("/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": "session-del" },
    });

    expect(res.status).toBe(204);
    expect(mockUnsub).toHaveBeenCalled();
    expect(mockMcpServer.close).toHaveBeenCalled();
  });

  it("DELETE /mcp returns 204 even for nonexistent session", async () => {
    const res = await app.request("/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": "ghost" },
    });
    expect(res.status).toBe(204);
  });

  it("slot listener triggers sendResourceListChanged on server", async () => {
    transportSessionIdRef.value = "session-slot";
    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    const listenerCb = mockAddSlotListener.mock.calls[0][0];
    listenerCb();

    expect(mockMcpServer.sendResourceListChanged).toHaveBeenCalled();
  });

  it("slot listener swallows errors from sendResourceListChanged", async () => {
    transportSessionIdRef.value = "session-err";
    mockMcpServer.sendResourceListChanged.mockImplementation(() => {
      throw new Error("disconnected");
    });

    await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    const listenerCb = mockAddSlotListener.mock.calls[0][0];
    expect(() => listenerCb()).not.toThrow();
  });
});
