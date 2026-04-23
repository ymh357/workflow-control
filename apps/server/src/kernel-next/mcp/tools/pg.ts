// Pipeline-generator (PG) domain MCP tools: start_pipeline_generator
// triggers the pipeline-generator builtin; wait_pipeline_result polls
// the run to a terminal state.

import { z } from "zod";
import type { PipelineIR } from "../../ir/schema.js";
import { handleStartPipelineGenerator, handleWaitPipelineResult } from "../pg-entry.js";
import { loadBuiltinPipelineIR } from "../../runtime/load-builtin-pipeline.js";
import { kernelNextBroadcaster } from "../../sse/singleton.js";
import { runPipeline } from "../../runtime/runner.js";
import { RealStageExecutor } from "../../runtime/real-executor.js";
import { DbPromptResolver } from "../../runtime/db-prompt-resolver.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse, errorResponse } from "../tool-helpers.js";

let cachedPipelineGeneratorIR: ReturnType<typeof loadBuiltinPipelineIR> | undefined;
function getPipelineGeneratorIR() {
  if (!cachedPipelineGeneratorIR) {
    cachedPipelineGeneratorIR = loadBuiltinPipelineIR("pipeline-generator");
  }
  return cachedPipelineGeneratorIR;
}

export function buildPgTools(deps: ToolsDeps): ToolDef[] {
  const { db, tscPath, createMcpServer } = deps;

  return [
    {
      name: "start_pipeline_generator",
      description:
        "Trigger the pipeline-generator builtin with a natural-language task " +
        "description. Returns {taskId, versionHash} immediately; use " +
        "wait_pipeline_result to retrieve the generated pipeline.",
      inputSchema: {
        description: z.string().min(1).max(8000),
        taskId: z.string().min(1).optional(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        const res = await handleStartPipelineGenerator(
          {
            description: String(args.description),
            taskId: typeof args.taskId === "string" ? args.taskId : undefined,
          },
          {
            db,
            broadcaster: kernelNextBroadcaster,
            loader: loadBuiltinPipelineIR,
            runner: async (a) => {
              return runPipeline({
                db: a.db,
                ir: a.ir,
                taskId: a.taskId,
                versionHash: a.versionHash,
                handlers: a.handlers as Record<string, never>,
                executor: a.executor,
                seedValues: a.seedValues,
                broadcaster: a.broadcaster,
              });
            },
            executorFactory: ({ versionHash, db: execDb, model, maxTurns, maxBudgetUsd }) =>
              new RealStageExecutor({
                mcpServerFactory: (_dispatcher, pr) =>
                  createMcpServer("internal", pr),
                promptResolver: new DbPromptResolver(execDb, versionHash),
                model,
                maxTurns: maxTurns ?? 80,
                maxBudgetUsd: maxBudgetUsd ?? 8,
              }),
            model: deps.pipelineGeneratorModel ?? "claude-sonnet-4-6",
            maxTurns: deps.pipelineGeneratorMaxTurns ?? 80,
            maxBudgetUsd: deps.pipelineGeneratorMaxBudgetUsd ?? 8,
            tscPath,
          },
        );
        return res.ok ? jsonResponse(res) : errorResponse(res.error, res as Record<string, unknown>);
      },
    },
    {
      name: "wait_pipeline_result",
      description:
        "Wait for a previously started pipeline-generator run to reach a " +
        "terminal state (done/gate_pending/running/error). Safe to call " +
        "repeatedly to continue waiting.",
      inputSchema: {
        taskId: z.string().min(1),
        timeoutMs: z.number().int().optional(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        let ir: PipelineIR;
        try {
          ir = getPipelineGeneratorIR().ir;
        } catch (err) {
          return errorResponse("LOAD_IR_FAILED", { reason: (err as Error).message });
        }
        const res = await handleWaitPipelineResult(
          {
            taskId: String(args.taskId),
            timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
          },
          { db, broadcaster: kernelNextBroadcaster, ir },
        );
        return res.ok
          ? jsonResponse(res)
          : errorResponse(res.error, res as Record<string, unknown>);
      },
    },
  ];
}
