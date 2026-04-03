// Unified agent executor interface for Claude and Gemini engines.
// Both engines produce an AgentQuery (AsyncIterable of messages)
// which is consumed by processAgentStream.

import type { AgentQuery, AgentResult } from "./query-tracker.js";

export interface AgentExecutorInput {
  taskId: string;
  stageName: string;
  prompt: string;
  systemPrompt: string;
  cwd?: string;
  resumeSessionId?: string;
  mcpServers?: Record<string, unknown>;
}

export interface AgentExecutor {
  readonly engine: "claude" | "gemini";
  createQuery(input: AgentExecutorInput): AgentQuery;
}
