// Hot-update domain MCP tools: the proposal lifecycle + migration +
// rollback + registry update + stats. All nine tools are façades over
// KernelService methods that share the hot_update_events / pipeline_
// proposals tables.

import { z } from "zod";
import { IRPatchSchema } from "../../ir/schema.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse, errorResponse } from "../tool-helpers.js";

export function buildHotUpdateTools(deps: ToolsDeps): ToolDef[] {
  const { kernel } = deps;

  return [
    {
      name: "propose_pipeline_change",
      description:
        "Propose a patch against the pipeline at currentVersion. " +
        "Patch is applied to a deep-copy of the IR, validated, and (if ok) " +
        "persisted with a pending proposal row. autoApplied is always " +
        "false in spike — proposals require human confirm before migrating " +
        "running tasks. `rerunFrom` optionally names a stage on the " +
        "proposed pipeline to rewind to on migration (null / omitted = " +
        "forward-only). `migrateRunningTasks` is the opt-in list — 'none' " +
        "(default), 'all', or an explicit array of taskIds.",
      inputSchema: {
        currentVersion: z.string(),
        patch: z.unknown(),
        actor: z.string().default("unknown"),
        rerunFrom: z.string().optional(),
        migrateRunningTasks: z.union([
          z.literal("all"),
          z.literal("none"),
          z.array(z.string()),
        ]).optional(),
        autoApprove: z.boolean().optional().describe(
          "Stage 5A — when true and dry-run safeRange.verdict==='safe', " +
          "flips proposal to 'approved' in same tx. Structural patches " +
          "ignore this flag and stay pending.",
        ),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const parsedPatch = IRPatchSchema.safeParse(args.patch);
          if (!parsedPatch.success) {
            return jsonResponse({
              ok: false,
              diagnostics: parsedPatch.error.issues.map((i) => ({
                code: "ZOD_PARSE_ERROR",
                message: `patch.${i.path.join(".") || "<root>"}: ${i.message}`,
                context: { path: i.path },
              })),
            });
          }
          const rerunFrom =
            typeof args.rerunFrom === "string" ? args.rerunFrom : undefined;
          const migrateRunningTasks: "all" | "none" | string[] | undefined =
            args.migrateRunningTasks === "all" || args.migrateRunningTasks === "none"
              ? args.migrateRunningTasks
              : Array.isArray(args.migrateRunningTasks)
                ? args.migrateRunningTasks.map((x: unknown) => String(x))
                : undefined;
          return jsonResponse(
            kernel.propose({
              currentVersion: String(args.currentVersion),
              patch: parsedPatch.data,
              actor: String(args.actor ?? "unknown"),
              rerunFrom,
              migrateRunningTasks,
              autoApprove: typeof args.autoApprove === "boolean" ? args.autoApprove : undefined,
            }),
          );
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "dry_run_proposal",
      description:
        "Stage 5A — read-only preview of a pipeline patch. Returns " +
        "{diff, impact, safeRange, wouldAutoApprove, proposedVersion} " +
        "without touching pipeline_proposals or pipeline_versions. " +
        "Safe to call concurrently; idempotent.",
      inputSchema: {
        currentVersion: z.string(),
        patch: z.unknown(),
        rerunFrom: z.string().optional(),
        migrateRunningTasks: z.union([
          z.literal("all"),
          z.literal("none"),
          z.array(z.string()),
        ]).optional(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const parsedPatch = IRPatchSchema.safeParse(args.patch);
          if (!parsedPatch.success) {
            return jsonResponse({
              ok: false,
              diagnostics: parsedPatch.error.issues.map((i) => ({
                code: "ZOD_PARSE_ERROR",
                message: `patch.${i.path.join(".") || "<root>"}: ${i.message}`,
                context: { path: i.path },
              })),
            });
          }
          return jsonResponse(kernel.dryRunProposal({
            currentVersion: String(args.currentVersion),
            patch: parsedPatch.data,
            rerunFrom: typeof args.rerunFrom === "string" ? args.rerunFrom : null,
            migrateRunningTasks:
              args.migrateRunningTasks === "all" || args.migrateRunningTasks === "none"
                ? args.migrateRunningTasks
                : Array.isArray(args.migrateRunningTasks)
                  ? args.migrateRunningTasks.map((x: unknown) => String(x))
                  : undefined,
          }));
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "update_registry_pipeline",
      description:
        "Stage 5A — replace a registry pipeline's IR definition and " +
        "register a new pipeline_versions row. Does NOT migrate running " +
        "tasks. REGISTRY_ROOT env var can override the registry root " +
        "for tests.",
      inputSchema: {
        pipelineName: z.string().min(1),
        newIR: z.unknown(),
        actor: z.string().default("unknown"),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          return jsonResponse(kernel.updateRegistryPipeline({
            pipelineName: String(args.pipelineName),
            newIR: args.newIR as never,
            actor: String(args.actor ?? "unknown"),
          }));
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "rollback_hot_update",
      description:
        "Stage 5A skeleton — writes an audit row indicating rollback " +
        "intent. Does NOT execute state rollback (that lands in Stage 5B). " +
        "Validates that toVersion exists in this task's migration history.",
      inputSchema: {
        taskId: z.string(),
        toVersion: z.string(),
        actor: z.string().default("unknown"),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          return jsonResponse(await kernel.rollbackHotUpdate({
            taskId: String(args.taskId),
            toVersion: String(args.toVersion),
            actor: String(args.actor ?? "unknown"),
          }));
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "query_hot_update_stats",
      description:
        "Stage 5E — aggregate queries over hot_update_events. Returns " +
        "total/success/failed/rolled_back counts, byPipelineName breakdown, " +
        "byActor counts, and topChurnPipelines ranking. All filters optional. " +
        "retry_task rows are included by default; set excludeRetries=true to " +
        "get proposal-only churn numbers.",
      inputSchema: {
        taskId: z.string().optional(),
        pipelineName: z.string().optional(),
        sinceMs: z.number().int().optional(),
        untilMs: z.number().int().optional(),
        actor: z.string().optional(),
        excludeRetries: z.boolean().optional(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          return jsonResponse({
            ok: true,
            stats: kernel.queryHotUpdateStats({
              taskId: typeof args.taskId === "string" ? args.taskId : undefined,
              pipelineName: typeof args.pipelineName === "string" ? args.pipelineName : undefined,
              sinceMs: typeof args.sinceMs === "number" ? args.sinceMs : undefined,
              untilMs: typeof args.untilMs === "number" ? args.untilMs : undefined,
              actor: typeof args.actor === "string" ? args.actor : undefined,
              excludeRetries: args.excludeRetries === true,
            }),
          });
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "list_proposals",
      description:
        "List pipeline-change proposals, newest first. Optionally filter " +
        "by status ('pending' | 'approved' | 'rejected').",
      inputSchema: {
        status: z.enum(["pending", "approved", "rejected"]).optional(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const filter = args.status ? { status: args.status } : {};
          return jsonResponse({ ok: true, proposals: kernel.listProposals(filter) });
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "approve_proposal",
      description:
        "Approve a pending proposal. Spike scope: flips status to 'approved' " +
        "only — does NOT migrate running tasks. New task submissions can " +
        "then reference the approved proposedVersion.",
      inputSchema: {
        proposalId: z.string(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          return jsonResponse(kernel.approveProposal(String(args.proposalId)));
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "reject_proposal",
      description:
        "Reject a pending proposal. Optional reason is persisted to " +
        "diagnostic_json for audit.",
      inputSchema: {
        proposalId: z.string(),
        // Mirror REST's 4096 cap to avoid oversize payloads bloating
        // pipeline_proposals.diagnostic_json.
        reason: z.string().max(4096).optional(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const reason = typeof args.reason === "string" ? args.reason : undefined;
          return jsonResponse(kernel.rejectProposal(String(args.proposalId), reason));
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "migrate_task",
      description:
        "Migrate a task onto an approved proposal's proposedVersion " +
        "(A8 forward-migration happy path, §10.5). The task must be in " +
        "the proposal's migrateRunningTasks opt-in list; the proposal " +
        "must be status='approved'. Marks rerunFrom + downstream stage " +
        "attempts as 'superseded' on the OLD version (lineage retained) " +
        "and writes a hot_update_events audit row. Returns eventId + " +
        "supersededStages; callers kick off fresh attempts on toVersion.",
      inputSchema: {
        taskId: z.string(),
        proposalId: z.string(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          return jsonResponse(
            kernel.migrateTask(String(args.taskId), String(args.proposalId)),
          );
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
