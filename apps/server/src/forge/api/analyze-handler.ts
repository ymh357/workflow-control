// The end-to-end analyze handler. Given a JSONL path or sessionId,
// runs the full pipeline:
//   1. load session into forge.db
//   2. distill via forge-distill builtin (inline, awaits result)
//   3. select primary episode
//   4. embed episode + refresh pipeline embedding cache
//   5. match against existing pipelines
//   6. branch:
//      - cosine ≥ MATCH_THRESHOLD → return use-existing
//      - else → return create-new (with pipeline-generator prompt)
//      - episodes empty → return no-pattern
//
// All steps are inline (request-scoped). Caller awaits.

import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { distillSession } from "../distillation/submit-distill.js";
import {
  loadSession, resolveSessionPath, findMostRecentSessionFile,
} from "../ingestion/session-loader.js";
import { getSession } from "../db/sessions.js";
import {
  buildEmbeddingClient, type EmbeddingClient,
} from "../similarity/embedding-client.js";
import {
  refreshPipelineEmbeddings, matchEpisodeAgainstPipelines, buildEpisodeText,
  MATCH_THRESHOLD,
} from "../matching/pipeline-matcher.js";
import { clusterEpisode } from "../similarity/cluster-episode.js";
import type { AnalyzeRequest, AnalyzeResponse } from "./types.js";
import type { SessionEpisode } from "../types.js";

export interface AnalyzeContext {
  forgeDb: DatabaseSync;
  kernelDb: DatabaseSync;
  /** Default: $HOME/.claude-personal/projects */
  projectsRoot?: string;
  /** Default: buildEmbeddingClient() — local-hash provider. */
  embedder?: EmbeddingClient;
  /** Override for tests; default 5 min. */
  distillTimeoutMs?: number;
  distillPollIntervalMs?: number;
}

export async function analyze(
  ctx: AnalyzeContext,
  req: AnalyzeRequest,
): Promise<AnalyzeResponse> {
  const projectsRoot = ctx.projectsRoot ?? join(homedir(), ".claude-personal", "projects");
  const embedder = ctx.embedder ?? buildEmbeddingClient();

  // 1. Resolve JSONL path
  let jsonlPath: string | null = null;
  if (req.jsonlPath) jsonlPath = req.jsonlPath;
  else if (req.sessionId) jsonlPath = resolveSessionPath(ctx.forgeDb, req.sessionId);
  else jsonlPath = await findMostRecentSessionFile(projectsRoot);

  if (!jsonlPath) {
    return {
      kind: "error",
      code: "NO_SESSION_FOUND",
      message: "no session JSONL provided or detectable",
    };
  }

  // 2. Load events (idempotent)
  let load;
  try {
    load = await loadSession(ctx.forgeDb, jsonlPath);
  } catch (err) {
    return {
      kind: "error",
      code: "LOAD_FAILED",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // 3. Distill
  const distill = await distillSession({
    forgeDb: ctx.forgeDb,
    kernelDb: ctx.kernelDb,
    sessionId: load.sessionId,
    timeoutMs: ctx.distillTimeoutMs,
    pollIntervalMs: ctx.distillPollIntervalMs,
  });
  if (!distill.ok) {
    return {
      kind: "error",
      code: distill.code,
      message: distill.message,
      details: distill.taskId ? { taskId: distill.taskId } : undefined,
    };
  }

  const sessionRow = getSession(ctx.forgeDb, load.sessionId)!;

  if (distill.episodes.length === 0) {
    return {
      kind: "no-pattern",
      sessionId: load.sessionId,
      jsonlPath,
      cwd: sessionRow.cwd,
      episodeCount: 0,
      episodes: [],
      truncated: distill.truncated,
      embeddingModel: embedder.model,
      reason: distill.reasonNoEpisodes ?? "distillation produced no episodes",
    };
  }

  // 4. Select primary episode (largest by event range; tie-break: most recent)
  const primary = selectPrimaryEpisode(distill.episodes);

  // 5. Embed + record cluster signal (non-gating)
  const epText = buildEpisodeText(primary);
  const [primaryEmb] = await embedder.embed([epText]);
  if (!primaryEmb) {
    return {
      kind: "error",
      code: "EMBEDDING_FAILED",
      message: "embedder returned no vector for the primary episode",
    };
  }
  // Best-effort cluster recording — failures here don't block the response
  try {
    clusterEpisode(ctx.forgeDb, primary, {
      embedding: primaryEmb,
      embeddingModel: embedder.model,
      signatureKey: signatureKeyFromEpisode(primary),
      threshold: 0.85,
    });
  } catch { /* swallow */ }

  // 6. Refresh pipeline embeddings + match
  await refreshPipelineEmbeddings({
    forgeDb: ctx.forgeDb, kernelDb: ctx.kernelDb, embedder,
  });
  const match = matchEpisodeAgainstPipelines({
    forgeDb: ctx.forgeDb,
    episodeEmbedding: primaryEmb,
    embeddingModel: embedder.model,
    topK: 5,
  });

  const base = {
    sessionId: load.sessionId,
    jsonlPath,
    cwd: sessionRow.cwd,
    episodeCount: distill.episodes.length,
    episodes: distill.episodes,
    truncated: distill.truncated,
    embeddingModel: embedder.model,
  };

  if (match.isMatch && match.bestPipelineName && match.bestVersionHash) {
    return {
      ...base,
      kind: "use-existing",
      recommendation: {
        pipelineName: match.bestPipelineName,
        versionHash: match.bestVersionHash,
        cosine: match.bestCosine,
        why: buildWhyExisting(primary, match.bestPipelineName, match.bestCosine),
        runUrl: `/kernel-next/pipelines/${encodeURIComponent(match.bestPipelineName)}`,
      },
      alternatives: match.ranking.slice(1).map((r) => ({
        pipelineName: r.pipelineName,
        versionHash: r.versionHash,
        cosine: r.cosine,
      })),
    };
  }

  // create-new branch
  const proposal = buildCreateProposal(primary, distill.episodes, match.ranking);
  return {
    ...base,
    kind: "create-new",
    proposal,
  };
}

function selectPrimaryEpisode(episodes: SessionEpisode[]): SessionEpisode {
  if (episodes.length === 1) return episodes[0]!;
  // Largest range; tie break by most recent endSeq.
  return episodes
    .slice()
    .sort((a, b) => {
      const ra = a.endSeq - a.startSeq;
      const rb = b.endSeq - b.startSeq;
      if (rb !== ra) return rb - ra;
      return b.endSeq - a.endSeq;
    })[0]!;
}

function signatureKeyFromEpisode(ep: SessionEpisode): string {
  // Coarse signature: first 5 verb-ish tokens of the intent. Used as a
  // cheap filter elsewhere; not load-bearing for the analyze flow.
  return ep.intent.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 5).join("-");
}

function buildWhyExisting(ep: SessionEpisode, pipelineName: string, cosine: number): string {
  return `Your session intent ("${ep.intent}") matches the existing `
    + `pipeline '${pipelineName}' at cosine similarity ${cosine.toFixed(3)} `
    + `(threshold ${MATCH_THRESHOLD}). Run that pipeline instead of building a new one.`;
}

function buildCreateProposal(
  primary: SessionEpisode,
  allEpisodes: SessionEpisode[],
  ranking: Array<{ pipelineName: string; cosine: number }>,
): {
  suggestedName: string;
  intent: string;
  description: string;
  pipelineGeneratorPrompt: string;
  suggestedExternalInputs: Array<{ name: string; type: string; description: string }>;
  nearestExisting: Array<{ pipelineName: string; cosine: number }>;
  whyNotExisting: string;
} {
  const slug = primary.intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "new-pipeline";

  // Suggest external inputs from the primary episode's first step's
  // abstract `inputs` array. These are already abstract (the
  // distillation prompt enforces it).
  const seenNames = new Set<string>();
  const inputs: Array<{ name: string; type: string; description: string }> = [];
  for (const step of primary.steps) {
    for (const input of step.inputs ?? []) {
      const slugName = input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
      if (!slugName || seenNames.has(slugName)) continue;
      seenNames.add(slugName);
      inputs.push({ name: slugName || `input_${inputs.length + 1}`, type: "string", description: input });
    }
  }

  const stepsText = primary.steps.map((s, i) =>
    `${i + 1}. [${s.stageKind}] ${s.description}`
    + (s.inputs && s.inputs.length > 0 ? `\n   inputs: ${s.inputs.join(", ")}` : "")
    + (s.outputs && s.outputs.length > 0 ? `\n   outputs: ${s.outputs.join(", ")}` : "")
    + (s.toolCalls && s.toolCalls.length > 0 ? `\n   tools: ${s.toolCalls.join(", ")}` : "")
  ).join("\n");

  const description = `${primary.intent}\n\n${stepsText}`;

  const generatorPrompt = [
    `Build a pipeline named '${slug}' that automates this task:`,
    "",
    primary.intent,
    "",
    "The user demonstrated this in a Claude Code session. Steps observed:",
    "",
    stepsText,
    "",
    inputs.length > 0
      ? "Suggested external inputs (one per parameterizable input):\n"
        + inputs.map((i) => `- ${i.name} (${i.type}): ${i.description}`).join("\n")
      : "No clearly-parameterizable inputs detected; design the pipeline with whatever externalInputs make sense.",
    "",
    `Outcome of the demonstration: ${primary.outcome}.`,
    `Rationale (why this is automatable): ${primary.rationale}`,
    allEpisodes.length > 1
      ? `\nNote: the session contained ${allEpisodes.length} distinct episodes; the primary one is summarized above.`
      : "",
  ].filter(Boolean).join("\n");

  const whyNotExisting = ranking.length > 0 && ranking[0]
    ? `The closest existing pipeline is '${ranking[0].pipelineName}' at cosine `
      + `${ranking[0].cosine.toFixed(3)} (below threshold ${MATCH_THRESHOLD}). `
      + `That pipeline is too dissimilar to reuse; a new pipeline is the better path.`
    : `No existing pipelines are even loosely similar; this is a fresh kind of work.`;

  return {
    suggestedName: slug,
    intent: primary.intent,
    description,
    pipelineGeneratorPrompt: generatorPrompt,
    suggestedExternalInputs: inputs,
    nearestExisting: ranking.slice(0, 3).map((r) => ({ pipelineName: r.pipelineName, cosine: r.cosine })),
    whyNotExisting,
  };
}
