// Admin MCP tools — long-running-server hygiene operations the agent can
// request on behalf of the user.
//
// Currently exposes:
//   prune_records — delete kernel-next DB rows older than a given threshold

import { z } from "zod";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse, errorResponse } from "../tool-helpers.js";
import {
  pruneAttempts,
  countAttemptsToDelete,
} from "../../../cli/lib/prune-kernel-records.js";

export function buildAdminTools(deps: ToolsDeps): ToolDef[] {
  const { db } = deps;

  return [
    {
      name: "prune_records",
      description:
        "Delete kernel-next stage_attempts records (and their FK children: " +
        "agent_execution_details, script_execution_details, port_values, " +
        "gate_queue, stage_checkpoints, migration_hints) older than the given " +
        "threshold. Default threshold is 30 days. Use dryRun=true to preview " +
        "the deletion counts without actually deleting anything.",
      inputSchema: {
        olderThanDays: z
          .number()
          .int()
          .positive()
          .default(30)
          .describe(
            "Age threshold in days. Records with started_at older than this are pruned.",
          ),
        dryRun: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true, return how many rows would be deleted without actually deleting them.",
          ),
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          const olderThanDays =
            typeof args.olderThanDays === "number" && args.olderThanDays > 0
              ? args.olderThanDays
              : 30;
          const dryRun = args.dryRun === true;
          const olderThanMs = olderThanDays * 86_400_000;
          const filter = { olderThanMs };

          if (dryRun) {
            const count = countAttemptsToDelete(db, filter);
            return jsonResponse({
              ok: true,
              dryRun: true,
              olderThanDays,
              wouldDelete: { attempts: count },
            });
          }

          const counts = pruneAttempts(db, filter);
          return jsonResponse({
            ok: true,
            dryRun: false,
            olderThanDays,
            deleted: counts,
          });
        } catch (err) {
          return errorResponse(
            err instanceof Error ? err.message : String(err),
          );
        }
      },
    },
  ];
}
