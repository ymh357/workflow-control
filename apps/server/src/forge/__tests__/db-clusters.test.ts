import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";
import { upsertSession } from "../db/sessions.js";
import { insertEpisode } from "../db/episodes.js";
import {
  insertCluster, getCluster, listClusters, listClustersByStatus,
  setClusterStatus, setClusterSuppressedUntil, updateClusterStats,
  addClusterMember, listClusterMembers,
  insertSignature, getSignature,
  f32ToBlob, blobToF32,
} from "../db/clusters.js";
import type { EpisodeCluster, EpisodeSignature } from "../types.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initForgeSchema(db);
  upsertSession(db, { sessionId: "s1", cwd: "/p", jsonlPath: "/p.jsonl", firstSeenAt: 1, lastEventAt: 1 });
  insertEpisode(db, {
    episodeId: "e1", sessionId: "s1", startSeq: 1, endSeq: 2,
    intent: "i", outcome: "completed", steps: [], rationale: "r", pipelineAble: true, createdAt: 1,
  });
});

function makeCluster(overrides: Partial<EpisodeCluster> = {}): EpisodeCluster {
  return {
    clusterId: overrides.clusterId ?? "c1",
    centroid: overrides.centroid ?? Float32Array.from([1, 0, 0, 0]),
    centroidModel: overrides.centroidModel ?? "test-model",
    memberCount: overrides.memberCount ?? 1,
    distinctSessionCount: overrides.distinctSessionCount ?? 1,
    distinctDayCount: overrides.distinctDayCount ?? 1,
    firstSeenAt: overrides.firstSeenAt ?? 100,
    lastSeenAt: overrides.lastSeenAt ?? 100,
    status: overrides.status ?? "forming",
    suppressedUntil: overrides.suppressedUntil ?? null,
  };
}

describe("Float32Array <-> blob round trip", () => {
  it("preserves values exactly", () => {
    const a = Float32Array.from([0.1, 0.2, 0.3, 0.4]);
    const b = blobToF32(f32ToBlob(a));
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]).toBeCloseTo(a[i]!, 6);
    }
  });
});

describe("clusters CRUD", () => {
  it("insert + get round-trips centroid", () => {
    const c = makeCluster({ centroid: Float32Array.from([0.5, 0.5, 0.5, 0.5]) });
    insertCluster(db, c);
    const got = getCluster(db, "c1");
    expect(got).not.toBeNull();
    expect(got!.centroid.length).toBe(4);
    expect(got!.centroid[0]).toBeCloseTo(0.5);
    expect(got!.status).toBe("forming");
  });

  it("getCluster returns null for unknown", () => {
    expect(getCluster(db, "ghost")).toBeNull();
  });

  it("listClustersByStatus filters", () => {
    insertCluster(db, makeCluster({ clusterId: "c1", status: "forming" }));
    insertCluster(db, makeCluster({ clusterId: "c2", status: "ripe" }));
    expect(listClustersByStatus(db, "ripe")).toHaveLength(1);
    expect(listClustersByStatus(db, "forming")).toHaveLength(1);
  });

  it("setClusterStatus updates", () => {
    insertCluster(db, makeCluster());
    setClusterStatus(db, "c1", "ripe");
    expect(getCluster(db, "c1")!.status).toBe("ripe");
  });

  it("setClusterSuppressedUntil works (set + clear)", () => {
    insertCluster(db, makeCluster());
    setClusterSuppressedUntil(db, "c1", 999_999);
    expect(getCluster(db, "c1")!.suppressedUntil).toBe(999_999);
    setClusterSuppressedUntil(db, "c1", null);
    expect(getCluster(db, "c1")!.suppressedUntil).toBeNull();
  });

  it("updateClusterStats updates centroid + counts", () => {
    insertCluster(db, makeCluster());
    updateClusterStats(db, "c1", {
      centroid: Float32Array.from([0.9, 0.1, 0, 0]),
      memberCount: 5,
      distinctSessionCount: 4,
      distinctDayCount: 3,
      lastSeenAt: 200,
    });
    const got = getCluster(db, "c1")!;
    expect(got.memberCount).toBe(5);
    expect(got.distinctSessionCount).toBe(4);
    expect(got.distinctDayCount).toBe(3);
    expect(got.centroid[0]).toBeCloseTo(0.9);
  });

  it("listClusters orders by last_seen_at desc", () => {
    insertCluster(db, makeCluster({ clusterId: "c1", lastSeenAt: 100 }));
    insertCluster(db, makeCluster({ clusterId: "c2", lastSeenAt: 200 }));
    const list = listClusters(db);
    expect(list[0]!.clusterId).toBe("c2");
    expect(list[1]!.clusterId).toBe("c1");
  });
});

describe("cluster_members", () => {
  beforeEach(() => {
    insertCluster(db, makeCluster());
  });

  it("addClusterMember inserts and listClusterMembers reads back", () => {
    addClusterMember(db, { clusterId: "c1", episodeId: "e1", addedAt: 100, cosine: 0.92 });
    const m = listClusterMembers(db, "c1");
    expect(m).toHaveLength(1);
    expect(m[0]!.cosine).toBeCloseTo(0.92);
  });

  it("addClusterMember is idempotent on (cluster, episode)", () => {
    const m = { clusterId: "c1", episodeId: "e1", addedAt: 100, cosine: 0.92 };
    addClusterMember(db, m);
    expect(() => addClusterMember(db, m)).not.toThrow();
    expect(listClusterMembers(db, "c1")).toHaveLength(1);
  });
});

describe("episode_signatures", () => {
  it("insertSignature + getSignature round-trips", () => {
    const sig: EpisodeSignature = {
      episodeId: "e1",
      embedding: Float32Array.from([0.1, 0.2, 0.3]),
      embeddingModel: "m",
      embeddingDim: 3,
      signatureKey: "key",
      createdAt: 100,
    };
    insertSignature(db, sig);
    const got = getSignature(db, "e1");
    expect(got).not.toBeNull();
    expect(got!.embedding.length).toBe(3);
    expect(got!.embedding[0]).toBeCloseTo(0.1);
    expect(got!.signatureKey).toBe("key");
  });

  it("getSignature returns null when absent", () => {
    expect(getSignature(db, "ghost")).toBeNull();
  });

  it("INSERT OR REPLACE allows update of existing signature", () => {
    const sig1: EpisodeSignature = {
      episodeId: "e1",
      embedding: Float32Array.from([1, 0, 0]),
      embeddingModel: "m",
      embeddingDim: 3,
      signatureKey: "k1",
      createdAt: 100,
    };
    insertSignature(db, sig1);
    const sig2: EpisodeSignature = { ...sig1, embedding: Float32Array.from([0, 1, 0]), signatureKey: "k2" };
    insertSignature(db, sig2);
    const got = getSignature(db, "e1")!;
    expect(got.signatureKey).toBe("k2");
    expect(got.embedding[1]).toBeCloseTo(1);
  });
});
