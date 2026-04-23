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
      name: "answer_gate",
      description:
        "Answer an open gate. The answer is validated against the gate " +
        "stage's routing table (exact match, falling back to '_default'). " +
        "On success dispatches GATE_ANSWERED to the live runner (if the " +
        "task is still running in this process) and returns the resolved " +
        "targetStage. If the task's runner is not registered (process " +
        "restart, task already completed), the gate answer is persisted " +
        "but no machine event is dispatched.",
      inputSchema: {
        gateId: z.string(),
        answer: z.string().min(1).max(4096),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const result = kernel.answerGate(String(args.gateId), String(args.answer));
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
