// Phase 1 / A1 — ExecutionRecordWriter. See docs/execution-record-design.md.
//
// Responsibilities:
//   1. Open a record row at stage start.
//   2. Buffer chatty append-only fields (tool_calls, agent_stream) and
//      flush at most once per second, on close, or on heartbeat.
//   3. Emit periodic heartbeats so the orphan reaper can tell real work
//      apart from server crashes.
//   4. Close the row with terminal fields set in one UPDATE.
//
// The feature flag `ENABLE_EXECUTION_RECORD` is read once per process
// at first use. When false, `create()` returns a no-op writer with the
// same shape so call sites can be flag-agnostic.

import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { logger } from "../logger.js";
import type {
  AgentStreamEvent,
  CloseRecordInput,
  DecisionRecord,
  OpenRecordInput,
  PrecompactEvent,
  ToolCallRecord,
} from "./types.js";
import { getWorkflowControlVersion } from "./workflow-version.js";

const FLUSH_INTERVAL_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 10_000;

function isEnabled(): boolean {
  return process.env.ENABLE_EXECUTION_RECORD === "true";
}

export interface ExecutionRecordWriter {
  readonly attemptId: string;
  readonly isNoop: boolean;
  appendToolCall(call: ToolCallRecord): void;
  completeToolCall(id: string, patch: Partial<ToolCallRecord>): void;
  appendAgentStream(event: AgentStreamEvent): void;
  recordPrecompact(event: PrecompactEvent): void;
  /** T1.5 — append a structured decision. Buffered with 1Hz flush. */
  recordDecision(decision: DecisionRecord): void;
  updateCost(patch: {
    costUsd?: number | null;
    tokenInput?: number | null;
    tokenOutput?: number | null;
  }): void;
  updateSessionId(sessionId: string | null): void;
  heartbeat(): void;
  close(input: CloseRecordInput): void;
  /** Test-only: force any pending buffered appends to commit now. */
  __flushForTests(): void;
}

class NoopWriter implements ExecutionRecordWriter {
  readonly attemptId: string;
  readonly isNoop = true;
  constructor(attemptId: string) {
    this.attemptId = attemptId;
  }
  appendToolCall(): void {}
  completeToolCall(): void {}
  appendAgentStream(): void {}
  recordPrecompact(): void {}
  recordDecision(): void {}
  updateCost(): void {}
  updateSessionId(): void {}
  heartbeat(): void {}
  close(): void {}
  __flushForTests(): void {}
}

interface WriterState {
  attemptId: string;
  toolCalls: ToolCallRecord[];
  agentStream: AgentStreamEvent[];
  precompactEvents: PrecompactEvent[];
  decisions: DecisionRecord[];
  dirtyToolCalls: boolean;
  dirtyAgentStream: boolean;
  dirtyPrecompact: boolean;
  dirtyDecisions: boolean;
  costUsd: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  sessionId: string | null;
  costDirty: boolean;
  sessionDirty: boolean;
  closed: boolean;
  flushTimer: ReturnType<typeof setInterval> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

class SqliteWriter implements ExecutionRecordWriter {
  readonly attemptId: string;
  readonly isNoop = false;
  private state: WriterState;

  constructor(attemptId: string) {
    this.attemptId = attemptId;
    this.state = {
      attemptId,
      toolCalls: [],
      agentStream: [],
      precompactEvents: [],
      decisions: [],
      dirtyToolCalls: false,
      dirtyAgentStream: false,
      dirtyPrecompact: false,
      dirtyDecisions: false,
      costUsd: null,
      tokenInput: null,
      tokenOutput: null,
      sessionId: null,
      costDirty: false,
      sessionDirty: false,
      closed: false,
      flushTimer: null,
      heartbeatTimer: null,
    };
    this.state.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.state.flushTimer.unref?.();
    this.state.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      HEARTBEAT_INTERVAL_MS,
    );
    this.state.heartbeatTimer.unref?.();
  }

  appendToolCall(call: ToolCallRecord): void {
    if (this.state.closed) return;
    this.state.toolCalls.push(call);
    this.state.dirtyToolCalls = true;
  }

  completeToolCall(id: string, patch: Partial<ToolCallRecord>): void {
    if (this.state.closed) return;
    const existing = this.state.toolCalls.find((t) => t.id === id);
    if (!existing) return;
    Object.assign(existing, patch);
    this.state.dirtyToolCalls = true;
  }

  appendAgentStream(event: AgentStreamEvent): void {
    if (this.state.closed) return;
    this.state.agentStream.push(event);
    this.state.dirtyAgentStream = true;
  }

  recordPrecompact(event: PrecompactEvent): void {
    if (this.state.closed) return;
    this.state.precompactEvents.push(event);
    this.state.dirtyPrecompact = true;
  }

  recordDecision(decision: DecisionRecord): void {
    if (this.state.closed) return;
    this.state.decisions.push(decision);
    this.state.dirtyDecisions = true;
  }

  updateCost(patch: {
    costUsd?: number | null;
    tokenInput?: number | null;
    tokenOutput?: number | null;
  }): void {
    if (this.state.closed) return;
    if (patch.costUsd !== undefined) this.state.costUsd = patch.costUsd;
    if (patch.tokenInput !== undefined) this.state.tokenInput = patch.tokenInput;
    if (patch.tokenOutput !== undefined)
      this.state.tokenOutput = patch.tokenOutput;
    this.state.costDirty = true;
  }

  updateSessionId(sessionId: string | null): void {
    if (this.state.closed) return;
    if (this.state.sessionId === sessionId) return;
    this.state.sessionId = sessionId;
    this.state.sessionDirty = true;
  }

  heartbeat(): void {
    if (this.state.closed) return;
    this.flush();
    try {
      getDb()
        .prepare(
          "UPDATE execution_records SET last_heartbeat_at = ? WHERE attempt_id = ?",
        )
        .run(new Date().toISOString(), this.state.attemptId);
    } catch (err) {
      logger.warn(
        { err, attemptId: this.state.attemptId },
        "ExecutionRecordWriter: heartbeat failed",
      );
    }
  }

  __flushForTests(): void {
    this.flush();
  }

  private flush(): void {
    const needsFlush =
      this.state.dirtyToolCalls ||
      this.state.dirtyAgentStream ||
      this.state.dirtyPrecompact ||
      this.state.dirtyDecisions ||
      this.state.costDirty ||
      this.state.sessionDirty;
    if (!needsFlush) return;

    try {
      const db = getDb();
      const parts: string[] = [];
      const values: Array<string | number | null> = [];

      if (this.state.dirtyToolCalls) {
        parts.push("tool_calls = ?");
        values.push(JSON.stringify(this.state.toolCalls));
      }
      if (this.state.dirtyAgentStream) {
        parts.push("agent_stream = ?");
        values.push(JSON.stringify(this.state.agentStream));
      }
      if (this.state.dirtyPrecompact) {
        // Precompact events live inside scratch_pad_snapshot, which is
        // otherwise owned by close(). We merge only the precompactEvents
        // field on flush; opening/final notes arrive at close.
        parts.push(
          "scratch_pad_snapshot = json_set(" +
            "COALESCE(scratch_pad_snapshot, json('{\"openingNote\":null,\"finalNote\":null,\"precompactEvents\":[]}'))," +
            " '$.precompactEvents', json(?))",
        );
        values.push(JSON.stringify(this.state.precompactEvents));
      }
      if (this.state.dirtyDecisions) {
        parts.push("decisions = ?");
        values.push(JSON.stringify(this.state.decisions));
      }
      if (this.state.costDirty) {
        parts.push("cost_usd = ?");
        values.push(this.state.costUsd);
        parts.push("token_input = ?");
        values.push(this.state.tokenInput);
        parts.push("token_output = ?");
        values.push(this.state.tokenOutput);
      }
      if (this.state.sessionDirty) {
        parts.push("session_id = ?");
        values.push(this.state.sessionId);
      }

      if (parts.length === 0) return;
      values.push(this.state.attemptId);
      db.prepare(
        `UPDATE execution_records SET ${parts.join(", ")} WHERE attempt_id = ?`,
      ).run(...values);

      this.state.dirtyToolCalls = false;
      this.state.dirtyAgentStream = false;
      this.state.dirtyPrecompact = false;
      this.state.dirtyDecisions = false;
      this.state.costDirty = false;
      this.state.sessionDirty = false;
    } catch (err) {
      // Swallow — see design §6.
      logger.warn(
        { err, attemptId: this.state.attemptId },
        "ExecutionRecordWriter: flush failed",
      );
    }
  }

  close(input: CloseRecordInput): void {
    if (this.state.closed) return;
    this.state.closed = true;

    if (this.state.flushTimer) {
      clearInterval(this.state.flushTimer);
      this.state.flushTimer = null;
    }
    if (this.state.heartbeatTimer) {
      clearInterval(this.state.heartbeatTimer);
      this.state.heartbeatTimer = null;
    }

    // Apply any pending buffered appends first so we don't lose them.
    this.flush();

    const terminatedAt = input.terminatedAt ?? new Date().toISOString();
    const finalScratch = mergeScratchPad(
      this.state.precompactEvents,
      input.scratchPadSnapshot,
    );
    const finalCost =
      input.costUsd !== undefined ? input.costUsd : this.state.costUsd;
    const finalTokenIn =
      input.tokenInput !== undefined ? input.tokenInput : this.state.tokenInput;
    const finalTokenOut =
      input.tokenOutput !== undefined
        ? input.tokenOutput
        : this.state.tokenOutput;
    const finalSessionId =
      input.sessionId !== undefined ? input.sessionId : this.state.sessionId;

    try {
      getDb()
        .prepare(
          `UPDATE execution_records SET
             terminated_at = ?,
             termination_reason = ?,
             writes_parsed = ?,
             writes_committed = ?,
             worktree_diff = ?,
             worktree_diff_truncated = ?,
             scratch_pad_snapshot = ?,
             cost_usd = ?,
             token_input = ?,
             token_output = ?,
             duration_ms = ?,
             session_id = ?,
             last_heartbeat_at = ?
           WHERE attempt_id = ?`,
        )
        .run(
          terminatedAt,
          input.terminationReason,
          input.writesParsed !== undefined
            ? input.writesParsed === null
              ? null
              : JSON.stringify(input.writesParsed)
            : null,
          input.writesCommitted !== undefined
            ? input.writesCommitted === null
              ? null
              : JSON.stringify(input.writesCommitted)
            : null,
          input.worktreeDiff?.text ?? null,
          input.worktreeDiff?.truncated ? 1 : 0,
          finalScratch ? JSON.stringify(finalScratch) : null,
          finalCost ?? null,
          finalTokenIn ?? null,
          finalTokenOut ?? null,
          input.durationMs ?? null,
          finalSessionId ?? null,
          terminatedAt,
          this.state.attemptId,
        );
    } catch (err) {
      logger.warn(
        { err, attemptId: this.state.attemptId },
        "ExecutionRecordWriter: close failed",
      );
    }
  }
}

function mergeScratchPad(
  precompactEvents: PrecompactEvent[],
  closing: CloseRecordInput["scratchPadSnapshot"],
): { openingNote: string | null; finalNote: string | null; precompactEvents: PrecompactEvent[] } | null {
  if (precompactEvents.length === 0 && !closing) return null;
  return {
    openingNote: closing?.openingNote ?? null,
    finalNote: closing?.finalNote ?? null,
    precompactEvents: [
      ...precompactEvents,
      ...(closing?.precompactEvents ?? []),
    ],
  };
}

/**
 * Create an ExecutionRecordWriter. If the feature flag is off or the
 * INSERT fails, returns a no-op writer. The caller is always given an
 * object it can invoke freely — the writer never throws into the
 * calling stage.
 */
export function createExecutionRecordWriter(
  input: OpenRecordInput,
): ExecutionRecordWriter {
  const attemptId = input.attemptId ?? randomUUID();
  if (!isEnabled()) return new NoopWriter(attemptId);

  const startedAt = input.startedAt ?? new Date().toISOString();
  // T1.2 — capture software version at open time. Never throws (falls
  // back to "unknown" internally), so this cannot break open().
  const workflowControlVersion = getWorkflowControlVersion();
  try {
    getDb()
      .prepare(
        `INSERT INTO execution_records (
           attempt_id, task_id, stage_name, attempt_index,
           pipeline_version_hash, workflow_control_version,
           started_at, engine, model, session_id,
           prompt_blob, reads_snapshot, last_heartbeat_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attemptId,
        input.taskId,
        input.stageName,
        input.attemptIndex,
        input.pipelineVersionHash,
        workflowControlVersion,
        startedAt,
        input.engine,
        input.model,
        input.sessionId,
        JSON.stringify(input.promptBlob),
        JSON.stringify(input.readsSnapshot),
        startedAt,
      );
    return new SqliteWriter(attemptId);
  } catch (err) {
    logger.warn(
      { err, attemptId, taskId: input.taskId, stageName: input.stageName },
      "ExecutionRecordWriter: open failed, falling back to no-op",
    );
    return new NoopWriter(attemptId);
  }
}

/**
 * Finalize orphaned rows whose writers died without close(). Called on
 * server start and optionally on a schedule. Any row with
 * terminated_at IS NULL and a stale heartbeat is marked
 * error_exceeded_retries.
 */
export function reapOrphanedRecords(
  options: { staleAfterMs?: number } = {},
): number {
  if (!isEnabled()) return 0;
  const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  try {
    const result = getDb()
      .prepare(
        `UPDATE execution_records SET
           terminated_at = datetime('now'),
           termination_reason = 'error_exceeded_retries'
         WHERE terminated_at IS NULL AND last_heartbeat_at < ?`,
      )
      .run(cutoff);
    return result.changes as number;
  } catch (err) {
    logger.warn({ err }, "reapOrphanedRecords failed");
    return 0;
  }
}
