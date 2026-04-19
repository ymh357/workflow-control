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
   */
  writePortDispatcher?: EventDispatcher;
  /**
   * Which tool surface to expose. Per design doc §9.1 the external
   * surface (AI consumers, dashboards) must NOT include write_port;
   * the internal surface (kernel's own executors) is in-process only
   * and exposes write_port + sidecar writes. This parameter is the
   * physical separation boundary.
   *
   *   "external" — AI-facing. submit/validate/propose/list/approve/
   *                reject/get_task_status/list_gates/answer_gate/
   *                read_port/query_lineage/diff_runs. NO write_port.
   *   "internal" — executor-facing. write_port only (sidecar TBD).
   *   "combined" — legacy: every tool. Default for backwards compat
   *                while callers migrate. New code should pick a
   *                specific surface.
   */
  surface?: "external" | "internal" | "combined";
}

/** Every tool name emitted by createKernelMcp across all surfaces. */
type ToolName =
  | "submit_pipeline" | "validate_pipeline" | "propose_pipeline_change"
  | "list_proposals" | "approve_proposal" | "reject_proposal"
  | "get_task_status" | "list_gates" | "answer_gate"
  | "read_port" | "query_lineage" | "diff_runs"
  | "write_port";

const EXTERNAL_TOOLS: ReadonlySet<ToolName> = new Set([
  "submit_pipeline", "validate_pipeline", "propose_pipeline_change",
  "list_proposals", "approve_proposal", "reject_proposal",
  "get_task_status", "list_gates", "answer_gate",
  "read_port", "query_lineage", "diff_runs",
]);
const INTERNAL_TOOLS: ReadonlySet<ToolName> = new Set(["write_port"]);

export function createKernelMcp(db: DatabaseSync, options: KernelMcpOptions = {}) {
  const kernel = new KernelService(db, options);
  const maxBytesDefault = options.defaultMaxBytes ?? MAX_VALUE_BYTES_DEFAULT;
  const surface = options.surface ?? "combined";
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
          "running tasks.",
        inputSchema: {
          currentVersion: z.string(),
          patch: z.unknown(),
          actor: z.string().default("unknown"),
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
            return jsonResponse(
              kernel.propose({
                currentVersion: String(args.currentVersion),
                patch: parsedPatch.data,
                actor: String(args.actor ?? "unknown"),
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

            // Dispatcher: use the caller-supplied one when provided (live
            // runner expects PORT_WRITTEN so stage guards can advance). Fall
            // back to inert for external / debugging callers where no actor
            // is listening.
            const dispatcher: EventDispatcher =
              options.writePortDispatcher ?? { send: () => { /* inert */ } };
            const runtime = new PortRuntime(db, dispatcher);
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
              dispatcher?.send({
                type: "GATE_ANSWERED",
                gateId: result.gateId,
                stageName: result.stageName,
                answer: result.answer,
                targetStage: result.targetStage,
              });
            }
            return jsonResponse(result);
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
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
