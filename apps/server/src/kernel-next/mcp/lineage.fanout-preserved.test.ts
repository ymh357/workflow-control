// Post-B17 audit: queryLineage + readLatestPort MUST return the
// fanout_aggregate row as the "current value" of a fanout stage's
// output port, NOT a preserved fanout_element row that survived
// a hot-update migration.
//
// Background: B17 T2+T3 leaves preserved fanout_element attempts
// (direction='out' port_values rows with a single scalar T) in place
// across migrations. The new run writes a fresh fanout_aggregate row
// containing T[]. If the downstream lookup picks the wrong row, a
// consumer sees T (scalar) where it expects T[] (array).
//
// These tests deliberately make the preserved element row look
// "newer" or "higher idx" than it normally would — to probe whether
// the current SQL ORDER BY accidentally protects us vs. whether the
// query explicitly excludes fanout_element from the candidate set.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initKernelNextSchema } from "../ir/sql.js";
import { queryLineage, diffRuns } from "./lineage.js";
import { readLatestPort } from "../runtime/port-runtime.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

interface SeedAttempt {
  db: DatabaseSync;
  taskId: string;
  stage: string;
  attemptIdx: number;
  kind: "fanout_element" | "fanout_aggregate" | "regular";
  fanoutIdx?: number;
  startedAt: number;
}

function seedAttempt(a: SeedAttempt): string {
  const id = randomUUID();
  a.db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx,
      started_at, ended_at, status, kind, fanout_element_idx)
     VALUES (?, ?, 'v', ?, ?, ?, ?, 'success', ?, ?)`,
  ).run(id, a.taskId, a.stage, a.attemptIdx, a.startedAt,
    a.startedAt + 1, a.kind,
    a.kind === "fanout_element" ? (a.fanoutIdx ?? 0) : null);
  return id;
}

function seedWrite(db: DatabaseSync, attemptId: string, stage: string, port: string, value: unknown, writtenAt: number): void {
  db.prepare(
    `INSERT INTO port_values
     (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
     VALUES (?, ?, ?, ?, 'out', ?, ?)`,
  ).run(randomUUID(), attemptId, stage, port, JSON.stringify(value), writtenAt);
}

describe("B17 post-audit: fanout port lookups prefer aggregate over preserved element", () => {
  it("readLatestPort returns the aggregate T[] even when a preserved element's written_at is newer", () => {
    // Simulates a clock anomaly or fixture seed error where a preserved
    // element row carries a written_at *later* than the new aggregate's.
    // The aggregate T[] must still win because it is the semantically
    // correct current value for the fanout stage's output port.
    const db = makeDb();
    try {
      const taskId = "t1";
      // Aggregate attempt — idx=5, written_at=1000
      const aggId = seedAttempt({ db, taskId, stage: "F", attemptIdx: 5, kind: "fanout_aggregate", startedAt: 1000 });
      seedWrite(db, aggId, "F", "doubled", [2, 4, 6, 8], 1000);
      // Preserved element — idx=1, written_at=2000 (pathologically newer)
      const elemId = seedAttempt({ db, taskId, stage: "F", attemptIdx: 1, kind: "fanout_element", fanoutIdx: 0, startedAt: 2000 });
      seedWrite(db, elemId, "F", "doubled", 2, 2000);

      const r = readLatestPort(db, "F", "doubled", taskId);
      expect(r).not.toBeNull();
      expect(r!.value).toEqual([2, 4, 6, 8]);
      expect(r!.attemptId).toBe(aggId);
    } finally { db.close(); }
  });

  it("readLatestPort returns the aggregate T[] even when a preserved element has a higher attempt_idx", () => {
    // A less pathological case: same ms, but preserved element has
    // higher attempt_idx (e.g. re-submit reordered fixtures). Aggregate
    // must still win on semantic grounds.
    const db = makeDb();
    try {
      const taskId = "t2";
      const aggId = seedAttempt({ db, taskId, stage: "F", attemptIdx: 3, kind: "fanout_aggregate", startedAt: 1000 });
      seedWrite(db, aggId, "F", "doubled", [2, 4, 6, 8], 1000);
      const elemId = seedAttempt({ db, taskId, stage: "F", attemptIdx: 99, kind: "fanout_element", fanoutIdx: 0, startedAt: 1000 });
      seedWrite(db, elemId, "F", "doubled", 2, 1000);

      const r = readLatestPort(db, "F", "doubled", taskId);
      expect(r).not.toBeNull();
      expect(r!.value).toEqual([2, 4, 6, 8]);
    } finally { db.close(); }
  });

  it("queryLineage latestWrite returns the aggregate attempt even when preserved element is newer", () => {
    const db = makeDb();
    try {
      const taskId = "t3";
      const aggId = seedAttempt({ db, taskId, stage: "F", attemptIdx: 5, kind: "fanout_aggregate", startedAt: 1000 });
      seedWrite(db, aggId, "F", "doubled", [2, 4, 6, 8], 1000);
      const elemId = seedAttempt({ db, taskId, stage: "F", attemptIdx: 1, kind: "fanout_element", fanoutIdx: 0, startedAt: 2000 });
      seedWrite(db, elemId, "F", "doubled", 2, 2000);

      const r = queryLineage(db, { stage: "F", port: "doubled", taskId });
      expect(r.latestWrite).not.toBeNull();
      expect(r.latestWrite!.attemptId).toBe(aggId);
      expect(JSON.parse(r.latestWrite!.valuePreview)).toEqual([2, 4, 6, 8]);
    } finally { db.close(); }
  });

  it("diffRuns compares fanout aggregates, not preserved elements, even if element has higher attempt_idx", () => {
    // Seed task A: aggregate idx=5 with T[]=[2,4,6,8], preserved element
    // idx=99 with scalar 2. Seed task B: aggregate idx=3 with T[]=[2,4,6,8].
    // Without the fix, diffRuns picks the idx=99 element for A (scalar),
    // which is nonsensical to compare against B's T[] aggregate.
    const db = makeDb();
    try {
      const aggA = seedAttempt({ db, taskId: "A", stage: "F", attemptIdx: 5, kind: "fanout_aggregate", startedAt: 1000 });
      seedWrite(db, aggA, "F", "doubled", [2, 4, 6, 8], 1000);
      const elemA = seedAttempt({ db, taskId: "A", stage: "F", attemptIdx: 99, kind: "fanout_element", fanoutIdx: 0, startedAt: 1000 });
      seedWrite(db, elemA, "F", "doubled", 2, 1000);

      const aggB = seedAttempt({ db, taskId: "B", stage: "F", attemptIdx: 3, kind: "fanout_aggregate", startedAt: 2000 });
      seedWrite(db, aggB, "F", "doubled", [2, 4, 6, 8], 2000);

      const d = diffRuns(db, "A", "B");
      const fStage = d.stageComparison.find((s) => s.stage === "F");
      expect(fStage).toBeDefined();
      expect(fStage!.outputsEqual).toBe(true);
      // Both should be aggregate's idx, not the inflated element idx.
      expect(fStage!.attemptIdxA).toBe(5);
      expect(fStage!.attemptIdxB).toBe(3);
    } finally { db.close(); }
  });

  it("fanout stages with no aggregate yet (mid-run failure) still surface element data — fallback case", () => {
    // Invariant: if there is NO aggregate row (fanout never completed
    // aggregation, e.g. mid-run failure), readLatestPort / queryLineage
    // should still find something — typically the last element written.
    // The exclusion is "prefer aggregate over element", not "hide
    // element rows entirely".
    const db = makeDb();
    try {
      const taskId = "t4";
      const elemId = seedAttempt({ db, taskId, stage: "F", attemptIdx: 1, kind: "fanout_element", fanoutIdx: 0, startedAt: 1000 });
      seedWrite(db, elemId, "F", "doubled", 2, 1000);
      // No aggregate.

      const r = readLatestPort(db, "F", "doubled", taskId);
      // Before the fix this returned the element; after the fix it
      // should STILL return the element, because there's no aggregate
      // to prefer over.
      expect(r).not.toBeNull();
      expect(r!.value).toBe(2);
      expect(r!.attemptId).toBe(elemId);

      const l = queryLineage(db, { stage: "F", port: "doubled", taskId });
      expect(l.latestWrite).not.toBeNull();
      expect(l.latestWrite!.attemptId).toBe(elemId);
    } finally { db.close(); }
  });
});
