// Expose kernel-next MCP tools over HTTP StreamableHTTP transport so
// that an external MCP client (another Claude Code session, Codex,
// Cursor, etc.) can call run_pipeline / answer_gate / get_task_status
// / list_pipelines / forge_analyze / etc. without being spawned as a
// pipeline agent.
//
// Stateless: each HTTP request spins up a fresh McpServer + transport
// pair. createKernelMcp already returns { instance: McpServer }; we
// connect it to a WebStandardStreamableHTTPServerTransport and hand
// the Hono Request straight through.
//
// Surface = "external": the server omits runner-internal tools
// (write_port). External agents get the caller-facing API only.
//
// 2026-05-04: Factory takes an optional forgeDb getter so the
// `forge_analyze` tool is available when Forge is enabled. The
// kernel-mcp route module itself remains DB-agnostic — index.ts
// passes the singleton via the factory.

import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getKernelNextDb } from "../lib/kernel-next-db.js";
import { createKernelMcp } from "../kernel-next/mcp/server.js";
import { MONOREPO_TSC_PATH } from "./kernel-run.js";

export interface KernelMcpRouteOpts {
  /** Optional forge.db handle. When provided, forge_analyze is exposed. */
  getForgeDb?: () => DatabaseSync | undefined;
}

export function buildKernelMcpRoute(opts: KernelMcpRouteOpts = {}): Hono {
  const route = new Hono();
  route.all("/mcp", async (c) => {
    const db = getKernelNextDb();
    const forgeDb = opts.getForgeDb?.();
    const { instance: server } = createKernelMcp(db, {
      surface: "external",
      tscPath: MONOREPO_TSC_PATH,
      forgeDb,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await transport.close();
      await server.close();
    }
  });
  return route;
}

// Backwards-compat: the no-arg route is what existing code imports.
// New code should call buildKernelMcpRoute({ getForgeDb }) explicitly
// so forge_analyze is available.
export const kernelMcpRoute = buildKernelMcpRoute();
