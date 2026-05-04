import type { DatabaseSync } from "node:sqlite";
import type { EpisodeCluster, EpisodeSignature, ClusterMember } from "../types.js";

export function f32ToBlob(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function blobToF32(buf: Buffer | Uint8Array): Float32Array {
  // Copy to ensure 4-byte alignment regardless of source buffer alignment.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

export function insertSignature(db: DatabaseSync, sig: EpisodeSignature): void {
  db.prepare(
    `INSERT OR REPLACE INTO episode_signatures
       (episode_id, embedding, embedding_model, embedding_dim, signature_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    sig.episodeId,
    f32ToBlob(sig.embedding),
    sig.embeddingModel,
    sig.embeddingDim,
    sig.signatureKey,
    sig.createdAt,
  );
}

export function getSignature(db: DatabaseSync, episodeId: string): EpisodeSignature | null {
  const r = db.prepare(`SELECT * FROM episode_signatures WHERE episode_id = ?`).get(episodeId) as
    Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    episodeId: r.episode_id as string,
    embedding: blobToF32(r.embedding as Buffer),
    embeddingModel: r.embedding_model as string,
    embeddingDim: r.embedding_dim as number,
    signatureKey: r.signature_key as string,
    createdAt: r.created_at as number,
  };
}

export function insertCluster(db: DatabaseSync, cluster: EpisodeCluster): void {
  db.prepare(
    `INSERT INTO episode_clusters
       (cluster_id, centroid_blob, centroid_model, member_count, distinct_session_count, distinct_day_count, first_seen_at, last_seen_at, status, suppressed_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cluster.clusterId,
    f32ToBlob(cluster.centroid),
    cluster.centroidModel,
    cluster.memberCount,
    cluster.distinctSessionCount,
    cluster.distinctDayCount,
    cluster.firstSeenAt,
    cluster.lastSeenAt,
    cluster.status,
    cluster.suppressedUntil,
  );
}

function rowToCluster(r: Record<string, unknown>): EpisodeCluster {
  return {
    clusterId: r.cluster_id as string,
    centroid: blobToF32(r.centroid_blob as Buffer),
    centroidModel: r.centroid_model as string,
    memberCount: r.member_count as number,
    distinctSessionCount: r.distinct_session_count as number,
    distinctDayCount: r.distinct_day_count as number,
    firstSeenAt: r.first_seen_at as number,
    lastSeenAt: r.last_seen_at as number,
    status: r.status as EpisodeCluster["status"],
    suppressedUntil: (r.suppressed_until as number | null) ?? null,
  };
}

export function getCluster(db: DatabaseSync, clusterId: string): EpisodeCluster | null {
  const r = db.prepare(`SELECT * FROM episode_clusters WHERE cluster_id = ?`).get(clusterId) as
    Record<string, unknown> | undefined;
  return r ? rowToCluster(r) : null;
}

export function listClusters(db: DatabaseSync, limit = 100): EpisodeCluster[] {
  const rows = db.prepare(
    `SELECT * FROM episode_clusters ORDER BY last_seen_at DESC LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToCluster);
}

export function listClustersByStatus(db: DatabaseSync, status: EpisodeCluster["status"]): EpisodeCluster[] {
  const rows = db.prepare(
    `SELECT * FROM episode_clusters WHERE status = ? ORDER BY last_seen_at DESC`,
  ).all(status) as Array<Record<string, unknown>>;
  return rows.map(rowToCluster);
}

export function setClusterStatus(
  db: DatabaseSync,
  clusterId: string,
  status: EpisodeCluster["status"],
): void {
  db.prepare(`UPDATE episode_clusters SET status = ? WHERE cluster_id = ?`).run(status, clusterId);
}

export function setClusterSuppressedUntil(
  db: DatabaseSync,
  clusterId: string,
  until: number | null,
): void {
  db.prepare(`UPDATE episode_clusters SET suppressed_until = ? WHERE cluster_id = ?`).run(until, clusterId);
}

export interface UpdateClusterStatsArgs {
  centroid: Float32Array;
  memberCount: number;
  distinctSessionCount: number;
  distinctDayCount: number;
  lastSeenAt: number;
}

export function updateClusterStats(db: DatabaseSync, clusterId: string, args: UpdateClusterStatsArgs): void {
  db.prepare(
    `UPDATE episode_clusters
        SET centroid_blob = ?,
            member_count = ?,
            distinct_session_count = ?,
            distinct_day_count = ?,
            last_seen_at = ?
      WHERE cluster_id = ?`,
  ).run(
    f32ToBlob(args.centroid),
    args.memberCount,
    args.distinctSessionCount,
    args.distinctDayCount,
    args.lastSeenAt,
    clusterId,
  );
}

export function addClusterMember(db: DatabaseSync, m: ClusterMember): void {
  db.prepare(
    `INSERT OR IGNORE INTO cluster_members (cluster_id, episode_id, added_at, cosine)
     VALUES (?, ?, ?, ?)`,
  ).run(m.clusterId, m.episodeId, m.addedAt, m.cosine);
}

export function listClusterMembers(db: DatabaseSync, clusterId: string): ClusterMember[] {
  const rows = db.prepare(
    `SELECT * FROM cluster_members WHERE cluster_id = ? ORDER BY added_at ASC`,
  ).all(clusterId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    clusterId: r.cluster_id as string,
    episodeId: r.episode_id as string,
    addedAt: r.added_at as number,
    cosine: r.cosine as number,
  }));
}
