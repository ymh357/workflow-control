// Pipeline matcher: given an episode's intent + step text, find the
// best matching existing pipeline. Refreshes the pipeline_embeddings
// cache lazily — for any pipeline_versions row not present in the
// cache (or present with a stale model), embeds the descriptor and
// upserts.

import type { DatabaseSync } from "node:sqlite";
import { listPipelineVersions, getPipelineIR, getLatestVersionHashByName } from "../../kernel-next/ir/sql.js";
import { buildPipelineDescriptor } from "./pipeline-descriptor.js";
import {
  listPipelineEmbeddings, upsertPipelineEmbedding, getPipelineEmbedding,
} from "../db/pipeline-embeddings.js";
import { cosine } from "../similarity/cluster.js";
import type { EmbeddingClient } from "../similarity/embedding-client.js";
import type { SessionEpisode } from "../types.js";

export const MATCH_THRESHOLD = 0.78;

export interface MatchResult {
  bestPipelineName: string | null;
  bestVersionHash: string | null;
  bestCosine: number;
  /** Top-K results (descending cosine). */
  ranking: Array<{ pipelineName: string; versionHash: string; cosine: number }>;
  /** True iff bestCosine >= MATCH_THRESHOLD. */
  isMatch: boolean;
  /** Embedding model used for both episode + pipelines. */
  embeddingModel: string;
}

/**
 * Build the embedding text for an episode. Combines intent + step
 * descriptions; pure function so the caller controls when this runs.
 */
export function buildEpisodeText(episode: SessionEpisode): string {
  const parts: string[] = [episode.intent];
  for (const s of episode.steps) {
    parts.push(`${s.stageKind} ${s.description}`);
    if (s.inputs) parts.push("inputs " + s.inputs.join(" "));
    if (s.outputs) parts.push("outputs " + s.outputs.join(" "));
    if (s.toolCalls) parts.push("tools " + s.toolCalls.join(" "));
  }
  return parts.join("\n");
}

/**
 * Refresh the pipeline_embeddings cache so it covers every pipeline
 * version currently known to kernel-next. Idempotent. Embeddings for
 * pipelines whose version_hash hasn't changed are reused. Old hashes
 * left in the cache are kept (audit trail; small storage cost).
 */
export async function refreshPipelineEmbeddings(args: {
  forgeDb: DatabaseSync;
  kernelDb: DatabaseSync;
  embedder: EmbeddingClient;
}): Promise<{ refreshed: number; reused: number }> {
  const { forgeDb, kernelDb, embedder } = args;

  // Get the latest version per pipeline name only (we don't match
  // against historical versions; matching against the latest is what
  // the user wants when running the recommended pipeline).
  const allHashes = listPipelineVersions(kernelDb);
  const seenNames = new Set<string>();
  const latestHashes: string[] = [];
  for (const hash of allHashes) {
    const ir = getPipelineIR(kernelDb, hash);
    if (!ir) continue;
    if (seenNames.has(ir.name)) continue;
    const latest = getLatestVersionHashByName(kernelDb, ir.name);
    if (latest !== hash) continue;
    seenNames.add(ir.name);
    latestHashes.push(hash);
  }

  let refreshed = 0;
  let reused = 0;
  for (const hash of latestHashes) {
    const cached = getPipelineEmbedding(forgeDb, hash);
    if (cached && cached.embeddingModel === embedder.model) {
      reused++;
      continue;
    }
    const ir = getPipelineIR(kernelDb, hash);
    if (!ir) continue;
    const desc = buildPipelineDescriptor(ir);
    const [emb] = await embedder.embed([desc.text]);
    if (!emb) continue;
    upsertPipelineEmbedding(forgeDb, {
      versionHash: hash,
      pipelineName: ir.name,
      descriptorText: desc.text,
      embedding: emb,
      embeddingModel: embedder.model,
      embeddingDim: emb.length,
      createdAt: Date.now(),
    });
    refreshed++;
  }
  return { refreshed, reused };
}

/**
 * Match an episode embedding against all cached pipeline embeddings.
 * Pure-ish — does not write anything. Caller is expected to have
 * called refreshPipelineEmbeddings first if it cares about freshness.
 */
export function matchEpisodeAgainstPipelines(args: {
  forgeDb: DatabaseSync;
  episodeEmbedding: Float32Array;
  embeddingModel: string;
  topK?: number;
}): MatchResult {
  const { forgeDb, episodeEmbedding, embeddingModel } = args;
  const topK = args.topK ?? 5;
  const candidates = listPipelineEmbeddings(forgeDb, embeddingModel);

  const ranked = candidates
    .filter((c) => c.embedding.length === episodeEmbedding.length)
    .map((c) => ({
      pipelineName: c.pipelineName,
      versionHash: c.versionHash,
      cosine: cosine(episodeEmbedding, c.embedding),
    }))
    .sort((a, b) => b.cosine - a.cosine);

  const top = ranked.slice(0, topK);
  const best = top[0];
  return {
    bestPipelineName: best?.pipelineName ?? null,
    bestVersionHash: best?.versionHash ?? null,
    bestCosine: best?.cosine ?? 0,
    ranking: top,
    isMatch: (best?.cosine ?? 0) >= MATCH_THRESHOLD,
    embeddingModel,
  };
}
