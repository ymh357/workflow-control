// Phase 4 / A4 — Debug query core, kernel-next edition.
//
// Reads `stage_attempts` LEFT JOIN `agent_execution_details` from
// kernel-next.db. One row per agent-stage attempt (non-agent stages
// like gate/script appear in stage_attempts but lack an AED row).
//
// Shared by the `__debug__` MCP and the `debug` CLI. Callers present
// the JSON result (agent consumes it directly; CLI prints it).
//
// None of these functions throw on "not found" — they return a shape
// with empty arrays / null fields and a `found: false` flag so both
// MCP and CLI can return a uniform JSON envelope.

import { getKernelNextDb } from "./kernel-next-db.js";
import type {
  AgentStreamEvent,
  TerminationReason,
  ToolCallRecord,
} from "../kernel-next/runtime/execution-record-types.js";

// ---------------------------------------------------------------------------
// Row shape + ExecutionRecord reconstruction
// ---------------------------------------------------------------------------

type StageAttemptStatus = "running" | "success" | "error" | "superseded";

interface JoinedRow {
  // stage_attempts columns
  attempt_id: string;
  task_id: string;
  version_hash: string;
  stage_name: string;
  attempt_idx: number;
  sa_started_at: number;
  sa_ended_at: number | null;
  status: StageAttemptStatus;
  kind: string;
  // agent_execution_details columns (nullable due to LEFT JOIN)
  prompt_ref: string | null;
  prompt_content_hash: string | null;
  prompt_content: string | null;
  model: string | null;
  sub_agents_json: string | null;
  tool_calls_json: string | null;
  agent_stream_json: string | null;
  cost_usd: number | null;
  token_input: number | null;
  token_output: number | null;
  session_id: string | null;
  duration_ms: number | null;
  aed_started_at: number | null;
  aed_ended_at: number | null;
  termination_reason: TerminationReason | null;
  last_heartbeat_at: number | null;
}

const JOIN_SELECT = `
  SELECT sa.attempt_id, sa.task_id, sa.version_hash, sa.stage_name, sa.attempt_idx,
         sa.started_at AS sa_started_at, sa.ended_at AS sa_ended_at, sa.status, sa.kind,
         aed.prompt_ref, aed.prompt_content_hash, aed.prompt_content, aed.model,
         aed.sub_agents_json, aed.tool_calls_json, aed.agent_stream_json,
         aed.cost_usd, aed.token_input, aed.token_output, aed.session_id, aed.duration_ms,
         aed.started_at AS aed_started_at, aed.ended_at AS aed_ended_at,
         aed.termination_reason, aed.last_heartbeat_at
    FROM stage_attempts sa
    LEFT JOIN agent_execution_details aed ON aed.attempt_id = sa.attempt_id
`;

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toIso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

/**
 * Reconstructed execution record, kernel-next edition. Compared to the
 * legacy shape, these fields are intentionally absent because the
 * kernel-next storage layer does not capture them:
 *   - promptBlob (complex tier1/fragments/outputSchema structure)
 *   - readsSnapshot / writesParsed / writesCommitted (derivable from port_values)
 *   - worktreeDiff / worktreeDiffTruncated (requires checkpoint infra)
 *   - scratchPadSnapshot (legacy single-session concept)
 *   - decisions (agent_log MCP retired)
 *   - workflowControlVersion / engine (kernel-next is Claude-only)
 *
 * What remains is what the sidecar row actually stores: the resolved
 * prompt text, the tool calls, the agent stream, the cost/tokens, and
 * the lifecycle metadata.
 */
export interface ExecutionRecord {
  attemptId: string;
  taskId: string;
  stageName: string;
  /** 1-based in kernel-next (stage_attempts.attempt_idx). */
  attemptIndex: number;
  pipelineVersionHash: string | null;
  startedAt: string;
  terminatedAt: string | null;
  terminationReason: TerminationReason | null;
  status: StageAttemptStatus;
  model: string | null;
  sessionId: string | null;
  /** Reference name of the prompt (AgentStage.config.promptRef). */
  promptRef: string | null;
  /** Hash of the resolved prompt content (FK to prompt_contents). */
  promptContentHash: string | null;
  /** Fully-resolved prompt text as the agent saw it. */
  promptContent: string | null;
  subAgents: unknown[] | null;
  toolCalls: ToolCallRecord[];
  agentStream: AgentStreamEvent[];
  costUsd: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  durationMs: number | null;
  lastHeartbeatAt: string | null;
}

function rowToRecord(row: JoinedRow): ExecutionRecord {
  return {
    attemptId: row.attempt_id,
    taskId: row.task_id,
    stageName: row.stage_name,
    attemptIndex: row.attempt_idx,
    pipelineVersionHash: row.version_hash,
    startedAt: toIso(row.sa_started_at) ?? new Date(0).toISOString(),
    terminatedAt: toIso(row.sa_ended_at),
    terminationReason: row.termination_reason,
    status: row.status,
    model: row.model,
    sessionId: row.session_id,
    promptRef: row.prompt_ref,
    promptContentHash: row.prompt_content_hash,
    promptContent: row.prompt_content,
    subAgents: row.sub_agents_json
      ? safeJsonParse<unknown[]>(row.sub_agents_json, [])
      : null,
    toolCalls: safeJsonParse<ToolCallRecord[]>(row.tool_calls_json, []),
    agentStream: safeJsonParse<AgentStreamEvent[]>(row.agent_stream_json, []),
    costUsd: row.cost_usd,
    tokenInput: row.token_input,
    tokenOutput: row.token_output,
    durationMs: row.duration_ms,
    lastHeartbeatAt: toIso(row.last_heartbeat_at),
  };
}

// ---------------------------------------------------------------------------
// 4.1 analyzeTaskFailure
// ---------------------------------------------------------------------------

export interface StageSummary {
  stageName: string;
  attempts: number;
  lastAttemptIndex: number;
  lastStatus: StageAttemptStatus;
  lastTerminationReason: TerminationReason | null;
  lastTerminatedAt: string | null;
  lastDurationMs: number | null;
  totalCostUsd: number;
  totalTokenInput: number;
  totalTokenOutput: number;
  isStuckOpen: boolean;
}

export interface FailureHint {
  kind:
    | "stuck_open"
    | "error_status"
    | "interrupted"
    | "superseded"
    | "error_in_stream"
    | "zero_attempts";
  stageName: string;
  attemptId?: string;
  detail: string;
}

export interface TaskFailureReport {
  taskId: string;
  found: boolean;
  totalAttempts: number;
  totalCostUsd: number;
  firstStartedAt: string | null;
  lastHeartbeatAt: string | null;
  stages: StageSummary[];
  /** Stage names whose last attempt did NOT complete successfully. */
  failingStages: string[];
  hints: FailureHint[];
}

const ERROR_MARKERS = [
  "error:",
  "failed",
  "traceback",
  "exception",
  "cannot",
  "unable to",
];

function scanStreamForError(
  stream: AgentStreamEvent[],
): string | null {
  // Scan from the tail: errors typically surface near the end.
  for (let i = stream.length - 1; i >= 0 && i >= stream.length - 30; i--) {
    const text = stream[i]?.text ?? "";
    const lower = text.toLowerCase();
    if (ERROR_MARKERS.some((m) => lower.includes(m))) {
      const snippet = text.length > 240 ? text.slice(0, 240) + "…" : text;
      return snippet;
    }
  }
  return null;
}

export function analyzeTaskFailure(taskId: string): TaskFailureReport {
  const db = getKernelNextDb();
  const rows = db
    .prepare(
      `${JOIN_SELECT}
         WHERE sa.task_id = ?
         ORDER BY sa.stage_name, sa.attempt_idx`,
    )
    .all(taskId) as unknown as JoinedRow[];

  if (rows.length === 0) {
    return {
      taskId,
      found: false,
      totalAttempts: 0,
      totalCostUsd: 0,
      firstStartedAt: null,
      lastHeartbeatAt: null,
      stages: [],
      failingStages: [],
      hints: [
        {
          kind: "zero_attempts",
          stageName: "",
          detail: `No stage_attempts rows found for task ${taskId}.`,
        },
      ],
    };
  }

  const byStage = new Map<string, JoinedRow[]>();
  for (const r of rows) {
    const arr = byStage.get(r.stage_name) ?? [];
    arr.push(r);
    byStage.set(r.stage_name, arr);
  }

  const stages: StageSummary[] = [];
  const hints: FailureHint[] = [];
  const failingStages: string[] = [];
  let totalCost = 0;
  let firstStartedAt: number | null = null;
  let lastHeartbeat: number | null = null;

  for (const [stageName, attempts] of byStage.entries()) {
    attempts.sort((a, b) => a.attempt_idx - b.attempt_idx);
    const last = attempts[attempts.length - 1]!;

    const stageCost = attempts.reduce(
      (acc, r) => acc + (r.cost_usd ?? 0),
      0,
    );
    const tokenIn = attempts.reduce(
      (acc, r) => acc + (r.token_input ?? 0),
      0,
    );
    const tokenOut = attempts.reduce(
      (acc, r) => acc + (r.token_output ?? 0),
      0,
    );
    totalCost += stageCost;

    const summary: StageSummary = {
      stageName,
      attempts: attempts.length,
      lastAttemptIndex: last.attempt_idx,
      lastStatus: last.status,
      lastTerminationReason: last.termination_reason,
      lastTerminatedAt: toIso(last.sa_ended_at),
      lastDurationMs: last.duration_ms,
      totalCostUsd: stageCost,
      totalTokenInput: tokenIn,
      totalTokenOutput: tokenOut,
      // stage_attempts.status='running' AND ended_at IS NULL — genuinely open.
      isStuckOpen: last.status === "running" && last.sa_ended_at === null,
    };
    stages.push(summary);

    const stageFirstStart = attempts[0]!.sa_started_at;
    if (firstStartedAt === null || stageFirstStart < firstStartedAt) {
      firstStartedAt = stageFirstStart;
    }
    const stageLastHeartbeat = last.last_heartbeat_at ?? last.sa_ended_at ?? last.sa_started_at;
    if (lastHeartbeat === null || stageLastHeartbeat > lastHeartbeat) {
      lastHeartbeat = stageLastHeartbeat;
    }

    // Hints — ordered by severity.
    if (summary.isStuckOpen) {
      failingStages.push(stageName);
      hints.push({
        kind: "stuck_open",
        stageName,
        attemptId: last.attempt_id,
        detail: `Last attempt (idx ${last.attempt_idx}) is still running. ` +
          `Last heartbeat: ${toIso(last.last_heartbeat_at) ?? "n/a"}. ` +
          `Either the stage is genuinely running or the writer died.`,
      });
      continue;
    }

    if (last.status === "error") {
      failingStages.push(stageName);
      hints.push({
        kind: "error_status",
        stageName,
        attemptId: last.attempt_id,
        detail: `Stage ended with status=error after ${attempts.length} attempt(s).` +
          (last.termination_reason ? ` termination_reason=${last.termination_reason}.` : ""),
      });
      const streamErr = scanStreamForError(
        safeJsonParse<AgentStreamEvent[]>(last.agent_stream_json, []),
      );
      if (streamErr) {
        hints.push({
          kind: "error_in_stream",
          stageName,
          attemptId: last.attempt_id,
          detail: `Last agent stream snippet looks error-shaped: "${streamErr}"`,
        });
      }
      continue;
    }

    if (last.status === "superseded") {
      failingStages.push(stageName);
      hints.push({
        kind: "superseded",
        stageName,
        attemptId: last.attempt_id,
        detail: `Last attempt was superseded (retry / hot-update). ` +
          `Look for a later attempt_idx for the real outcome.`,
      });
      continue;
    }

    // termination_reason may still indicate an interrupt that ended up as
    // 'success' in stage_attempts (rare — include for completeness).
    if (last.termination_reason === "interrupted") {
      hints.push({
        kind: "interrupted",
        stageName,
        attemptId: last.attempt_id,
        detail: `Last attempt was interrupted mid-stream but marked success.`,
      });
    }
  }

  return {
    taskId,
    found: true,
    totalAttempts: rows.length,
    totalCostUsd: Number(totalCost.toFixed(6)),
    firstStartedAt: toIso(firstStartedAt),
    lastHeartbeatAt: toIso(lastHeartbeat),
    stages,
    failingStages,
    hints,
  };
}

// ---------------------------------------------------------------------------
// 4.5 listTaskRecords
// ---------------------------------------------------------------------------
//
// Returns a lightweight index of every attempt for a task — no prompt
// content, no agent_stream, no tool_calls. Use when you need to pick an
// attemptId to feed into get_stage_execution_record or diff_executions
// without pulling the full payloads.

export interface TaskRecordEntry {
  attemptId: string;
  stageName: string;
  attemptIndex: number;
  startedAt: string;
  terminatedAt: string | null;
  status: StageAttemptStatus;
  terminationReason: TerminationReason | null;
  model: string | null;
  pipelineVersionHash: string;
  costUsd: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  durationMs: number | null;
  isOpen: boolean;
}

export interface ListTaskRecordsResult {
  taskId: string;
  found: boolean;
  total: number;
  records: TaskRecordEntry[];
}

export function listTaskRecords(taskId: string): ListTaskRecordsResult {
  const rows = getKernelNextDb()
    .prepare(
      `SELECT sa.attempt_id, sa.stage_name, sa.attempt_idx,
              sa.started_at AS sa_started_at, sa.ended_at AS sa_ended_at,
              sa.status, sa.version_hash,
              aed.model, aed.termination_reason,
              aed.cost_usd, aed.token_input, aed.token_output, aed.duration_ms
         FROM stage_attempts sa
         LEFT JOIN agent_execution_details aed ON aed.attempt_id = sa.attempt_id
        WHERE sa.task_id = ?
        ORDER BY sa.started_at, sa.stage_name, sa.attempt_idx`,
    )
    .all(taskId) as unknown as Array<{
      attempt_id: string;
      stage_name: string;
      attempt_idx: number;
      sa_started_at: number;
      sa_ended_at: number | null;
      status: StageAttemptStatus;
      version_hash: string;
      model: string | null;
      termination_reason: TerminationReason | null;
      cost_usd: number | null;
      token_input: number | null;
      token_output: number | null;
      duration_ms: number | null;
    }>;

  const records: TaskRecordEntry[] = rows.map((r) => ({
    attemptId: r.attempt_id,
    stageName: r.stage_name,
    attemptIndex: r.attempt_idx,
    startedAt: toIso(r.sa_started_at) ?? new Date(0).toISOString(),
    terminatedAt: toIso(r.sa_ended_at),
    status: r.status,
    terminationReason: r.termination_reason,
    model: r.model,
    pipelineVersionHash: r.version_hash,
    costUsd: r.cost_usd,
    tokenInput: r.token_input,
    tokenOutput: r.token_output,
    durationMs: r.duration_ms,
    isOpen: r.status === "running" && r.sa_ended_at === null,
  }));

  return {
    taskId,
    found: rows.length > 0,
    total: rows.length,
    records,
  };
}

// ---------------------------------------------------------------------------
// 4.2 getStageExecutionRecord
// ---------------------------------------------------------------------------

export interface GetStageRecordOptions {
  /** If omitted, the latest attempt (highest attempt_idx) is returned. */
  attempt?: number;
}

export interface GetStageRecordResult {
  taskId: string;
  stageName: string;
  attempt: number | null;
  found: boolean;
  record: ExecutionRecord | null;
  /**
   * Attempt indices available for this task/stage. Empty if found=false.
   * Useful so the caller can retry with a specific attempt.
   */
  availableAttempts: number[];
}

export function getStageExecutionRecord(
  taskId: string,
  stageName: string,
  options: GetStageRecordOptions = {},
): GetStageRecordResult {
  const db = getKernelNextDb();
  const indices = (
    db
      .prepare(
        `SELECT attempt_idx FROM stage_attempts
           WHERE task_id = ? AND stage_name = ?
           ORDER BY attempt_idx`,
      )
      .all(taskId, stageName) as Array<{ attempt_idx: number }>
  ).map((r) => r.attempt_idx);

  if (indices.length === 0) {
    return {
      taskId,
      stageName,
      attempt: options.attempt ?? null,
      found: false,
      record: null,
      availableAttempts: [],
    };
  }

  const wantedAttempt =
    options.attempt !== undefined
      ? options.attempt
      : indices[indices.length - 1]!;

  if (!indices.includes(wantedAttempt)) {
    return {
      taskId,
      stageName,
      attempt: wantedAttempt,
      found: false,
      record: null,
      availableAttempts: indices,
    };
  }

  const row = db
    .prepare(
      `${JOIN_SELECT}
         WHERE sa.task_id = ? AND sa.stage_name = ? AND sa.attempt_idx = ?`,
    )
    .get(taskId, stageName, wantedAttempt) as unknown as
    | JoinedRow
    | undefined;

  if (!row) {
    return {
      taskId,
      stageName,
      attempt: wantedAttempt,
      found: false,
      record: null,
      availableAttempts: indices,
    };
  }

  return {
    taskId,
    stageName,
    attempt: wantedAttempt,
    found: true,
    record: rowToRecord(row),
    availableAttempts: indices,
  };
}

// ---------------------------------------------------------------------------
// 4.3 diffExecutions
// ---------------------------------------------------------------------------

export interface ExecutionDiffResult {
  found: boolean;
  missing: string[];
  a: { attemptId: string; taskId: string; stageName: string; attemptIndex: number } | null;
  b: { attemptId: string; taskId: string; stageName: string; attemptIndex: number } | null;
  identical: boolean;
  differences: {
    prompt: ScalarDiff[];
    toolCalls: ToolCallDiff;
    termination: ScalarDiff[];
    cost: { a: number | null; b: number | null; deltaUsd: number | null };
    tokens: {
      a: { input: number | null; output: number | null };
      b: { input: number | null; output: number | null };
    };
    durationMs: { a: number | null; b: number | null; deltaMs: number | null };
  } | null;
}

interface ScalarDiff {
  field: string;
  a: string | number | boolean | null;
  b: string | number | boolean | null;
}

interface ToolCallDiff {
  aCount: number;
  bCount: number;
  countByName: {
    onlyInA: Record<string, number>;
    onlyInB: Record<string, number>;
    shared: Record<string, { a: number; b: number }>;
  };
}

function previewValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v.length > 120 ? v.slice(0, 120) + "…" : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  } catch {
    return String(v);
  }
}

function diffToolCalls(a: ToolCallRecord[], b: ToolCallRecord[]): ToolCallDiff {
  const countByName = (list: ToolCallRecord[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const c of list) out[c.name] = (out[c.name] ?? 0) + 1;
    return out;
  };
  const aCounts = countByName(a);
  const bCounts = countByName(b);
  const onlyInA: Record<string, number> = {};
  const onlyInB: Record<string, number> = {};
  const shared: Record<string, { a: number; b: number }> = {};
  const names = new Set<string>([...Object.keys(aCounts), ...Object.keys(bCounts)]);
  for (const name of names) {
    const aN = aCounts[name] ?? 0;
    const bN = bCounts[name] ?? 0;
    if (aN > 0 && bN === 0) onlyInA[name] = aN;
    else if (aN === 0 && bN > 0) onlyInB[name] = bN;
    else shared[name] = { a: aN, b: bN };
  }
  return {
    aCount: a.length,
    bCount: b.length,
    countByName: { onlyInA, onlyInB, shared },
  };
}

function findRecordByAttemptId(attemptId: string): ExecutionRecord | null {
  const row = getKernelNextDb()
    .prepare(`${JOIN_SELECT} WHERE sa.attempt_id = ?`)
    .get(attemptId) as unknown as JoinedRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function diffExecutions(
  attemptIdA: string,
  attemptIdB: string,
): ExecutionDiffResult {
  const a = findRecordByAttemptId(attemptIdA);
  const b = findRecordByAttemptId(attemptIdB);
  const missing: string[] = [];
  if (!a) missing.push(attemptIdA);
  if (!b) missing.push(attemptIdB);
  if (!a || !b) {
    return {
      found: false,
      missing,
      a: a
        ? {
            attemptId: a.attemptId,
            taskId: a.taskId,
            stageName: a.stageName,
            attemptIndex: a.attemptIndex,
          }
        : null,
      b: b
        ? {
            attemptId: b.attemptId,
            taskId: b.taskId,
            stageName: b.stageName,
            attemptIndex: b.attemptIndex,
          }
        : null,
      identical: false,
      differences: null,
    };
  }

  const prompt: ScalarDiff[] = [];
  if ((a.promptRef ?? null) !== (b.promptRef ?? null)) {
    prompt.push({ field: "promptRef", a: a.promptRef, b: b.promptRef });
  }
  if ((a.promptContentHash ?? null) !== (b.promptContentHash ?? null)) {
    prompt.push({
      field: "promptContentHash",
      a: a.promptContentHash,
      b: b.promptContentHash,
    });
  }
  if ((a.promptContent ?? "") !== (b.promptContent ?? "")) {
    prompt.push({
      field: "promptContent",
      a: previewValue(a.promptContent),
      b: previewValue(b.promptContent),
    });
  }

  const toolCalls = diffToolCalls(a.toolCalls, b.toolCalls);
  const termination: ScalarDiff[] = [];
  if (a.terminationReason !== b.terminationReason) {
    termination.push({
      field: "terminationReason",
      a: a.terminationReason,
      b: b.terminationReason,
    });
  }
  if (a.status !== b.status) {
    termination.push({ field: "status", a: a.status, b: b.status });
  }
  if (a.model !== b.model) {
    termination.push({ field: "model", a: a.model, b: b.model });
  }
  if (a.pipelineVersionHash !== b.pipelineVersionHash) {
    termination.push({
      field: "pipelineVersionHash",
      a: a.pipelineVersionHash,
      b: b.pipelineVersionHash,
    });
  }

  const sharedToolCallsMismatch = Object.values(
    toolCalls.countByName.shared,
  ).some((v) => v.a !== v.b);
  const identical =
    prompt.length === 0 &&
    Object.keys(toolCalls.countByName.onlyInA).length === 0 &&
    Object.keys(toolCalls.countByName.onlyInB).length === 0 &&
    !sharedToolCallsMismatch &&
    termination.length === 0;

  return {
    found: true,
    missing: [],
    a: {
      attemptId: a.attemptId,
      taskId: a.taskId,
      stageName: a.stageName,
      attemptIndex: a.attemptIndex,
    },
    b: {
      attemptId: b.attemptId,
      taskId: b.taskId,
      stageName: b.stageName,
      attemptIndex: b.attemptIndex,
    },
    identical,
    differences: {
      prompt,
      toolCalls,
      termination,
      cost: {
        a: a.costUsd,
        b: b.costUsd,
        deltaUsd:
          a.costUsd !== null && b.costUsd !== null
            ? Number((b.costUsd - a.costUsd).toFixed(6))
            : null,
      },
      tokens: {
        a: { input: a.tokenInput, output: a.tokenOutput },
        b: { input: b.tokenInput, output: b.tokenOutput },
      },
      durationMs: {
        a: a.durationMs,
        b: b.durationMs,
        deltaMs:
          a.durationMs !== null && b.durationMs !== null
            ? b.durationMs - a.durationMs
            : null,
      },
    },
  };
}
