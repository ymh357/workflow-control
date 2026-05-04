import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initForgeSchema } from "../db/schema.js";
import { insertCluster } from "../db/clusters.js";
import {
  insertCandidate, getCandidate, listPendingCandidates, listCandidatesForCluster,
  setCandidateDryRun, markCandidateAdopted, markCandidateDismissed,
} from "../db/candidates.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  initForgeSchema(db);
  insertCluster(db, {
    clusterId: "c1",
    centroid: Float32Array.from([1, 0, 0]),
    centroidModel: "m",
    memberCount: 3, distinctSessionCount: 3, distinctDayCount: 2,
    firstSeenAt: 100, lastSeenAt: 200,
    status: "ripe",
    suppressedUntil: null,
  });
});

function insertOne(args: Partial<{ id: string; clusterId: string; generatedAt: number }> = {}) {
  insertCandidate(db, {
    candidateId: args.id ?? "cand1",
    clusterId: args.clusterId ?? "c1",
    irJson: "{}",
    promptsJson: "{}",
    synthTaskId: "task-1",
    generatedAt: args.generatedAt ?? 1000,
  });
}

describe("candidates CRUD", () => {
  it("insert + get round-trips", () => {
    insertOne();
    const got = getCandidate(db, "cand1");
    expect(got).not.toBeNull();
    expect(got!.dryRunStatus).toBe("pending");
    expect(got!.adoptedAt).toBeNull();
  });

  it("getCandidate returns null for unknown", () => {
    expect(getCandidate(db, "ghost")).toBeNull();
  });

  it("listPendingCandidates excludes adopted", () => {
    insertOne({ id: "c1c" });
    insertOne({ id: "c1d" });
    markCandidateAdopted(db, "c1d", "hashabc");
    const list = listPendingCandidates(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.candidateId).toBe("c1c");
  });

  it("listPendingCandidates excludes dismissed", () => {
    insertOne({ id: "c1c" });
    insertOne({ id: "c1d" });
    markCandidateDismissed(db, "c1d", "user-rejected");
    const list = listPendingCandidates(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.candidateId).toBe("c1c");
  });

  it("listPendingCandidates orders by generated_at desc", () => {
    insertOne({ id: "c1a", generatedAt: 1 });
    insertOne({ id: "c1b", generatedAt: 2 });
    insertOne({ id: "c1c", generatedAt: 3 });
    const list = listPendingCandidates(db);
    expect(list.map((c) => c.candidateId)).toEqual(["c1c", "c1b", "c1a"]);
  });

  it("setCandidateDryRun updates status + diagnostics", () => {
    insertOne();
    setCandidateDryRun(db, "cand1", "passed", JSON.stringify({ ok: true }));
    const got = getCandidate(db, "cand1")!;
    expect(got.dryRunStatus).toBe("passed");
    expect(got.dryRunDiagnosticsJson).toBe(JSON.stringify({ ok: true }));
  });

  it("markCandidateAdopted sets versionHash and adoptedAt", () => {
    insertOne();
    markCandidateAdopted(db, "cand1", "hashabc");
    const got = getCandidate(db, "cand1")!;
    expect(got.adoptedVersionHash).toBe("hashabc");
    expect(got.adoptedAt).not.toBeNull();
  });

  it("markCandidateDismissed sets reason and dismissedAt", () => {
    insertOne();
    markCandidateDismissed(db, "cand1", "not useful");
    const got = getCandidate(db, "cand1")!;
    expect(got.dismissedAt).not.toBeNull();
    expect(got.dismissedReason).toBe("not useful");
  });

  it("listCandidatesForCluster returns history including adopted/dismissed", () => {
    insertOne({ id: "a1" });
    insertOne({ id: "a2" });
    markCandidateDismissed(db, "a1", "x");
    const list = listCandidatesForCluster(db, "c1");
    expect(list).toHaveLength(2);
  });

  it("rejects invalid dry_run_status via CHECK", () => {
    insertOne();
    expect(() =>
      db.prepare(`UPDATE pipeline_candidates SET dry_run_status = 'bogus' WHERE candidate_id = ?`).run("cand1"),
    ).toThrow();
  });
});
