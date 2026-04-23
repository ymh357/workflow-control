// Debug-domain MCP tools: replay_stage, dry_run_stage, propose_pipeline_fix.
// These wrap the live debug/ module implementations (kernel-next/debug/*.ts)
// as MCP tool surfaces — they are LIVE product surfaces, not just test-only.

import { z } from "zod";
import { RealStageExecutor } from "../../runtime/real-executor.js";
import { DbPromptResolver } from "../../runtime/db-prompt-resolver.js";
import { replayStage } from "../../debug/replay-stage.js";
import { dryRunStage } from "../../debug/dry-run-stage.js";
import { proposePipelineFix, proposePipelineFixWithAi } from "../../debug/propose-pipeline-fix.js";
import { createClaudeSdkPatchSynthesizer } from "../../debug/claude-sdk-patch-synthesizer.js";
import { analyzeTaskFailure } from "../../../lib/debug-queries.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse, errorResponse } from "../tool-helpers.js";

export function buildDebugTools(deps: ToolsDeps): ToolDef[] {
  const { db, createMcpServer } = deps;

  return [
    {
      name: "replay_stage",
      description:
        "Re-execute a specific stage attempt with the same inputs as the " +
        "original (reconstructed from lineage reads). Produces a NEW attempt " +
        "tagged kind='replay' + replayed_from_attempt_id, leaving the source " +
        "attempt untouched. Useful for debugging flaky agent stages or " +
        "reproducing a prior failure under current conditions. Only 'regular' " +
        "attempts of agent/script stages are replayable; external-seed, gate, " +
        "fanout, and prior-replay attempts are rejected with " +
        "SOURCE_STAGE_NOT_REPLAYABLE.",
      inputSchema: {
        attemptId: z.string().describe("attempt_id of the source attempt to replay"),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const sourceAttemptId = String(args.attemptId);
          // DbPromptResolver is version-bound; look up the source
          // attempt's version_hash first so the executor resolves
          // prompts against the right pipeline version. replay-stage's
          // preflight will re-derive the same hash, but we need it
          // here to construct the executor.
          const versionRow = db.prepare(
            `SELECT version_hash FROM stage_attempts WHERE attempt_id = ?`,
          ).get(sourceAttemptId) as { version_hash: string } | undefined;
          if (!versionRow) {
            return jsonResponse({
              ok: false,
              code: "SOURCE_ATTEMPT_NOT_FOUND",
              message: `no stage_attempts row with attempt_id='${sourceAttemptId}'`,
            });
          }
          const executor = new RealStageExecutor({
            mcpServerFactory: (_dispatcher, portRuntime) =>
              createMcpServer("combined", portRuntime),
            promptResolver: new DbPromptResolver(db, versionRow.version_hash),
          });
          const result = await replayStage({
            db,
            sourceAttemptId,
            executor,
          });
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "dry_run_stage",
      description:
        "Run a SINGLE stage against caller-supplied inputs, without " +
        "requiring a task or prior attempt. Produces a fresh attempt " +
        "tagged kind='dry_run' under a synthetic task_id prefixed " +
        "'dry_run-'. No events propagate to any running XState machine " +
        "(inert dispatcher). Only 'agent' and 'script' stages are " +
        "supported; gates are rejected with STAGE_NOT_DRY_RUNNABLE. " +
        "All inputs declared by the target stage must be supplied in " +
        "the 'inputs' object; missing inputs are rejected up-front " +
        "with MISSING_INPUT.",
      inputSchema: {
        pipelineVersion: z.string().describe("version_hash of the pipeline that declares the target stage"),
        stageName: z.string().describe("name of the stage within that pipeline"),
        inputs: z.record(z.string(), z.unknown()).describe("flat input map keyed by port name"),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const pipelineVersion = String(args.pipelineVersion);
          const stageName = String(args.stageName);
          const inputs =
            args.inputs && typeof args.inputs === "object"
              ? (args.inputs as Record<string, unknown>)
              : {};
          const executor = new RealStageExecutor({
            mcpServerFactory: (_dispatcher, portRuntime) =>
              createMcpServer("combined", portRuntime),
            promptResolver: new DbPromptResolver(db, pipelineVersion),
          });
          const result = await dryRunStage({
            db,
            pipelineVersion,
            stageName,
            inputs,
            executor,
          });
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
    {
      name: "propose_pipeline_fix",
      description:
        "Given a failing taskId, analyse its stage_attempts + agent " +
        "execution detail and produce a list of concrete pipeline-change " +
        "suggestions. Rule-based foundation surfaces stuck-open attempts, " +
        "error_status failures, error markers in agent streams, " +
        "supersede/interrupt provenance, and zero-attempt anomalies as " +
        "human-readable suggestions tagged with severity. Each suggestion " +
        "may carry a proposedPatch (IRPatch) — the rule layer leaves these " +
        "undefined. Set aiPatch=true to let a Claude sub-session propose " +
        "update_stage_config patches for every non-info suggestion (safe " +
        "range only; other patch shapes are rejected). aiPatch costs API " +
        "tokens and adds latency; default off.",
      inputSchema: {
        taskId: z.string().describe("task_id whose failure we want suggestions for"),
        aiPatch: z.boolean().optional().describe("When true, use a Claude sub-session to synthesise update_stage_config patches. Default false."),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        try {
          const taskId = String(args.taskId);
          const useAi = Boolean(args.aiPatch);
          const report = analyzeTaskFailure(taskId);
          if (useAi) {
            const synth = createClaudeSdkPatchSynthesizer({
              model: deps.pipelineGeneratorModel,
            });
            const result = await proposePipelineFixWithAi({
              db, taskId, report, aiPatchSynthesizer: synth,
            });
            return jsonResponse(result);
          }
          const result = proposePipelineFix({ db, taskId, report });
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err instanceof Error ? err.message : String(err));
        }
      },
    },
  ];
}
