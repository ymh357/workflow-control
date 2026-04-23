// Pipeline-domain MCP tools: the authoring + launch surface.
// submit_pipeline persists an IR + prompts; validate_pipeline runs the
// full validator without persisting; run_pipeline starts a task against
// a previously-submitted version.

import { z } from "zod";
import { kernelNextBroadcaster } from "../../sse/singleton.js";
import { startPipelineRun } from "../../runtime/start-pipeline-run.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse, errorResponse } from "../tool-helpers.js";

export function buildPipelineTools(deps: ToolsDeps): ToolDef[] {
  const { db, kernel, tscPath } = deps;

  return [
    {
      name: "submit_pipeline",
      description:
        "Submit a pipeline IR for validation + persistence. Returns the " +
        "version hash on success, or structured diagnostics on failure. " +
        "AgentStage prompts must be supplied via the 'prompts' map " +
        "(promptRef -> content).",
      inputSchema: {
        ir: z.unknown().describe("PipelineIR object (see kernel-next docs)"),
        parentHash: z.string().optional(),
        prompts: z
          .record(z.string(), z.string())
          .optional()
          .describe("Map of promptRef to prompt content; required if the IR contains AgentStage entries"),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const prompts =
            args.prompts && typeof args.prompts === "object"
              ? (args.prompts as Record<string, string>)
              : undefined;
          const result = kernel.submit(args.ir, {
            parentHash: typeof args.parentHash === "string" ? args.parentHash : undefined,
            prompts,
          });
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "run_pipeline",
      description:
        "Start a new task running a previously-submitted pipeline. " +
        "Specify `name` (resolves to latest versionHash) or `versionHash` " +
        "(exact). Returns the taskId — poll get_task_status to observe.",
      inputSchema: {
        name: z.string().optional().describe("Pipeline name; resolves to latest versionHash"),
        versionHash: z.string().optional().describe("Exact pipeline versionHash; overrides name when both supplied"),
        seedValues: z.record(z.string(), z.unknown()).optional().describe("Per-port external input values"),
        policy: z.unknown().optional().describe("ExecutionPolicy (see terminal-design §5.3)"),
        model: z.string().optional(),
        maxTurns: z.number().int().positive().optional(),
        maxBudgetUsd: z.number().positive().optional(),
        taskId: z.string().optional(),
        checkpointConfig: z
          .object({
            enabled: z.boolean().optional(),
            workdir: z.string().optional(),
            maxDiffBytes: z.number().int().positive().optional(),
            timeouts: z
              .object({
                revParseMs: z.number().int().positive().optional(),
                snapshotMs: z.number().int().positive().optional(),
                diffMs: z.number().int().positive().optional(),
              })
              .optional(),
          })
          .optional()
          .describe("Per-task checkpoint config; omit to use defaults (enabled=true, workdir=process.cwd())"),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const result = await startPipelineRun({
            db,
            broadcaster: kernelNextBroadcaster,
            name: typeof args.name === "string" ? args.name : undefined,
            versionHash: typeof args.versionHash === "string" ? args.versionHash : undefined,
            seedValues:
              args.seedValues && typeof args.seedValues === "object"
                ? (args.seedValues as Record<string, unknown>)
                : undefined,
            policy: args.policy as never,
            model: typeof args.model === "string" ? args.model : undefined,
            maxTurns: typeof args.maxTurns === "number" ? args.maxTurns : undefined,
            maxBudgetUsd: typeof args.maxBudgetUsd === "number" ? args.maxBudgetUsd : undefined,
            taskId: typeof args.taskId === "string" ? args.taskId : undefined,
            checkpointConfig:
              args.checkpointConfig && typeof args.checkpointConfig === "object"
                ? (args.checkpointConfig as import("../../runtime/checkpoint/checkpoint.js").CheckpointConfig)
                : undefined,
            tscPath,
          });
          if (result.ok === true) {
            return jsonResponse({
              ok: true,
              taskId: result.taskId,
              versionHash: result.versionHash,
            });
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(result),
            }],
            isError: true,
          };
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "validate_pipeline",
      description:
        "Run the full validation pipeline (zod + structural + DAG + tsc) on " +
        "an IR without persisting. Returns ok + diagnostics[].",
      inputSchema: {
        ir: z.unknown(),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          return jsonResponse(kernel.validate(args.ir));
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
