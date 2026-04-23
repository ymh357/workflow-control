// Shared types for kernel-next MCP tool modules.
//
// Each per-domain tool module exports a `build<Domain>Tools(deps)` factory
// returning a `ToolDef[]`. The aggregator (`server.ts`) composes these
// arrays, filters by surface, and hands them to `createSdkMcpServer`.

import type { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { KernelService } from "./kernel.js";
import type { PortRuntime, EventDispatcher } from "../runtime/port-runtime.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<CallToolResult>;
}

/**
 * Dependency bag passed to every `build<Domain>Tools` factory. Holds the
 * live kernel resources a tool handler may need. Individual builders
 * destructure only what they use — unused fields are not a lint error.
 */
export interface ToolsDeps {
  db: DatabaseSync;
  kernel: KernelService;
  /** Max bytes returned by read_port before truncating. */
  maxBytesDefault: number;
  /** Optional PortRuntime for write_port — reused from caller when provided. */
  portRuntime?: PortRuntime;
  /** Fallback dispatcher used to construct a PortRuntime inside write_port. */
  writePortDispatcher?: EventDispatcher;
  /** tsc binary path propagated to executors the tools construct. */
  tscPath?: string;
  /** Model for AI-driven tools (propose_pipeline_fix, pipeline-generator). */
  pipelineGeneratorModel?: string;
  /** Max turns for pipeline-generator. */
  pipelineGeneratorMaxTurns?: number;
  /** Per-run budget ceiling for pipeline-generator. */
  pipelineGeneratorMaxBudgetUsd?: number;
  /**
   * Back-reference to createKernelMcp so tools that recursively build an
   * MCP server (replay_stage, dry_run_stage, pipeline-generator) can
   * reach for it without a circular import.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createMcpServer: (surface: "external" | "internal" | "combined", portRuntime?: PortRuntime) => any;
}
