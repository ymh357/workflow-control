// Migration real-resume e2e — no startRunnerOverride.
//
// All existing migration tests mock startRunner via
// startRunnerOverride, so the "new runner starts on toVersion,
// executes rerunFrom + downstream, task terminates" half of the
// chain is verified only by unit-level happy-path assumptions. This
// suite closes that gap by letting migration-orchestrator call the
// real startPipelineRun and running a mock-registry diamond through
// it.
//
// Setup: the "diamond" entry in MOCK_HANDLER_REGISTRY provides
// synthetic handlers. startPipelineRun's name-based registry lookup
// also works when only versionHash is passed (it resolves ir.name
// → registry entry), so migration's versionHash-only call path
// exercises the same handler wiring as the initial run.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import {
  executeMigration,
  __resetOrchestratorLocksForTest,
} from "./migration-orchestrator.js";
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

describe("migration real-resume e2e (no startRunnerOverride)", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("propose + migrate fires real startPipelineRun which completes the rerun chain on toVersion", async () => {
    const db = makeDb();
    try {
      // Seed v1 via submit — diamond IR, prompts dummy.
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
      if (!submitted.ok) throw new Error("submit: " + JSON.stringify(submitted.diagnostics));
      const v1 = submitted.versionHash;

      // Kick off a real v1 run via startPipelineRun (same entry
      // migration-orchestrator uses internally). Using name triggers
      // the mock-registry fast path → MockExecutor + slowDiamondHandlers
      // not necessary; plain diamond handlers are instantaneous.
      const run1 = await startPipelineRun({
        db,
        broadcaster: { publish: () => {} } as never,
        name: "diamond",
        versionHash: v1,
        taskId: "t-real-resume",
      });
      if (!run1.ok) throw new Error("initial run: " + JSON.stringify(run1));

      // Wait for v1 run to finish — the mock diamond handlers complete
      // in microseconds, so 500ms is plenty.
      await waitUntilTaskDone(db, "t-real-resume", 3000);

      // Confirm v1 run actually finished successfully — all 4 stages
      // have a success attempt on v1.
      const v1Attempts = db.prepare(
        `SELECT stage_name, status FROM stage_attempts
         WHERE task_id = ? AND version_hash = ?
         ORDER BY stage_name`,
      ).all("t-real-resume", v1) as Array<{ stage_name: string; status: string }>;
      expect(v1Attempts.length).toBeGreaterThanOrEqual(4);
      expect(v1Attempts.every((r) => r.status === "success")).toBe(true);

      // Propose v2: modify B's promptRef. rerunFrom=B.
      const firstAgent = diamondIR().stages.find((s) => s.type === "agent" && s.name === "B");
      if (!firstAgent || firstAgent.type !== "agent") throw new Error("no B stage");
      const newPromptRef = firstAgent.config.promptRef + "-v2";
      const propose = svc.propose({
        currentVersion: v1,
        patch: { ops: [{
          op: "update_stage_config", stage: "B",
          configPatch: { promptRef: newPromptRef },
        }] },
        actor: "test",
        rerunFrom: "B",
        migrateRunningTasks: ["t-real-resume"],
        autoApprove: true,
      });
      if (!propose.ok) throw new Error("propose: " + JSON.stringify(propose.diagnostics));

      // Execute migration WITHOUT startRunnerOverride — uses the real
      // startPipelineRun imported from runtime/start-pipeline-run.js.
      const mig = await executeMigration({
        db, taskId: "t-real-resume", proposalId: propose.proposalId,
        // interruptWaitMs doesn't matter here (task not running).
      });
      if (!mig.ok) throw new Error("migration: " + JSON.stringify(mig));

      // Let the resume run settle.
      await waitUntilTaskDone(db, "t-real-resume", 5000);

      // Two assertions close the chain:
      //
      // 1. There is at least one new attempt on v2 for the rerunFrom
      //    stage (B) and every stage wire-reachable from it (B, D).
      //    wire-reachable compute sets supersede scope; the resume is
      //    expected to re-execute exactly those stages on v2.
      const v2Attempts = db.prepare(
        `SELECT stage_name, status FROM stage_attempts
         WHERE task_id = ? AND version_hash = ?
         ORDER BY stage_name, attempt_idx`,
      ).all("t-real-resume", propose.proposedVersion) as Array<{ stage_name: string; status: string }>;
      const byStage = new Map<string, string[]>();
      for (const r of v2Attempts) {
        const list = byStage.get(r.stage_name) ?? [];
        list.push(r.status);
        byStage.set(r.stage_name, list);
      }
      expect(byStage.get("B")).toBeDefined();
      expect(byStage.get("B")!.some((s) => s === "success")).toBe(true);
      expect(byStage.get("D")).toBeDefined();
      expect(byStage.get("D")!.some((s) => s === "success")).toBe(true);

      // 2. The v1 attempts for the supersede set (B and its
      //    wire-reachable descendants) are now status='superseded';
      //    out-of-scope stages (A, C) stay 'success' on v1. This
      //    confirms the precision half of B13 holds: sibling C's
      //    work is preserved across migration.
      const v1AttemptsAfter = db.prepare(
        `SELECT stage_name, status FROM stage_attempts
         WHERE task_id = ? AND version_hash = ?
         ORDER BY stage_name`,
      ).all("t-real-resume", v1) as Array<{ stage_name: string; status: string }>;
      const v1ByStage = new Map<string, string>();
      for (const r of v1AttemptsAfter) v1ByStage.set(r.stage_name, r.status);
      expect(v1ByStage.get("A")).toBe("success");
      expect(v1ByStage.get("C")).toBe("success");
      expect(v1ByStage.get("B")).toBe("superseded");
      expect(v1ByStage.get("D")).toBe("superseded");

      // 3. hot_update_events has a success row.
      const evts = db.prepare(
        `SELECT status FROM hot_update_events WHERE task_id = ?`,
      ).all("t-real-resume") as Array<{ status: string }>;
      expect(evts.length).toBe(1);
      expect(evts[0]!.status).toBe("success");
    } finally {
      db.close();
    }
  });
});
