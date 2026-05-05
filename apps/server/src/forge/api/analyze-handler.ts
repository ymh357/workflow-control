// The end-to-end analyze handler. Given a JSONL path or sessionId,
// runs the full pipeline:
//   1. load session into forge.db
//   2. distill via forge-distill builtin (inline, awaits result)
//   3. embed each pipeline-able episode + refresh pipeline cache
//   4. for each episode: match against existing pipelines
//   5. per-episode branch: use-existing / create-new
//   6. assemble AnalyzeOk { recommendations[], skippedEpisodes[] }
//
// Multi-episode is the norm — one session usually contains several
// distinct units of work. The handler surfaces ALL of them.

import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { distillSession, type DistillResult } from "../distillation/submit-distill.js";
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
import type {
  AnalyzeRequest, AnalyzeResponse, AnalyzeBase,
  PerEpisodeRecommendation, UseExistingRec, CreateNewRec, SkippedEpisode,
} from "./types.js";
import type { SessionEpisode } from "../types.js";

export interface AnalyzeContext {
  forgeDb: DatabaseSync;
  kernelDb: DatabaseSync;
  /** Default: $HOME/.claude-personal/projects */
  projectsRoot?: string;
  /** Default: buildEmbeddingClient() — local-hash provider. */
  embedder?: EmbeddingClient;
  distillTimeoutMs?: number;
  distillPollIntervalMs?: number;
  /**
   * Test seam — replace the distillation step entirely. Default
   * implementation calls the real `distillSession` (which runs
   * `forge-distill` against kernel-next runtime). Tests inject a
   * pre-canned result so they can exercise downstream branching
   * (multi-episode partitioning, matching, etc.) without spinning
   * up a real Claude SDK call.
   */
  distill?: (sessionId: string) => Promise<DistillResult>;
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

  // 2. Load events
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

  // 3. Distill (real or test-injected)
  const distill = ctx.distill
    ? await ctx.distill(load.sessionId)
    : await distillSession({
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
  const base: AnalyzeBase = {
    sessionId: load.sessionId,
    jsonlPath,
    cwd: sessionRow.cwd,
    episodeCount: distill.episodes.length,
    truncated: distill.truncated,
    embeddingModel: embedder.model,
  };

  if (distill.episodes.length === 0) {
    return {
      ...base,
      kind: "no-pattern",
      reason: distill.reasonNoEpisodes ?? "distillation produced no episodes",
    };
  }

  // 4. Partition pipeline-able vs skipped
  const pipelineAble = distill.episodes.filter((e) => e.pipelineAble);
  const skipped: SkippedEpisode[] = distill.episodes
    .filter((e) => !e.pipelineAble)
    .map((episode) => ({
      episode,
      reason: episode.rationale || "marked not pipeline-able by distiller",
    }));

  // If every episode was skipped, no recommendations to make.
  if (pipelineAble.length === 0) {
    return {
      ...base,
      kind: "ok",
      recommendations: [],
      skippedEpisodes: skipped,
      summary: {
        useExistingCount: 0,
        createNewCount: 0,
        skippedCount: skipped.length,
      },
    };
  }

  // 5. Batch-embed all pipeline-able episodes in ONE provider call.
  const epTexts = pipelineAble.map(buildEpisodeText);
  const epEmbeddings = await embedder.embed(epTexts);
  if (epEmbeddings.length !== pipelineAble.length) {
    return {
      kind: "error",
      code: "EMBEDDING_BATCH_MISMATCH",
      message: `embedder returned ${epEmbeddings.length} vectors for ${pipelineAble.length} inputs`,
    };
  }

  // Best-effort cluster recording (non-gating): fire-and-track for each.
  for (let i = 0; i < pipelineAble.length; i++) {
    try {
      clusterEpisode(ctx.forgeDb, pipelineAble[i]!, {
        embedding: epEmbeddings[i]!,
        embeddingModel: embedder.model,
        signatureKey: signatureKeyFromEpisode(pipelineAble[i]!),
        threshold: 0.85,
      });
    } catch { /* swallow */ }
  }

  // 6. Refresh pipeline cache once for all episodes
  await refreshPipelineEmbeddings({
    forgeDb: ctx.forgeDb, kernelDb: ctx.kernelDb, embedder,
  });

  // 7. Per-episode match
  const recommendations: PerEpisodeRecommendation[] = [];
  for (let i = 0; i < pipelineAble.length; i++) {
    const ep = pipelineAble[i]!;
    const emb = epEmbeddings[i]!;
    const match = matchEpisodeAgainstPipelines({
      forgeDb: ctx.forgeDb,
      episodeEmbedding: emb,
      embeddingModel: embedder.model,
      topK: 5,
    });

    if (match.isMatch && match.bestPipelineName && match.bestVersionHash) {
      const rec: UseExistingRec = {
        kind: "use-existing",
        episode: ep,
        pipelineName: match.bestPipelineName,
        versionHash: match.bestVersionHash,
        cosine: match.bestCosine,
        why: buildWhyExisting(ep, match.bestPipelineName, match.bestCosine),
        runUrl: `/kernel-next/pipelines/${encodeURIComponent(match.bestPipelineName)}`,
        alternatives: match.ranking.slice(1).map((r) => ({
          pipelineName: r.pipelineName,
          versionHash: r.versionHash,
          cosine: r.cosine,
        })),
      };
      recommendations.push(rec);
    } else {
      const rec: CreateNewRec = {
        kind: "create-new",
        episode: ep,
        proposal: buildCreateProposal(ep, match.ranking),
      };
      recommendations.push(rec);
    }
  }

  // Sort: use-existing first (immediate value), then create-new.
  recommendations.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "use-existing" ? -1 : 1;
    if (a.kind === "use-existing" && b.kind === "use-existing") return b.cosine - a.cosine;
    return 0;
  });

  const useExistingCount = recommendations.filter((r) => r.kind === "use-existing").length;
  const createNewCount = recommendations.filter((r) => r.kind === "create-new").length;

  return {
    ...base,
    kind: "ok",
    recommendations,
    skippedEpisodes: skipped,
    summary: {
      useExistingCount,
      createNewCount,
      skippedCount: skipped.length,
    },
  };
}

function signatureKeyFromEpisode(ep: SessionEpisode): string {
  return ep.intent.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 5).join("-");
}

function buildWhyExisting(ep: SessionEpisode, pipelineName: string, cosine: number): string {
  return `Episode "${ep.intent}" matches the existing `
    + `pipeline '${pipelineName}' at cosine similarity ${cosine.toFixed(3)} `
    + `(threshold ${MATCH_THRESHOLD}). Run that pipeline instead of building a new one.`;
}

function buildCreateProposal(
  ep: SessionEpisode,
  ranking: Array<{ pipelineName: string; cosine: number }>,
): CreateNewRec["proposal"] {
  // Slice BEFORE the trailing-strip so we don't end up with a slug
  // like "create-database-schema-and-type-definitions-for-" (the
  // truncation cut mid-word and left a trailing hyphen).
  const slug = (ep.intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "")) || "new-pipeline";

  const seenNames = new Set<string>();
  const inputs: Array<{ name: string; type: string; description: string }> = [];
  for (const step of ep.steps) {
    for (const input of step.inputs ?? []) {
      const slugName = input.toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .slice(0, 32)
        .replace(/^_+|_+$/g, "");
      if (!slugName || seenNames.has(slugName)) continue;
      seenNames.add(slugName);
      inputs.push({ name: slugName || `input_${inputs.length + 1}`, type: "string", description: input });
    }
  }

  const stepsText = ep.steps.map((s, i) =>
    `${i + 1}. [${s.stageKind}] ${s.description}`
    + (s.inputs && s.inputs.length > 0 ? `\n   inputs: ${s.inputs.join(", ")}` : "")
    + (s.outputs && s.outputs.length > 0 ? `\n   outputs: ${s.outputs.join(", ")}` : "")
    + (s.toolCalls && s.toolCalls.length > 0 ? `\n   tools: ${s.toolCalls.join(", ")}` : ""),
  ).join("\n");

  const description = `${ep.intent}\n\n${stepsText}`;

  const generatorPrompt = [
    `Build a pipeline named '${slug}' that automates this task:`,
    "",
    ep.intent,
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
    `Outcome of the demonstration: ${ep.outcome}.`,
    `Rationale (why this is automatable): ${ep.rationale}`,
  ].filter(Boolean).join("\n");

  const whyNotExisting = ranking.length > 0 && ranking[0]
    ? `The closest existing pipeline is '${ranking[0].pipelineName}' at cosine `
      + `${ranking[0].cosine.toFixed(3)} (below threshold ${MATCH_THRESHOLD}). `
      + `That pipeline is too dissimilar to reuse; a new pipeline is the better path.`
    : `No existing pipelines are even loosely similar; this is a fresh kind of work.`;

  return {
    suggestedName: slug,
    intent: ep.intent,
    description,
    pipelineGeneratorPrompt: generatorPrompt,
    suggestedExternalInputs: inputs,
    nearestExisting: ranking.slice(0, 3).map((r) => ({ pipelineName: r.pipelineName, cosine: r.cosine })),
    whyNotExisting,
  };
}
