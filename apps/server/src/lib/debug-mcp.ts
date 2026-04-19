// Phase 4 / A4 — __debug__ MCP server.
//
// Exposes the core debug queries (analyze_task_failure,
// get_stage_execution_record, diff_executions) to the agent as MCP
// tools. All tools return JSON text content — the agent consumes
// the raw JSON and reasons over it.
//
// This MCP is intentionally read-only: it never writes to the
// execution_records table or touches the running workflow.
// Tools are safe to call at any time, including during active
// task execution.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  analyzeTaskFailure,
  diffExecutions,
  getStageExecutionRecord,
} from "./debug-queries.js";

const MAX_RESPONSE_BYTES = 200 * 1024;

function jsonResponse(payload: unknown) {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2);
  } catch {
    return {
      content: [{
        type: "text" as const,
        text: "Error: could not serialize debug result (possible circular reference).",
      }],
      isError: true,
    };
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    text =
      text.slice(0, MAX_RESPONSE_BYTES) +
      `\n\n… [truncated — full payload was ${text.length} bytes]`;
  }
  return { content: [{ type: "text" as const, text }] };
}

export function createDebugMcp() {
  return createSdkMcpServer({
    name: "__debug__",
    version: "1.0.0",
    tools: [
      {
        name: "analyze_task_failure",
        description:
          "Analyze a task's execution records and surface failure hints. " +
          "Returns per-stage summaries (attempts, cost, tokens, termination), " +
          "a list of stages whose last attempt did not terminate naturally, and " +
          "structured hints (stuck_open / exceeded_retries / interrupted / " +
          "no_writes / error_in_stream). Use this first when diagnosing a " +
          "failed task — it tells you which stage/attempt to zoom into next.",
        inputSchema: {
          taskId: z
            .string()
            .min(1)
            .describe("Task ID to analyze. Matches execution_records.task_id."),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          const taskId = String(args.taskId ?? "");
          if (!taskId) {
            return {
              content: [{ type: "text" as const, text: "Error: taskId is required" }],
              isError: true,
            };
          }
          try {
            return jsonResponse(analyzeTaskFailure(taskId));
          } catch (err) {
            return {
              content: [{
                type: "text" as const,
                text: `Error analyzing task: ${err instanceof Error ? err.message : String(err)}`,
              }],
              isError: true,
            };
          }
        },
      },
      {
        name: "get_stage_execution_record",
        description:
          "Fetch a full ExecutionRecord for one (taskId, stageName, attempt). " +
          "Returns prompt_blob, reads_snapshot, writes_committed, decisions, " +
          "tool_calls, agent_stream, scratch_pad_snapshot, and cost/token/duration. " +
          "If 'attempt' is omitted, the latest attempt is returned. " +
          "Use this after analyze_task_failure identifies a stage of interest.",
        inputSchema: {
          taskId: z.string().min(1).describe("Task ID."),
          stageName: z.string().min(1).describe("Stage name."),
          attempt: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "Attempt index (0-based). Omit for the latest attempt.",
            ),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          const taskId = String(args.taskId ?? "");
          const stageName = String(args.stageName ?? "");
          if (!taskId || !stageName) {
            return {
              content: [{
                type: "text" as const,
                text: "Error: both taskId and stageName are required",
              }],
              isError: true,
            };
          }
          const options: { attempt?: number } = {};
          if (typeof args.attempt === "number") options.attempt = args.attempt;
          try {
            return jsonResponse(
              getStageExecutionRecord(taskId, stageName, options),
            );
          } catch (err) {
            return {
              content: [{
                type: "text" as const,
                text: `Error fetching record: ${err instanceof Error ? err.message : String(err)}`,
              }],
              isError: true,
            };
          }
        },
      },
      {
        name: "diff_executions",
        description:
          "Compare two ExecutionRecords by attempt_id. Returns structural " +
          "differences in prompt_blob, reads_snapshot, writes_committed, " +
          "decisions, tool_calls, termination reason/engine/model, and " +
          "cost/token/duration deltas. Use this to understand why attempt B " +
          "succeeded while attempt A failed (or vice versa), or to pinpoint " +
          "what changed between pipeline versions.",
        inputSchema: {
          attemptIdA: z
            .string()
            .min(1)
            .describe("First attempt ID (execution_records.attempt_id)."),
          attemptIdB: z
            .string()
            .min(1)
            .describe("Second attempt ID."),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          const aId = String(args.attemptIdA ?? "");
          const bId = String(args.attemptIdB ?? "");
          if (!aId || !bId) {
            return {
              content: [{
                type: "text" as const,
                text: "Error: both attemptIdA and attemptIdB are required",
              }],
              isError: true,
            };
          }
          try {
            return jsonResponse(diffExecutions(aId, bId));
          } catch (err) {
            return {
              content: [{
                type: "text" as const,
                text: `Error diffing records: ${err instanceof Error ? err.message : String(err)}`,
              }],
              isError: true,
            };
          }
        },
      },
    ],
  });
}
