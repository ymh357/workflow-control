// Hot-update behaviour on session_mode='single' pipelines.
//
// Coverage gap closed: existing migration-orchestrator suites all use
// the diamond IR which defaults to session_mode='multi'. Nothing
// previously exercised supersede + rerun semantics on a single-session
// IR, so a regression that only manifests under single-session would
// have slipped through. These tests assert the two invariants that
// matter at the hot-update boundary:
//
//   1. Supersede scope is identical between multi and single — wire
//      reachability is structural, not session-mode-dependent.
//   2. After supersede, the v1 stage_attempts.status='superseded' rows
//      are present, which is the precondition that lets
//      segmentContinuationFor's status filter prevent v1 sessions from
//      leaking into v2 segment continuation (asserted by direct unit
//      tests in runner.single-session.test.ts).
//
// Tests use startRunnerOverride to skip the real runner — the
// migration-orchestrator path itself is what we're verifying, not the
// downstream rerun execution (already covered by migration.real-resume).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import type { PipelineIR } from "../ir/schema.js";
import {
  executeMigration,
  __resetOrchestratorLocksForTest,
} from "./migration-orchestrator.js";
import { taskRegistry } from "../runtime/task-registry.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

// Diamond shaped like generator-mock/mini-generator's diamondIR but
// with session_mode='single'. Building inline so the test owns its
// shape and isn't coupled to the mock generator's defaults.
function singleSessionDiamond(): PipelineIR {
  return {
    name: "diamond-single",
    session_mode: "single",
    externalInputs: [],
    stages: [
      {
        name: "A", type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { promptRef: "p/A" },
      },
      {
        name: "B", type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "y", type: "string" }],
        config: { promptRef: "p/B" },
      },
      {
        name: "C", type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "z", type: "string" }],
        config: { promptRef: "p/C" },
      },
      {
        name: "D", type: "agent",
        inputs: [
          { name: "b", type: "string" },
          { name: "c", type: "string" },
        ],
        outputs: [{ name: "final", type: "string" }],
        config: { promptRef: "p/D" },
      },
    ],
    wires: [
      { from: { source: "stage", stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
      { from: { source: "stage", stage: "A", port: "x" }, to: { stage: "C", port: "x" } },
      { from: { source: "stage", stage: "B", port: "y" }, to: { stage: "D", port: "b" } },
      { from: { source: "stage", stage: "C", port: "z" }, to: { stage: "D", port: "c" } },
    ],
  };
}

function singleSessionPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of singleSessionDiamond().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

function seedAttempt(
  db: DatabaseSync,
  taskId: string,
  versionHash: string,
  stageName: string,
  status: "success" | "running" | "error" | "superseded",
): string {
  const attemptId = randomUUID();
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, status,
      started_at, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'regular')`,
  ).run(attemptId, taskId, versionHash, stageName, 0, status, Date.now());
  return attemptId;
}

describe("executeMigration on single-session pipelines", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("supersede scope on single-session diamond matches multi-session: only wire-reachable from rerunFrom", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(singleSessionDiamond(), {
      prompts: singleSessionPrompts(),
    });
    if (!submitted.ok) throw new Error("submit failed: " + JSON.stringify(submitted.diagnostics));

    for (const s of singleSessionDiamond().stages) {
      seedAttempt(db, "t-ss-par", submitted.versionHash, s.name, "success");
    }

    const propose = svc.propose({
      currentVersion: submitted.versionHash,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: "B",
          configPatch: { promptRef: "p/B-v2" },
        }],
      },
      actor: "test",
      rerunFrom: "B",
      migrateRunningTasks: ["t-ss-par"],
      autoApprove: true,
    });
    if (!propose.ok) throw new Error("propose failed: " + JSON.stringify(propose.diagnostics));

    const startRunner = vi.fn(async () => ({
      ok: true as const,
      taskId: "t-ss-par",
      versionHash: propose.proposedVersion,
    }));

    const r = await executeMigration({
      db,
      taskId: "t-ss-par",
      proposalId: propose.proposalId,
      startRunnerOverride: startRunner as never,
    });
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r));
    expect(r.newRunnerStarted).toBe(true);

    // session_mode does not change wire reachability.
    expect(r.supersededStages.sort()).toEqual(["B", "D"]);

    const byStage = new Map(
      (db.prepare(
        `SELECT stage_name, status FROM stage_attempts WHERE task_id = 't-ss-par'`,
      ).all() as Array<{ stage_name: string; status: string }>)
        .map((s) => [s.stage_name, s.status]),
    );
    expect(byStage.get("A")).toBe("success");
    expect(byStage.get("B")).toBe("superseded");
    expect(byStage.get("C")).toBe("success");
    expect(byStage.get("D")).toBe("superseded");

    // hot_update_events row recorded for audit.
    const evt = db.prepare(
      `SELECT status FROM hot_update_events WHERE task_id = 't-ss-par'`,
    ).get() as { status: string };
    expect(evt.status).toBe("success");
    db.close();
  });

  it("rerunFrom=A on single-session diamond supersedes everything (full chain)", async () => {
    // Boundary: when the patched stage is the chain root, every
    // downstream is wire-reachable. The test guards against an
    // accidental "single-session keeps something alive" optimization
    // ever sneaking in. Same supersede scope as multi-mode.
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(singleSessionDiamond(), {
      prompts: singleSessionPrompts(),
    });
    if (!submitted.ok) throw new Error("submit failed: " + JSON.stringify(submitted.diagnostics));

    for (const s of singleSessionDiamond().stages) {
      seedAttempt(db, "t-ss-root", submitted.versionHash, s.name, "success");
    }

    const propose = svc.propose({
      currentVersion: submitted.versionHash,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: "A",
          configPatch: { promptRef: "p/A-v2" },
        }],
      },
      actor: "test",
      rerunFrom: "A",
      migrateRunningTasks: ["t-ss-root"],
      autoApprove: true,
    });
    if (!propose.ok) throw new Error("propose failed: " + JSON.stringify(propose.diagnostics));

    const startRunner = vi.fn(async () => ({
      ok: true as const,
      taskId: "t-ss-root",
      versionHash: propose.proposedVersion,
    }));

    const r = await executeMigration({
      db,
      taskId: "t-ss-root",
      proposalId: propose.proposalId,
      startRunnerOverride: startRunner as never,
    });
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r));
    expect(r.supersededStages.sort()).toEqual(["A", "B", "C", "D"]);
    db.close();
  });

  it("v1 superseded attempts retain their session_id rows so cross-version isolation can be enforced", async () => {
    // The session-mode-aware invariant proper: after migration,
    // segmentContinuationFor (tested directly in
    // runner.single-session.test.ts) relies on v1 attempts being marked
    // 'superseded' WITHOUT being deleted, so its status filter has
    // something to filter against. This test confirms the precondition
    // — orchestrator transitions status, never DELETEs the row.
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(singleSessionDiamond(), {
      prompts: singleSessionPrompts(),
    });
    if (!submitted.ok) throw new Error("submit failed: " + JSON.stringify(submitted.diagnostics));
    const v1 = submitted.versionHash;

    for (const s of singleSessionDiamond().stages) {
      seedAttempt(db, "t-ss-iso", v1, s.name, "success");
    }

    // Snapshot pre-migration row count.
    const preCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM stage_attempts WHERE task_id = 't-ss-iso'`,
    ).get() as { n: number }).n;
    expect(preCount).toBe(4);

    const propose = svc.propose({
      currentVersion: v1,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: "B",
          configPatch: { promptRef: "p/B-v2" },
        }],
      },
      actor: "test",
      rerunFrom: "B",
      migrateRunningTasks: ["t-ss-iso"],
      autoApprove: true,
    });
    if (!propose.ok) throw new Error("propose failed: " + JSON.stringify(propose.diagnostics));

    const startRunner = vi.fn(async () => ({
      ok: true as const,
      taskId: "t-ss-iso",
      versionHash: propose.proposedVersion,
    }));

    const r = await executeMigration({
      db,
      taskId: "t-ss-iso",
      proposalId: propose.proposalId,
      startRunnerOverride: startRunner as never,
    });
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r));

    // Post-migration: same row count (no deletes), v1 superseded rows
    // preserved with their version_hash for audit.
    const postRows = db.prepare(
      `SELECT stage_name, status, version_hash FROM stage_attempts
       WHERE task_id = 't-ss-iso'`,
    ).all() as Array<{ stage_name: string; status: string; version_hash: string }>;
    expect(postRows.length).toBe(4);
    const v1Superseded = postRows.filter(
      (r) => r.version_hash === v1 && r.status === "superseded",
    );
    expect(v1Superseded.map((r) => r.stage_name).sort()).toEqual(["B", "D"]);
    db.close();
  });
});
