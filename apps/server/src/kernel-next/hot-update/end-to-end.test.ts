// Stage 5E end-to-end integration — exercises submit → propose autoApprove
// → migrate → query_hot_update_stats round-trip, plus rollback and INTERRUPT
// timeout paths. Uses mock startRunner so the orchestrator can complete
// without launching real agents.

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
import { executeRollback } from "./rollback.js";
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

function seedAttempt(
  db: DatabaseSync, taskId: string, versionHash: string,
  stageName: string, status: "success" | "running" | "error" | "superseded",
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

describe("Stage 5E end-to-end: autoApprove → migrate → stats", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("idle task: autoApprove safe, migrate succeeds, stats reports 1 success", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");

    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    seedAttempt(db, "t-e2e-1", submitted.versionHash, firstAgent.name, "success");

    const newPromptRef = firstAgent.type === "agent"
      ? firstAgent.config.promptRef + "-v2" : "x";
    const propose = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{
        op: "update_stage_config", stage: firstAgent.name,
        configPatch: { promptRef: newPromptRef },
      }] },
      actor: "ai",
      rerunFrom: firstAgent.name,
      migrateRunningTasks: ["t-e2e-1"],
      autoApprove: true,
    });
    if (!propose.ok) throw new Error("propose failed");
    expect(propose.autoApplied).toBe(true);

    const startRunner = vi.fn(async () => ({
      ok: true as const, taskId: "t-e2e-1", versionHash: propose.proposedVersion,
    }));
    const mig = await executeMigration({
      db, taskId: "t-e2e-1", proposalId: propose.proposalId,
      startRunnerOverride: startRunner as never,
    });
    expect(mig.ok).toBe(true);

    const stats = svc.queryHotUpdateStats({ taskId: "t-e2e-1" });
    expect(stats.totalMigrations).toBe(1);
    expect(stats.successCount).toBe(1);
    expect(stats.failedCount).toBe(0);
    expect(stats.rolledBackCount).toBe(0);
    db.close();
  });

  it("forward then rollback: stats reports 2 success + 1 rolled_back", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const v1 = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!v1.ok) throw new Error("submit failed");

    for (const s of diamondIR().stages) {
      seedAttempt(db, "t-e2e-2", v1.versionHash, s.name, "success");
    }

    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    const newPromptRef = firstAgent.type === "agent"
      ? firstAgent.config.promptRef + "-fwd" : "x";
    const prop = svc.propose({
      currentVersion: v1.versionHash,
      patch: { ops: [{
        op: "update_stage_config", stage: firstAgent.name,
        configPatch: { promptRef: newPromptRef },
      }] },
      actor: "ai",
      rerunFrom: firstAgent.name,
      migrateRunningTasks: ["t-e2e-2"],
      autoApprove: true,
    });
    if (!prop.ok) throw new Error("propose failed");
    const v2 = prop.proposedVersion;

    const startRunner = vi.fn(async () => ({
      ok: true as const, taskId: "t-e2e-2", versionHash: v2,
    }));
    const fwd = await executeMigration({
      db, taskId: "t-e2e-2", proposalId: prop.proposalId,
      startRunnerOverride: startRunner as never,
    });
    expect(fwd.ok).toBe(true);

    seedAttempt(db, "t-e2e-2", v2, firstAgent.name, "running");

    const rb = await executeRollback({
      db, taskId: "t-e2e-2", toVersion: v1.versionHash, actor: "user",
      startRunnerOverride: startRunner as never,
    });
    expect(rb.ok).toBe(true);

    const stats = svc.queryHotUpdateStats({ taskId: "t-e2e-2" });
    // forward migration's success audit + rollback migration's success + rolled_back audit = 3
    expect(stats.totalMigrations).toBe(3);
    expect(stats.successCount).toBe(2);
    expect(stats.rolledBackCount).toBe(1);
    db.close();
  });

  it("INTERRUPT timeout: state preserved, stats reports failedCount=1", async () => {
    const db = makeDb();
    const svc = new KernelService(db, {
      skipTypeCheck: true,
      migrationInterruptWaitMsOverride: 50,
    });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    seedAttempt(db, "t-e2e-3", submitted.versionHash, firstAgent.name, "running");

    taskRegistry.register("t-e2e-3", { send: () => { /* swallow */ } });

    const newPromptRef = firstAgent.type === "agent"
      ? firstAgent.config.promptRef + "-v2" : "x";
    const prop = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{
        op: "update_stage_config", stage: firstAgent.name,
        configPatch: { promptRef: newPromptRef },
      }] },
      actor: "ai",
      rerunFrom: firstAgent.name,
      migrateRunningTasks: ["t-e2e-3"],
      autoApprove: true,
    });
    if (!prop.ok) throw new Error("propose failed");

    const result = await svc.migrateTask("t-e2e-3", prop.proposalId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.diagnostics[0]!.code).toBe("MIGRATION_INTERRUPT_TIMEOUT");

    const stillRunning = db.prepare(
      `SELECT status FROM stage_attempts WHERE task_id = 't-e2e-3' AND stage_name = ?`,
    ).get(firstAgent.name) as { status: string };
    expect(stillRunning.status).toBe("running");

    const stats = svc.queryHotUpdateStats({ taskId: "t-e2e-3" });
    expect(stats.totalMigrations).toBe(1);
    expect(stats.failedCount).toBe(1);
    expect(stats.successCount).toBe(0);

    taskRegistry.__clearForTest();
    db.close();
  });
});
