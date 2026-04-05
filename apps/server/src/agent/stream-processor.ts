import type { SSEMessage } from "../types/index.js";
import type { StageTokenUsage, ModelTokenUsage } from "@workflow-control/shared";
import { sseManager } from "../sse/manager.js";
import { taskLogger } from "../lib/logger.js";
import {
  type AgentResult,
  AgentError,
  registerQuery,
  unregisterQuery,
  getActiveQuery,
  consumePendingResume,
  hasPendingResume,
} from "./query-tracker.js";
import { persistSessionId } from "./session-persister.js";

function createSSEMessage(taskId: string, type: SSEMessage["type"], data: unknown): SSEMessage {
  return { type, taskId, timestamp: new Date().toISOString(), data };
}

const MAX_RESUME_DEPTH = 3;
const MAX_RESULT_TEXT = 5 * 1024 * 1024; // 5MB cap to prevent unbounded accumulation
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (large structured outputs need time to construct)

export async function processAgentStream(params: {
  taskId: string;
  stageName: string;
  agentQuery: any;
  resumeDepth: number;
  onResume: (opts: { sessionId: string; resumePrompt: string }) => Promise<AgentResult>;
}): Promise<AgentResult> {
  const { taskId, stageName, agentQuery, resumeDepth, onResume } = params;

  let resultText = "", sessionId: string | undefined, costUsd = 0, durationMs = 0;
  let tokenUsage: StageTokenUsage | undefined;
  let toolCallCount = 0;

  registerQuery(taskId, { query: agentQuery, stageName });
  let handledResume = false;
  let timedOut = false;

  // Inactivity timeout: close query if no messages for too long
  let inactivityTimer: ReturnType<typeof setTimeout> = undefined!;
  const resetInactivityTimer = () => {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      taskLogger(taskId, stageName).error(`Stage inactivity timeout (${INACTIVITY_TIMEOUT_MS / 60000}min) — closing query`);
      sseManager.pushMessage(taskId, createSSEMessage(taskId, "error", {
        error: `Stage "${stageName}" timed out after ${INACTIVITY_TIMEOUT_MS / 60000} minutes of inactivity. The agent process may be stuck.`,
      }));
      try { agentQuery.close(); } catch { /* already closed */ }
    }, INACTIVITY_TIMEOUT_MS);
  };
  resetInactivityTimer();

  try {
    for await (const message of agentQuery) {
      resetInactivityTimer();
      const msgSessionId = (message as Record<string, unknown>).session_id as string | undefined;
      if (msgSessionId && !sessionId) {
        sessionId = msgSessionId;
        const active = getActiveQuery(taskId);
        if (active) active.sessionId = sessionId;
        // Persist early so retry-on-error can resume this session
        await persistSessionId(taskId, stageName, sessionId);
      }

      switch (message.type) {
        case "assistant":
          for (const block of message.message.content) {
            if (block.type === "text" && block.text) {
              sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_text", { text: block.text }));
              if (resultText.length < MAX_RESULT_TEXT) {
                resultText += block.text;
              }
            }
            if (block.type === "thinking" && (block as any).thinking) {
              sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_thinking", {
                text: (block as any).thinking as string
              }));
            }
            if (block.type === "tool_use") {
              sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_tool_use", { toolName: block.name, input: block.input as Record<string, unknown> }));
              toolCallCount++;
              sseManager.pushMessage(taskId, createSSEMessage(taskId, "agent_progress", {
                toolCallCount, phase: "working"
              }));
            }
          }
          break;
        case "result": {
          const r = message as Record<string, unknown>;
          costUsd = (r.total_cost_usd as number) ?? 0;
          durationMs = (r.duration_ms as number) ?? 0;
          tokenUsage = extractTokenUsage(r);
          if (r.session_id) sessionId = r.session_id as string;
          const subtype = r.subtype as string | undefined;
          taskLogger(taskId, stageName).info({ subtype, sessionId: sessionId ?? "none", hasResult: !!r.result, hasStructured: !!r.structured_output }, "result message received");
          if (subtype === "error_max_structured_output_retries") {
            taskLogger(taskId, stageName).warn("structured output failed after retries, falling back to last text");
          } else if (subtype === "success") {
            if (r.structured_output) {
              resultText = JSON.stringify(r.structured_output);
            } else if (r.result) {
              resultText = r.result as string;
            }
          } else {
            const subtypeMessages: Record<string, string> = {
              error_max_budget_usd: "Budget limit reached for this stage",
              error_max_turns: "Max turns reached for this stage",
            };
            const errMsg = String(r.error_message ?? r.result ?? subtypeMessages[subtype ?? ""] ?? "unknown error");
            taskLogger(taskId, stageName).warn({ subtype, errorMessage: errMsg }, "agent query ended with non-success result");
            throw new AgentError(subtype ?? "error", errMsg);
          }
          break;
        }
        case "system": {
          const sysMsg = message as Record<string, unknown>;
          taskLogger(taskId, stageName).info({ subtype: sysMsg.subtype, data: sysMsg }, "system message");
          break;
        }
        default:
          taskLogger(taskId, stageName).debug({ type: (message as Record<string, unknown>).type }, "unhandled message type");
          break;
      }
    }
  } catch (err) {
    if (hasPendingResume(taskId) && sessionId) {
      if (resumeDepth >= MAX_RESUME_DEPTH) {
        throw new Error(`Max resume depth (${MAX_RESUME_DEPTH}) exceeded`);
      }
      const userMessage = consumePendingResume(taskId)!;
      handledResume = true;
      taskLogger(taskId, stageName).info({ sessionId }, "interrupted, resuming with user message");
      try {
        return await onResume({ sessionId, resumePrompt: userMessage });
      } catch (resumeErr) {
        unregisterQuery(taskId);
        throw resumeErr;
      }
    }
    taskLogger(taskId, stageName).error({ err }, "agent query threw");
    throw err;
  } finally {
    clearTimeout(inactivityTimer);
    if (!handledResume) {
      unregisterQuery(taskId);
    }
  }

  if (timedOut) {
    throw new Error(`Stage "${stageName}" timed out after ${INACTIVITY_TIMEOUT_MS / 60000} minutes of inactivity`);
  }

  // Check for pending resume after normal completion
  if (hasPendingResume(taskId) && sessionId) {
    if (resumeDepth >= MAX_RESUME_DEPTH) {
      throw new Error(`Max resume depth (${MAX_RESUME_DEPTH}) exceeded`);
    }
    const userMessage = consumePendingResume(taskId)!;
    taskLogger(taskId, stageName).info({ sessionId }, "stream ended with pending resume, resuming with user message");
    return onResume({ sessionId, resumePrompt: userMessage });
  }

  taskLogger(taskId, stageName).info({ costUsd: costUsd.toFixed(3), durationMs, sessionId: sessionId ?? "none", resultTextLength: resultText.length, tokenUsage: tokenUsage ? { input: tokenUsage.inputTokens, output: tokenUsage.outputTokens } : undefined }, "stage DONE");
  return { resultText, sessionId, costUsd, durationMs, tokenUsage };
}

function extractTokenUsage(r: Record<string, unknown>): StageTokenUsage | undefined {
  // Claude SDK: usage + modelUsage fields
  const usage = r.usage as Record<string, number> | undefined;
  // Gemini: stats object with token fields
  const stats = r.stats as Record<string, unknown> | undefined;
  // modelUsage from Claude SDK or models from Gemini stats
  const modelUsage = r.modelUsage as Record<string, Record<string, unknown>> | undefined;
  const geminiModels = stats?.models as Record<string, Record<string, unknown>> | undefined;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens: number | undefined;
  let modelBreakdown: ModelTokenUsage[] | undefined;

  if (usage) {
    // Claude SDK result message
    inputTokens = (usage.input_tokens ?? 0);
    outputTokens = (usage.output_tokens ?? 0);
    cacheReadTokens = (usage.cache_read_input_tokens ?? 0);
    cacheCreationTokens = usage.cache_creation_input_tokens || undefined;
  } else if (stats) {
    // Gemini CLI result message
    inputTokens = (stats.input_tokens as number) ?? 0;
    outputTokens = (stats.output_tokens as number) ?? 0;
    cacheReadTokens = (stats.cached as number) ?? 0;
  }

  // Build model breakdown from Claude modelUsage
  if (modelUsage && Object.keys(modelUsage).length > 0) {
    modelBreakdown = Object.entries(modelUsage).map(([modelName, mu]) => ({
      modelName,
      inputTokens: (mu.inputTokens as number) ?? 0,
      outputTokens: (mu.outputTokens as number) ?? 0,
      cacheReadTokens: (mu.cacheReadInputTokens as number) ?? 0,
      cacheCreationTokens: (mu.cacheCreationInputTokens as number) || undefined,
      totalTokens: ((mu.inputTokens as number) ?? 0) + ((mu.outputTokens as number) ?? 0),
      costUsd: (mu.costUSD as number) || undefined,
    }));
  }

  // Build model breakdown from Gemini stats.models
  if (geminiModels && Object.keys(geminiModels).length > 0) {
    modelBreakdown = Object.entries(geminiModels).map(([modelName, ms]) => ({
      modelName,
      inputTokens: (ms.input_tokens as number) ?? 0,
      outputTokens: (ms.output_tokens as number) ?? 0,
      cacheReadTokens: (ms.cached as number) ?? 0,
      totalTokens: ((ms.input_tokens as number) ?? 0) + ((ms.output_tokens as number) ?? 0),
      costUsd: (ms.cost_usd as number) || undefined,
    }));
  }

  const totalTokens = inputTokens + outputTokens;
  if (totalTokens === 0 && !modelBreakdown) return undefined;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    modelBreakdown,
  };
}
