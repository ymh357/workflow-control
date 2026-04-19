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
}

export function createKernelMcp(db: DatabaseSync, options: KernelMcpOptions = {}) {
  const kernel = new KernelService(db, options);
  const maxBytesDefault = options.defaultMaxBytes ?? MAX_VALUE_BYTES_DEFAULT;

  return createSdkMcpServer({
    name: "__kernel_next__",
    version: "0.1.0",
    tools: [
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
    ],
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
