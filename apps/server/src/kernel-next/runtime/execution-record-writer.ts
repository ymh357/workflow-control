// kernel-next agent execution sidecar writer. See spec §5.
// Buffered append-only appender over agent_execution_details.
// Never throws into the executor; on any DB failure, logs + returns
// a degraded writer.

import type { DatabaseSync } from "node:sqlite";
import { logger } from "../../lib/logger.js";
import type {
  AgentStreamEvent,
  CloseWriterInput,
  OpenWriterInput,
  ToolCallRecord,
} from "./execution-record-types.js";

const FLUSH_DEBOUNCE_MS = 1_000;

export interface ExecutionRecordWriter {
  readonly attemptId: string;
  appendToolCall(call: ToolCallRecord): void;
  completeToolCall(id: string, patch: Partial<ToolCallRecord>): void;
  appendAgentStream(event: AgentStreamEvent): void;
  updateCost(patch: { costUsd?: number | null; tokenInput?: number | null; tokenOutput?: number | null }): void;
  updateSessionId(sessionId: string | null): void;
  heartbeat(): void;
  close(input: CloseWriterInput): void;
  __flushForTests(): void;
}

class NoopWriter implements ExecutionRecordWriter {
  constructor(public readonly attemptId: string) {}
  appendToolCall(): void {}
  completeToolCall(): void {}
  appendAgentStream(): void {}
  updateCost(): void {}
  updateSessionId(): void {}
  heartbeat(): void {}
  close(): void {}
  __flushForTests(): void {}
}

class ActiveWriter implements ExecutionRecordWriter {
  readonly attemptId: string;
  private readonly db: DatabaseSync;
  private readonly startedAt: number;
  private toolCalls: ToolCallRecord[] = [];
  private agentStream: AgentStreamEvent[] = [];
  private costUsd: number | null = null;
  private tokenInput: number | null = null;
  private tokenOutput: number | null = null;
  private sessionId: string | null = null;
  private pendingFlush: NodeJS.Timeout | null = null;
  private closed = false;
  private dirtyAppend = false;
  private dirtyMeta = false;

  constructor(db: DatabaseSync, attemptId: string, startedAt: number) {
    this.db = db;
    this.attemptId = attemptId;
    this.startedAt = startedAt;
  }

  appendToolCall(call: ToolCallRecord): void {
    if (this.closed) return;
    this.toolCalls.push(call);
    this.dirtyAppend = true;
    this.scheduleFlush();
  }

  completeToolCall(id: string, patch: Partial<ToolCallRecord>): void {
    if (this.closed) return;
    for (const c of this.toolCalls) {
      if (c.id === id) {
        Object.assign(c, patch);
        this.dirtyAppend = true;
        this.scheduleFlush();
        return;
      }
    }
  }

  appendAgentStream(event: AgentStreamEvent): void {
    if (this.closed) return;
    this.agentStream.push(event);
    this.dirtyAppend = true;
    this.scheduleFlush();
  }

  updateCost(patch: { costUsd?: number | null; tokenInput?: number | null; tokenOutput?: number | null }): void {
    if (this.closed) return;
    if (patch.costUsd !== undefined) this.costUsd = patch.costUsd;
    if (patch.tokenInput !== undefined) this.tokenInput = patch.tokenInput;
    if (patch.tokenOutput !== undefined) this.tokenOutput = patch.tokenOutput;
    this.dirtyMeta = true;
    this.scheduleFlush();
  }

  updateSessionId(sessionId: string | null): void {
    if (this.closed) return;
    this.sessionId = sessionId;
    this.dirtyMeta = true;
    this.scheduleFlush();
  }

  heartbeat(): void {
    if (this.closed) return;
    this.flushNow();
  }

  close(input: CloseWriterInput): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
    if (input.costUsd !== undefined) this.costUsd = input.costUsd;
    if (input.tokenInput !== undefined) this.tokenInput = input.tokenInput;
    if (input.tokenOutput !== undefined) this.tokenOutput = input.tokenOutput;
    if (input.sessionId !== undefined) this.sessionId = input.sessionId;
    const endedAt = Date.now();
    try {
      this.db.prepare(
        `UPDATE agent_execution_details
         SET tool_calls_json = ?, agent_stream_json = ?,
             cost_usd = ?, token_input = ?, token_output = ?, session_id = ?,
             ended_at = ?, termination_reason = ?, duration_ms = ?,
             last_heartbeat_at = ?
         WHERE attempt_id = ?`,
      ).run(
        JSON.stringify(this.toolCalls),
        JSON.stringify(this.agentStream),
        this.costUsd,
        this.tokenInput,
        this.tokenOutput,
        this.sessionId,
        endedAt,
        input.terminationReason,
        endedAt - this.startedAt,
        endedAt,
        this.attemptId,
      );
    } catch (err) {
      logger.error(
        { attemptId: this.attemptId, err: (err as Error).message },
        "[execution-record-writer] close failed",
      );
    }
  }

  __flushForTests(): void {
    this.flushNow();
  }

  private scheduleFlush(): void {
    if (this.pendingFlush || this.closed) return;
    this.pendingFlush = setTimeout(() => {
      this.pendingFlush = null;
      this.flushNow();
    }, FLUSH_DEBOUNCE_MS);
  }

  private flushNow(): void {
    if (this.closed) return;
    const now = Date.now();
    try {
      this.db.prepare(
        `UPDATE agent_execution_details
         SET tool_calls_json = ?, agent_stream_json = ?,
             cost_usd = ?, token_input = ?, token_output = ?, session_id = ?,
             last_heartbeat_at = ?
         WHERE attempt_id = ?`,
      ).run(
        JSON.stringify(this.toolCalls),
        JSON.stringify(this.agentStream),
        this.costUsd,
        this.tokenInput,
        this.tokenOutput,
        this.sessionId,
        now,
        this.attemptId,
      );
      this.dirtyAppend = false;
      this.dirtyMeta = false;
    } catch (err) {
      logger.error(
        { attemptId: this.attemptId, err: (err as Error).message },
        "[execution-record-writer] flush failed",
      );
    }
  }
}

export function openExecutionRecordWriter(
  db: DatabaseSync,
  input: OpenWriterInput,
): ExecutionRecordWriter {
  const startedAt = Date.now();
  try {
    db.prepare(
      `INSERT INTO agent_execution_details
       (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
        sub_agents_json, started_at, last_heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.attemptId,
      input.promptRef,
      input.promptContentHash,
      input.promptContent,
      input.model,
      input.subAgents && input.subAgents.length > 0 ? JSON.stringify(input.subAgents) : null,
      startedAt,
      startedAt,
    );
    return new ActiveWriter(db, input.attemptId, startedAt);
  } catch (err) {
    logger.warn(
      { attemptId: input.attemptId, err: (err as Error).message },
      "[execution-record-writer] open failed; falling back to no-op writer",
    );
    return new NoopWriter(input.attemptId);
  }
}
