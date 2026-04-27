import { z } from "zod";
import {
  getLatestVersionHashByName,
  getPipelineIR,
  getPromptsByVersion,
} from "../../ir/sql.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse } from "../tool-helpers.js";

export function buildGetPipelineDefinitionTools(deps: ToolsDeps): ToolDef[] {
  const { db } = deps;

  return [
    {
      name: "get_pipeline_definition",
      description:
        "Return the IR and prompts for a pipeline by name or versionHash.",
      inputSchema: {
        name: z.string().optional().describe("Pipeline name to look up the latest version for."),
        versionHash: z.string().optional().describe("Exact version hash; takes precedence over name."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        let resolvedHash: string;

        if (typeof args.versionHash === "string" && args.versionHash.length > 0) {
          resolvedHash = args.versionHash;
        } else if (typeof args.name === "string" && args.name.length > 0) {
          const found = getLatestVersionHashByName(db, args.name);
          if (found === null) {
            return jsonResponse({
              ok: false,
              diagnostics: [
                {
                  code: "MODIFIER_TARGET_UNKNOWN",
                  message: `Pipeline not found: ${args.name}`,
                },
              ],
            });
          }
          resolvedHash = found;
        } else {
          return jsonResponse({
            ok: false,
            diagnostics: [
              {
                code: "MODIFIER_TARGET_UNKNOWN",
                message: "missing input: name or versionHash required",
              },
            ],
          });
        }

        const ir = getPipelineIR(db, resolvedHash);
        if (ir === null) {
          return jsonResponse({
            ok: false,
            diagnostics: [
              {
                code: "MODIFIER_TARGET_UNKNOWN",
                message: `Pipeline version not found: ${resolvedHash}`,
              },
            ],
          });
        }

        const prompts = getPromptsByVersion(db, resolvedHash);
        return jsonResponse({ ok: true, versionHash: resolvedHash, ir, prompts });
      },
    },
  ];
}
