import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import { executeRollback } from "./rollback.js";
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

describe("executeRollback", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("unknown toVersion → VERSION_NOT_IN_HISTORY", async () => {
    const db = makeDb();
    const r = await executeRollback({
      db,
      taskId: "nonexistent",
      toVersion: "hash-nope",
      actor: "t",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.diagnostics[0]!.code).toBe("VERSION_NOT_IN_HISTORY");
    db.close();
  });

  it("identical current and target IR → ROLLBACK_EMPTY_DIFF", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");

    seedAttempt(db, "t-eq", submitted.versionHash, "A", "success");
    // Seed a hot_update_events row so VERSION_NOT_IN_HISTORY doesn't
    // fire first.
    db.prepare(
      `INSERT INTO hot_update_events
       (event_id, task_id, from_version, to_version, actor, proposal_id,
        rerun_from_stage, status, started_at, finished_at, diagnostic_json)
       VALUES ('e', 't-eq', ?, ?, 'a', NULL, NULL, 'success', 1, 2, NULL)`,
    ).run(submitted.versionHash, submitted.versionHash);

    const r = await executeRollback({
      db,
      taskId: "t-eq",
      toVersion: submitted.versionHash,
      actor: "t",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.diagnostics[0]!.code).toBe("ROLLBACK_EMPTY_DIFF");
    db.close();
  });

  it("forward then rollback: task resumes from divergence stage", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const v1 = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!v1.ok) throw new Error("submit v1 failed");

    // Seed lineage on v1 (all diamond stages complete)
    for (const s of diamondIR().stages) {
      seedAttempt(db, "t-rb", v1.versionHash, s.name, "success");
    }

    // Forward propose: change A's promptRef
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    const newPromptRef =
      firstAgent.type === "agent"
        ? firstAgent.config.promptRef + "-fwd"
        : "x";
    const prop = svc.propose({
      currentVersion: v1.versionHash,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: firstAgent.name,
          configPatch: { promptRef: newPromptRef },
        }],
      },
      actor: "ai",
      rerunFrom: firstAgent.name,
      migrateRunningTasks: ["t-rb"],
      autoApprove: true,
    });
    if (!prop.ok) throw new Error("propose failed");
    const v2 = prop.proposedVersion;

    // Fire forward migration via orchestrator with mock runner
    const startRunnerStub = vi.fn(async () => ({
      ok: true as const,
      taskId: "t-rb",
      versionHash: v2,
    }));
    const mig = await executeMigration({
      db,
      taskId: "t-rb",
      proposalId: prop.proposalId,
      startRunnerOverride: startRunnerStub as never,
    });
    if (!mig.ok) {
      throw new Error("forward migrate failed: " + JSON.stringify(mig));
    }

    // After the forward migration the task's most-recent attempt row is
    // still on v1 (we never actually kicked off a runner on v2). For
    // rollback to detect currentVersion as v2, seed a new attempt row
    // on v2 emulating what the resumed runner would have produced.
    seedAttempt(db, "t-rb", v2, firstAgent.name, "running");

    const rb = await executeRollback({
      db,
      taskId: "t-rb",
      toVersion: v1.versionHash,
      actor: "t",
      startRunnerOverride: startRunnerStub as never,
    });
    if (!rb.ok) {
      throw new Error("rollback failed: " + JSON.stringify(rb.diagnostics));
    }

    expect(rb.rolledTo).toBe(v1.versionHash);
    expect(rb.divergenceStage).toBe(firstAgent.name);

    // rolled_back audit row exists
    const rollbacks = db.prepare(
      `SELECT COUNT(*) AS n FROM hot_update_events
       WHERE task_id = 't-rb' AND status = 'rolled_back'`,
    ).get() as { n: number };
    expect(rollbacks.n).toBeGreaterThanOrEqual(1);

    // migrationEventId from rb.migrationEventId is a separate success row
    const migEvent = db.prepare(
      `SELECT status, diagnostic_json FROM hot_update_events WHERE event_id = ?`,
    ).get(rb.migrationEventId) as
      | { status: string; diagnostic_json: string }
      | undefined;
    expect(migEvent?.status).toBe("success");
    expect(JSON.parse(migEvent!.diagnostic_json).__kind).toBe("migration-executed-v1");

    db.close();
  });
});
