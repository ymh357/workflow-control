// Task-domain MCP tools: observation / introspection of a running or
// completed task. Covers high-level status (get_task_status) and
// port-lineage queries that narrow by taskId (query_lineage, diff_runs,
// compare_runs).

import { z } from "zod";
import { queryLineage, diffRuns } from "../lineage.js";
import { compareRuns } from "../compare-runs.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse, errorResponse } from "../tool-helpers.js";
import { kernelNextBroadcaster } from "../../sse/singleton.js";
import type {
  AnyKernelNextSSEEvent,
  GateOpenedData,
  RunFinalData,
  StageErrorData,
} from "../../sse/types.js";

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
      name: "cancel_task",
      description:
        "Cancel a task. If the task is actively running in this process, " +
        "dispatches INTERRUPT to its machine so the runner can fold " +
        "graceful-summary / checkpoint writes into its finally block. " +
        "Writes task_finals.final_state='cancelled' and cleans up " +
        "task_env_values (plaintext tokens removed per P3.6). Returns " +
        "TASK_ALREADY_TERMINAL if a task_finals row already exists and " +
        "TASK_NOT_FOUND if the task has no stage_attempts.",
      inputSchema: {
        taskId: z.string().min(1).describe("Task to cancel."),
        reason: z.string().optional().describe(
          "Free-form reason persisted to task_finals.reason. " +
          "Defaults to 'cancelled via MCP'.",
        ),
        actor: z.string().optional().describe(
          "Audit actor. Appended to the persisted detail field. " +
          "Defaults to 'mcp-cancel'.",
        ),
      },
      handler: async (args: Record<string, unknown>) => {
        try {
          const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
          if (!taskId) {
            return errorResponse("taskId is required");
          }
          const reason =
            typeof args.reason === "string" && args.reason.length > 0
              ? args.reason
              : undefined;
          const actor =
            typeof args.actor === "string" && args.actor.length > 0
              ? args.actor
              : undefined;
          return jsonResponse(kernel.cancelTask({ taskId, reason, actor }));
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "wait_for_task_event",
      description:
        "Block until the task emits one of the requested events or the " +
        "timeout elapses. Designed for external callers (main Claude) " +
        "driving a pipeline over MCP: one tool call waits for the next " +
        "decision point (gate_opened, stage_error, or task terminal) " +
        "and returns a compact payload so the caller never pulls the " +
        "full SSE stream into its context window. Polling get_task_status " +
        "still works; this tool exists so you don't have to.\n\n" +
        "Events vocabulary:\n" +
        "  - 'gate_opened': pipeline paused on a gate; payload carries gateId + questionText + answerOptions.\n" +
        "  - 'terminal': task reached 'completed' or 'failed' (run_final).\n" +
        "  - 'stage_error': any stage reached error final; useful when you want intermediate failures surfaced before terminal.\n\n" +
        "Pass 'sinceSeq' to resume after a previously-consumed event — the " +
        "broadcaster replays history > sinceSeq so short gaps between " +
        "successive waits don't drop events. Omit sinceSeq for the first " +
        "wait. The returned event includes its 'seq'; feed that back in " +
        "the next call. Timeout resolves as { ok:true, event:null } so " +
        "the caller can decide whether to retry or abort.",
      inputSchema: {
        taskId: z.string().min(1),
        events: z.array(z.enum(["gate_opened", "terminal", "stage_error"]))
          .min(1)
          .describe("Event kinds that satisfy the wait."),
        sinceSeq: z.number().int().nonnegative().optional().describe(
          "Skip events with seq ≤ this value. Use the 'seq' field of the " +
          "previous returned event to avoid re-consuming it.",
        ),
        timeoutMs: z.number().int().positive().max(30 * 60 * 1000).optional()
          .describe("Max wait in milliseconds. Default 300000 (5 min). Max 30 min."),
      },
      handler: async (args: Record<string, unknown>) => {
        const taskId = typeof args.taskId === "string" ? args.taskId : undefined;
        if (!taskId) return errorResponse("taskId is required");
        const rawEvents = Array.isArray(args.events) ? args.events : [];
        const wanted = new Set<string>(
          rawEvents.filter((e): e is string => typeof e === "string"),
        );
        if (wanted.size === 0) {
          return errorResponse("events must be a non-empty array");
        }
        const sinceSeq = typeof args.sinceSeq === "number"
          ? args.sinceSeq
          : -1;
        const timeoutMs = typeof args.timeoutMs === "number"
          ? args.timeoutMs
          : 5 * 60 * 1000;

        // Map caller vocabulary → broadcaster event types. 'terminal'
        // aliases the run_final event; other names pass through.
        const matches = (ev: AnyKernelNextSSEEvent): boolean => {
          if (wanted.has("gate_opened") && ev.type === "gate_opened") return true;
          if (wanted.has("stage_error") && ev.type === "stage_error") return true;
          if (wanted.has("terminal") && ev.type === "run_final") return true;
          return false;
        };

        // Shape a caller-friendly payload — do not leak internal fields.
        const shape = (ev: AnyKernelNextSSEEvent) => {
          if (ev.type === "gate_opened") {
            const d = ev.data as GateOpenedData;
            return {
              event: "gate_opened",
              seq: ev.seq,
              timestamp: ev.timestamp,
              gateId: d.gateId,
              stage: d.stage,
              questionText: d.questionText,
              answerOptions: d.answerOptions,
            };
          }
          if (ev.type === "run_final") {
            const d = ev.data as RunFinalData;
            return {
              event: "terminal",
              seq: ev.seq,
              timestamp: ev.timestamp,
              finalState: d.finalState,
              stageErrors: d.stageErrors,
            };
          }
          if (ev.type === "stage_error") {
            const d = ev.data as StageErrorData;
            return {
              event: "stage_error",
              seq: ev.seq,
              timestamp: ev.timestamp,
              stage: d.stage,
              reason: d.reason,
              message: d.message,
            };
          }
          return { event: ev.type, seq: ev.seq, timestamp: ev.timestamp };
        };

        return new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
          let settled = false;
          let unsubscribe: (() => void) | null = null;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (unsubscribe) unsubscribe();
            resolve(jsonResponse({ ok: true, event: null, timedOut: true }));
          }, timeoutMs);

          unsubscribe = kernelNextBroadcaster.subscribe(
            taskId,
            (ev) => {
              if (settled) return;
              if ((ev.seq ?? 0) <= sinceSeq) return;
              if (!matches(ev as AnyKernelNextSSEEvent)) return;
              settled = true;
              clearTimeout(timer);
              if (unsubscribe) unsubscribe();
              resolve(jsonResponse({
                ok: true,
                event: shape(ev as AnyKernelNextSSEEvent),
                timedOut: false,
              }));
            },
            { fromSeq: sinceSeq >= 0 ? sinceSeq : 0 },
          );
        });
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
