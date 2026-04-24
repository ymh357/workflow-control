// Concurrent migrations on DIFFERENT taskIds sharing the same
// approved proposal. The orchestrator lock is per-taskId; there's
// nothing structural preventing two migrations from interleaving
// their supersede TXs, resume fires, and hot_update_events writes.
// This test pins that down so a future change to lock scope or
// proposal handling can't silently regress the multi-task case.

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

describe("concurrent migration across different tasks (shared proposal)", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("both task migrations succeed independently; v1 supersede + v2 resume land per task", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
      if (!submitted.ok) throw new Error("submit: " + JSON.stringify(submitted.diagnostics));
      const v1 = submitted.versionHash;

      // Launch two independent v1 runs.
      const run1 = await startPipelineRun({
        db, broadcaster: { publish: () => {} } as never,
        name: "diamond", versionHash: v1, taskId: "t-a",
      });
      const run2 = await startPipelineRun({
        db, broadcaster: { publish: () => {} } as never,
        name: "diamond", versionHash: v1, taskId: "t-b",
      });
      if (!run1.ok || !run2.ok) throw new Error("initial run failed");
      await Promise.all([
        waitUntilTaskDone(db, "t-a", 3000),
        waitUntilTaskDone(db, "t-b", 3000),
      ]);

      // Both tasks finished on v1; sanity check.
      for (const tid of ["t-a", "t-b"]) {
        const attempts = db.prepare(
          `SELECT status FROM stage_attempts
           WHERE task_id = ? AND version_hash = ?`,
        ).all(tid, v1) as Array<{ status: string }>;
        expect(attempts.every((r) => r.status === "success")).toBe(true);
      }

      // Propose v2 with migrateRunningTasks covering both.
      const newPromptRef = diamondIR().stages.find(
        (s) => s.name === "B" && s.type === "agent",
      )!.type === "agent"
        ? "p-b-v2-concurrent"
        : "x";
      const propose = svc.propose({
        currentVersion: v1,
        patch: { ops: [{
          op: "update_stage_config", stage: "B",
          configPatch: { promptRef: newPromptRef },
        }] },
        actor: "test",
        rerunFrom: "B",
        migrateRunningTasks: ["t-a", "t-b"],
        autoApprove: true,
      });
      if (!propose.ok) throw new Error("propose: " + JSON.stringify(propose.diagnostics));

      // Fire both migrations concurrently. They must not interfere —
      // lock is per-taskId, supersede TX touches per-taskId rows only,
      // resume startPipelineRun is fully independent.
      const [mA, mB] = await Promise.all([
        executeMigration({
          db, taskId: "t-a", proposalId: propose.proposalId,
        }),
        executeMigration({
          db, taskId: "t-b", proposalId: propose.proposalId,
        }),
      ]);
      if (!mA.ok) throw new Error("migA: " + JSON.stringify(mA));
      if (!mB.ok) throw new Error("migB: " + JSON.stringify(mB));

      // Wait for both resume runs to finish.
      await Promise.all([
        waitUntilTaskDone(db, "t-a", 5000),
        waitUntilTaskDone(db, "t-b", 5000),
      ]);

      // Per-task invariants — same shape for both.
      for (const tid of ["t-a", "t-b"]) {
        // v2 attempts for B + D (wire-reachable from B) are success.
        const v2 = db.prepare(
          `SELECT stage_name, status FROM stage_attempts
           WHERE task_id = ? AND version_hash = ?`,
        ).all(tid, propose.proposedVersion) as Array<{ stage_name: string; status: string }>;
        const v2ByStage = new Map<string, string[]>();
        for (const r of v2) {
          const list = v2ByStage.get(r.stage_name) ?? [];
          list.push(r.status);
          v2ByStage.set(r.stage_name, list);
        }
        expect(v2ByStage.get("B")!.some((s) => s === "success")).toBe(true);
        expect(v2ByStage.get("D")!.some((s) => s === "success")).toBe(true);

        // v1 B + D superseded; A + C still success.
        const v1After = db.prepare(
          `SELECT stage_name, status FROM stage_attempts
           WHERE task_id = ? AND version_hash = ?`,
        ).all(tid, v1) as Array<{ stage_name: string; status: string }>;
        const v1ByStage = new Map<string, string>();
        for (const r of v1After) v1ByStage.set(r.stage_name, r.status);
        expect(v1ByStage.get("A")).toBe("success");
        expect(v1ByStage.get("C")).toBe("success");
        expect(v1ByStage.get("B")).toBe("superseded");
        expect(v1ByStage.get("D")).toBe("superseded");
      }

      // hot_update_events has exactly two success rows, one per task.
      const evts = db.prepare(
        `SELECT task_id, status FROM hot_update_events
         ORDER BY task_id`,
      ).all() as Array<{ task_id: string; status: string }>;
      expect(evts.length).toBe(2);
      expect(evts.map((e) => e.task_id).sort()).toEqual(["t-a", "t-b"]);
      expect(evts.every((e) => e.status === "success")).toBe(true);
    } finally {
      db.close();
    }
  });
});
