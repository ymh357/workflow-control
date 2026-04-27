// MCP tools for the catalog supply chain: recommend_mcp_servers + get_mcp_catalog_entry.
// Exposed to LLM agents (e.g. pipeline-generator's analyzing stage) so they can
// discover and look up MCP servers without knowing the internal catalog API.
//
// Response shape: top-level semantic fields (ok, recommendations, entry,
// diagnostics) are included directly on the return value — the CallToolResult
// type infers $loose (index-signature) so extra properties are type-safe.
// Callers that need JSON text can read content[0].text; callers in the same
// process (tests, pipeline stages) can read .ok directly.

import { z } from "zod";
import type { ToolDef, ToolsDeps } from "../tool-types.js";

import { getEntry } from "../../mcp-catalog/catalog-store.js";
import {
  recommendForTopicLocal,
  recommendForTopicWithLLM,
} from "../../mcp-catalog/recommender.js";

export function buildMcpCatalogTools(deps: ToolsDeps): ToolDef[] {
  return [
    {
      name: "recommend_mcp_servers",
      description:
        "Given a topic in natural language, recommend MCP servers from the catalog. " +
        "Optionally use LLM-overlay for natural-language reasons.",
      inputSchema: {
        topic: z
          .string()
          .min(1)
          .max(4096)
          .describe("Free-text topic, in English or Chinese"),
        excludeIds: z
          .array(z.string())
          .optional()
          .describe("Catalog entry ids to exclude from results"),
        maxResults: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("Max number of recommendations"),
        withLLM: z
          .boolean()
          .optional()
          .describe(
            "If true, run LLM-overlay rerank with natural-language reasons; default false",
          ),
      },
      handler: async (args: Record<string, unknown>) => {
        const topic = typeof args.topic === "string" ? args.topic : "";
        const excludeIds = Array.isArray(args.excludeIds)
          ? (args.excludeIds as string[])
          : undefined;
        const maxResults =
          typeof args.maxResults === "number" ? args.maxResults : undefined;
        const withLLM = args.withLLM === true;

        if (withLLM) {
          const result = await recommendForTopicWithLLM(deps.db, topic, {
            excludeIds,
            maxResults,
          });
          const payload = {
            ok: true,
            recommendations: result.recommendations,
            ...(result.warnings ? { warnings: result.warnings } : {}),
          };
          return {
            ...payload,
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          };
        }

        const recs = recommendForTopicLocal(deps.db, topic, {
          excludeIds,
          maxResults,
        });
        const payload = { ok: true, recommendations: recs };
        return {
          ...payload,
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        };
      },
    },
    {
      name: "get_mcp_catalog_entry",
      description:
        "Get a full catalog entry by id, including command, args, envKeys, and obtainSteps.",
      inputSchema: {
        id: z.string().min(1).describe("Catalog entry id (kebab-case)"),
      },
      handler: async (args: Record<string, unknown>) => {
        const id = typeof args.id === "string" ? args.id : "";
        const found = getEntry(deps.db, id);
        if (!found) {
          const payload = {
            ok: false,
            diagnostics: [
              {
                code: "CATALOG_ENTRY_NOT_FOUND",
                message: `entry '${id}' not found`,
                context: { id },
              },
            ],
          };
          return {
            ...payload,
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          };
        }
        const payload = { ok: true, entry: found };
        return {
          ...payload,
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        };
      },
    },
  ];
}
