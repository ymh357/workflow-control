// Phase 4 / A4 — Debug query core. Pure functions over the
// execution_records table, shared by the __debug__ MCP and the
// `debug` CLI. Callers are responsible for presenting the JSON
// result (agent reads it directly; CLI prints it).
//
// None of these functions throw on "not found" — they return a
// shape with empty arrays / null fields and a `found: false` flag
// so both MCP and CLI can return a uniform JSON envelope.

import { getDb } from "./db.js";
import type {
  AgentStreamEvent,
  DecisionRecord,
  ExecutionRecord,
  PromptBlob,
  ScratchPadSnapshot,
  ToolCallRecord,
} from "./execution-record/types.js";

// ---------------------------------------------------------------------------
// Row -> ExecutionRecord reconstruction
// ---------------------------------------------------------------------------

interface ExecutionRecordRow {
  attempt_id: string;
  task_id: string;
  stage_name: string;
  attempt_index: number;
  pipeline_version_hash: string | null;
  workflow_control_version: string | null;
  started_at: string;
  terminated_at: string | null;
  termination_reason: string | null;
  engine: string;
  model: string | null;
  session_id: string | null;
  prompt_blob: string;
  reads_snapshot: string;
  tool_calls: string;
  agent_stream: string;
  decisions: string;
  writes_parsed: string | null;
  writes_committed: string | null;
  worktree_diff: string | null;
  worktree_diff_truncated: number;
  scratch_pad_snapshot: string | null;
  cost_usd: number | null;
  token_input: number | null;
  token_output: number | null;
  duration_ms: number | null;
  last_heartbeat_at: string;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToRecord(row: ExecutionRecordRow): ExecutionRecord {
  return {
    attemptId: row.attempt_id,
    taskId: row.task_id,
    stageName: row.stage_name,
    attemptIndex: row.attempt_index,
    pipelineVersionHash: row.pipeline_version_hash,
    workflowControlVersion: row.workflow_control_version,
    startedAt: row.started_at,
    terminatedAt: row.terminated_at,
    terminationReason: (row.termination_reason ?? null) as ExecutionRecord["terminationReason"],
    engine: row.engine as ExecutionRecord["engine"],
    model: row.model,
    sessionId: row.session_id,
    promptBlob: safeJsonParse<PromptBlob>(row.prompt_blob, {
      tier1: "",
      systemPromptFull: "",
      stagePrompt: "",
      invariants: [],
      fragments: [],
      outputSchema: null,
    }),
    readsSnapshot: safeJsonParse<Record<string, unknown>>(row.reads_snapshot, {}),
    toolCalls: safeJsonParse<ToolCallRecord[]>(row.tool_calls, []),
    agentStream: safeJsonParse<AgentStreamEvent[]>(row.agent_stream, []),
    decisions: safeJsonParse<DecisionRecord[]>(row.decisions, []),
    writesParsed: row.writes_parsed
      ? safeJsonParse<Record<string, unknown>>(row.writes_parsed, {})
      : null,
    writesCommitted: row.writes_committed
      ? safeJsonParse<Record<string, unknown>>(row.writes_committed, {})
      : null,
    worktreeDiff: row.worktree_diff,
    worktreeDiffTruncated: !!row.worktree_diff_truncated,
    scratchPadSnapshot: row.scratch_pad_snapshot
      ? safeJsonParse<ScratchPadSnapshot>(row.scratch_pad_snapshot, {
          openingNote: null,
          finalNote: null,
          precompactEvents: [],
        })
      : null,
    costUsd: row.cost_usd,
    tokenInput: row.token_input,
    tokenOutput: row.token_output,
    durationMs: row.duration_ms,
    lastHeartbeatAt: row.last_heartbeat_at,
  };
}

// ---------------------------------------------------------------------------
// 4.1 analyzeTaskFailure
// ---------------------------------------------------------------------------

export interface StageSummary {
  stageName: string;
  attempts: number;
  lastAttemptIndex: number;
  lastTerminationReason: string | null;
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
    | "exceeded_retries"
    | "interrupted"
    | "no_writes"
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
  /** Stage names whose last attempt did NOT terminate naturally. */
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
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM execution_records
         WHERE task_id = ?
         ORDER BY stage_name, attempt_index`,
    )
    .all(taskId) as unknown as ExecutionRecordRow[];

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
          detail: `No execution_records rows found for task ${taskId}.`,
        },
      ],
    };
  }

  const byStage = new Map<string, ExecutionRecordRow[]>();
  for (const r of rows) {
    const arr = byStage.get(r.stage_name) ?? [];
    arr.push(r);
    byStage.set(r.stage_name, arr);
  }

  const stages: StageSummary[] = [];
  const hints: FailureHint[] = [];
  const failingStages: string[] = [];
  let totalCost = 0;
  let firstStartedAt: string | null = null;
  let lastHeartbeat: string | null = null;

  for (const [stageName, attempts] of byStage.entries()) {
    attempts.sort((a, b) => a.attempt_index - b.attempt_index);
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
      lastAttemptIndex: last.attempt_index,
      lastTerminationReason: last.termination_reason,
      lastTerminatedAt: last.terminated_at,
      lastDurationMs: last.duration_ms,
      totalCostUsd: stageCost,
      totalTokenInput: tokenIn,
      totalTokenOutput: tokenOut,
      isStuckOpen: last.terminated_at === null,
    };
    stages.push(summary);

    const stageFirstStart = attempts[0]!.started_at;
    if (!firstStartedAt || stageFirstStart < firstStartedAt) {
      firstStartedAt = stageFirstStart;
    }
    if (!lastHeartbeat || last.last_heartbeat_at > lastHeartbeat) {
      lastHeartbeat = last.last_heartbeat_at;
    }

    // Hints — ordered by severity.
    if (summary.isStuckOpen) {
      failingStages.push(stageName);
      hints.push({
        kind: "stuck_open",
        stageName,
        attemptId: last.attempt_id,
        detail: `Last attempt (index ${last.attempt_index}) is still open. ` +
          `Last heartbeat: ${last.last_heartbeat_at}. ` +
          `Either the stage is genuinely running or the writer died — see reapOrphanedRecords.`,
      });
      continue;
    }

    const reason = last.termination_reason ?? "";
    if (reason === "error_exceeded_retries") {
      failingStages.push(stageName);
      hints.push({
        kind: "exceeded_retries",
        stageName,
        attemptId: last.attempt_id,
        detail: `Stage exhausted its retry budget after ${attempts.length} attempt(s).`,
      });
      const streamErr = scanStreamForError(
        safeJsonParse<AgentStreamEvent[]>(last.agent_stream, []),
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
    if (
      reason === "interrupted_by_user" ||
      reason === "interrupted_by_hot_update" ||
      reason === "superseded_by_retry" ||
      reason === "superseded_by_hot_update"
    ) {
      failingStages.push(stageName);
      hints.push({
        kind: "interrupted",
        stageName,
        attemptId: last.attempt_id,
        detail: `Last attempt was interrupted: ${reason}. ` +
          `Look for a later attempt (may be in a different stage) that followed this one.`,
      });
      continue;
    }

    // Natural completion but no writes — usually means the agent replied
    // text without emitting the expected JSON, which a writer-less stage
    // can't distinguish from success.
    if (reason === "natural_completion") {
      const writesCommitted = last.writes_committed
        ? safeJsonParse<Record<string, unknown>>(last.writes_committed, {})
        : null;
      if (
        writesCommitted === null ||
        (writesCommitted && Object.keys(writesCommitted).length === 0)
      ) {
        hints.push({
          kind: "no_writes",
          stageName,
          attemptId: last.attempt_id,
          detail: `Stage terminated naturally but committed no writes. ` +
            `Check prompt_blob.outputSchema and the agent_stream tail for the actual reply.`,
        });
      }
    }
  }

  return {
    taskId,
    found: true,
    totalAttempts: rows.length,
    totalCostUsd: Number(totalCost.toFixed(6)),
    firstStartedAt,
    lastHeartbeatAt: lastHeartbeat,
    stages,
    failingStages,
    hints,
  };
}

// ---------------------------------------------------------------------------
// 4.2 getStageExecutionRecord
// ---------------------------------------------------------------------------

export interface GetStageRecordOptions {
  /** If omitted, the latest attempt (highest attempt_index) is returned. */
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
  const db = getDb();
  const indices = (
    db
      .prepare(
        `SELECT attempt_index FROM execution_records
           WHERE task_id = ? AND stage_name = ?
           ORDER BY attempt_index`,
      )
      .all(taskId, stageName) as Array<{ attempt_index: number }>
  ).map((r) => r.attempt_index);

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
      `SELECT * FROM execution_records
         WHERE task_id = ? AND stage_name = ? AND attempt_index = ?`,
    )
    .get(taskId, stageName, wantedAttempt) as unknown as
    | ExecutionRecordRow
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
    promptBlob: ScalarDiff[];
    readsSnapshot: KeyDiff;
    writesCommitted: KeyDiff;
    decisions: DecisionDiff;
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

interface KeyDiff {
  onlyInA: string[];
  onlyInB: string[];
  changed: Array<{ key: string; aPreview: string; bPreview: string }>;
  unchanged: string[];
}

interface DecisionDiff {
  aCount: number;
  bCount: number;
  /** decisions present in A whose (context,chosen) pair doesn't appear in B. */
  onlyInA: Array<{ context: string; chosen: string }>;
  onlyInB: Array<{ context: string; chosen: string }>;
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

function diffKeyedObjects(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): KeyDiff {
  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const changed: Array<{ key: string; aPreview: string; bPreview: string }> = [];
  const unchanged: string[] = [];
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const inA = Object.prototype.hasOwnProperty.call(a, key);
    const inB = Object.prototype.hasOwnProperty.call(b, key);
    if (inA && !inB) {
      onlyInA.push(key);
      continue;
    }
    if (!inA && inB) {
      onlyInB.push(key);
      continue;
    }
    const aVal = a[key];
    const bVal = b[key];
    const aJson = stableStringify(aVal);
    const bJson = stableStringify(bVal);
    if (aJson === bJson) {
      unchanged.push(key);
    } else {
      changed.push({
        key,
        aPreview: previewValue(aVal),
        bPreview: previewValue(bVal),
      });
    }
  }
  return { onlyInA, onlyInB, changed, unchanged };
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map((x) => stableStringify(x)).join(",") + "]";
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

function diffPromptBlob(a: PromptBlob, b: PromptBlob): ScalarDiff[] {
  const out: ScalarDiff[] = [];
  const scalarFields: Array<keyof PromptBlob> = [
    "tier1",
    "systemPromptFull",
    "stagePrompt",
  ];
  for (const field of scalarFields) {
    const aVal = a[field] ?? "";
    const bVal = b[field] ?? "";
    if (aVal !== bVal) {
      out.push({
        field: `promptBlob.${String(field)}`,
        a: typeof aVal === "string" && aVal.length > 200 ? aVal.slice(0, 200) + "…" : (aVal as string),
        b: typeof bVal === "string" && bVal.length > 200 ? bVal.slice(0, 200) + "…" : (bVal as string),
      });
    }
  }
  const aInv = (a.invariants ?? []).join("|");
  const bInv = (b.invariants ?? []).join("|");
  if (aInv !== bInv) {
    out.push({
      field: "promptBlob.invariants",
      a: previewValue(a.invariants),
      b: previewValue(b.invariants),
    });
  }
  const aFrag = (a.fragments ?? []).map((f) => `${f.id}@${f.contentHash}`).sort().join("|");
  const bFrag = (b.fragments ?? []).map((f) => `${f.id}@${f.contentHash}`).sort().join("|");
  if (aFrag !== bFrag) {
    out.push({
      field: "promptBlob.fragments",
      a: previewValue(a.fragments),
      b: previewValue(b.fragments),
    });
  }
  if (stableStringify(a.outputSchema) !== stableStringify(b.outputSchema)) {
    out.push({
      field: "promptBlob.outputSchema",
      a: previewValue(a.outputSchema),
      b: previewValue(b.outputSchema),
    });
  }
  return out;
}

function diffDecisions(
  a: DecisionRecord[],
  b: DecisionRecord[],
): DecisionDiff {
  const keyOf = (d: DecisionRecord) => `${d.context}::${d.chosen}`;
  const aKeys = new Set(a.map(keyOf));
  const bKeys = new Set(b.map(keyOf));
  const onlyInA = a
    .filter((d) => !bKeys.has(keyOf(d)))
    .map((d) => ({ context: d.context, chosen: d.chosen }));
  const onlyInB = b
    .filter((d) => !aKeys.has(keyOf(d)))
    .map((d) => ({ context: d.context, chosen: d.chosen }));
  return {
    aCount: a.length,
    bCount: b.length,
    onlyInA,
    onlyInB,
  };
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
  const row = getDb()
    .prepare("SELECT * FROM execution_records WHERE attempt_id = ?")
    .get(attemptId) as unknown as ExecutionRecordRow | undefined;
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

  const promptBlob = diffPromptBlob(a.promptBlob, b.promptBlob);
  const readsSnapshot = diffKeyedObjects(a.readsSnapshot, b.readsSnapshot);
  const writesCommitted = diffKeyedObjects(
    a.writesCommitted ?? {},
    b.writesCommitted ?? {},
  );
  const decisions = diffDecisions(a.decisions, b.decisions);
  const toolCalls = diffToolCalls(a.toolCalls, b.toolCalls);
  const termination: ScalarDiff[] = [];
  if (a.terminationReason !== b.terminationReason) {
    termination.push({
      field: "terminationReason",
      a: a.terminationReason,
      b: b.terminationReason,
    });
  }
  if (a.engine !== b.engine) {
    termination.push({ field: "engine", a: a.engine, b: b.engine });
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
    promptBlob.length === 0 &&
    readsSnapshot.changed.length === 0 &&
    readsSnapshot.onlyInA.length === 0 &&
    readsSnapshot.onlyInB.length === 0 &&
    writesCommitted.changed.length === 0 &&
    writesCommitted.onlyInA.length === 0 &&
    writesCommitted.onlyInB.length === 0 &&
    decisions.onlyInA.length === 0 &&
    decisions.onlyInB.length === 0 &&
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
      promptBlob,
      readsSnapshot,
      writesCommitted,
      decisions,
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
