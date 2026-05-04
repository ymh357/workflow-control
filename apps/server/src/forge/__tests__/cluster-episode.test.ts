import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";
import { upsertSession } from "../db/sessions.js";
import { insertEpisode } from "../db/episodes.js";
import { getCluster, listClusters, listClusterMembers } from "../db/clusters.js";
import { clusterEpisode } from "../similarity/cluster-episode.js";
import type { SessionEpisode } from "../types.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initForgeSchema(db);
});

function makeSession(sid: string, firstSeenAt: number) {
  upsertSession(db, {
    sessionId: sid, cwd: "/p", jsonlPath: `/p/${sid}.jsonl`,
    firstSeenAt, lastEventAt: firstSeenAt + 100,
  });
}

function makeEpisode(eid: string, sid: string): SessionEpisode {
  const ep: SessionEpisode = {
    episodeId: eid, sessionId: sid, startSeq: 1, endSeq: 5,
    intent: "test", outcome: "completed", steps: [],
    rationale: "r", pipelineAble: true, createdAt: 1000,
  };
  insertEpisode(db, ep);
  return ep;
}

const VEC_A = Float32Array.from([1, 0, 0, 0]);
const VEC_A_NEAR = Float32Array.from([0.95, 0.1, 0.1, 0]);
const VEC_B = Float32Array.from([0, 0, 1, 0]);

const STD = {
  embeddingModel: "test-model",
  signatureKey: "k",
  threshold: 0.85,
};

describe("clusterEpisode", () => {
  it("creates a new cluster when no clusters exist", () => {
    makeSession("s1", 1_700_000_000_000);
    const ep = makeEpisode("e1", "s1");
    const r = clusterEpisode(db, ep, { ...STD, embedding: VEC_A, now: 1_700_000_000_000 });
    expect(r.isNew).toBe(true);
    expect(r.status).toBe("forming");
    expect(listClusters(db)).toHaveLength(1);
    expect(listClusterMembers(db, r.clusterId)).toHaveLength(1);
  });

  it("joins an existing cluster when cosine >= threshold", () => {
    makeSession("s1", 1_700_000_000_000);
    makeSession("s2", 1_700_000_000_000);
    const e1 = makeEpisode("e1", "s1");
    const e2 = makeEpisode("e2", "s2");
    const r1 = clusterEpisode(db, e1, { ...STD, embedding: VEC_A, now: 1_700_000_000_000 });
    const r2 = clusterEpisode(db, e2, { ...STD, embedding: VEC_A_NEAR, now: 1_700_000_000_000 });
    expect(r2.isNew).toBe(false);
    expect(r2.clusterId).toBe(r1.clusterId);
    expect(listClusters(db)).toHaveLength(1);
    expect(listClusterMembers(db, r1.clusterId)).toHaveLength(2);
  });

  it("creates a separate cluster when far apart", () => {
    makeSession("s1", 1_700_000_000_000);
    makeSession("s2", 1_700_000_000_000);
    const e1 = makeEpisode("e1", "s1");
    const e2 = makeEpisode("e2", "s2");
    clusterEpisode(db, e1, { ...STD, embedding: VEC_A, now: 1_700_000_000_000 });
    const r2 = clusterEpisode(db, e2, { ...STD, embedding: VEC_B, now: 1_700_000_000_000 });
    expect(r2.isNew).toBe(true);
    expect(listClusters(db)).toHaveLength(2);
  });

  it("flips forming → ripe when 3 sessions on 2 days are admitted", () => {
    const day1 = Date.UTC(2026, 4, 1, 10, 0, 0);
    const day2 = Date.UTC(2026, 4, 2, 10, 0, 0);
    makeSession("s1", day1);
    makeSession("s2", day1);
    makeSession("s3", day2);
    const e1 = makeEpisode("e1", "s1");
    const e2 = makeEpisode("e2", "s2");
    const e3 = makeEpisode("e3", "s3");
    const r1 = clusterEpisode(db, e1, { ...STD, embedding: VEC_A, now: day1 });
    expect(r1.status).toBe("forming");
    const r2 = clusterEpisode(db, e2, { ...STD, embedding: VEC_A, now: day1 });
    expect(r2.status).toBe("forming");
    const r3 = clusterEpisode(db, e3, { ...STD, embedding: VEC_A, now: day2 });
    expect(r3.status).toBe("ripe");
    expect(getCluster(db, r3.clusterId)!.status).toBe("ripe");
    expect(getCluster(db, r3.clusterId)!.distinctSessionCount).toBe(3);
    expect(getCluster(db, r3.clusterId)!.distinctDayCount).toBe(2);
  });

  it("does not demote a ripe cluster on subsequent admission", () => {
    const day1 = Date.UTC(2026, 4, 1);
    const day2 = Date.UTC(2026, 4, 2);
    makeSession("s1", day1);
    makeSession("s2", day1);
    makeSession("s3", day2);
    makeSession("s4", day2);
    const e1 = makeEpisode("e1", "s1");
    const e2 = makeEpisode("e2", "s2");
    const e3 = makeEpisode("e3", "s3");
    const e4 = makeEpisode("e4", "s4");
    clusterEpisode(db, e1, { ...STD, embedding: VEC_A, now: day1 });
    clusterEpisode(db, e2, { ...STD, embedding: VEC_A, now: day1 });
    const r3 = clusterEpisode(db, e3, { ...STD, embedding: VEC_A, now: day2 });
    expect(r3.status).toBe("ripe");
    const r4 = clusterEpisode(db, e4, { ...STD, embedding: VEC_A, now: day2 });
    expect(r4.status).toBe("ripe"); // unchanged, not demoted
    expect(getCluster(db, r3.clusterId)!.status).toBe("ripe");
  });

  it("does not consider adopted/dismissed clusters as candidates", () => {
    makeSession("s1", 1_700_000_000_000);
    makeSession("s2", 1_700_000_000_000);
    const e1 = makeEpisode("e1", "s1");
    const e2 = makeEpisode("e2", "s2");
    const r1 = clusterEpisode(db, e1, { ...STD, embedding: VEC_A, now: 1_700_000_000_000 });
    // Manually mark adopted
    db.prepare(`UPDATE episode_clusters SET status='adopted' WHERE cluster_id = ?`).run(r1.clusterId);
    const r2 = clusterEpisode(db, e2, { ...STD, embedding: VEC_A, now: 1_700_000_000_000 });
    expect(r2.isNew).toBe(true);
    expect(r2.clusterId).not.toBe(r1.clusterId);
  });

  it("only matches clusters built from the same embedding model", () => {
    makeSession("s1", 1_700_000_000_000);
    makeSession("s2", 1_700_000_000_000);
    const e1 = makeEpisode("e1", "s1");
    const e2 = makeEpisode("e2", "s2");
    clusterEpisode(db, e1, { ...STD, embeddingModel: "model-A", embedding: VEC_A, now: 1_700_000_000_000 });
    const r2 = clusterEpisode(db, e2, { ...STD, embeddingModel: "model-B", embedding: VEC_A, now: 1_700_000_000_000 });
    expect(r2.isNew).toBe(true);
    expect(listClusters(db)).toHaveLength(2);
  });

  it("persists the signature row regardless of new/existing cluster", () => {
    makeSession("s1", 1_700_000_000_000);
    const ep = makeEpisode("e1", "s1");
    clusterEpisode(db, ep, { ...STD, embedding: VEC_A, now: 1_700_000_000_000 });
    const sig = db.prepare(`SELECT * FROM episode_signatures WHERE episode_id = ?`).get("e1");
    expect(sig).toBeDefined();
  });
});
