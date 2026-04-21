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
import { queryLineage, diffRuns } from "./lineage.js";
import { IRPatchSchema } from "../ir/schema.js";
import type { PipelineIR } from "../ir/schema.js";
import { PortRuntime, type EventDispatcher } from "../runtime/port-runtime.js";
import { taskRegistry } from "../runtime/task-registry.js";
import { handleStartPipelineGenerator, handleWaitPipelineResult } from "./pg-entry.js";
import { loadLegacyPipelineIR } from "../runtime/load-legacy-pipeline.js";
import { kernelNextBroadcaster } from "../sse/singleton.js";
import { runPipeline } from "../runtime/runner.js";
import { RealStageExecutor } from "../runtime/real-executor.js";
import { FsPromptResolver } from "../runtime/fs-prompt-resolver.js";

const MAX_VALUE_BYTES_DEFAULT = 65_536;

function jsonResponse(payload: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(payload),
    }],
  };
}

function errorResponse(message: string, extra: Record<string, unknown> = {}) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ ok: false, error: message, ...extra }),
    }],
    isError: true,
  };
}

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
  | "read_port" | "query_lineage" | "diff_runs"
  | "write_port"
  | "start_pipeline_generator" | "wait_pipeline_result";

const EXTERNAL_TOOLS: ReadonlySet<ToolName> = new Set([
  "submit_pipeline", "validate_pipeline", "propose_pipeline_change",
  "list_proposals", "approve_proposal", "reject_proposal",
  "migrate_task",
  "get_task_status", "list_gates", "answer_gate",
  "read_port", "query_lineage", "diff_runs",
  "start_pipeline_generator", "wait_pipeline_result",
]);
const INTERNAL_TOOLS: ReadonlySet<ToolName> = new Set(["write_port"]);

let cachedPipelineGeneratorIR: ReturnType<typeof loadLegacyPipelineIR> | undefined;
function getPipelineGeneratorIR() {
  if (!cachedPipelineGeneratorIR) {
    cachedPipelineGeneratorIR = loadLegacyPipelineIR("pipeline-generator");
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

  const allTools = [
      {
        name: "submit_pipeline",
        description:
          "Submit a pipeline IR for validation + persistence. Returns the " +
          "version hash on success, or structured diagnostics on failure.",
        inputSchema: {
          ir: z.unknown().describe("PipelineIR object (see kernel-next docs)"),
          parentHash: z.string().optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const result = kernel.submit(args.ir, {
              parentHash: typeof args.parentHash === "string" ? args.parentHash : undefined,
            });
            return jsonResponse(result);
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
              }),
            );
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "read_port",
        description:
          "Read the latest value for a port, optionally scoped to a taskId " +
          "and attempt index. Truncates to maxBytes (default 64KB) and " +
          "returns { truncated: true, preview, totalBytes } when larger.",
        inputSchema: {
          taskId: z.string().optional(),
          stage: z.string(),
          port: z.string(),
          attempt: z.number().int().optional(),
          maxBytes: z.number().int().positive().optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const stage = String(args.stage);
            const port = String(args.port);
            const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
            const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : maxBytesDefault;
            const attempt = typeof args.attempt === "number" ? args.attempt : undefined;

            const row = readPortSpecific(db, stage, port, taskId, attempt);
            if (!row) {
              return jsonResponse({ ok: false, error: "port not found" });
            }
            const encoded = JSON.stringify(row.value);
            const bytes = Buffer.byteLength(encoded, "utf8");
            if (bytes > maxBytes) {
              // UTF-8-safe truncation: slice at byte boundary via Buffer so
              // partial multi-byte sequences become a single U+FFFD rather
              // than a lone surrogate corrupting later JSON.stringify.
              const preview = Buffer.from(encoded, "utf8")
                .subarray(0, maxBytes)
                .toString("utf8");
              return jsonResponse({
                ok: true,
                truncated: true,
                preview,
                totalBytes: bytes,
                valueId: row.valueId,
                writtenAt: row.writtenAt,
                attemptId: row.attemptId,
              });
            }
            return jsonResponse({
              ok: true,
              truncated: false,
              value: row.value,
              valueId: row.valueId,
              writtenAt: row.writtenAt,
              attemptId: row.attemptId,
            });
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "query_lineage",
        description:
          "Return the latest write for a port plus its precise downstream " +
          "readers (filtered via the pipeline's wires when versionHash is " +
          "supplied, else a task-scope upper-bound approximation). " +
          "valuePreview is capped to 200 bytes; use read_port for full value.",
        inputSchema: {
          stage: z.string(),
          port: z.string(),
          taskId: z.string().optional(),
          versionHash: z.string().optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const stage = String(args.stage);
            const port = String(args.port);
            const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
            const versionHash = typeof args.versionHash === "string" ? args.versionHash : undefined;

            // If versionHash provided, look up wires whose source is
            // (stage, port) and pass the precise consumer (stage, port)
            // list to queryLineage for filtering.
            let wiredInputs: Array<{ stage: string; port: string }> | undefined;
            if (versionHash) {
              const rows = db.prepare(
                `SELECT to_stage, to_port FROM wires
                 WHERE version_hash = ? AND from_stage = ? AND from_port = ?`,
              ).all(versionHash, stage, port) as Array<{ to_stage: string; to_port: string }>;
              wiredInputs = rows.map((r) => ({ stage: r.to_stage, port: r.to_port }));
            }

            return jsonResponse({
              ok: true,
              report: queryLineage(db, { stage, port, taskId, wiredInputs }),
            });
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "diff_runs",
        description:
          "Compare two task runs at the stage-output level. For each stage " +
          "that appeared in either run, reports which output ports are equal, " +
          "differing, or missing on one side.",
        inputSchema: {
          taskA: z.string(),
          taskB: z.string(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            return jsonResponse({
              ok: true,
              report: diffRuns(db, String(args.taskA), String(args.taskB)),
            });
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
      {
        name: "write_port",
        description:
          "Write a value to a declared output port for an in-flight stage " +
          "attempt. The (stage, port) pair must be declared as an `out` port " +
          "on the stage of the pipeline version associated with the attempt. " +
          "Dispatches PORT_WRITTEN via an inert dispatcher — this tool is " +
          "intended for authors / agents recording outputs, not for driving " +
          "the XState runner (the runner owns its own PortRuntime).",
        inputSchema: {
          taskId: z.string(),
          attemptId: z.string(),
          stage: z.string(),
          port: z.string(),
          value: z.unknown(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            const taskId = String(args.taskId);
            const attemptId = String(args.attemptId);
            const stage = String(args.stage);
            const port = String(args.port);

            // Guard: '__external__' is a reserved stage name owned by the
            // runner's seed phase, which is the sole legitimate producer of
            // port_values rows with that stage. Rejecting here — before the
            // FK / lineage work below — prevents agents from forging
            // external-input provenance via write_port.
            if (stage === "__external__") {
              return errorResponse(
                "stage '__external__' is reserved for runner-initiated seed values; write_port cannot target it",
              );
            }

            // Resolve the pipeline version this attempt belongs to, so we can
            // validate that (stage, port) is declared as an output on that
            // specific version (not just any version in the DB).
            const attemptRow = db.prepare(
              `SELECT version_hash, task_id, stage_name
               FROM stage_attempts WHERE attempt_id = ?`,
            ).get(attemptId) as
              | { version_hash: string; task_id: string; stage_name: string }
              | undefined;
            if (!attemptRow) {
              return errorResponse(`attemptId '${attemptId}' not found`);
            }
            if (attemptRow.task_id !== taskId) {
              return errorResponse(
                `attemptId '${attemptId}' belongs to task '${attemptRow.task_id}', not '${taskId}'`,
              );
            }
            if (attemptRow.stage_name !== stage) {
              return errorResponse(
                `attemptId '${attemptId}' belongs to stage '${attemptRow.stage_name}', not '${stage}'`,
              );
            }

            const versionRow = db.prepare(
              `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
            ).get(attemptRow.version_hash) as { ir_json: string } | undefined;
            if (!versionRow) {
              return errorResponse(
                `pipeline version '${attemptRow.version_hash}' not found for attempt`,
              );
            }
            const ir = JSON.parse(versionRow.ir_json) as PipelineIR;
            const stageDef = ir.stages.find((s) => s.name === stage);
            if (!stageDef) {
              return errorResponse(`stage '${stage}' not declared in pipeline version`);
            }
            if (!stageDef.outputs.some((p) => p.name === port)) {
              return errorResponse(
                `port '${port}' is not a declared output of stage '${stage}'`,
              );
            }

            // Prefer the caller-supplied live PortRuntime so Slice 2's
            // onPortWritten hook fires on MCP-initiated writes too
            // (without this, real-executor runs produce zero SSE
            // port_written events). Fall back to constructing one here
            // for external callers that only pass a dispatcher.
            const runtime = options.portRuntime ?? new PortRuntime(
              db,
              options.writePortDispatcher ?? { send: () => { /* inert */ } },
            );
            runtime.writePort({
              attemptId,
              stageName: stage,
              portName: port,
              value: args.value,
            });

            return jsonResponse({ ok: true });
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
        name: "get_task_status",
        description:
          "Aggregate status of a running / completed task from stage_attempts " +
          "and gate_queue. Returns one of 'not_found' | 'running' | 'gated' | " +
          "'completed' | 'failed'. When status is 'gated', `pending` lists the " +
          "open gate(s) with their questionJson so the caller can answer via " +
          "answer_gate. 'gated' takes priority over 'running' — a task with an " +
          "unanswered gate is reported as gated even though the gate's stage " +
          "attempt row is still in status 'running'.",
        inputSchema: {
          taskId: z.string(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            return jsonResponse(kernel.getTaskStatus(String(args.taskId)));
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
              // Task 4 will add kind==="rejected" dispatch (GATE_REJECTED).
              // For now only answered answers are forwarded to the runner.
              if (result.kind === "answered") {
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
              loader: loadLegacyPipelineIR,
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
              executorFactory: ({ promptRoot, model, maxTurns, maxBudgetUsd }) =>
                new RealStageExecutor({
                  mcpServerFactory: (_dispatcher, pr) =>
                    createKernelMcp(db, { surface: "internal", portRuntime: pr }),
                  promptResolver: new FsPromptResolver({ rootDir: promptRoot }),
                  model,
                  maxTurns: maxTurns ?? 80,
                  maxBudgetUsd: maxBudgetUsd ?? 8,
                }),
              model: options.pipelineGeneratorModel ?? "claude-sonnet-4-6",
              maxTurns: options.pipelineGeneratorMaxTurns ?? 80,
              maxBudgetUsd: options.pipelineGeneratorMaxBudgetUsd ?? 8,
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

// Helper for read_port when `attempt` is provided. readLatestPort in
// port-runtime.ts only returns the latest; this variant picks a specific one.
// Returns port_values.value_id so callers can reference the individual row
// (distinct from attempt_id which groups all port_values for one attempt).
function readPortSpecific(
  db: DatabaseSync,
  stage: string,
  port: string,
  taskId: string | undefined,
  attemptIdx: number | undefined,
): { value: unknown; valueId: string; attemptId: string; writtenAt: number } | null {
  if (attemptIdx === undefined) {
    const sql = taskId
      ? `SELECT pv.value_json, pv.value_id, pv.attempt_id, pv.written_at
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
         WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
           AND sa.task_id = ?
         ORDER BY pv.written_at DESC LIMIT 1`
      : `SELECT pv.value_json, pv.value_id, pv.attempt_id, pv.written_at
         FROM port_values pv
         WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
         ORDER BY pv.written_at DESC LIMIT 1`;
    const row = taskId
      ? db.prepare(sql).get(stage, port, taskId)
      : db.prepare(sql).get(stage, port);
    if (!row) return null;
    const r = row as { value_json: string; value_id: string; attempt_id: string; written_at: number };
    return {
      value: JSON.parse(r.value_json),
      valueId: r.value_id,
      attemptId: r.attempt_id,
      writtenAt: r.written_at,
    };
  }
  const row = taskId
    ? db.prepare(
        `SELECT pv.value_json, pv.value_id, pv.attempt_id, pv.written_at
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
         WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
           AND sa.task_id = ? AND sa.attempt_idx = ?
         ORDER BY pv.written_at DESC LIMIT 1`,
      ).get(stage, port, taskId, attemptIdx)
    : db.prepare(
        `SELECT pv.value_json, pv.value_id, pv.attempt_id, pv.written_at
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
         WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
           AND sa.attempt_idx = ?
         ORDER BY pv.written_at DESC LIMIT 1`,
      ).get(stage, port, attemptIdx);
  if (!row) return null;
  const r = row as { value_json: string; value_id: string; attempt_id: string; written_at: number };
  return {
    value: JSON.parse(r.value_json),
    valueId: r.value_id,
    attemptId: r.attempt_id,
    writtenAt: r.written_at,
  };
}
