// MCP tool: forge_analyze. Invoked from inside a Claude Code session
// (or any MCP client) to run the full Forge analysis on a session
// JSONL and return per-episode pipeline recommendations. The user
// gets a structured response they can act on without leaving the
// agent — "use existing pipeline X" or "create new pipeline Y with
// this prompt".
//
// Note: this is the SAME logic as POST /api/forge/analyze, exposed
// over MCP. See apps/server/src/forge/api/analyze-handler.ts for the
// implementation; this file is a thin adapter.

import { z } from "zod";
import { analyze } from "../../../forge/api/analyze-handler.js";
import type { ToolDef, ToolsDeps } from "../tool-types.js";
import { jsonResponse } from "../tool-helpers.js";

export function buildForgeTools(deps: ToolsDeps): ToolDef[] {
  if (!deps.forgeDb) return [];
  const forgeDb = deps.forgeDb;
  const kernelDb = deps.db;

  return [
    {
      name: "forge_analyze",
      description:
        "Analyze a Claude Code session JSONL for automation candidates. "
        + "One session typically contains multiple distinct tasks; this tool "
        + "returns a recommendation per pipeline-able episode: either run an "
        + "existing pipeline (when the embedding matches at cosine ≥ 0.78) "
        + "or create a new one (with a ready-to-paste pipeline-generator "
        + "prompt). Call with no args to auto-detect the most recent session "
        + "under $HOME/.claude-personal/projects/. Provide `sessionId` (UUID) "
        + "or `jsonlPath` (absolute path) to target a specific session.",
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
        const result = await analyze(
          { forgeDb, kernelDb },
          {
            sessionId: typeof args.sessionId === "string" ? args.sessionId : undefined,
            jsonlPath: typeof args.jsonlPath === "string" ? args.jsonlPath : undefined,
          },
        );
        return jsonResponse(formatForMcp(result));
      },
    },
  ];
}

// Reduce the response to a shape that's pleasant to read in the
// Claude Code agent UI. Episodes carry rationale + steps; the agent
// will summarise them to the user. We DO NOT strip the structured
// fields — agents reasoning over the result need pipelineName /
// versionHash / suggestedName / pipelineGeneratorPrompt verbatim.
//
// We only add a top-level `humanSummary` line so the agent has an
// obvious thing to read out loud.
function formatForMcp(result: import("../../../forge/api/types.js").AnalyzeResponse): unknown {
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
