// kernel-next agent execution sidecar writer. See spec §5.
// Buffered append-only appender over agent_execution_details.
// Never throws into the executor; on any DB failure, logs + returns
// a degraded writer.

import type { DatabaseSync } from "node:sqlite";
import { logger } from "../../lib/logger.js";
import type {
  AgentStreamEvent,
  CloseWriterInput,
  CompactEvent,
  OpenWriterInput,
  ToolCallRecord,
} from "./execution-record-types.js";

const FLUSH_DEBOUNCE_MS = 1_000;

export interface ExecutionRecordWriter {
  readonly attemptId: string;
  /**
   * Bug 61 (c12+ review): true when the open INSERT failed and the
   * writer is the silent NoopWriter fallback. Callers that depend on
   * the AED row existing (SDK session resume looks up session_id;
   * cost reporting joins on attempt_id) MUST check this flag and
   * either decline the dependent operation or surface a diagnostic.
   * Pre-fix the NoopWriter was indistinguishable from ActiveWriter,
   * so subsequent updateSessionId / appendToolCall calls silently
   * no-op'd and the user only discovered the break when SDK resume
   * later failed with "no session id" or cost stayed at $0.
   */
  readonly degraded: boolean;
  appendToolCall(call: ToolCallRecord): void;
  completeToolCall(id: string, patch: Partial<ToolCallRecord>): void;
  appendAgentStream(event: AgentStreamEvent): void;
  /** Append a COMPACT_STARTED event to the sidecar. */
  appendCompactEvent(event: Omit<CompactEvent, "endedAt">): void;
  /** Fill the endedAt of the most recent still-open compact event. */
  completeCompactEvent(endedAt: string): void;
  updateCost(patch: { costUsd?: number | null; tokenInput?: number | null; tokenOutput?: number | null }): void;
  updateSessionId(sessionId: string | null): void;
  heartbeat(): void;
  close(input: CloseWriterInput): void;
  __flushForTests(): void;
}

class NoopWriter implements ExecutionRecordWriter {
  readonly degraded = true;
  constructor(public readonly attemptId: string) {}
  appendToolCall(): void {}
  completeToolCall(): void {}
  appendAgentStream(): void {}
  appendCompactEvent(): void {}
  completeCompactEvent(): void {}
  updateCost(): void {}
  updateSessionId(): void {}
  heartbeat(): void {}
  close(): void {}
  __flushForTests(): void {}
}

class ActiveWriter implements ExecutionRecordWriter {
  readonly attemptId: string;
  readonly degraded = false;
  private readonly db: DatabaseSync;
  private readonly startedAt: number;
  private toolCalls: ToolCallRecord[] = [];
  private agentStream: AgentStreamEvent[] = [];
  private compactEvents: CompactEvent[] = [];
  private costUsd: number | null = null;
  private tokenInput: number | null = null;
  private tokenOutput: number | null = null;
  private cacheReadInputTokens: number | null = null;
  private cacheCreationInputTokens: number | null = null;
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

  appendCompactEvent(event: Omit<CompactEvent, "endedAt">): void {
    if (this.closed) return;
    this.compactEvents.push({ ...event, endedAt: null });
    this.dirtyAppend = true;
    this.scheduleFlush();
  }

  completeCompactEvent(endedAt: string): void {
    if (this.closed) return;
    // Fill the endedAt of the most recent still-open event; silent no-op
    // when there is none (e.g., adapter emitted a synthetic COMPACT_ENDED
    // without a matching COMPACT_STARTED we tracked — defensive).
    for (let i = this.compactEvents.length - 1; i >= 0; i--) {
      if (this.compactEvents[i]!.endedAt === null) {
        this.compactEvents[i]!.endedAt = endedAt;
        this.dirtyAppend = true;
        this.scheduleFlush();
        return;
      }
    }
  }

  updateCost(patch: {
    costUsd?: number | null;
    tokenInput?: number | null;
    tokenOutput?: number | null;
    cacheReadInputTokens?: number | null;
    cacheCreationInputTokens?: number | null;
  }): void {
    if (this.closed) return;
    if (patch.costUsd !== undefined) this.costUsd = patch.costUsd;
    if (patch.tokenInput !== undefined) this.tokenInput = patch.tokenInput;
    if (patch.tokenOutput !== undefined) this.tokenOutput = patch.tokenOutput;
    if (patch.cacheReadInputTokens !== undefined) this.cacheReadInputTokens = patch.cacheReadInputTokens;
    if (patch.cacheCreationInputTokens !== undefined) this.cacheCreationInputTokens = patch.cacheCreationInputTokens;
    this.dirtyMeta = true;
    this.scheduleFlush();
  }

  updateSessionId(sessionId: string | null): void {
    if (this.closed) return;
    this.sessionId = sessionId;
    this.dirtyMeta = true;
    // M-R5: flush synchronously so a subsequent SIGKILL/crash cannot
    // lose the id. sessionId is the only piece of state that unlocks
    // SDK session resume; we pay one extra SQLite write per stage
    // attempt (once, at init) to make crash recovery actually work.
    this.flushNow();
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
    if (input.cacheReadInputTokens !== undefined) this.cacheReadInputTokens = input.cacheReadInputTokens;
    if (input.cacheCreationInputTokens !== undefined) this.cacheCreationInputTokens = input.cacheCreationInputTokens;
    if (input.sessionId !== undefined) this.sessionId = input.sessionId;
    const endedAt = Date.now();
    try {
      this.db.prepare(
        `UPDATE agent_execution_details
         SET tool_calls_json = ?, agent_stream_json = ?, compact_events_json = ?,
             cost_usd = ?, token_input = ?, token_output = ?,
             cache_read_input_tokens = ?, cache_creation_input_tokens = ?,
             session_id = ?,
             ended_at = ?, termination_reason = ?, duration_ms = ?,
             last_heartbeat_at = ?
         WHERE attempt_id = ?`,
      ).run(
        JSON.stringify(this.toolCalls),
        JSON.stringify(this.agentStream),
        JSON.stringify(this.compactEvents),
        this.costUsd,
        this.tokenInput,
        this.tokenOutput,
        this.cacheReadInputTokens,
        this.cacheCreationInputTokens,
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
         SET tool_calls_json = ?, agent_stream_json = ?, compact_events_json = ?,
             cost_usd = ?, token_input = ?, token_output = ?,
             cache_read_input_tokens = ?, cache_creation_input_tokens = ?,
             session_id = ?,
             last_heartbeat_at = ?
         WHERE attempt_id = ?`,
      ).run(
        JSON.stringify(this.toolCalls),
        JSON.stringify(this.agentStream),
        JSON.stringify(this.compactEvents),
        this.costUsd,
        this.tokenInput,
        this.tokenOutput,
        this.cacheReadInputTokens,
        this.cacheCreationInputTokens,
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
    // Bug 61 (c12+ review): elevated from warn -> error. The
    // NoopWriter fallback means SDK session resume + cost reporting
    // are silently disabled for this attempt — that's a real outage
    // dimension that operators must see. The returned writer carries
    // `degraded=true` so callers (real-executor) can also branch on
    // the failure rather than discovering it indirectly through a
    // missing session_id at resume time.
    logger.error(
      {
        attemptId: input.attemptId,
        err: (err as Error).message,
        stack: (err as Error).stack,
      },
      "[execution-record-writer] open failed; SDK resume + cost reporting disabled for this attempt",
    );
    return new NoopWriter(input.attemptId);
  }
}
