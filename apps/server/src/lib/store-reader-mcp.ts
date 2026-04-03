import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getNestedValue } from "./config-loader.js";

const MAX_VALUE_BYTES = 50 * 1024; // 50KB

export function createStoreReaderMcp(store: Record<string, unknown>) {
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
            return {
              content: [{ type: "text" as const, text: "Store is empty — no values available." }],
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
    ],
  });
}
