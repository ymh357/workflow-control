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
import type { DatabaseSync } from "node:sqlite";
import { KernelService, type KernelServiceOptions } from "./kernel.js";
import { type EventDispatcher, type PortRuntime } from "../runtime/port-runtime.js";
import type { ToolDef, ToolsDeps } from "./tool-types.js";
import { buildPipelineTools } from "./tools/pipeline.js";
import { buildPortsTools } from "./tools/ports.js";
import { buildTaskTools } from "./tools/task.js";
import { buildGateTools } from "./tools/gate.js";
import { buildPgTools } from "./tools/pg.js";
import { buildDebugTools } from "./tools/debug.js";
import { buildHotUpdateTools } from "./tools/hot-update.js";
import { buildAdminTools } from "./tools/admin.js";
import { buildMcpCatalogTools } from "./tools/mcp-catalog.js";
import { buildGetPipelineDefinitionTools } from "./tools/get-pipeline-definition.js";
import { BUILTIN_SCRIPT_IDS } from "../builtin-scripts/index.js";

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
  | "submit_pipeline" | "validate_pipeline" | "describe_pipeline" | "propose_pipeline_change"
  | "list_proposals" | "approve_proposal" | "reject_proposal"
  | "migrate_task"
  | "get_task_status" | "list_gates" | "answer_gate" | "provide_task_secrets"
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
  | "dry_run_stage" | "propose_pipeline_fix"
  // Phase 4 P4.1 (D8)
  | "retry_task"
  // Phase 4 P4.2 (D9)
  | "prune_records"
  // Phase 4 P4.3 (D4)
  | "cancel_task"
  // P1.1 external-driver observation (post-4.5 dogfood)
  | "wait_for_task_event"
  // Phase 1 MCP supply-chain
  | "recommend_mcp_servers"
  | "get_mcp_catalog_entry"
  // 2026-04-27 pipeline-modifier
  | "get_pipeline_definition";

const EXTERNAL_TOOLS: ReadonlySet<ToolName> = new Set([
  "submit_pipeline", "validate_pipeline", "describe_pipeline", "propose_pipeline_change",
  "list_proposals", "approve_proposal", "reject_proposal",
  "migrate_task",
  "get_task_status", "list_gates", "answer_gate", "provide_task_secrets",
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
  // Phase 4 P4.1 (D8)
  "retry_task",
  // Phase 4 P4.2 (D9)
  "prune_records",
  // Phase 4 P4.3 (D4)
  "cancel_task",
  // P1.1 external-driver observation
  "wait_for_task_event",
  // Phase 1 MCP supply-chain
  "recommend_mcp_servers",
  "get_mcp_catalog_entry",
  // 2026-04-27 pipeline-modifier
  "get_pipeline_definition",
]);
const INTERNAL_TOOLS: ReadonlySet<ToolName> = new Set(["write_port"]);

export function createKernelMcp(db: DatabaseSync, options: KernelMcpOptions = {}) {
  // D'-1: default allowedScriptModuleIds to the kernel's builtin registry
  // so any ScriptStage.config.moduleId that can't be resolved at run time
  // is caught at submit time with SCRIPT_MODULE_NOT_REGISTERED. Callers
  // that want to bypass the check (currently only tests that don't
  // exercise script stages) must explicitly pass an empty set.
  const effective: KernelMcpOptions =
    options.allowedScriptModuleIds === undefined
      ? { ...options, allowedScriptModuleIds: BUILTIN_SCRIPT_IDS }
      : options;
  const kernel = new KernelService(db, effective);
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
    // Propagate ALL configurable options to nested MCP servers so the
    // recursively-constructed server shares the outer caller's overrides
    // (PG model / budget / maxBytes / writePortDispatcher / tscPath).
    // Surface + portRuntime must come from the caller since they identify
    // what the nested server is being spun up for.
    createMcpServer: (s, pr) =>
      createKernelMcp(db, {
        surface: s,
        portRuntime: pr,
        tscPath: options.tscPath,
        defaultMaxBytes: options.defaultMaxBytes,
        writePortDispatcher: options.writePortDispatcher,
        pipelineGeneratorModel: options.pipelineGeneratorModel,
        pipelineGeneratorMaxTurns: options.pipelineGeneratorMaxTurns,
        pipelineGeneratorMaxBudgetUsd: options.pipelineGeneratorMaxBudgetUsd,
      }),
  };

  const allTools: ToolDef[] = [
      ...buildPipelineTools(deps),
      ...buildPortsTools(deps),
      ...buildTaskTools(deps),
      ...buildGateTools(deps),
      ...buildPgTools(deps),
      ...buildDebugTools(deps),
      ...buildHotUpdateTools(deps),
      ...buildAdminTools(deps),
      ...buildMcpCatalogTools(deps),
      ...buildGetPipelineDefinitionTools(deps),
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

