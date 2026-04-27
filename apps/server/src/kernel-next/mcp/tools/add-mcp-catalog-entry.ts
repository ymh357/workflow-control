import { z } from "zod";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { CatalogEntrySchema } from "../../mcp-catalog/schema.js";
import { upsertCustomEntry } from "../../mcp-catalog/catalog-store.js";
import {
  checkPackage,
  resolvePackageName,
  type ExecFn,
} from "../../mcp-catalog/healthcheck.js";

const InputEntrySchema = CatalogEntrySchema.omit({ source: true });

export function buildAddMcpCatalogEntryTools(
  deps: ToolsDeps,
  catalogExec?: ExecFn,
): ToolDef[] {
  return [
    {
      name: "add_mcp_catalog_entry",
      description:
        "Add a custom MCP server entry to the catalog so future pipelines can " +
        "reference it via recommend_mcp_servers / get_mcp_catalog_entry. " +
        "Runs `npm view <packageName>` as a healthcheck unless skipPackageCheck=true. " +
        "Cannot overwrite builtin entries; subsequent calls upsert custom entries. " +
        "Source is forced to 'custom'.",
      inputSchema: {
        entry: InputEntrySchema.describe(
          "Catalog entry definition. id must be kebab-case lowercase. " +
          "useCases must be non-empty. envKeys may be empty array. " +
          "schemaVersion: '1'. Source is forced to 'custom' regardless of input.",
        ),
        skipPackageCheck: z
          .boolean()
          .optional()
          .describe(
            "Skip the `npm view` healthcheck. Default false. " +
            "Use only for offline / private-registry / local-development entries.",
          ),
      },
      handler: async (args: Record<string, unknown>) => {
        const parsed = InputEntrySchema.safeParse(args.entry);
        if (!parsed.success) {
          const payload = {
            ok: false,
            diagnostics: [
              {
                code: "CATALOG_INVALID_ENTRY",
                message: parsed.error.issues[0]?.message ?? "invalid entry",
                context: { path: parsed.error.issues[0]?.path },
              },
            ],
          };
          return {
            ...payload,
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          };
        }

        const skipPackageCheck = args.skipPackageCheck === true;
        if (!skipPackageCheck) {
          const packageName = resolvePackageName({
            packageName: parsed.data.packageName,
            args: parsed.data.args,
          });
          if (packageName) {
            const hc = await checkPackage({
              packageName,
              timeoutMs: parsed.data.healthCheckTimeoutMs,
              exec: catalogExec,
            });
            if (!hc.ok) {
              const payload = { ok: false, diagnostics: hc.diagnostics };
              return {
                ...payload,
                content: [{ type: "text" as const, text: JSON.stringify(payload) }],
              };
            }
          }
        }

        const result = upsertCustomEntry(deps.db, {
          ...parsed.data,
          source: "custom",
        });
        if (!result.ok) {
          const payload = { ok: false, diagnostics: result.diagnostics };
          return {
            ...payload,
            content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          };
        }
        const payload = { ok: true, entry: result.entry };
        return {
          ...payload,
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        };
      },
    },
  ];
}
