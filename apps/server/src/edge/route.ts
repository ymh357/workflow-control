import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createEdgeMcpServer } from "./mcp-server.js";
import { addSlotListener } from "./registry.js";
import { logger } from "../lib/logger.js";

interface McpSession {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  unsubscribe: () => void;
  createdAt: number;
  lastActivityAt: number;
}

const sessions = new Map<string, McpSession>();
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle
const SESSION_MAX_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours absolute max

// Cleanup stale sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    const idleExpired = now - session.lastActivityAt > SESSION_IDLE_TIMEOUT_MS;
    const absoluteExpired = now - session.createdAt > SESSION_MAX_TTL_MS;
    if (idleExpired || absoluteExpired) {
      session.unsubscribe();
      session.server.close().catch(() => {});
      sessions.delete(id);
      logger.info({ sessionId: id }, "MCP session expired");
    }
  }
}, 10 * 60 * 1000).unref();

function buildRequest(c: { req: { url: string; raw: Request } }, method: string, body?: string): Request {
  return new Request(c.req.url, {
    method,
    headers: c.req.raw.headers,
    ...(body ? { body } : {}),
  });
}

export const edgeMcpRoute = new Hono();

// POST /mcp — tool calls and initialize
edgeMcpRoute.post("/", async (c) => {
  const sessionId = c.req.header("mcp-session-id");
  const body = await c.req.json();

  // Existing session: route to its transport
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.lastActivityAt = Date.now();
    const req = buildRequest(c, "POST", JSON.stringify(body));
    return session.transport.handleRequest(req, { parsedBody: body });
  }

  // Fallback: client didn't send session header but this isn't an initialize request.
  // If exactly one active session exists, reuse it (covers clients that drop the header).
  const isInitialize = Array.isArray(body)
    ? body.some((m: { method?: string }) => m.method === "initialize")
    : body.method === "initialize";

  if (!isInitialize && sessions.size > 0) {
    // Pick the most recently active session
    let best: McpSession | undefined;
    let bestTime = 0;
    for (const s of sessions.values()) {
      if (s.lastActivityAt > bestTime) {
        best = s;
        bestTime = s.lastActivityAt;
      }
    }
    if (best) {
      best.lastActivityAt = Date.now();
      // Inject the session ID header so the transport's validateSession() passes
      const sid = best.transport.sessionId;
      const patchedHeaders = new Headers(c.req.raw.headers);
      if (sid) patchedHeaders.set("mcp-session-id", sid);
      const req = new Request(c.req.url, {
        method: "POST",
        headers: patchedHeaders,
        body: JSON.stringify(body),
      });
      return best.transport.handleRequest(req, { parsedBody: body });
    }
  }

  // New session: create server + transport
  const server = createEdgeMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  const req = buildRequest(c, "POST", JSON.stringify(body));
  const response = await transport.handleRequest(req, { parsedBody: body });

  // After initialize handshake, transport has a session ID
  if (transport.sessionId) {
    const sid = transport.sessionId;

    // Subscribe to slot creation events → push resource list_changed to this client
    const unsubscribe = addSlotListener(() => {
      try {
        server.sendResourceListChanged();
      } catch {
        // Session closed or transport disconnected
      }
    });

    const now = Date.now();
    sessions.set(sid, { server, transport, unsubscribe, createdAt: now, lastActivityAt: now });
    logger.info({ sessionId: sid }, "MCP session created");
  } else {
    // No session ID after handshake — clean up orphaned server/transport
    await server.close().catch(() => {});
  }

  return response;
});

// GET /mcp — SSE stream for server-initiated notifications
edgeMcpRoute.get("/", async (c) => {
  const sessionId = c.req.header("mcp-session-id");
  if (!sessionId || !sessions.has(sessionId)) {
    return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found. Send initialize first." }, id: null }, 404);
  }
  const session = sessions.get(sessionId)!;
  return session.transport.handleRequest(c.req.raw);
});

// DELETE /mcp — session cleanup
edgeMcpRoute.delete("/", async (c) => {
  const sessionId = c.req.header("mcp-session-id");
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!;
    session.unsubscribe();
    await session.server.close().catch(() => {});
    sessions.delete(sessionId);
    logger.info({ sessionId }, "MCP session closed by client");
  }
  return new Response(null, { status: 204 });
});
