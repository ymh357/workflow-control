// Expose kernel-next MCP tools over HTTP StreamableHTTP transport so
// that an external MCP client (another Claude Code session, Codex,
// Cursor, etc.) can call run_pipeline / answer_gate / get_task_status
// / list_pipelines without being spawned as a pipeline agent.
//
// Stateless: each HTTP request spins up a fresh McpServer + transport
// pair. createKernelMcp already returns { instance: McpServer }; we
// connect it to a WebStandardStreamableHTTPServerTransport and hand
// the Hono Request straight through.
//
// Surface = "external": the server omits runner-internal tools
// (write_port). External agents get the caller-facing API only.

import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getKernelNextDb } from "../lib/kernel-next-db.js";
import { createKernelMcp } from "../kernel-next/mcp/server.js";
import { MONOREPO_TSC_PATH } from "./kernel-run.js";

export const kernelMcpRoute = new Hono();

kernelMcpRoute.all("/mcp", async (c) => {
  const db = getKernelNextDb();
  const { instance: server } = createKernelMcp(db, {
    surface: "external",
    tscPath: MONOREPO_TSC_PATH,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    // Close in reverse order so any in-flight SSE stream is already
    // terminated before the server tears down its handler table.
    await transport.close();
    await server.close();
  }
});
