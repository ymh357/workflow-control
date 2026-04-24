// B17 (Phase 4.5 T2) — migration-orchestrator preserves successful
// fanout_element attempts under supersede. Non-fanout attempts and
// fanout_aggregate attempts supersede as before.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import {
  executeMigration,
  __resetOrchestratorLocksForTest,
} from "./migration-orchestrator.js";
import { taskRegistry } from "../runtime/task-registry.js";

function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

interface SeedArgs {
  db: DatabaseSync;
  taskId: string;
  versionHash: string;
  stageName: string;
  attemptIdx: number;
  status: "success" | "running" | "error";
  kind: "regular" | "fanout_element" | "fanout_aggregate";
}

function seed(a: SeedArgs): string {
  const attemptId = randomUUID();
  // B17 full — fanout_element rows require non-NULL fanout_element_idx
  // (schema CHECK). Use attemptIdx as a stand-in; actual value doesn't
  // matter to the preserve/supersede logic exercised here.
  const fanoutIdx = a.kind === "fanout_element" ? a.attemptIdx : null;
  a.db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, status,
      started_at, kind, fanout_element_idx)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attemptId, a.taskId, a.versionHash, a.stageName,
    a.attemptIdx, a.status, Date.now(), a.kind, fanoutIdx,
  );
  return attemptId;
}

function readStatus(db: DatabaseSync, attemptId: string): string | undefined {
  return (db.prepare(
    `SELECT status FROM stage_attempts WHERE attempt_id = ?`,
  ).get(attemptId) as { status: string } | undefined)?.status;
}

describe("executeMigration — B17 fanout preservation", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("successful fanout_element attempts are preserved; aggregate + regular are superseded", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");

    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    const stageName = firstAgent.name;
    const vh = submitted.versionHash;

    // 3 successful fanout_element attempts + 1 success fanout_aggregate +
    // 1 running fanout_element + 1 regular success (simulates the stage
    // being rerun once previously; kernel-next doesn't actually produce
    // this mix today but the SQL must handle every combination).
    const elemOk1 = seed({ db, taskId: "t1", versionHash: vh, stageName, attemptIdx: 1, status: "success", kind: "fanout_element" });
    const elemOk2 = seed({ db, taskId: "t1", versionHash: vh, stageName, attemptIdx: 2, status: "success", kind: "fanout_element" });
    const elemOk3 = seed({ db, taskId: "t1", versionHash: vh, stageName, attemptIdx: 3, status: "success", kind: "fanout_element" });
    const elemRunning = seed({ db, taskId: "t1", versionHash: vh, stageName, attemptIdx: 4, status: "running", kind: "fanout_element" });
    const aggregate = seed({ db, taskId: "t1", versionHash: vh, stageName, attemptIdx: 5, status: "success", kind: "fanout_aggregate" });
    const regular = seed({ db, taskId: "t1", versionHash: vh, stageName, attemptIdx: 6, status: "success", kind: "regular" });

    const propose = svc.propose({
      currentVersion: vh,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: stageName,
          configPatch: {
            promptRef: (firstAgent.type === "agent" ? firstAgent.config.promptRef : "x") + "-v2",
          },
        }],
      },
      actor: "test",
      rerunFrom: stageName,
      migrateRunningTasks: ["t1"],
      autoApprove: true,
    });
    if (!propose.ok) throw new Error("propose failed: " + JSON.stringify(propose.diagnostics));

    const startRunner = vi.fn(async () => ({
      ok: true as const, taskId: "t1", versionHash: propose.proposedVersion,
    }));
    const r = await executeMigration({
      db, taskId: "t1", proposalId: propose.proposalId,
      startRunnerOverride: startRunner as never,
    });
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r));

    // Three successful fanout_element attempts — preserved.
    expect(readStatus(db, elemOk1)).toBe("success");
    expect(readStatus(db, elemOk2)).toBe("success");
    expect(readStatus(db, elemOk3)).toBe("success");
    // Running fanout_element — superseded (it was incomplete).
    expect(readStatus(db, elemRunning)).toBe("superseded");
    // Aggregate — superseded (the T[] outputs array becomes stale).
    expect(readStatus(db, aggregate)).toBe("superseded");
    // Regular attempt — superseded (pre-existing behaviour).
    expect(readStatus(db, regular)).toBe("superseded");
    db.close();
  });

  it("reverse-supersede ignores preserved fanout_element successes", async () => {
    // When resume fails after supersede, the orchestrator restores
    // pre-supersede status ONLY for attempts it actually touched. Since
    // fanout_element successes were never in the snapshot, they are
    // untouched on the reverse path too — no accidental status flip.
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    const stageName = firstAgent.name;
    const vh = submitted.versionHash;

    const elemOk = seed({ db, taskId: "t2", versionHash: vh, stageName, attemptIdx: 1, status: "success", kind: "fanout_element" });
    const aggregate = seed({ db, taskId: "t2", versionHash: vh, stageName, attemptIdx: 2, status: "success", kind: "fanout_aggregate" });

    const propose = svc.propose({
      currentVersion: vh,
      patch: {
        ops: [{
          op: "update_stage_config", stage: stageName,
          configPatch: {
            promptRef: (firstAgent.type === "agent" ? firstAgent.config.promptRef : "x") + "-v3",
          },
        }],
      },
      actor: "test", rerunFrom: stageName,
      migrateRunningTasks: ["t2"], autoApprove: true,
    });
    if (!propose.ok) throw new Error("propose failed");

    const startRunner = vi.fn(async () => {
      throw new Error("resume exploded");
    });
    const r = await executeMigration({
      db, taskId: "t2", proposalId: propose.proposalId,
      startRunnerOverride: startRunner as never,
    });
    expect(r.ok).toBe(false);

    // aggregate status was supersede-then-restored
    expect(readStatus(db, aggregate)).toBe("success");
    // elemOk was never touched
    expect(readStatus(db, elemOk)).toBe("success");
    db.close();
  });
});
