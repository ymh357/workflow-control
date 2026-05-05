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
import {
  distillSession,
  startDistill,
  harvestDistillResult,
  type DistillResult,
} from "../distillation/submit-distill.js";
import {
  loadSession, resolveSessionPath, findMostRecentSessionFile,
  listRecentSessionFiles,
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
  AnalyzeRequest, AnalyzeResponse, AnalyzeBase, AnalyzeError,
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
  return finalizeAnalyze(ctx, embedder, jsonlPath, load.sessionId, distill);
}

async function finalizeAnalyze(
  ctx: AnalyzeContext,
  embedder: EmbeddingClient,
  jsonlPath: string,
  sessionId: string,
  distill: DistillResult,
): Promise<AnalyzeResponse> {
  if (!distill.ok) {
    return {
      kind: "error",
      code: distill.code,
      message: distill.message,
      details: distill.taskId ? { taskId: distill.taskId } : undefined,
    };
  }

  const sessionRow = getSession(ctx.forgeDb, sessionId)!;
  const base: AnalyzeBase = {
    sessionId,
    jsonlPath,
    cwd: sessionRow.cwd,
    projectDirEncoded: true,
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

// ---------------- Async API (split for MCP) ------------------------
//
// MCP tool calls have a ~60s timeout; the agent stage inside
// forge-distill takes 60-180s. So we expose a 2-step API:
//
//   analyzeStart(req)   → returns { analysisId } in <1s
//   analyzeHarvest(id)  → polls once. status="running" or kind="ok"/"no-pattern"/"error".
//
// analysisId IS the kernel-next taskId (a short, ergonomic identifier
// like `forge-distill-1777993813697-4d43d155`). The full handle —
// sessionId, jsonlPath, truncated flag, optional empty-result cache —
// lives server-side in the `forge_analyses` table keyed by
// analysis_id. Empty-session shortcut paths use a synthetic
// `empty-<ts>-<rand>` analysis_id since no kernel task spawned.

import { insertAnalysis, getAnalysis } from "../db/analyses.js";

export type AnalyzeStartResponse =
  | { kind: "started"; analysisId: string; sessionId: string; taskId: string; jsonlPath: string }
  | AnalyzeError;

export async function analyzeStart(
  ctx: AnalyzeContext,
  req: AnalyzeRequest,
): Promise<AnalyzeStartResponse> {
  const projectsRoot = ctx.projectsRoot ?? join(homedir(), ".claude-personal", "projects");

  let jsonlPath: string | null = null;
  if (req.jsonlPath) jsonlPath = req.jsonlPath;
  else if (req.sessionId) jsonlPath = resolveSessionPath(ctx.forgeDb, req.sessionId);
  else jsonlPath = await findMostRecentSessionFile(projectsRoot);

  if (!jsonlPath) {
    return { kind: "error", code: "NO_SESSION_FOUND", message: "no session JSONL provided or detectable" };
  }

  let load;
  try {
    load = await loadSession(ctx.forgeDb, jsonlPath);
  } catch (err) {
    return { kind: "error", code: "LOAD_FAILED", message: err instanceof Error ? err.message : String(err) };
  }

  const start = await startDistill({
    forgeDb: ctx.forgeDb, kernelDb: ctx.kernelDb, sessionId: load.sessionId,
  });
  if (!start.ok) {
    return { kind: "error", code: start.code, message: start.message };
  }

  // analysisId = taskId for the real-distill path. For the
  // empty-session shortcut, the start helper returns taskId === "" —
  // synthesise a unique id so the harvest can find the row.
  const analysisId = start.taskId !== ""
    ? start.taskId
    : `empty-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

  insertAnalysis(ctx.forgeDb, {
    analysisId,
    sessionId: load.sessionId,
    jsonlPath,
    taskId: start.taskId,
    truncated: start.truncated,
    startedAt: Date.now(),
    emptyResult: start.emptySessionResult
      ? {
          episodes: start.emptySessionResult.episodes,
          reasonNoEpisodes: start.emptySessionResult.reasonNoEpisodes,
        }
      : undefined,
  });

  return {
    kind: "started",
    analysisId,
    sessionId: load.sessionId,
    taskId: start.taskId,
    jsonlPath,
  };
}

export type AnalyzeHarvestResponse =
  | { kind: "running"; analysisId: string; taskId: string; sessionId: string; status: string }
  | AnalyzeResponse;

export interface AnalyzeHarvestOpts {
  /**
   * If set, internally polls the distill task until either it
   * reaches a terminal state OR `waitMs` elapses. Designed so the
   * caller (typically an MCP agent) doesn't have to maintain its own
   * sleep-and-retry loop. Bounded to a hard ceiling of 50_000 ms to
   * leave headroom under MCP tool-call timeouts (~60s).
   *
   *   waitMs === 0 (or omitted) → single non-blocking poll (legacy)
   *   waitMs > 0                → poll every WAIT_POLL_INTERVAL_MS
   *                                until done or wait elapses
   */
  waitMs?: number;
}

const WAIT_MS_MAX = 50_000;
const WAIT_POLL_INTERVAL_MS = 1_000;

export async function analyzeHarvest(
  ctx: AnalyzeContext,
  analysisId: string,
  opts: AnalyzeHarvestOpts = {},
): Promise<AnalyzeHarvestResponse> {
  const handle = getAnalysis(ctx.forgeDb, analysisId);
  if (!handle) {
    return { kind: "error", code: "INVALID_ANALYSIS_ID", message: "analysisId not found" };
  }
  const embedder = ctx.embedder ?? buildEmbeddingClient();

  // Empty-session shortcut: distill never spawned, return the result directly.
  if (handle.taskId === "" && handle.emptyResult) {
    const distill: DistillResult = {
      ok: true,
      episodes: handle.emptyResult.episodes,
      taskId: "",
      truncated: false,
      reasonNoEpisodes: handle.emptyResult.reasonNoEpisodes,
    };
    return finalizeAnalyze(ctx, embedder, handle.jsonlPath, handle.sessionId, distill);
  }

  const waitMs = clampWaitMs(opts.waitMs);
  const deadline = waitMs > 0 ? Date.now() + waitMs : 0;

  // First poll always runs. When waitMs > 0, keep polling until
  // terminal or until the deadline passes (then surface "running"
  // so the caller can re-issue with the same analysisId).
  let lastRunningStatus = "running";
  while (true) {
    const harvest = harvestDistillResult({
      forgeDb: ctx.forgeDb,
      kernelDb: ctx.kernelDb,
      sessionId: handle.sessionId,
      taskId: handle.taskId,
      truncated: handle.truncated,
    });
    if (harvest.kind === "done") {
      return finalizeAnalyze(ctx, embedder, handle.jsonlPath, handle.sessionId, harvest.result);
    }
    lastRunningStatus = harvest.status;
    if (deadline === 0 || Date.now() >= deadline) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(WAIT_POLL_INTERVAL_MS, remaining));
  }

  return {
    kind: "running",
    analysisId,
    taskId: handle.taskId,
    sessionId: handle.sessionId,
    status: lastRunningStatus,
  };
}

// Exported for direct testing — captures the boundary contract
// (negative / NaN / Infinity → 0; over-cap → WAIT_MS_MAX).
export function clampWaitMs(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.floor(raw), WAIT_MS_MAX);
}

// ---------------- Multi-session kickoff ---------------------------
//
// "I worked on three small things over the last hour, can you tell
// me which ones are worth automating?" The answer used to require
// three forge_analyze_start calls with three different sessionIds.
// analyzeRecent kicks off N analyses in parallel so the agent can
// poll all of them with the existing forge_analyze_result tool.

export interface AnalyzeRecentRequest {
  /** Default 3, capped at RECENT_COUNT_MAX (10). */
  count?: number;
}

export type AnalyzeRecentResponse =
  | {
      kind: "started";
      analyses: Array<{
        sessionId: string;
        analysisId: string;
        taskId: string;
        jsonlPath: string;
      }>;
      // Sessions that we tried but couldn't start. Surfaced
      // explicitly so the agent doesn't silently see "we asked for 3,
      // got 1, must be normal". Common causes: stale jsonl path,
      // permission errors, distill submit failure on a single
      // session.
      failures: Array<{
        jsonlPath: string;
        code: string;
        message: string;
      }>;
    }
  | AnalyzeError;

const RECENT_COUNT_DEFAULT = 3;
const RECENT_COUNT_MAX = 10;

export async function analyzeRecent(
  ctx: AnalyzeContext,
  req: AnalyzeRecentRequest = {},
): Promise<AnalyzeRecentResponse> {
  const projectsRoot = ctx.projectsRoot ?? join(homedir(), ".claude-personal", "projects");
  const requested = typeof req.count === "number" && Number.isFinite(req.count) && req.count > 0
    ? Math.floor(req.count)
    : RECENT_COUNT_DEFAULT;
  const count = Math.min(requested, RECENT_COUNT_MAX);

  const paths = await listRecentSessionFiles(projectsRoot, count);
  if (paths.length === 0) {
    return { kind: "started", analyses: [], failures: [] };
  }

  // Run starts in parallel — each one is sub-second by design (no
  // distill SDK call until kernel-next picks the task up).
  const settled = await Promise.allSettled(
    paths.map(async (p) => ({ path: p, result: await analyzeStart(ctx, { jsonlPath: p }) })),
  );

  type RecentSuccess = {
    sessionId: string;
    analysisId: string;
    taskId: string;
    jsonlPath: string;
  };
  type RecentFailure = { jsonlPath: string; code: string; message: string };
  const analyses: RecentSuccess[] = [];
  const failures: RecentFailure[] = [];

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]!;
    const path = paths[i]!;
    if (s.status === "rejected") {
      failures.push({
        jsonlPath: path,
        code: "START_THREW",
        message: s.reason instanceof Error ? s.reason.message : String(s.reason),
      });
      continue;
    }
    const v = s.value.result;
    if (v.kind === "error") {
      failures.push({ jsonlPath: path, code: v.code, message: v.message });
      continue;
    }
    analyses.push({
      sessionId: v.sessionId,
      analysisId: v.analysisId,
      taskId: v.taskId,
      jsonlPath: v.jsonlPath,
    });
  }
  return { kind: "started", analyses, failures };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function signatureKeyFromEpisode(ep: SessionEpisode): string {
  return ep.intent.toLowerCase().split(/\s+/).filter((w) => w.length > 2).slice(0, 5).join("-");
}

function buildWhyExisting(ep: SessionEpisode, pipelineName: string, cosine: number): string {
  return `Episode "${ep.intent}" matches the existing `
    + `pipeline '${pipelineName}' at cosine similarity ${cosine.toFixed(3)} `
    + `(threshold ${MATCH_THRESHOLD}). Run that pipeline instead of building a new one.`;
}

// Word-boundary-aware slug truncation. Tokenises on non-alphanumeric
// runs, joins with `sep`, and stops appending tokens once adding the
// next one would exceed `maxLen`. Never cuts inside a word — the
// previous .slice(0, N) approach produced live regressions like
// "discovered_urls_from_search_resu" (cut at "resu") and
// "research-a-web3-protocol-s-cross-chain-bridge-ar".
//
// Edge case: a single token longer than maxLen is returned in full
// rather than mid-word truncated. The caller decides whether to
// truncate or fall back. (Empirically the longest single tokens we
// see are user-typed identifiers like step names; a long-but-whole
// slug is more useful than a shortened-but-broken one.)
export function safeSlug(text: string, maxLen: number, sep: "-" | "_"): string {
  const tokens = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/);
  let out = "";
  for (const t of tokens) {
    if (!t) continue;
    if (!out) { out = t; continue; }
    const next = out + sep + t;
    if (next.length > maxLen) break;
    out = next;
  }
  return out;
}

function buildCreateProposal(
  ep: SessionEpisode,
  ranking: Array<{ pipelineName: string; cosine: number }>,
): CreateNewRec["proposal"] {
  // Truncate at a word boundary so slugs never end mid-word (real
  // regression: "research-a-web3-protocol-s-cross-chain-bridge-ar"
  // and "discovered_urls_from_search_resu" both leaked through old
  // .slice(0, N) approach).
  const slug = safeSlug(ep.intent, 48, "-") || "new-pipeline";

  const seenNames = new Set<string>();
  const inputs: Array<{ name: string; type: string; description: string }> = [];
  for (const step of ep.steps) {
    for (const input of step.inputs ?? []) {
      const slugName = safeSlug(input, 32, "_");
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
    pipelineGeneratorPrompt: generatorPrompt,
    suggestedExternalInputs: inputs,
    nearestExisting: ranking.slice(0, 3).map((r) => ({ pipelineName: r.pipelineName, cosine: r.cosine })),
    whyNotExisting,
  };
}
