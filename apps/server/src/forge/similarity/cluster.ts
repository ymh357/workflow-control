// Pure clustering primitives: cosine similarity, cluster assignment,
// incremental centroid update. Storage / persistence lives in db/clusters.ts;
// this file is purely numerical.

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error("dim mismatch");
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export type AssignResult =
  | { kind: "existing"; clusterId: string; cosine: number }
  | { kind: "new" };

export interface ClusterCandidate {
  clusterId: string;
  centroid: Float32Array;
}

export function assignToCluster(
  newEmbedding: Float32Array,
  clusters: ClusterCandidate[],
  threshold: number,
): AssignResult {
  let best: { clusterId: string; cosine: number } | null = null;
  for (const c of clusters) {
    if (c.centroid.length !== newEmbedding.length) continue;
    const sim = cosine(newEmbedding, c.centroid);
    if (best === null || sim > best.cosine) best = { clusterId: c.clusterId, cosine: sim };
  }
  if (best && best.cosine >= threshold) return { kind: "existing", ...best };
  return { kind: "new" };
}

// Incremental running mean. Old centroid + memberCount -> new centroid
// after admitting one more embedding. The result is a fresh Float32Array;
// callers receive a new vector (immutability discipline) and the old
// centroid is untouched.
export function updateCentroidIncremental(
  oldCentroid: Float32Array,
  oldMemberCount: number,
  newEmbedding: Float32Array,
): Float32Array {
  if (oldCentroid.length !== newEmbedding.length) throw new Error("dim mismatch");
  const out = new Float32Array(oldCentroid.length);
  const n = oldMemberCount + 1;
  for (let i = 0; i < oldCentroid.length; i++) {
    out[i] = (oldCentroid[i]! * oldMemberCount + newEmbedding[i]!) / n;
  }
  return out;
}
