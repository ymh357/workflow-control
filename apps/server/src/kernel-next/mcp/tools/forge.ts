// MCP tools: forge_analyze_start + forge_analyze_result. Invoked
// from inside a Claude Code session (or any MCP client) to run the
// full Forge analysis on a session JSONL and return per-episode
// pipeline recommendations.
//
// IMPORTANT — async by design. forge-distill calls Claude SDK; that
// agent stage typically takes 60-180 seconds. MCP tool invocations
// have a ~60s timeout in most clients (Claude Code included). We
// expose two tools instead of one:
//
//   forge_analyze_start    → returns analysisId in <1s; spawns the
//                            forge-distill kernel-next task.
//   forge_analyze_result   → polls the task; returns either
//                            {status: "running"} or the final
//                            recommendation set.
//
// The agent loop is "call start, then poll result with sleep until
// status !== 'running'". This is the same pattern kernel-next's
// `run_pipeline` + `get_task_status` already use.

import { z } from "zod";
import {
  analyzeStart,
  analyzeHarvest,
} from "../../../forge/api/analyze-handler.js";
import type {
  AnalyzeStartResponse,
  AnalyzeHarvestResponse,
} from "../../../forge/api/analyze-handler.js";
import type { AnalyzeResponse } from "../../../forge/api/types.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse } from "../tool-helpers.js";

export function buildForgeTools(deps: ToolsDeps): ToolDef[] {
  if (!deps.forgeDb) return [];
  const forgeDb = deps.forgeDb;
  const kernelDb = deps.db;

  return [
    {
      name: "forge_analyze_start",
      description:
        "Start an asynchronous Forge analysis on a Claude Code session JSONL. "
        + "Returns an `analysisId` immediately (sub-second); the actual distillation "
        + "runs as a kernel-next task in the background and typically takes 60-180s. "
        + "Use `forge_analyze_result` to poll for completion. "
        + "Call with no args to auto-detect the most recent session under "
        + "$HOME/.claude-personal/projects/. Provide `sessionId` (UUID) or "
        + "`jsonlPath` (absolute path) to target a specific session.",
      inputSchema: {
        sessionId: z.string().optional().describe(
          "Claude Code session UUID. Resolves to a JSONL path via Forge's session index.",
        ),
        jsonlPath: z.string().optional().describe(
          "Absolute filesystem path to a Claude Code session JSONL file.",
        ),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        const result = await analyzeStart(
          { forgeDb, kernelDb },
          {
            sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
            jsonlPath: typeof args.jsonlPath === "string" ? args.jsonlPath : undefined,
          },
        );
        return jsonResponse(formatStartForMcp(result));
      },
    },
    {
      name: "forge_analyze_result",
      description:
        "Poll a running Forge analysis. Pass the `analysisId` returned by "
        + "`forge_analyze_start`. Returns either {status: 'running'} (call again "
        + "after a short wait — typically 5-10s) or the final recommendations. "
        + "When the result is final, each pipeline-able episode in the session "
        + "has its own recommendation (use-existing or create-new with a "
        + "ready-to-paste pipeline-generator prompt).",
      inputSchema: {
        analysisId: z.string().describe(
          "The analysisId from forge_analyze_start. Self-describing token; "
            + "no server-side state to look up.",
        ),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        const id = typeof args.analysisId === "string" ? args.analysisId : "";
        const result = await analyzeHarvest({ forgeDb, kernelDb }, id);
        return jsonResponse(formatHarvestForMcp(result));
      },
    },
  ];
}

function formatStartForMcp(result: AnalyzeStartResponse): unknown {
  if (result.kind === "error") {
    return {
      ...result,
      humanSummary: `Forge analysis could not start: ${result.code} — ${result.message}`,
    };
  }
  return {
    ...result,
    humanSummary:
      `Forge analysis started for session ${result.sessionId} (taskId ${result.taskId}). `
      + `Distillation runs in the background. Call forge_analyze_result with `
      + `analysisId="${result.analysisId}" — typically takes 60-180s. Poll every 5-10s.`,
  };
}

function formatHarvestForMcp(result: AnalyzeHarvestResponse): unknown {
  if (result.kind === "running") {
    return {
      ...result,
      humanSummary:
        `Analysis still running (taskId ${result.taskId}, status ${result.status}). `
        + `Wait a few seconds and call forge_analyze_result again with the same analysisId.`,
    };
  }
  return formatFinalForMcp(result);
}

// Reduce the response to a shape that's pleasant to read in the
// Claude Code agent UI. Episodes carry rationale + steps; the agent
// will summarise them to the user. We DO NOT strip the structured
// fields — agents reasoning over the result need pipelineName /
// versionHash / suggestedName / pipelineGeneratorPrompt verbatim.
function formatFinalForMcp(result: AnalyzeResponse): unknown {
  if (result.kind === "error") {
    return {
      ...result,
      humanSummary: `Forge analysis failed: ${result.code} — ${result.message}`,
    };
  }
  if (result.kind === "no-pattern") {
    return {
      ...result,
      humanSummary: `No pipeline-able pattern detected in session ${result.sessionId}: ${result.reason}`,
    };
  }
  // kind: "ok"
  const lines: string[] = [];
  lines.push(`Forge analysis of session ${result.sessionId}:`);
  lines.push(
    `${result.episodeCount} episode${result.episodeCount === 1 ? "" : "s"} detected. `
      + `${result.summary.useExistingCount} can run an existing pipeline; `
      + `${result.summary.createNewCount} would need a new pipeline; `
      + `${result.summary.skippedCount} not pipeline-able.`,
  );
  if (result.recommendations.length === 0) {
    lines.push("No automation candidates this session — every detected episode was one-off / exploratory.");
  } else {
    lines.push("");
    lines.push("Recommendations:");
    for (let i = 0; i < result.recommendations.length; i++) {
      const r = result.recommendations[i]!;
      if (r.kind === "use-existing") {
        lines.push(`  ${i + 1}. [USE EXISTING] "${r.episode.intent}" → run pipeline '${r.pipelineName}' (cosine ${r.cosine.toFixed(3)}).`);
      } else {
        lines.push(`  ${i + 1}. [CREATE NEW] "${r.episode.intent}" → propose pipeline '${r.proposal.suggestedName}'. Paste the included pipelineGeneratorPrompt into pipeline-generator.`);
      }
    }
  }
  return {
    ...result,
    humanSummary: lines.join("\n"),
  };
}
