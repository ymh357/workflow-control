// Types for kernel-next agent execution sidecar.
// See docs/superpowers/specs/2026-04-24-execution-record-sidecar-design.md §5.1.

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

export type TerminationReason =
  | "natural_completion"
  | "interrupted"
  | "error"
  | "superseded";

export interface OpenWriterInput {
  attemptId: string;
  promptRef: string;
  promptContentHash: string;
  promptContent: string;
  model: string;
  subAgents?: unknown[] | null;
}

export interface CloseWriterInput {
  terminationReason: TerminationReason;
  costUsd?: number | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
  sessionId?: string | null;
}
