// Port-domain MCP tools: read_port (external + combined) and write_port
// (internal + combined). These are the only kernel-next tools that touch
// port_values directly.

import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { PortRuntime } from "../../runtime/port-runtime.js";
import type { PipelineIR } from "../../ir/schema.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse, errorResponse } from "../tool-helpers.js";

export function buildPortsTools(deps: ToolsDeps): ToolDef[] {
  const { db, maxBytesDefault } = deps;

  return [
    {
      name: "read_port",
      description:
        "Read the latest value for a port, optionally scoped to a taskId " +
        "and attempt index. Truncates to maxBytes (default 64KB) and " +
        "returns { truncated: true, preview, totalBytes } when larger. " +
        "On miss (no row in port_values), returns { ok:false, error:'port not found' } " +
        "plus an optional `reason` when a taskId is supplied: " +
        "'port_not_declared' (stage or port name wrong for this pipeline version), " +
        "'no_attempt_yet' (stage hasn't been dispatched for this task), " +
        "or 'no_write_yet' (stage attempt exists but the agent hasn't written " +
        "that port — wait for the stage to finish or poll).",
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
            const reason = taskId
              ? classifyMissingPort(db, taskId, stage, port)
              : undefined;
            return jsonResponse(
              reason !== undefined
                ? { ok: false, error: "port not found", reason }
                : { ok: false, error: "port not found" },
            );
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
      name: "write_port",
      description:
        "Write a value to a declared output port for an in-flight stage " +
        "attempt. The (stage, port) pair must be declared as an `out` port " +
        "on the stage of the pipeline version associated with the attempt. " +
        "Dispatches PORT_WRITTEN via an inert dispatcher — this tool is " +
        "intended for authors / agents recording outputs, not for driving " +
        "the XState runner (the runner owns its own PortRuntime). " +
        "On failure the response includes `reason`: " +
        "'task_not_found' (taskId never seen — verify it), " +
        "'task_finalized' (task already ended; further writes refused — `taskFinalState` indicates completed/failed/cancelled), " +
        "'stage_advanced' (caller passed a stale attemptId — `latestActiveAttemptId` gives the active one, retry with it), " +
        "'no_attempt_for_stage' (task exists but stage hasn't been dispatched yet — wait), " +
        "'attempt_terminal' (this attempt finished; `attemptStatus` is success/error/superseded — `latestActiveAttemptId` if a replacement exists), " +
        "'task_mismatch' / 'stage_mismatch' (attemptId belongs to a different task/stage; `actualTaskId` / `actualStage` is in the response), " +
        "'stage_not_declared' / 'port_not_declared' (typo in stage or port name), " +
        "'external_sentinel' (stage='__external__' is reserved for the runner). " +
        "Always inspect `reason` and `latestActiveAttemptId` before retrying.",
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
              { reason: "external_sentinel" },
            );
          }

          // Bug 68 (dogfood 2026-04-30): bare 'attemptId not found' was
          // unactionable. Agents seeing it could not tell whether the
          // task was finalized, whether the stage had a different
          // active attempt, or whether the entire taskId was wrong —
          // so they fell back to building stand-alone reproducers.
          // The classifier returns the actionable next step.
          //
          // Also handles c12+ review P2#209: writes to a terminal
          // attempt (success/error/superseded) are now rejected,
          // not silently accepted.
          //
          // Resolve the pipeline version this attempt belongs to, so we can
          // validate that (stage, port) is declared as an output on that
          // specific version (not just any version in the DB).
          const attemptRow = db.prepare(
            `SELECT version_hash, task_id, stage_name, status
             FROM stage_attempts WHERE attempt_id = ?`,
          ).get(attemptId) as
            | { version_hash: string; task_id: string; stage_name: string; status: string }
            | undefined;
          if (!attemptRow) {
            const cls = classifyMissingAttempt(db, taskId, stage);
            const extra: Record<string, unknown> = { reason: cls.reason };
            if (cls.latestActiveAttemptId !== undefined) {
              extra.latestActiveAttemptId = cls.latestActiveAttemptId;
            }
            if (cls.taskFinalState !== undefined) {
              extra.taskFinalState = cls.taskFinalState;
            }
            return errorResponse(
              buildMissingAttemptMessage(attemptId, taskId, stage, cls),
              extra,
            );
          }
          if (attemptRow.task_id !== taskId) {
            return errorResponse(
              `attemptId '${attemptId}' belongs to task '${attemptRow.task_id}', not '${taskId}'`,
              { reason: "task_mismatch", actualTaskId: attemptRow.task_id },
            );
          }
          if (attemptRow.stage_name !== stage) {
            return errorResponse(
              `attemptId '${attemptId}' belongs to stage '${attemptRow.stage_name}', not '${stage}'`,
              { reason: "stage_mismatch", actualStage: attemptRow.stage_name },
            );
          }
          // c12+ review P2#209: writes to terminal attempts are
          // semantically wrong. The attempt that wrote port_values for
          // success/error/superseded states already finished; another
          // attempt may have superseded it. Accepting this write would
          // either re-fire onPortWritten for a stage already past, or
          // produce port_values rows that no downstream stage can
          // legitimately reference.
          if (attemptRow.status !== "running" && attemptRow.status !== "secret_pending") {
            const latest = latestActiveAttemptForStage(db, taskId, stage);
            return errorResponse(
              `attemptId '${attemptId}' is in terminal status '${attemptRow.status}'; ` +
                (latest
                  ? `the active attempt for stage '${stage}' is now '${latest}'. Use that attemptId.`
                  : `stage '${stage}' has no active attempt — the task may have advanced past it or finalized.`),
              latest !== undefined
                ? {
                    reason: "attempt_terminal",
                    attemptStatus: attemptRow.status,
                    latestActiveAttemptId: latest,
                  }
                : { reason: "attempt_terminal", attemptStatus: attemptRow.status },
            );
          }

          const versionRow = db.prepare(
            `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
          ).get(attemptRow.version_hash) as { ir_json: string } | undefined;
          if (!versionRow) {
            return errorResponse(
              `pipeline version '${attemptRow.version_hash}' not found for attempt`,
              { reason: "version_missing" },
            );
          }
          const ir = JSON.parse(versionRow.ir_json) as PipelineIR;
          const stageDef = ir.stages.find((s) => s.name === stage);
          if (!stageDef) {
            return errorResponse(
              `stage '${stage}' not declared in pipeline version`,
              { reason: "stage_not_declared" },
            );
          }
          if (!stageDef.outputs.some((p) => p.name === port)) {
            return errorResponse(
              `port '${port}' is not a declared output of stage '${stage}'`,
              { reason: "port_not_declared" },
            );
          }

          // Prefer the caller-supplied live PortRuntime so Slice 2's
          // onPortWritten hook fires on MCP-initiated writes too
          // (without this, real-executor runs produce zero SSE
          // port_written events). Fall back to constructing one here
          // for external callers that only pass a dispatcher.
          const runtime = deps.portRuntime ?? new PortRuntime(
            db,
            deps.writePortDispatcher ?? { send: () => { /* inert */ } },
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
  ];
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

type MissingPortReason = "port_not_declared" | "no_attempt_yet" | "no_write_yet";

/**
 * Distinguish the three failure modes a read_port miss can hide so that a
 * caller polling for live data stops conflating "you typed the port name
 * wrong" with "the stage hasn't written it yet". Returns undefined when the
 * task has no stage_attempts + no pipeline_versions to check (unresolvable);
 * the caller keeps the bare "port not found" error in that case.
 *
 * Implementation cost is two indexed SELECTs: one against stage_attempts to
 * pick a version, one against pipeline_versions to parse the IR. Both are
 * on-path for write_port already, so the cost profile is understood.
 */
function classifyMissingPort(
  db: DatabaseSync,
  taskId: string,
  stage: string,
  port: string,
): MissingPortReason | undefined {
  const attemptRow = db.prepare(
    `SELECT version_hash FROM stage_attempts
     WHERE task_id = ? AND stage_name = ?
     ORDER BY started_at DESC LIMIT 1`,
  ).get(taskId, stage) as { version_hash: string } | undefined;

  if (!attemptRow) {
    // No attempt for this stage. Could still be a typo, but without a
    // version_hash we can't check IR declaration. Pick the latest version
    // any attempt on this task ran under — if the task has *no* attempts
    // at all we genuinely can't classify and return undefined.
    const anyAttemptRow = db.prepare(
      `SELECT version_hash FROM stage_attempts
       WHERE task_id = ?
       ORDER BY started_at DESC LIMIT 1`,
    ).get(taskId) as { version_hash: string } | undefined;
    if (!anyAttemptRow) return undefined;
    const declared = isPortDeclared(db, anyAttemptRow.version_hash, stage, port);
    if (declared === false) return "port_not_declared";
    // declared === true: stage exists in the IR but hasn't started yet.
    // declared === undefined: version row missing (unexpected but possible) — fall through to no_attempt_yet.
    return "no_attempt_yet";
  }

  const declared = isPortDeclared(db, attemptRow.version_hash, stage, port);
  if (declared === false) return "port_not_declared";
  return "no_write_yet";
}

function isPortDeclared(
  db: DatabaseSync,
  versionHash: string,
  stage: string,
  port: string,
): boolean | undefined {
  const versionRow = db.prepare(
    `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
  ).get(versionHash) as { ir_json: string } | undefined;
  if (!versionRow) return undefined;
  try {
    const ir = JSON.parse(versionRow.ir_json) as PipelineIR;
    const stageDef = ir.stages.find((s) => s.name === stage);
    if (!stageDef) return false;
    return stageDef.outputs.some((p) => p.name === port);
  } catch {
    return undefined;
  }
}

// Bug 68 (dogfood 2026-04-30): structured classification of "attemptId
// not found in stage_attempts" so write_port can return an actionable
// next step. Returns the most specific reason that matches plus, when
// applicable, the active attemptId the caller should retry against.
type MissingAttemptReason =
  | "task_finalized"
  | "stage_advanced"
  | "task_not_found"
  | "no_attempt_for_stage"
  | "stale_or_typo";
interface MissingAttemptClassification {
  reason: MissingAttemptReason;
  latestActiveAttemptId?: string;
  taskFinalState?: string;
}

function classifyMissingAttempt(
  db: DatabaseSync,
  taskId: string,
  stage: string,
): MissingAttemptClassification {
  // 1. Task is fully finalized — task_finals row exists.
  const finalRow = db.prepare(
    `SELECT final_state FROM task_finals WHERE task_id = ?`,
  ).get(taskId) as { final_state: string } | undefined;
  if (finalRow) {
    return { reason: "task_finalized", taskFinalState: finalRow.final_state };
  }

  // 2. Stage has a current active attempt — caller passed a stale id.
  const active = latestActiveAttemptForStage(db, taskId, stage);
  if (active) {
    return { reason: "stage_advanced", latestActiveAttemptId: active };
  }

  // 3. Task exists somewhere — disambiguate "task never existed" from
  //    "task exists but this stage hasn't been dispatched".
  const anyAttemptRow = db.prepare(
    `SELECT 1 FROM stage_attempts WHERE task_id = ? LIMIT 1`,
  ).get(taskId) as { 1: number } | undefined;
  if (!anyAttemptRow) {
    // No stage_attempts and no task_finals — the kernel has never
    // seen this taskId. Could be a typo or a wholly fabricated id.
    return { reason: "task_not_found" };
  }
  return { reason: "no_attempt_for_stage" };
}

function latestActiveAttemptForStage(
  db: DatabaseSync,
  taskId: string,
  stage: string,
): string | undefined {
  // Active = status writers can legitimately target. 'superseded'
  // attempts are by construction not the live one; 'success'/'error'
  // are terminal. Match the same set the handler accepts.
  const row = db.prepare(
    `SELECT attempt_id FROM stage_attempts
     WHERE task_id = ? AND stage_name = ?
       AND status IN ('running','secret_pending')
     ORDER BY started_at DESC LIMIT 1`,
  ).get(taskId, stage) as { attempt_id: string } | undefined;
  return row?.attempt_id;
}

function buildMissingAttemptMessage(
  attemptId: string,
  taskId: string,
  stage: string,
  cls: MissingAttemptClassification,
): string {
  const head = `attemptId '${attemptId}' not found`;
  switch (cls.reason) {
    case "task_finalized":
      return (
        `${head}: task '${taskId}' is already finalized ` +
        `(${cls.taskFinalState ?? "unknown"}); no further writes are accepted.`
      );
    case "stage_advanced":
      return (
        `${head}: the active attempt for stage '${stage}' on task '${taskId}' ` +
        `is now '${cls.latestActiveAttemptId}'. Use that attemptId.`
      );
    case "task_not_found":
      return (
        `${head}: no stage_attempts or task_finals row exists for task '${taskId}'. ` +
        `Verify the taskId — the kernel has never seen it.`
      );
    case "no_attempt_for_stage":
      return (
        `${head}: task '${taskId}' exists but stage '${stage}' has no attempts yet. ` +
        `Wait for the stage to be dispatched, or verify the stage name.`
      );
    case "stale_or_typo":
    default:
      return `${head} (no matching row in stage_attempts).`;
  }
}
