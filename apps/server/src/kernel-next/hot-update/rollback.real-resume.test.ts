// Real rollback e2e: forward migrate v1 → v2, then rollback v2 → v1,
// without startRunnerOverride on either hop. Verifies the chain
// executeRollback → synthetic approved proposal → executeMigration →
// real startPipelineRun is structurally sound.
//
// Existing rollback tests (hot-update/rollback.test.ts) mock
// startRunner on the rollback hop. This closes that gap using the
// MOCK_HANDLER_REGISTRY diamond fast path (same as
// migration.real-resume.test.ts — the registry resolves by ir.name,
// so versionHash-only calls still pick up mock handlers).

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import { executeMigration, __resetOrchestratorLocksForTest } from "./migration-orchestrator.js";
import { executeRollback } from "./rollback.js";
import { taskRegistry } from "../runtime/task-registry.js";
import { startPipelineRun } from "../runtime/start-pipeline-run.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

async function waitUntilTaskDone(
  db: DatabaseSync, taskId: string, timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const running = db.prepare(
      `SELECT 1 FROM stage_attempts WHERE task_id = ? AND status = 'running' LIMIT 1`,
    ).get(taskId);
    const reg = taskRegistry.get(taskId);
    if (!running && !reg) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout: task ${taskId} never settled`);
}

describe("rollback real-resume e2e (no startRunnerOverride)", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("forward to v2, then rollback to v1: v1 attempts surface as success again, v2 attempts superseded", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
      if (!submitted.ok) throw new Error("submit: " + JSON.stringify(submitted.diagnostics));
      const v1 = submitted.versionHash;

      // Forward v1 run.
      const run1 = await startPipelineRun({
        db, broadcaster: { publish: () => {} } as never,
        name: "diamond", versionHash: v1, taskId: "t-rb",
      });
      if (!run1.ok) throw new Error("run1: " + JSON.stringify(run1));
      await waitUntilTaskDone(db, "t-rb", 3000);

      // Propose v2: modify B.promptRef. autoApprove, rerunFrom=B,
      // migrateRunningTasks=[t-rb].
      const propose = svc.propose({
        currentVersion: v1,
        patch: { ops: [{
          op: "update_stage_config", stage: "B",
          configPatch: { promptRef: "p-b-forward" },
        }] },
        actor: "test", rerunFrom: "B",
        migrateRunningTasks: ["t-rb"], autoApprove: true,
      });
      if (!propose.ok) throw new Error("propose: " + JSON.stringify(propose.diagnostics));
      const v2 = propose.proposedVersion;

      // Forward migrate.
      const mig = await executeMigration({
        db, taskId: "t-rb", proposalId: propose.proposalId,
      });
      if (!mig.ok) throw new Error("migrate: " + JSON.stringify(mig));
      await waitUntilTaskDone(db, "t-rb", 5000);

      // After forward, B + D have fresh v2 success; v1 B + D are superseded.
      // (Asserted more thoroughly in migration.real-resume.test; here we
      // just confirm the state machine is at v2 before rolling back.)
      const v2StatusBeforeRollback = db.prepare(
        `SELECT stage_name, status FROM stage_attempts
         WHERE task_id = ? AND version_hash = ? AND stage_name IN ('B','D')`,
      ).all("t-rb", v2) as Array<{ stage_name: string; status: string }>;
      expect(v2StatusBeforeRollback.every((r) => r.status === "success")).toBe(true);

      // Rollback v2 → v1 without startRunnerOverride.
      const rb = await executeRollback({
        db, taskId: "t-rb", toVersion: v1, actor: "test",
      });
      if (!rb.ok) throw new Error("rollback: " + JSON.stringify(rb.diagnostics));
      await waitUntilTaskDone(db, "t-rb", 5000);

      // Invariant 1 — three audit rows in order:
      //   [0] forward v1→v2 success (written by first executeMigration)
      //   [1] rollback's internal migrate v2→v1 success (second executeMigration
      //       via executeRollback's synthetic approved proposal)
      //   [2] rollback marker v2→v1 rolled_back (written by executeRollback
      //       after the internal migration succeeds — see rollback.ts:170)
      // Consumers that want "true rollbacks only" filter on
      // status='rolled_back'; the duplicate 'success' row is an
      // intentional migration-level audit detail per Stage 5E.
      const evts = db.prepare(
        `SELECT status, from_version, to_version FROM hot_update_events
         WHERE task_id = ?
         ORDER BY started_at ASC, rowid ASC`,
      ).all("t-rb") as Array<{ status: string; from_version: string; to_version: string }>;
      expect(evts.length).toBe(3);
      expect(evts[0]!.status).toBe("success");
      expect(evts[0]!.from_version).toBe(v1);
      expect(evts[0]!.to_version).toBe(v2);
      expect(evts[1]!.status).toBe("success");
      expect(evts[1]!.from_version).toBe(v2);
      expect(evts[1]!.to_version).toBe(v1);
      expect(evts[2]!.status).toBe("rolled_back");
      expect(evts[2]!.from_version).toBe(v2);
      expect(evts[2]!.to_version).toBe(v1);

      // Invariant 2 — after rollback there's a NEW success attempt on v1
      // for B + D (the re-run), and the v2 attempts for B + D become
      // superseded.
      const v1AfterRb = db.prepare(
        `SELECT stage_name, status, attempt_idx FROM stage_attempts
         WHERE task_id = ? AND version_hash = ?
         ORDER BY stage_name, attempt_idx`,
      ).all("t-rb", v1) as Array<{ stage_name: string; status: string; attempt_idx: number }>;
      const v1ByStage = new Map<string, Array<{ status: string; attempt_idx: number }>>();
      for (const r of v1AfterRb) {
        const list = v1ByStage.get(r.stage_name) ?? [];
        list.push({ status: r.status, attempt_idx: r.attempt_idx });
        v1ByStage.set(r.stage_name, list);
      }
      // B's v1 history: original success (superseded now) + new success after rollback.
      expect(v1ByStage.get("B")!.some((a) => a.status === "success")).toBe(true);
      expect(v1ByStage.get("D")!.some((a) => a.status === "success")).toBe(true);

      // v2 attempts for the rerunFrom scope are now superseded.
      const v2AfterRb = db.prepare(
        `SELECT stage_name, status FROM stage_attempts
         WHERE task_id = ? AND version_hash = ?`,
      ).all("t-rb", v2) as Array<{ stage_name: string; status: string }>;
      const v2StageStatus = new Map<string, string[]>();
      for (const r of v2AfterRb) {
        const list = v2StageStatus.get(r.stage_name) ?? [];
        list.push(r.status);
        v2StageStatus.set(r.stage_name, list);
      }
      expect(v2StageStatus.get("B")!.some((s) => s === "superseded")).toBe(true);
      expect(v2StageStatus.get("D")!.some((s) => s === "superseded")).toBe(true);
    } finally {
      db.close();
    }
  });
});
