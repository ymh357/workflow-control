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
import { IRPatchSchema } from "../ir/schema.js";
import type { PipelineIR } from "../ir/schema.js";
import { type EventDispatcher, type PortRuntime } from "../runtime/port-runtime.js";
import { taskRegistry } from "../runtime/task-registry.js";
import { handleStartPipelineGenerator, handleWaitPipelineResult } from "./pg-entry.js";
import { loadBuiltinPipelineIR } from "../runtime/load-builtin-pipeline.js";
import { kernelNextBroadcaster } from "../sse/singleton.js";
import { runPipeline } from "../runtime/runner.js";
import { RealStageExecutor } from "../runtime/real-executor.js";
import { DbPromptResolver } from "../runtime/db-prompt-resolver.js";
import { startPipelineRun } from "../runtime/start-pipeline-run.js";
import { replayStage } from "../debug/replay-stage.js";
import { dryRunStage } from "../debug/dry-run-stage.js";
import { proposePipelineFix, proposePipelineFixWithAi } from "../debug/propose-pipeline-fix.js";
import { createClaudeSdkPatchSynthesizer } from "../debug/claude-sdk-patch-synthesizer.js";
import { analyzeTaskFailure } from "../../lib/debug-queries.js";
import { jsonResponse, errorResponse } from "./tool-helpers.js";
import type { ToolDef, ToolsDeps } from "./tool-types.js";
import { buildPortsTools } from "./tools/ports.js";
import { buildTaskTools } from "./tools/task.js";

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

let cachedPipelineGeneratorIR: ReturnType<typeof loadBuiltinPipelineIR> | undefined;
function getPipelineGeneratorIR() {
  if (!cachedPipelineGeneratorIR) {
    cachedPipelineGeneratorIR = loadBuiltinPipelineIR("pipeline-generator");
  }
  return cachedPipelineGeneratorIR;
}

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
      {
        name: "propose_pipeline_change",
        description:
          "Propose a patch against the pipeline at currentVersion. " +
          "Patch is applied to a deep-copy of the IR, validated, and (if ok) " +
          "persisted with a pending proposal row. autoApplied is always " +
          "false in spike — proposals require human confirm before migrating " +
          "running tasks. `rerunFrom` optionally names a stage on the " +
          "proposed pipeline to rewind to on migration (null / omitted = " +
          "forward-only). `migrateRunningTasks` is the opt-in list — 'none' " +
          "(default), 'all', or an explicit array of taskIds.",
        inputSchema: {
          currentVersion: z.string(),
          patch: z.unknown(),
          actor: z.string().default("unknown"),
          rerunFrom: z.string().optional(),
          migrateRunningTasks: z.union([
            z.literal("all"),
            z.literal("none"),
            z.array(z.string()),
          ]).optional(),
          autoApprove: z.boolean().optional().describe(
            "Stage 5A — when true and dry-run safeRange.verdict==='safe', " +
            "flips proposal to 'approved' in same tx. Structural patches " +
            "ignore this flag and stay pending.",
          ),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const parsedPatch = IRPatchSchema.safeParse(args.patch);
            if (!parsedPatch.success) {
              return jsonResponse({
                ok: false,
                diagnostics: parsedPatch.error.issues.map((i) => ({
                  code: "ZOD_PARSE_ERROR",
                  message: `patch.${i.path.join(".") || "<root>"}: ${i.message}`,
                  context: { path: i.path },
                })),
              });
            }
            const rerunFrom =
              typeof args.rerunFrom === "string" ? args.rerunFrom : undefined;
            const migrateRunningTasks: "all" | "none" | string[] | undefined =
              args.migrateRunningTasks === "all" || args.migrateRunningTasks === "none"
                ? args.migrateRunningTasks
                : Array.isArray(args.migrateRunningTasks)
                  ? args.migrateRunningTasks.map((x: unknown) => String(x))
                  : undefined;
            return jsonResponse(
              kernel.propose({
                currentVersion: String(args.currentVersion),
                patch: parsedPatch.data,
                actor: String(args.actor ?? "unknown"),
                rerunFrom,
                migrateRunningTasks,
                autoApprove: typeof args.autoApprove === "boolean" ? args.autoApprove : undefined,
              }),
            );
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "dry_run_proposal",
        description:
          "Stage 5A — read-only preview of a pipeline patch. Returns " +
          "{diff, impact, safeRange, wouldAutoApprove, proposedVersion} " +
          "without touching pipeline_proposals or pipeline_versions. " +
          "Safe to call concurrently; idempotent.",
        inputSchema: {
          currentVersion: z.string(),
          patch: z.unknown(),
          rerunFrom: z.string().optional(),
          migrateRunningTasks: z.union([
            z.literal("all"),
            z.literal("none"),
            z.array(z.string()),
          ]).optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const parsedPatch = IRPatchSchema.safeParse(args.patch);
            if (!parsedPatch.success) {
              return jsonResponse({
                ok: false,
                diagnostics: parsedPatch.error.issues.map((i) => ({
                  code: "ZOD_PARSE_ERROR",
                  message: `patch.${i.path.join(".") || "<root>"}: ${i.message}`,
                  context: { path: i.path },
                })),
              });
            }
            return jsonResponse(kernel.dryRunProposal({
              currentVersion: String(args.currentVersion),
              patch: parsedPatch.data,
              rerunFrom: typeof args.rerunFrom === "string" ? args.rerunFrom : null,
              migrateRunningTasks:
                args.migrateRunningTasks === "all" || args.migrateRunningTasks === "none"
                  ? args.migrateRunningTasks
                  : Array.isArray(args.migrateRunningTasks)
                    ? args.migrateRunningTasks.map((x: unknown) => String(x))
                    : undefined,
            }));
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "update_registry_pipeline",
        description:
          "Stage 5A — replace a registry pipeline's IR definition and " +
          "register a new pipeline_versions row. Does NOT migrate running " +
          "tasks. REGISTRY_ROOT env var can override the registry root " +
          "for tests.",
        inputSchema: {
          pipelineName: z.string().min(1),
          newIR: z.unknown(),
          actor: z.string().default("unknown"),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            return jsonResponse(kernel.updateRegistryPipeline({
              pipelineName: String(args.pipelineName),
              newIR: args.newIR as never,
              actor: String(args.actor ?? "unknown"),
            }));
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "rollback_hot_update",
        description:
          "Stage 5A skeleton — writes an audit row indicating rollback " +
          "intent. Does NOT execute state rollback (that lands in Stage 5B). " +
          "Validates that toVersion exists in this task's migration history.",
        inputSchema: {
          taskId: z.string(),
          toVersion: z.string(),
          actor: z.string().default("unknown"),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            return jsonResponse(await kernel.rollbackHotUpdate({
              taskId: String(args.taskId),
              toVersion: String(args.toVersion),
              actor: String(args.actor ?? "unknown"),
            }));
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "query_hot_update_stats",
        description:
          "Stage 5E — aggregate queries over hot_update_events. Returns " +
          "total/success/failed/rolled_back counts, byPipelineName breakdown, " +
          "byActor counts, and topChurnPipelines ranking. All filters optional.",
        inputSchema: {
          taskId: z.string().optional(),
          pipelineName: z.string().optional(),
          sinceMs: z.number().int().optional(),
          untilMs: z.number().int().optional(),
          actor: z.string().optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            return jsonResponse({
              ok: true,
              stats: kernel.queryHotUpdateStats({
                taskId: typeof args.taskId === "string" ? args.taskId : undefined,
                pipelineName: typeof args.pipelineName === "string" ? args.pipelineName : undefined,
                sinceMs: typeof args.sinceMs === "number" ? args.sinceMs : undefined,
                untilMs: typeof args.untilMs === "number" ? args.untilMs : undefined,
                actor: typeof args.actor === "string" ? args.actor : undefined,
              }),
            });
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "replay_stage",
        description:
          "Re-execute a specific stage attempt with the same inputs as the " +
          "original (reconstructed from lineage reads). Produces a NEW attempt " +
          "tagged kind='replay' + replayed_from_attempt_id, leaving the source " +
          "attempt untouched. Useful for debugging flaky agent stages or " +
          "reproducing a prior failure under current conditions. Only 'regular' " +
          "attempts of agent/script stages are replayable; external-seed, gate, " +
          "fanout, and prior-replay attempts are rejected with " +
          "SOURCE_STAGE_NOT_REPLAYABLE.",
        inputSchema: {
          attemptId: z.string().describe("attempt_id of the source attempt to replay"),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const sourceAttemptId = String(args.attemptId);
            // DbPromptResolver is version-bound; look up the source
            // attempt's version_hash first so the executor resolves
            // prompts against the right pipeline version. replay-stage's
            // preflight will re-derive the same hash, but we need it
            // here to construct the executor.
            const versionRow = db.prepare(
              `SELECT version_hash FROM stage_attempts WHERE attempt_id = ?`,
            ).get(sourceAttemptId) as { version_hash: string } | undefined;
            if (!versionRow) {
              return jsonResponse({
                ok: false,
                code: "SOURCE_ATTEMPT_NOT_FOUND",
                message: `no stage_attempts row with attempt_id='${sourceAttemptId}'`,
              });
            }
            const executor = new RealStageExecutor({
              mcpServerFactory: (_dispatcher, portRuntime) =>
                createKernelMcp(db, {
                  surface: "combined",
                  portRuntime,
                  tscPath: options.tscPath,
                }),
              promptResolver: new DbPromptResolver(db, versionRow.version_hash),
            });
            const result = await replayStage({
              db,
              sourceAttemptId,
              executor,
            });
            return jsonResponse(result);
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "dry_run_stage",
        description:
          "Run a SINGLE stage against caller-supplied inputs, without " +
          "requiring a task or prior attempt. Produces a fresh attempt " +
          "tagged kind='dry_run' under a synthetic task_id prefixed " +
          "'dry_run-'. No events propagate to any running XState machine " +
          "(inert dispatcher). Only 'agent' and 'script' stages are " +
          "supported; gates are rejected with STAGE_NOT_DRY_RUNNABLE. " +
          "All inputs declared by the target stage must be supplied in " +
          "the 'inputs' object; missing inputs are rejected up-front " +
          "with MISSING_INPUT.",
        inputSchema: {
          pipelineVersion: z.string().describe("version_hash of the pipeline that declares the target stage"),
          stageName: z.string().describe("name of the stage within that pipeline"),
          inputs: z.record(z.string(), z.unknown()).describe("flat input map keyed by port name"),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const pipelineVersion = String(args.pipelineVersion);
            const stageName = String(args.stageName);
            const inputs =
              args.inputs && typeof args.inputs === "object"
                ? (args.inputs as Record<string, unknown>)
                : {};
            const executor = new RealStageExecutor({
              mcpServerFactory: (_dispatcher, portRuntime) =>
                createKernelMcp(db, {
                  surface: "combined",
                  portRuntime,
                  tscPath: options.tscPath,
                }),
              promptResolver: new DbPromptResolver(db, pipelineVersion),
            });
            const result = await dryRunStage({
              db,
              pipelineVersion,
              stageName,
              inputs,
              executor,
            });
            return jsonResponse(result);
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "propose_pipeline_fix",
        description:
          "Given a failing taskId, analyse its stage_attempts + agent " +
          "execution detail and produce a list of concrete pipeline-change " +
          "suggestions. Rule-based foundation surfaces stuck-open attempts, " +
          "error_status failures, error markers in agent streams, " +
          "supersede/interrupt provenance, and zero-attempt anomalies as " +
          "human-readable suggestions tagged with severity. Each suggestion " +
          "may carry a proposedPatch (IRPatch) — the rule layer leaves these " +
          "undefined. Set aiPatch=true to let a Claude sub-session propose " +
          "update_stage_config patches for every non-info suggestion (safe " +
          "range only; other patch shapes are rejected). aiPatch costs API " +
          "tokens and adds latency; default off.",
        inputSchema: {
          taskId: z.string().describe("task_id whose failure we want suggestions for"),
          aiPatch: z.boolean().optional().describe("When true, use a Claude sub-session to synthesise update_stage_config patches. Default false."),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const taskId = String(args.taskId);
            const useAi = Boolean(args.aiPatch);
            const report = analyzeTaskFailure(taskId);
            if (useAi) {
              const synth = createClaudeSdkPatchSynthesizer({
                model: options.pipelineGeneratorModel,
              });
              const result = await proposePipelineFixWithAi({
                db, taskId, report, aiPatchSynthesizer: synth,
              });
              return jsonResponse(result);
            }
            const result = proposePipelineFix({ db, taskId, report });
            return jsonResponse(result);
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "list_proposals",
        description:
          "List pipeline-change proposals, newest first. Optionally filter " +
          "by status ('pending' | 'approved' | 'rejected').",
        inputSchema: {
          status: z.enum(["pending", "approved", "rejected"]).optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const filter = args.status ? { status: args.status } : {};
            return jsonResponse({ ok: true, proposals: kernel.listProposals(filter) });
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "approve_proposal",
        description:
          "Approve a pending proposal. Spike scope: flips status to 'approved' " +
          "only — does NOT migrate running tasks. New task submissions can " +
          "then reference the approved proposedVersion.",
        inputSchema: {
          proposalId: z.string(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            return jsonResponse(kernel.approveProposal(String(args.proposalId)));
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "reject_proposal",
        description:
          "Reject a pending proposal. Optional reason is persisted to " +
          "diagnostic_json for audit.",
        inputSchema: {
          proposalId: z.string(),
          // Mirror REST's 4096 cap to avoid oversize payloads bloating
          // pipeline_proposals.diagnostic_json.
          reason: z.string().max(4096).optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const reason = typeof args.reason === "string" ? args.reason : undefined;
            return jsonResponse(kernel.rejectProposal(String(args.proposalId), reason));
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "migrate_task",
        description:
          "Migrate a task onto an approved proposal's proposedVersion " +
          "(A8 forward-migration happy path, §10.5). The task must be in " +
          "the proposal's migrateRunningTasks opt-in list; the proposal " +
          "must be status='approved'. Marks rerunFrom + downstream stage " +
          "attempts as 'superseded' on the OLD version (lineage retained) " +
          "and writes a hot_update_events audit row. Returns eventId + " +
          "supersededStages; callers kick off fresh attempts on toVersion.",
        inputSchema: {
          taskId: z.string(),
          proposalId: z.string(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            return jsonResponse(
              kernel.migrateTask(String(args.taskId), String(args.proposalId)),
            );
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "list_gates",
        description:
          "List gates in the queue. Optional taskId narrows to a single task; " +
          "optional `answered` filters to pending (false) or resolved (true).",
        inputSchema: {
          taskId: z.string().optional(),
          answered: z.boolean().optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const filter: { taskId?: string; answered?: boolean } = {};
            if (typeof args.taskId === "string") filter.taskId = args.taskId;
            if (typeof args.answered === "boolean") filter.answered = args.answered;
            return jsonResponse({ ok: true, gates: kernel.listGates(filter) });
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "answer_gate",
        description:
          "Answer an open gate. The answer is validated against the gate " +
          "stage's routing table (exact match, falling back to '_default'). " +
          "On success dispatches GATE_ANSWERED to the live runner (if the " +
          "task is still running in this process) and returns the resolved " +
          "targetStage. If the task's runner is not registered (process " +
          "restart, task already completed), the gate answer is persisted " +
          "but no machine event is dispatched.",
        inputSchema: {
          gateId: z.string(),
          answer: z.string().min(1).max(4096),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const result = kernel.answerGate(String(args.gateId), String(args.answer));
            if (result.ok) {
              const dispatcher = taskRegistry.get(result.taskId);
              if (result.kind === "rejected") {
                dispatcher?.send({
                  type: "GATE_REJECTED",
                  gateId: result.gateId,
                  stageName: result.stageName,
                  answer: result.answer,
                  targetStage: result.targetStage,
                  affectedStages: result.affectedStages,
                });
              } else {
                dispatcher?.send({
                  type: "GATE_ANSWERED",
                  gateId: result.gateId,
                  stageName: result.stageName,
                  answer: result.answer,
                  targetStage: result.targetStage,
                });
              }
            }
            return jsonResponse(result);
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "start_pipeline_generator",
        description:
          "Trigger the pipeline-generator builtin with a natural-language task " +
          "description. Returns {taskId, versionHash} immediately; use " +
          "wait_pipeline_result to retrieve the generated pipeline.",
        inputSchema: {
          description: z.string().min(1).max(8000),
          taskId: z.string().min(1).optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          const res = await handleStartPipelineGenerator(
            {
              description: String(args.description),
              taskId: typeof args.taskId === "string" ? args.taskId : undefined,
            },
            {
              db,
              broadcaster: kernelNextBroadcaster,
              loader: loadBuiltinPipelineIR,
              runner: async (a) => {
                return runPipeline({
                  db: a.db,
                  ir: a.ir,
                  taskId: a.taskId,
                  versionHash: a.versionHash,
                  handlers: a.handlers as Record<string, never>,
                  executor: a.executor,
                  seedValues: a.seedValues,
                  broadcaster: a.broadcaster,
                });
              },
              executorFactory: ({ versionHash, db: execDb, model, maxTurns, maxBudgetUsd, tscPath }) =>
                new RealStageExecutor({
                  mcpServerFactory: (_dispatcher, pr) =>
                    createKernelMcp(db, { surface: "internal", portRuntime: pr, tscPath }),
                  promptResolver: new DbPromptResolver(execDb, versionHash),
                  model,
                  maxTurns: maxTurns ?? 80,
                  maxBudgetUsd: maxBudgetUsd ?? 8,
                }),
              model: options.pipelineGeneratorModel ?? "claude-sonnet-4-6",
              maxTurns: options.pipelineGeneratorMaxTurns ?? 80,
              maxBudgetUsd: options.pipelineGeneratorMaxBudgetUsd ?? 8,
              tscPath: options.tscPath,
            },
          );
          return res.ok ? jsonResponse(res) : errorResponse(res.error, res as Record<string, unknown>);
        },
      },
      {
        name: "wait_pipeline_result",
        description:
          "Wait for a previously started pipeline-generator run to reach a " +
          "terminal state (done/gate_pending/running/error). Safe to call " +
          "repeatedly to continue waiting.",
        inputSchema: {
          taskId: z.string().min(1),
          timeoutMs: z.number().int().optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          let ir: PipelineIR;
          try {
            ir = getPipelineGeneratorIR().ir;
          } catch (err) {
            return errorResponse("LOAD_IR_FAILED", { reason: (err as Error).message });
          }
          const res = await handleWaitPipelineResult(
            {
              taskId: String(args.taskId),
              timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
            },
            { db, broadcaster: kernelNextBroadcaster, ir },
          );
          return res.ok
            ? jsonResponse(res)
            : errorResponse(res.error, res as Record<string, unknown>);
        },
      },
      ...buildPortsTools(deps),
      ...buildTaskTools(deps),
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

