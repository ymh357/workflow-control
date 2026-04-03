import type { AgentResult } from "../agent/query-tracker.js";
import type { AgentRuntimeConfig } from "../lib/config-loader.js";
import type { WorkflowContext } from "../machine/types.js";
import { sseManager } from "../sse/manager.js";
import { createSlot } from "./registry.js";

const DEFAULT_EDGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export async function runEdgeAgent(
  taskId: string,
  input: {
    stageName: string;
    runtime: AgentRuntimeConfig;
    context?: WorkflowContext;
    worktreePath: string;
    tier1Context: string;
    enabledSteps?: string[];
    attempt: number;
    resumeInfo?: { sessionId: string; feedback?: string; sync?: boolean };
  },
): Promise<AgentResult> {
  const timeoutMs = DEFAULT_EDGE_TIMEOUT_MS;

  sseManager.pushMessage(taskId, {
    type: "status",
    taskId,
    timestamp: new Date().toISOString(),
    data: {
      status: input.stageName,
      message: `Waiting for edge agent to claim stage "${input.stageName}" via MCP`,
    },
  });

  return createSlot(taskId, input.stageName, timeoutMs);
}
