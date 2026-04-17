import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getNestedValue } from "./config-loader.js";
import type { ScratchPadEntry } from "../machine/types.js";

const MAX_VALUE_BYTES = 50 * 1024; // 50KB
// Hard limit on a single scratch-pad entry's content. Keeps tier1 context
// and store snapshots bounded even if an agent writes verbose notes.
const MAX_SCRATCH_PAD_CONTENT_BYTES = 2000;

export function createStoreReaderMcp(
  store: Record<string, unknown>,
  scratchPad?: ScratchPadEntry[],
  currentStage?: string,
) {
  return createSdkMcpServer({
    name: "__store__",
    version: "1.0.0",
    tools: [
      {
        name: "get_store_value",
        description:
          "Read a value from the workflow store by dot-notation path. " +
          "Use when you see keys in 'Other Available Context' that you need.",
        inputSchema: {
          path: z.string().describe(
            'Dot-notation path into the store, e.g. "analysis.modules" or "refactorPlan.foundationTasks"',
          ),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          const path = args.path as string;
          if (!path) {
            return {
              content: [{ type: "text" as const, text: "Error: path is required" }],
              isError: true,
            };
          }

          const topLevelKeys = Object.keys(store);

          if (topLevelKeys.length === 0) {
            const scratchHint =
              scratchPad && scratchPad.length > 0
                ? " Note: the scratch pad has entries — use `read_scratch_pad` instead."
                : "";
            return {
              content: [{ type: "text" as const, text: `Store is empty — no values available.${scratchHint}` }],
              isError: true,
            };
          }

          const value = getNestedValue(store as Record<string, any>, path);

          if (value === undefined) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Path "${path}" not found. Available top-level keys: ${topLevelKeys.join(", ")}`,
                },
              ],
              isError: true,
            };
          }

          let serialized: string;
          try {
            serialized = JSON.stringify(value, null, 2);
          } catch {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: could not serialize value at "${path}" (possible circular reference)`,
                },
              ],
              isError: true,
            };
          }

          if (serialized.length > MAX_VALUE_BYTES) {
            // Truncate at line boundary to avoid breaking JSON structure
            const truncated = serialized.slice(0, MAX_VALUE_BYTES);
            const lastNl = truncated.lastIndexOf("\n");
            const cutPoint = lastNl > MAX_VALUE_BYTES * 0.5 ? lastNl : MAX_VALUE_BYTES;

            // For objects/arrays, prepend a structural summary
            let summary = "";
            if (typeof value === "object" && value !== null) {
              if (Array.isArray(value)) {
                summary = `Array with ${value.length} items.\n`;
              } else {
                const keys = Object.keys(value);
                summary = `Object with ${keys.length} keys: [${keys.slice(0, 30).join(", ")}${keys.length > 30 ? ", ..." : ""}]\nUse dot notation (e.g., "${path}.${keys[0]}") to read specific fields.\n`;
              }
            }

            serialized = summary + "--- Preview (first " + cutPoint + " bytes) ---\n" + serialized.slice(0, cutPoint) +
              `\n\n... [truncated — full value is ${serialized.length} bytes]`;
          }

          return {
            content: [{ type: "text" as const, text: serialized }],
          };
        },
      },
      ...(scratchPad
        ? [
            {
              name: "append_scratch_pad",
              description:
                "Append a note to the task scratch pad. Use for observations, caveats, discoveries, " +
                "or any context that downstream stages should know about but doesn't fit your formal output schema. " +
                "Categories: caveat, discovery, concern, reference, decision.",
              inputSchema: {
                category: z.enum(["caveat", "discovery", "concern", "reference", "decision"]).describe("Type of note"),
                // Length cap keeps the aggregate scratch-pad from bloating tier1
                // context. Agents needing to record more should split into
                // multiple focused entries.
                content: z
                  .string()
                  .min(1)
                  .max(MAX_SCRATCH_PAD_CONTENT_BYTES)
                  .describe(`The note content (be specific and actionable, max ${MAX_SCRATCH_PAD_CONTENT_BYTES} chars)`),
              },
              handler: async (args: any) => {
                const content = typeof args.content === "string" ? args.content : "";
                // Defensive re-check: zod validates at the SDK boundary but
                // pretend-compliant MCP clients could skip it.
                if (content.length > MAX_SCRATCH_PAD_CONTENT_BYTES) {
                  return {
                    content: [{
                      type: "text" as const,
                      text: `Error: scratch pad content exceeds ${MAX_SCRATCH_PAD_CONTENT_BYTES} characters (got ${content.length}). Split into multiple entries.`,
                    }],
                    isError: true,
                  };
                }
                const entry: ScratchPadEntry = {
                  stage: currentStage ?? "unknown",
                  timestamp: new Date().toISOString(),
                  category: args.category as string,
                  content,
                };
                scratchPad.push(entry);
                return {
                  content: [{ type: "text" as const, text: `Scratch pad entry appended (${scratchPad.length} total entries).` }],
                };
              },
            },
            {
              name: "read_scratch_pad",
              description:
                "Read notes from the task scratch pad. Returns notes left by previous stages. " +
                "Filter by stage name or category to narrow results.",
              inputSchema: {
                stage: z.string().optional().describe("Filter by stage name"),
                category: z.enum(["caveat", "discovery", "concern", "reference", "decision"]).optional().describe("Filter by category"),
              },
              handler: async (args: any) => {
                if (scratchPad.length === 0) {
                  return { content: [{ type: "text" as const, text: "Scratch pad is empty — no notes from previous stages." }] };
                }
                let entries = scratchPad;
                if (args.stage) entries = entries.filter((e) => e.stage === args.stage);
                if (args.category) entries = entries.filter((e) => e.category === args.category);
                if (entries.length === 0) {
                  return { content: [{ type: "text" as const, text: `No scratch pad entries matching filters (stage=${args.stage ?? "any"}, category=${args.category ?? "any"}).` }] };
                }
                const text = entries
                  .map((e) => `[${e.stage}] (${e.category}) ${e.timestamp}\n${e.content}`)
                  .join("\n\n---\n\n");
                return { content: [{ type: "text" as const, text }] };
              },
            },
          ]
        : []),
    ],
  });
}
