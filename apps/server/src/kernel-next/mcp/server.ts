// Kernel-next MCP server.
//
// Exposes 7 tools to userland (pipeline-generator and future AI-driven
// pipeline authors / debuggers). Implementation is thin: each handler
// parses args, calls through to KernelService / queries, and wraps the
// response in the MCP text-envelope shape.
//
// Response convention: single `text` content block with a JSON payload.
// On error: isError: true + diagnostic JSON text.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { KernelService, type KernelServiceOptions } from "./kernel.js";
import { type EventDispatcher, type PortRuntime } from "../runtime/port-runtime.js";
import { kernelNextBroadcaster } from "../sse/singleton.js";
import { startPipelineRun } from "../runtime/start-pipeline-run.js";
import { jsonResponse, errorResponse } from "./tool-helpers.js";
import type { ToolDef, ToolsDeps } from "./tool-types.js";
import { buildPortsTools } from "./tools/ports.js";
import { buildTaskTools } from "./tools/task.js";
import { buildGateTools } from "./tools/gate.js";
import { buildPgTools } from "./tools/pg.js";
import { buildDebugTools } from "./tools/debug.js";
import { buildHotUpdateTools } from "./tools/hot-update.js";

const MAX_VALUE_BYTES_DEFAULT = 65_536;

export interface KernelMcpOptions extends KernelServiceOptions {
  /** Max bytes returned by read_port before truncating. Default 64KB. */
  defaultMaxBytes?: number;
  /**
   * Optional dispatcher for port_write's PORT_WRITTEN events. When the
   * caller is running a live XState runner and wants the agent's
   * write_port tool calls to advance the machine, pass the runner's
   * dispatcher here. Omit (default inert) for external authoring /
   * debugging use cases where no machine is listening.
   *
   * Ignored when `portRuntime` is supplied — the caller's runtime
   * already carries its own dispatcher.
   */
  writePortDispatcher?: EventDispatcher;
  /**
   * Reuse the caller's PortRuntime instead of constructing a fresh
   * one per write_port call. Preserves any observability hooks the
   * runtime was built with (notably Slice 2's onPortWritten, which
   * backs the SSE port_written events). Without this, an
   * MCP-initiated write silently bypasses the runner-side hook and
   * the dashboard sees no port_written events for real-executor
   * runs.
   *
   * The runtime's dispatcher takes precedence; writePortDispatcher
   * is ignored when portRuntime is set.
   */
  portRuntime?: PortRuntime;
  /**
   * Which tool surface to expose. Per design doc §9.1 the external
   * surface (AI consumers, dashboards) must NOT include write_port;
   * the internal surface (kernel's own executors) is in-process only
   * and exposes write_port + sidecar writes. This parameter is the
   * physical separation boundary.
   *
   *   "external" — AI-facing. submit/validate/propose/list/approve/
   *                reject/get_task_status/list_gates/answer_gate/
   *                read_port/query_lineage/diff_runs/
   *                start_pipeline_generator/wait_pipeline_result.
   *                NO write_port.
   *   "internal" — executor-facing. write_port only (sidecar TBD).
   *   "combined" — legacy: every tool. Default for backwards compat
   *                while callers migrate. New code should pick a
   *                specific surface.
   */
  surface?: "external" | "internal" | "combined";
  /** Model for the pipeline-generator builtin. Default "claude-sonnet-4-6". */
  pipelineGeneratorModel?: string;
  /** Max turns for the pipeline-generator run. Default 80. */
  pipelineGeneratorMaxTurns?: number;
  /** Per-run budget ceiling in USD for pipeline-generator. Default 8. */
  pipelineGeneratorMaxBudgetUsd?: number;
}

/** Every tool name emitted by createKernelMcp across all surfaces. */
type ToolName =
  | "submit_pipeline" | "validate_pipeline" | "propose_pipeline_change"
  | "list_proposals" | "approve_proposal" | "reject_proposal"
  | "migrate_task"
  | "get_task_status" | "list_gates" | "answer_gate"
  | "read_port" | "query_lineage" | "diff_runs" | "compare_runs"
  | "write_port"
  | "start_pipeline_generator" | "wait_pipeline_result"
  | "run_pipeline"
  // Stage 5A
  | "dry_run_proposal" | "update_registry_pipeline" | "rollback_hot_update"
  // Stage 5E
  | "query_hot_update_stats"
  // A4 Phase 4.5 Tier2
  | "replay_stage"
  // A4 Phase 4.5 Tier3
  | "dry_run_stage" | "propose_pipeline_fix";

const EXTERNAL_TOOLS: ReadonlySet<ToolName> = new Set([
  "submit_pipeline", "validate_pipeline", "propose_pipeline_change",
  "list_proposals", "approve_proposal", "reject_proposal",
  "migrate_task",
  "get_task_status", "list_gates", "answer_gate",
  "read_port", "query_lineage", "diff_runs", "compare_runs",
  "start_pipeline_generator", "wait_pipeline_result",
  "run_pipeline",
  // Stage 5A additions
  "dry_run_proposal", "update_registry_pipeline", "rollback_hot_update",
  // Stage 5E addition
  "query_hot_update_stats",
  // A4 Phase 4.5 Tier2
  "replay_stage",
  // A4 Phase 4.5 Tier3
  "dry_run_stage", "propose_pipeline_fix",
]);
const INTERNAL_TOOLS: ReadonlySet<ToolName> = new Set(["write_port"]);

export function createKernelMcp(db: DatabaseSync, options: KernelMcpOptions = {}) {
  const kernel = new KernelService(db, options);
  const maxBytesDefault = options.defaultMaxBytes ?? MAX_VALUE_BYTES_DEFAULT;
  // Debt #2 retire — default is 'external' (AI-facing authoring + read
  // surface only). 'combined' remains opt-in for in-process callers that
  // also need `write_port` (real-executor dispatch path, sdk-probe).
  // Narrowing the default prevents new callers from accidentally handing
  // runner-internal tools to external agents.
  const surface = options.surface ?? "external";
  const allow: ReadonlySet<ToolName> =
    surface === "external" ? EXTERNAL_TOOLS :
    surface === "internal" ? INTERNAL_TOOLS :
    new Set([...EXTERNAL_TOOLS, ...INTERNAL_TOOLS]);

  // Dependency bag passed to each build<Domain>Tools factory.
  const deps: ToolsDeps = {
    db,
    kernel,
    maxBytesDefault,
    portRuntime: options.portRuntime,
    writePortDispatcher: options.writePortDispatcher,
    tscPath: options.tscPath,
    pipelineGeneratorModel: options.pipelineGeneratorModel,
    pipelineGeneratorMaxTurns: options.pipelineGeneratorMaxTurns,
    pipelineGeneratorMaxBudgetUsd: options.pipelineGeneratorMaxBudgetUsd,
    createMcpServer: (s, pr) =>
      createKernelMcp(db, { surface: s, portRuntime: pr, tscPath: options.tscPath }),
  };

  const allTools: ToolDef[] = [
      {
        name: "submit_pipeline",
        description:
          "Submit a pipeline IR for validation + persistence. Returns the " +
          "version hash on success, or structured diagnostics on failure. " +
          "AgentStage prompts must be supplied via the 'prompts' map " +
          "(promptRef -> content).",
        inputSchema: {
          ir: z.unknown().describe("PipelineIR object (see kernel-next docs)"),
          parentHash: z.string().optional(),
          prompts: z
            .record(z.string(), z.string())
            .optional()
            .describe("Map of promptRef to prompt content; required if the IR contains AgentStage entries"),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const prompts =
              args.prompts && typeof args.prompts === "object"
                ? (args.prompts as Record<string, string>)
                : undefined;
            const result = kernel.submit(args.ir, {
              parentHash: typeof args.parentHash === "string" ? args.parentHash : undefined,
              prompts,
            });
            return jsonResponse(result);
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "run_pipeline",
        description:
          "Start a new task running a previously-submitted pipeline. " +
          "Specify `name` (resolves to latest versionHash) or `versionHash` " +
          "(exact). Returns the taskId — poll get_task_status to observe.",
        inputSchema: {
          name: z.string().optional().describe("Pipeline name; resolves to latest versionHash"),
          versionHash: z.string().optional().describe("Exact pipeline versionHash; overrides name when both supplied"),
          seedValues: z.record(z.string(), z.unknown()).optional().describe("Per-port external input values"),
          policy: z.unknown().optional().describe("ExecutionPolicy (see terminal-design §5.3)"),
          model: z.string().optional(),
          maxTurns: z.number().int().positive().optional(),
          maxBudgetUsd: z.number().positive().optional(),
          taskId: z.string().optional(),
          checkpointConfig: z
            .object({
              enabled: z.boolean().optional(),
              workdir: z.string().optional(),
              maxDiffBytes: z.number().int().positive().optional(),
              timeouts: z
                .object({
                  revParseMs: z.number().int().positive().optional(),
                  snapshotMs: z.number().int().positive().optional(),
                  diffMs: z.number().int().positive().optional(),
                })
                .optional(),
            })
            .optional()
            .describe("Per-task checkpoint config; omit to use defaults (enabled=true, workdir=process.cwd())"),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const result = await startPipelineRun({
              db,
              broadcaster: kernelNextBroadcaster,
              name: typeof args.name === "string" ? args.name : undefined,
              versionHash: typeof args.versionHash === "string" ? args.versionHash : undefined,
              seedValues:
                args.seedValues && typeof args.seedValues === "object"
                  ? (args.seedValues as Record<string, unknown>)
                  : undefined,
              policy: args.policy as never,
              model: typeof args.model === "string" ? args.model : undefined,
              maxTurns: typeof args.maxTurns === "number" ? args.maxTurns : undefined,
              maxBudgetUsd: typeof args.maxBudgetUsd === "number" ? args.maxBudgetUsd : undefined,
              taskId: typeof args.taskId === "string" ? args.taskId : undefined,
              checkpointConfig:
                args.checkpointConfig && typeof args.checkpointConfig === "object"
                  ? (args.checkpointConfig as import("../runtime/checkpoint/checkpoint.js").CheckpointConfig)
                  : undefined,
              tscPath: options.tscPath,
            });
            if (result.ok === true) {
              return jsonResponse({
                ok: true,
                taskId: result.taskId,
                versionHash: result.versionHash,
              });
            }
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify(result),
              }],
              isError: true,
            };
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "validate_pipeline",
        description:
          "Run the full validation pipeline (zod + structural + DAG + tsc) on " +
          "an IR without persisting. Returns ok + diagnostics[].",
        inputSchema: {
          ir: z.unknown(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            return jsonResponse(kernel.validate(args.ir));
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      ...buildPortsTools(deps),
      ...buildTaskTools(deps),
      ...buildGateTools(deps),
      ...buildPgTools(deps),
      ...buildDebugTools(deps),
      ...buildHotUpdateTools(deps),
  ];

  return createSdkMcpServer({
    name:
      surface === "internal"
        ? "__kernel_next_internal__"
        : surface === "external"
          ? "__kernel_next_external__"
          : "__kernel_next__",
    version: "0.1.0",
    // Physical separation per §9.1: filter the all-tools list down to
    // what this surface is supposed to expose. An external server
    // literally cannot emit write_port — the tool is not in its
    // descriptor list, so the SDK won't route a matching tool call to
    // any handler.
    tools: allTools.filter((t) => allow.has(t.name as ToolName)),
  });
}

