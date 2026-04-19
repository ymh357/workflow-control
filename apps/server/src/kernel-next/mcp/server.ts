// Kernel-next MCP server.
//
// Exposes 6 tools to userland (pipeline-generator and future AI-driven
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
import { readLatestPort } from "../runtime/port-runtime.js";

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
              return jsonResponse({
                ok: true,
                truncated: true,
                preview: encoded.slice(0, maxBytes),
                totalBytes: bytes,
                valueId: row.attemptId,
                writtenAt: row.writtenAt,
                attemptId: row.attemptId,
              });
            }
            return jsonResponse({
              ok: true,
              truncated: false,
              value: row.value,
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
          "Return the latest write for a port plus all downstream reads. " +
          "valuePreview is capped to 200 bytes; use read_port for full value.",
        inputSchema: {
          stage: z.string(),
          port: z.string(),
          taskId: z.string().optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            return jsonResponse({
              ok: true,
              report: queryLineage(db, {
                stage: String(args.stage),
                port: String(args.port),
                taskId: typeof args.taskId === "string" ? args.taskId : undefined,
              }),
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
    ],
  });
}

// Helper for read_port when `attempt` is provided. readLatestPort in
// port-runtime.ts only returns the latest; this variant picks a specific one.
function readPortSpecific(
  db: DatabaseSync,
  stage: string,
  port: string,
  taskId: string | undefined,
  attemptIdx: number | undefined,
): { value: unknown; attemptId: string; writtenAt: number } | null {
  if (attemptIdx === undefined) {
    const r = readLatestPort(db, stage, port, taskId);
    return r ? { value: r.value, attemptId: r.attemptId, writtenAt: r.writtenAt } : null;
  }
  const row = taskId
    ? db.prepare(
        `SELECT pv.value_json, pv.attempt_id, pv.written_at
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
         WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
           AND sa.task_id = ? AND sa.attempt_idx = ?
         ORDER BY pv.written_at DESC LIMIT 1`,
      ).get(stage, port, taskId, attemptIdx)
    : db.prepare(
        `SELECT pv.value_json, pv.attempt_id, pv.written_at
         FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
         WHERE pv.stage_name = ? AND pv.port_name = ? AND pv.direction = 'out'
           AND sa.attempt_idx = ?
         ORDER BY pv.written_at DESC LIMIT 1`,
      ).get(stage, port, attemptIdx);
  if (!row) return null;
  const r = row as { value_json: string; attempt_id: string; written_at: number };
  return {
    value: JSON.parse(r.value_json),
    attemptId: r.attempt_id,
    writtenAt: r.written_at,
  };
}
