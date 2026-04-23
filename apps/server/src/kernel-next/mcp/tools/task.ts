// Task-domain MCP tools: observation / introspection of a running or
// completed task. Covers high-level status (get_task_status) and
// port-lineage queries that narrow by taskId (query_lineage, diff_runs,
// compare_runs).

import { z } from "zod";
import { queryLineage, diffRuns } from "../lineage.js";
import { compareRuns } from "../compare-runs.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse, errorResponse } from "../tool-helpers.js";

export function buildTaskTools(deps: ToolsDeps): ToolDef[] {
  const { db, kernel } = deps;

  return [
    {
      name: "get_task_status",
      description:
        "Aggregate status of a running / completed task from stage_attempts " +
        "and gate_queue. Returns one of 'not_found' | 'running' | 'gated' | " +
        "'completed' | 'failed'. When status is 'gated', `pending` lists the " +
        "open gate(s) with their questionJson so the caller can answer via " +
        "answer_gate. 'gated' takes priority over 'running' — a task with an " +
        "unanswered gate is reported as gated even though the gate's stage " +
        "attempt row is still in status 'running'.",
      inputSchema: {
        taskId: z.string(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          return jsonResponse(kernel.getTaskStatus(String(args.taskId)));
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "query_lineage",
      description:
        "Return the latest write for a port plus its precise downstream " +
        "readers (filtered via the pipeline's wires when versionHash is " +
        "supplied, else a task-scope upper-bound approximation). " +
        "valuePreview is capped to 200 bytes; use read_port for full value.",
      inputSchema: {
        stage: z.string(),
        port: z.string(),
        taskId: z.string().optional(),
        versionHash: z.string().optional(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const stage = String(args.stage);
          const port = String(args.port);
          const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
          const versionHash = typeof args.versionHash === "string" ? args.versionHash : undefined;

          // If versionHash provided, look up wires whose source is
          // (stage, port) and pass the precise consumer (stage, port)
          // list to queryLineage for filtering.
          let wiredInputs: Array<{ stage: string; port: string }> | undefined;
          if (versionHash) {
            const rows = db.prepare(
              `SELECT to_stage, to_port FROM wires
               WHERE version_hash = ? AND from_stage = ? AND from_port = ?`,
            ).all(versionHash, stage, port) as Array<{ to_stage: string; to_port: string }>;
            wiredInputs = rows.map((r) => ({ stage: r.to_stage, port: r.to_port }));
          }

          return jsonResponse({
            ok: true,
            report: queryLineage(db, { stage, port, taskId, wiredInputs }),
          });
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "diff_runs",
      description:
        "Compare two task runs at the stage-output level. For each stage " +
        "that appeared in either run, reports which output ports are equal, " +
        "differing, or missing on one side.",
      inputSchema: {
        taskA: z.string(),
        taskB: z.string(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          return jsonResponse({
            ok: true,
            report: diffRuns(db, String(args.taskA), String(args.taskB)),
          });
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "compare_runs",
      description:
        "Compare two task runs at the execution-record level. Per stage, " +
        "reports delta on cost / token / duration, prompt-content-hash " +
        "equality (did the prompt change between runs?), tool-call count + " +
        "name-set differences, compact-event counts, and termination_reason. " +
        "Complements diff_runs (port-output-level only). Selection: the " +
        "LAST attempt per (task, stage) whose kind is regular / " +
        "fanout_aggregate / replay / dry_run. Script attempts (no agent " +
        "execution-record row) surface null deltas.",
      inputSchema: {
        taskA: z.string(),
        taskB: z.string(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          return jsonResponse({
            ok: true,
            report: compareRuns(db, String(args.taskA), String(args.taskB)),
          });
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "retry_task",
      description:
        "Retry a task from a specific stage (or the first errored stage " +
        "if fromStage omitted). Internally reuses the hot-update rerunFrom " +
        "mechanism — a same-version synthetic proposal is created and the " +
        "migration orchestrator supersedes the target stage + its " +
        "wire-downstream, then kicks off startPipelineRun with resumeFrom. " +
        "Does NOT submit a new pipeline version; runs against the task's " +
        "current version.",
      inputSchema: {
        taskId: z.string().min(1).describe("The task to retry."),
        fromStage: z.string().min(1).optional().describe(
          "Stage name to rewind to. Omit to retry from the earliest " +
          "stage whose latest attempt is in 'error' status.",
        ),
        actor: z.string().min(1).optional().describe(
          "Audit actor label persisted on the synthetic proposal and " +
          "hot_update_events row. Defaults to 'mcp-retry'.",
        ),
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
          if (!taskId) {
            return errorResponse("taskId is required");
          }
          const fromStage =
            typeof args.fromStage === "string" && args.fromStage.length > 0
              ? args.fromStage
              : undefined;
          const actor =
            typeof args.actor === "string" && args.actor.length > 0
              ? args.actor
              : undefined;
          return jsonResponse(
            await kernel.retryTaskFromStage({ taskId, fromStage, actor }),
          );
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
