// Phase 1 / A1 — ExecutionRecord types. See docs/execution-record-design.md.

export type TerminationReason =
  | "natural_completion"
  | "interrupted_by_hot_update"
  | "interrupted_by_user"
  | "error_exceeded_retries"
  | "superseded_by_retry"
  | "superseded_by_hot_update";

export type EngineName = "claude" | "gemini" | "codex";

export interface PromptBlob {
  tier1: string;
  systemPromptFull: string;
  stagePrompt: string;
  invariants: string[];
  fragments: Array<{ id: string; contentHash: string }>;
  outputSchema: unknown | null;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
  tokenIn: number | null;
  tokenOut: number | null;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AgentStreamEvent {
  type: "text" | "thinking";
  text: string;
  timestamp: string;
}

export interface PrecompactEvent {
  tokensAtTrigger: number;
  tier1ReInjectedBytes: number;
  timestamp: string;
}

export interface ScratchPadSnapshot {
  openingNote: string | null;
  finalNote: string | null;
  precompactEvents: PrecompactEvent[];
}

export interface ExecutionRecord {
  attemptId: string;
  taskId: string;
  stageName: string;
  attemptIndex: number;
  pipelineVersionHash: string | null;

  startedAt: string;
  terminatedAt: string | null;
  terminationReason: TerminationReason | null;

  engine: EngineName;
  model: string | null;
  sessionId: string | null;

  promptBlob: PromptBlob;
  readsSnapshot: Record<string, unknown>;
  toolCalls: ToolCallRecord[];
  agentStream: AgentStreamEvent[];
  writesParsed: Record<string, unknown> | null;
  writesCommitted: Record<string, unknown> | null;
  worktreeDiff: string | null;
  worktreeDiffTruncated: boolean;
  scratchPadSnapshot: ScratchPadSnapshot | null;

  costUsd: number | null;
  tokenInput: number | null;
  tokenOutput: number | null;
  durationMs: number | null;

  lastHeartbeatAt: string;
}

/**
 * Input shape for `ExecutionRecordWriter.open()`.
 */
export interface OpenRecordInput {
  taskId: string;
  stageName: string;
  attemptIndex: number;
  pipelineVersionHash: string | null;
  engine: EngineName;
  model: string | null;
  sessionId: string | null;
  promptBlob: PromptBlob;
  readsSnapshot: Record<string, unknown>;
  /** Optional override for the ULID; default: generated. */
  attemptId?: string;
  /** Optional override for started_at; default: now. */
  startedAt?: string;
}

/**
 * Input shape for `ExecutionRecordWriter.close()`.
 */
export interface CloseRecordInput {
  terminationReason: TerminationReason;
  writesParsed?: Record<string, unknown> | null;
  writesCommitted?: Record<string, unknown> | null;
  worktreeDiff?: { text: string; truncated: boolean } | null;
  scratchPadSnapshot?: ScratchPadSnapshot | null;
  costUsd?: number | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
  durationMs?: number | null;
  sessionId?: string | null;
  /** Optional override for terminated_at; default: now. */
  terminatedAt?: string;
}
