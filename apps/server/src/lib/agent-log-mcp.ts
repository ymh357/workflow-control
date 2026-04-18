// T1.5 — __agent_log__ MCP server.
//
// Structured log tools the agent calls to leave a machine-readable trail
// of its reasoning for downstream tooling (A4 debug MCP, human review).
//
// Currently exposes one tool: record_decision. Future additions in the
// same namespace: record_intent, record_assumption, record_risk, etc.
// Keeps these separate from __store__ because Store is business data
// (stages read/write each other through it) while agent_log is
// metadata — consumed only by tooling, never by downstream stages.

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ExecutionRecordWriter } from "./execution-record/writer.js";

const MAX_CONTEXT_BYTES = 500;
const MAX_REASONING_BYTES = 2000;
const MAX_OPTION_BYTES = 200;
const MAX_OPTIONS = 10;

export function createAgentLogMcp(
  executionRecordWriter: ExecutionRecordWriter | null | undefined,
) {
  return createSdkMcpServer({
    name: "__agent_log__",
    version: "1.0.0",
    tools: [
      {
        name: "record_decision",
        description:
          "Record a structured decision you made that affects downstream work. " +
          "Use when you pick between options, choose an approach, or commit to an interpretation " +
          "whose alternatives future debugging might want to see. " +
          "Unlike append_scratch_pad (free-form notes), this has mandatory structure " +
          "so debug tools can reason over decisions without NLP.",
        inputSchema: {
          context: z
            .string()
            .min(1)
            .max(MAX_CONTEXT_BYTES)
            .describe(
              `One-line context describing the choice point (max ${MAX_CONTEXT_BYTES} chars). ` +
                `Example: "picking the JSON parser for untrusted config files"`,
            ),
          optionsConsidered: z
            .array(z.string().min(1).max(MAX_OPTION_BYTES))
            .min(2)
            .max(MAX_OPTIONS)
            .describe(
              `2-${MAX_OPTIONS} options you considered. Must include the chosen one. ` +
                `Each option max ${MAX_OPTION_BYTES} chars.`,
            ),
          chosen: z
            .string()
            .min(1)
            .max(MAX_OPTION_BYTES)
            .describe(
              "The option you picked. Should exactly match one of optionsConsidered.",
            ),
          reasoning: z
            .string()
            .min(1)
            .max(MAX_REASONING_BYTES)
            .describe(
              `Why you picked chosen over the others (max ${MAX_REASONING_BYTES} chars). ` +
                `Be specific — future debugging will read this.`,
            ),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          const context = String(args.context ?? "");
          const optionsConsidered = Array.isArray(args.optionsConsidered)
            ? (args.optionsConsidered as unknown[]).map(String)
            : [];
          const chosen = String(args.chosen ?? "");
          const reasoning = String(args.reasoning ?? "");

          // Defensive validation — zod should have caught these at the
          // SDK boundary, but pretend-compliant clients can skip.
          if (!context) {
            return {
              content: [{ type: "text" as const, text: "Error: context is required" }],
              isError: true,
            };
          }
          if (optionsConsidered.length < 2) {
            return {
              content: [{
                type: "text" as const,
                text: "Error: at least 2 options required in optionsConsidered",
              }],
              isError: true,
            };
          }
          if (!chosen) {
            return {
              content: [{ type: "text" as const, text: "Error: chosen is required" }],
              isError: true,
            };
          }
          // Chosen may legitimately summarize an option rather than quote it
          // verbatim (e.g. chosen="option A" when option was "option A: use
          // fs.readFile"). We WARN but still record — the decision is the
          // valuable signal, verbatim match is a nice-to-have.
          const chosenMismatch = !optionsConsidered.includes(chosen);

          // Silently tolerated when writer is missing / no-op: record is lost
          // but agent work continues. This matches the rest of the
          // ExecutionRecord contract (writer is inert unless flag enabled).
          if (executionRecordWriter && !executionRecordWriter.isNoop) {
            executionRecordWriter.recordDecision({
              timestamp: new Date().toISOString(),
              context,
              optionsConsidered,
              chosen,
              reasoning,
            });
          }

          const successText =
            `Decision recorded: chose "${chosen}" from ${optionsConsidered.length} options. ` +
            `Reasoning captured (${reasoning.length} chars).`;
          const warnText =
            `Warning: chosen="${chosen}" does not exactly match any entry in optionsConsidered. ` +
            `Decision recorded anyway; consider re-running with a matching chosen value.`;
          return {
            content: [{
              type: "text" as const,
              text: chosenMismatch ? warnText : successText,
            }],
          };
        },
      },
    ],
  });
}
