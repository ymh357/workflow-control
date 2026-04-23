// REST route for full agent_execution_details of a single attempt (P7.3 / D25).
//
// GET /api/kernel/attempts/:attemptId/details
//
// Returns the rich execution record captured by the kernel-next executor:
// tool calls, agent stream events (text + thinking), compact events, usage
// (cost + tokens), session id, and a status timeline derived from
// stage_attempts (started_at -> ended_at + status). Consumed by the
// per-attempt detail dashboard page.
//
// Column layout follows agent_execution_details as defined in
// kernel-next/ir/sql.ts. Notable mappings:
//   tool_calls_json      -> toolCalls
//   agent_stream_json    -> agentStream   (contains both "text" and
//                                           "thinking" event types)
//   compact_events_json  -> compactEvents (context-compaction timeline)
//
// There is no `thinking_blocks_json` or `status_history_json` column —
// thinking lives inside agent_stream_json and the status timeline is
// derived from stage_attempts.

import { Hono } from "hono";
import { getKernelNextDb } from "../lib/kernel-next-db.js";

export interface AttemptDetailsPayload {
  toolCalls: unknown[];
  agentStream: unknown[];
  compactEvents: unknown[];
  subAgents: unknown[];
  statusHistory: Array<{
    status: string;
    startedAt: number;
    endedAt: number | null;
  }>;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  sessionId: string | null;
  model: string | null;
  durationMs: number | null;
  startedAt: number | null;
  endedAt: number | null;
  terminationReason: string | null;
}

export const kernelAttemptDetailsRoute = new Hono();

kernelAttemptDetailsRoute.get("/kernel/attempts/:attemptId/details", (c) => {
  const attemptId = c.req.param("attemptId");
  const db = getKernelNextDb();

  const row = db
    .prepare(
      `SELECT tool_calls_json,
              agent_stream_json,
              compact_events_json,
              sub_agents_json,
              cost_usd,
              token_input,
              token_output,
              session_id,
              model,
              duration_ms,
              started_at,
              ended_at,
              termination_reason
         FROM agent_execution_details
        WHERE attempt_id = ?`,
    )
    .get(attemptId) as
    | {
        tool_calls_json: string | null;
        agent_stream_json: string | null;
        compact_events_json: string | null;
        sub_agents_json: string | null;
        cost_usd: number | null;
        token_input: number | null;
        token_output: number | null;
        session_id: string | null;
        model: string | null;
        duration_ms: number | null;
        started_at: number | null;
        ended_at: number | null;
        termination_reason: string | null;
      }
    | undefined;

  if (!row) {
    return c.json(
      {
        ok: false,
        diagnostics: [
          { code: "ATTEMPT_NOT_FOUND", message: attemptId },
        ],
      },
      404,
    );
  }

  // stage_attempts is the source of truth for the status timeline.
  // The row may not exist (e.g. the attempt was seeded without a
  // parent stage_attempts row in a partial test fixture); in that case
  // emit an empty history rather than fabricating one from
  // agent_execution_details.started_at alone.
  const stageRow = db
    .prepare(
      `SELECT status, started_at, ended_at
         FROM stage_attempts
        WHERE attempt_id = ?`,
    )
    .get(attemptId) as
    | { status: string; started_at: number; ended_at: number | null }
    | undefined;

  const statusHistory: AttemptDetailsPayload["statusHistory"] = stageRow
    ? [
        {
          status: stageRow.status,
          startedAt: stageRow.started_at,
          endedAt: stageRow.ended_at,
        },
      ]
    : [];

  return c.json({
    ok: true,
    details: {
      toolCalls: safeParseArray(row.tool_calls_json),
      agentStream: safeParseArray(row.agent_stream_json),
      compactEvents: safeParseArray(row.compact_events_json),
      subAgents: safeParseArray(row.sub_agents_json),
      statusHistory,
      costUsd: row.cost_usd,
      inputTokens: row.token_input,
      outputTokens: row.token_output,
      sessionId: row.session_id,
      model: row.model,
      durationMs: row.duration_ms,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      terminationReason: row.termination_reason,
    } satisfies AttemptDetailsPayload,
  });
});

// Tolerant JSON array parser. The column uses DEFAULT '[]' so the
// common case is a valid array literal, but NULL is still possible for
// sub_agents_json (no DEFAULT), and a corrupted write would be worse
// than an empty list for a read-only debug view.
const safeParseArray = (s: string | null): unknown[] => {
  if (s === null || s === "") return [];
  try {
    const parsed = JSON.parse(s) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
