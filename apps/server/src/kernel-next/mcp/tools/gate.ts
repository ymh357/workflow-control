// Gate-domain MCP tools: human-in-the-loop gate queue observability +
// answer persistence. answer_gate also bridges to the live XState runner
// via taskRegistry so running machines advance on the same tick.

import { z } from "zod";
import { taskRegistry } from "../../runtime/task-registry.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse, errorResponse } from "../tool-helpers.js";

export function buildGateTools(deps: ToolsDeps): ToolDef[] {
  const { kernel } = deps;

  return [
    {
      name: "list_gates",
      description:
        "List gates in the queue. Optional taskId narrows to a single task; " +
        "optional `answered` filters to pending (false) or resolved (true).",
      inputSchema: {
        taskId: z.string().optional(),
        answered: z.boolean().optional(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const filter: { taskId?: string; answered?: boolean } = {};
          if (typeof args.taskId === "string") filter.taskId = args.taskId;
          if (typeof args.answered === "boolean") filter.answered = args.answered;
          return jsonResponse({ ok: true, gates: kernel.listGates(filter) });
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "provide_task_secrets",
      description:
        "Supply secret values (env vars) required by a stage that is paused " +
        "with status 'secret_pending'. Secrets are written to task_env_values " +
        "and never echoed back in the response. When all required keys are " +
        "satisfied the secret gate is marked resolved and the paused stage is " +
        "automatically retried. If some keys are still missing the response " +
        "includes a `stillMissing` array so the caller knows what to provide next. " +
        "Optional `persistAs` map (envKey -> {entryId}) saves provided secrets " +
        "to the encrypted MCP inventory so future tasks reuse them without " +
        "prompting again (Bug 25 fix; pre-fix the wrapper dropped this option).",
      inputSchema: {
        taskId: z.string(),
        secrets: z.record(z.string(), z.string()),
        persistAs: z.record(
          z.string().min(1),
          z.object({ entryId: z.string().min(1) }).strict(),
        ).optional(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          // Bug 25 fix (c12+ review): forward `persistAs` to KernelService
          // so the documented "save to inventory" path is reachable from
          // MCP. Pre-fix only the underlying KernelService.provideTaskSecrets
          // accepted persistAs; the MCP wrapper silently dropped it.
          const persistAs = args.persistAs as
            | Record<string, { entryId: string }>
            | undefined;
          const result = await kernel.provideTaskSecrets(
            String(args.taskId),
            (args.secrets ?? {}) as Record<string, string>,
            persistAs ? { persistAs } : undefined,
          );
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "answer_gate",
      description:
        "Answer an open gate. The answer is validated against the gate " +
        "stage's routing table (exact match, falling back to '_default'). " +
        "On success dispatches GATE_ANSWERED to the live runner (if the " +
        "task is still running in this process) and returns the resolved " +
        "targetStage. If the task's runner is not registered (process " +
        "restart, task already completed), the gate answer is persisted " +
        "but no machine event is dispatched.\n\n" +
        "Optional `comment` is a free-text feedback string. On ANY answer " +
        "(approve, reject, or custom routing) the runner writes the " +
        "comment to the gate's builtin `__gate_feedback__` output port. " +
        "Downstream stages can read it via the standard wire mechanism — " +
        "in a reject-rollback this is how the user's correction reaches " +
        "the upstream regenerating agent. Empty string is persisted when " +
        "comment is omitted, so downstream consumers see a determinate " +
        "value either way.",
      inputSchema: {
        gateId: z.string(),
        answer: z.string().min(1).max(4096),
        comment: z.string().max(16_384).optional().describe(
          "Free-text feedback relayed to downstream stages via the gate's " +
          "builtin __gate_feedback__ port. Primary use case: reject with a " +
          "correction so the upstream agent can regenerate with guidance.",
        ),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const comment = typeof args.comment === "string" ? args.comment : undefined;
          const result = kernel.answerGate(String(args.gateId), String(args.answer), comment);
          if (result.ok) {
            const dispatcher = taskRegistry.get(result.taskId);
            if (result.kind === "rejected") {
              dispatcher?.send({
                type: "GATE_REJECTED",
                gateId: result.gateId,
                stageName: result.stageName,
                answer: result.answer,
                targetStage: result.targetStage,
                affectedStages: result.affectedStages,
              });
            } else {
              dispatcher?.send({
                type: "GATE_ANSWERED",
                gateId: result.gateId,
                stageName: result.stageName,
                answer: result.answer,
                targetStage: result.targetStage,
              });
            }
          }
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
