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

/**
 * T1.5 — Structured decision log entry. Agents call `record_decision`
 * on the `__agent_log__` MCP when they make a choice that affects
 * downstream stages. Unlike scratch-pad notes (free-form observations),
 * decisions have mandatory structure so A4 debug tools can reason over
 * them without NLP.
 */
export interface DecisionRecord {
  /** ISO timestamp when the decision was recorded. */
  timestamp: string;
  /** Brief one-line context the decision was made in. */
  context: string;
  /** Options the agent considered. Must include the chosen one. */
  optionsConsidered: string[];
  /** The option the agent picked. Should match one of optionsConsidered. */
  chosen: string;
  /** Free-form reasoning explaining WHY chosen over the alternatives. */
  reasoning: string;
}

export interface ExecutionRecord {
  attemptId: string;
  taskId: string;
  stageName: string;
  attemptIndex: number;
  pipelineVersionHash: string | null;
  /**
   * T1.2 — workflow-control software version at attempt open.
   * pipelineVersionHash covers config; this covers the code that
   * interprets config. Format: "0.0.1+abc1234" | "0.0.1" | "unknown".
   */
  workflowControlVersion: string | null;

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
  /** T1.5 — structured decisions recorded via the __agent_log__ MCP. */
  decisions: DecisionRecord[];

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
