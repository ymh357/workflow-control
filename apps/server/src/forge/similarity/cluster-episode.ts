// Operational entry point that ties cluster.ts (pure math) with the
// DB layer. Given a freshly-distilled episode and its embedding,
// either join an existing cluster (updating centroid + stats) or
// create a new one. After the assignment, re-evaluates ripeness and
// transitions cluster status forming -> ripe when threshold met.
//
// Returns the affected cluster id and its post-assignment status so
// the daemon can decide whether to enqueue a synthesis job.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  insertCluster, getCluster, listClusters, addClusterMember,
  updateClusterStats, setClusterStatus,
  insertSignature,
  listClusterMembers,
} from "../db/clusters.js";
import { getSession } from "../db/sessions.js";
import { getEpisode } from "../db/episodes.js";
import { assignToCluster, updateCentroidIncremental } from "./cluster.js";
import { evaluateThreshold } from "./threshold.js";
import type { SessionEpisode, EpisodeCluster } from "../types.js";

export interface ClusterAssignment {
  clusterId: string;
  status: EpisodeCluster["status"];
  cosine: number;
  isNew: boolean;
}

export interface ClusterEpisodeOpts {
  embedding: Float32Array;
  embeddingModel: string;
  signatureKey: string;
  threshold: number;
  now?: number;
}

export function clusterEpisode(
  db: DatabaseSync,
  episode: SessionEpisode,
  opts: ClusterEpisodeOpts,
): ClusterAssignment {
  const now = opts.now ?? Date.now();

  // Persist the signature first; this is the audit trail.
  insertSignature(db, {
    episodeId: episode.episodeId,
    embedding: opts.embedding,
    embeddingModel: opts.embeddingModel,
    embeddingDim: opts.embedding.length,
    signatureKey: opts.signatureKey,
    createdAt: now,
  });

  // Only consider clusters built from the same embedding model — mixing
  // models breaks cosine semantics.
  const candidates = listClusters(db, 500)
    .filter((c) => c.centroidModel === opts.embeddingModel
      && c.status !== "dismissed"
      && c.status !== "adopted")
    .map((c) => ({ clusterId: c.clusterId, centroid: c.centroid }));

  const result = assignToCluster(opts.embedding, candidates, opts.threshold);

  if (result.kind === "new") {
    const clusterId = randomUUID();
    insertCluster(db, {
      clusterId,
      centroid: opts.embedding.slice(),
      centroidModel: opts.embeddingModel,
      memberCount: 1,
      distinctSessionCount: 1,
      distinctDayCount: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      status: "forming",
      suppressedUntil: null,
    });
    addClusterMember(db, {
      clusterId, episodeId: episode.episodeId, addedAt: now, cosine: 1,
    });
    return { clusterId, status: "forming", cosine: 1, isNew: true };
  }

  // Existing cluster: pull current state, update stats, then re-evaluate ripeness.
  const cluster = getCluster(db, result.clusterId);
  if (!cluster) {
    // Defensive: race condition where the cluster was just dismissed.
    // Treat as new.
    return clusterEpisode(db, episode, opts);
  }

  const newCentroid = updateCentroidIncremental(
    cluster.centroid, cluster.memberCount, opts.embedding,
  );
  addClusterMember(db, {
    clusterId: cluster.clusterId,
    episodeId: episode.episodeId,
    addedAt: now,
    cosine: result.cosine,
  });

  // Recompute distinct sessions / days from the full member set so we
  // never drift; cheap given expected cluster size.
  const stats = recomputeClusterStats(db, cluster.clusterId);
  updateClusterStats(db, cluster.clusterId, {
    centroid: newCentroid,
    memberCount: stats.memberCount,
    distinctSessionCount: stats.distinctSessionCount,
    distinctDayCount: stats.distinctDayCount,
    lastSeenAt: now,
  });

  // Ripeness re-eval. We only transition forward (forming -> ripe),
  // never demote (a ripe cluster that has had a candidate emitted
  // stays in 'synthesized' until adopted/dismissed).
  let nextStatus: EpisodeCluster["status"] = cluster.status;
  if (cluster.status === "forming") {
    const verdict = evaluateThreshold({
      distinctSessionCount: stats.distinctSessionCount,
      distinctDayCount: stats.distinctDayCount,
      suppressedUntil: cluster.suppressedUntil,
    }, now);
    if (verdict === "ripe") {
      setClusterStatus(db, cluster.clusterId, "ripe");
      nextStatus = "ripe";
    }
  }

  return {
    clusterId: cluster.clusterId,
    status: nextStatus,
    cosine: result.cosine,
    isNew: false,
  };
}

interface RecomputedStats {
  memberCount: number;
  distinctSessionCount: number;
  distinctDayCount: number;
}

function recomputeClusterStats(db: DatabaseSync, clusterId: string): RecomputedStats {
  const members = listClusterMembers(db, clusterId);
  const sessions = new Set<string>();
  const days = new Set<string>();
  for (const m of members) {
    const ep = getEpisode(db, m.episodeId);
    if (!ep) continue;
    sessions.add(ep.sessionId);
    const session = getSession(db, ep.sessionId);
    const ts = session?.firstSeenAt ?? ep.createdAt;
    days.add(new Date(ts).toISOString().slice(0, 10));
  }
  return {
    memberCount: members.length,
    distinctSessionCount: sessions.size,
    distinctDayCount: days.size,
  };
}
