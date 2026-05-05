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
  analyzeRecent,
} from "../../../forge/api/analyze-handler.js";
import type {
  AnalyzeStartResponse,
  AnalyzeHarvestResponse,
  AnalyzeRecentResponse,
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
      name: "forge_analyze_recent",
      description:
        "Start Forge analyses on the N most-recently-modified Claude Code "
        + "session JSONLs in parallel. Default count=3, max=10. Returns "
        + "one analysisId per session immediately (sub-second total — no "
        + "blocking on distill). Poll each analysisId with "
        + "`forge_analyze_result` (typically with waitMs=50000) to harvest "
        + "the recommendations. Use this when the user says \"tell me "
        + "what I should automate from my recent work\".",
      inputSchema: {
        count: z.number().int().min(1).max(10).optional().describe(
          "Number of recent sessions to analyze. Default 3, max 10.",
        ),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        const count = typeof args.count === "number" ? args.count : undefined;
        const result = await analyzeRecent({ forgeDb, kernelDb }, { count });
        return jsonResponse(formatRecentForMcp(result));
      },
    },
    {
      name: "forge_analyze_result",
      description:
        "Poll a running Forge analysis. Pass the `analysisId` returned by "
        + "`forge_analyze_start`. By default the server blocks for up to "
        + "`waitMs` (default 50000, max 50000) waiting for the distill task "
        + "to finish — so a typical analysis returns the final result in a "
        + "single call. If the task is still running when waitMs elapses, "
        + "the response is {status: 'running'} and the caller should re-issue "
        + "with the same analysisId. Pass `waitMs: 0` for a single "
        + "non-blocking poll.",
      inputSchema: {
        analysisId: z.string().describe(
          "The analysisId from forge_analyze_start (a short kernel-next "
            + "task id like `forge-distill-1777993813697-4d43d155`). "
            + "Resolved server-side against the forge_analyses table.",
        ),
        waitMs: z.number().int().min(0).max(50000).optional().describe(
          "How long to block waiting for the task to finish, in ms. "
            + "Default 50000 (50s — leaves ~10s headroom under the MCP "
            + "tool-call timeout). 0 = single non-blocking poll.",
        ),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (args: any) => {
        const id = typeof args.analysisId === "string" ? args.analysisId : "";
        const waitMs = typeof args.waitMs === "number" ? args.waitMs : 50_000;
        const result = await analyzeHarvest({ forgeDb, kernelDb }, id, { waitMs });
        return jsonResponse(formatHarvestForMcp(result));
      },
    },
  ];
}

function formatRecentForMcp(result: AnalyzeRecentResponse): unknown {
  if (result.kind === "error") {
    return {
      ...result,
      humanSummary: `forge_analyze_recent failed: ${result.code} — ${result.message}`,
    };
  }
  if (result.analyses.length === 0 && result.failures.length === 0) {
    return {
      ...result,
      humanSummary:
        "No recent Claude Code sessions found under the configured projects "
        + "root. Have you used Claude Code recently?",
    };
  }
  const lines: string[] = [];
  if (result.analyses.length > 0) {
    lines.push(`Started ${result.analyses.length} parallel analyses:`);
    for (let i = 0; i < result.analyses.length; i++) {
      const a = result.analyses[i]!;
      lines.push(`  ${i + 1}. session ${a.sessionId} → analysisId ${a.analysisId}`);
    }
    lines.push("");
    lines.push(
      "Poll each analysisId with forge_analyze_result (waitMs=50000 will "
      + "typically return the final result in one call). Distill takes 60-180s "
      + "per session — they run in parallel so total wait is ~the slowest one.",
    );
  }
  if (result.failures.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`${result.failures.length} session(s) could not be started:`);
    for (const f of result.failures) {
      lines.push(`  - ${f.jsonlPath}: ${f.code} — ${f.message}`);
    }
  }
  return { ...result, humanSummary: lines.join("\n") };
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
