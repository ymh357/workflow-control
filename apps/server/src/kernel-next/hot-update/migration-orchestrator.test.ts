// Integration tests for Stage 5B migration orchestrator. Exercises the
// full pipeline against the real SQLite schema + KernelService; the
// runner is mocked via startRunnerOverride so tests don't launch real
// agents.

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

describe("executeMigration — idle task (no runner registered)", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("skips INTERRUPT, supersedes wire-reachable stages, resumes via startRunner", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");

    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    seedAttempt(db, "t1", submitted.versionHash, firstAgent.name, "success");

    const newPromptRef =
      firstAgent.type === "agent"
        ? firstAgent.config.promptRef + "-v2"
        : "irrelevant";
    const propose = svc.propose({
      currentVersion: submitted.versionHash,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: firstAgent.name,
          configPatch: { promptRef: newPromptRef },
        }],
      },
      actor: "test",
      rerunFrom: firstAgent.name,
      migrateRunningTasks: ["t1"],
      autoApprove: true,
    });
    if (!propose.ok) {
      throw new Error("propose failed: " + JSON.stringify(propose.diagnostics));
    }

    const startRunner = vi.fn(async () => ({
      ok: true as const,
      taskId: "t1",
      versionHash: propose.proposedVersion,
    }));

    const r = await executeMigration({
      db,
      taskId: "t1",
      proposalId: propose.proposalId,
      startRunnerOverride: startRunner as never,
    });
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r));
    expect(r.newRunnerStarted).toBe(true);
    expect(startRunner).toHaveBeenCalledOnce();
    expect(r.supersededStages).toContain(firstAgent.name);

    const audit = db.prepare(
      `SELECT status, diagnostic_json FROM hot_update_events
       WHERE event_id = ?`,
    ).get(r.eventId) as { status: string; diagnostic_json: string };
    expect(audit.status).toBe("success");
    expect(JSON.parse(audit.diagnostic_json).__kind).toBe("migration-executed-v1");
    db.close();
  });
});

describe("executeMigration — INTERRUPT timeout", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("times out when registered runner never signals termination", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    seedAttempt(db, "t-to", submitted.versionHash, firstAgent.name, "running");

    const newPromptRef =
      firstAgent.type === "agent"
        ? firstAgent.config.promptRef + "-v2"
        : "x";
    const propose = svc.propose({
      currentVersion: submitted.versionHash,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: firstAgent.name,
          configPatch: { promptRef: newPromptRef },
        }],
      },
      actor: "test",
      rerunFrom: firstAgent.name,
      migrateRunningTasks: ["t-to"],
      autoApprove: true,
    });
    if (!propose.ok) throw new Error("propose failed");

    // Register a dispatcher that swallows INTERRUPT — emulates hung runner
    taskRegistry.register("t-to", { send: () => { /* swallow */ } });

    const r = await executeMigration({
      db,
      taskId: "t-to",
      proposalId: propose.proposalId,
      interruptWaitMsOverride: 50,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("MIGRATION_INTERRUPT_TIMEOUT");

    // Supersede did NOT happen — firstAgent is still running
    const stillRunning = db.prepare(
      `SELECT status FROM stage_attempts
       WHERE task_id = 't-to' AND stage_name = ?`,
    ).get(firstAgent.name) as { status: string };
    expect(stillRunning.status).toBe("running");

    // A status='failed' audit row exists
    const audits = db.prepare(
      `SELECT status FROM hot_update_events WHERE task_id = 't-to'`,
    ).all() as Array<{ status: string }>;
    expect(audits.some((a) => a.status === "failed")).toBe(true);

    taskRegistry.__clearForTest();
    db.close();
  });
});

describe("executeMigration — resume failure reverts supersede", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("reverse-supersede when startPipelineRun throws", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    seedAttempt(db, "t-rf", submitted.versionHash, firstAgent.name, "success");

    const newPromptRef =
      firstAgent.type === "agent"
        ? firstAgent.config.promptRef + "-v2"
        : "x";
    const propose = svc.propose({
      currentVersion: submitted.versionHash,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: firstAgent.name,
          configPatch: { promptRef: newPromptRef },
        }],
      },
      actor: "test",
      rerunFrom: firstAgent.name,
      migrateRunningTasks: ["t-rf"],
      autoApprove: true,
    });
    if (!propose.ok) throw new Error("propose failed");

    const startRunner = vi.fn(async () => {
      throw new Error("boom");
    });

    const r = await executeMigration({
      db,
      taskId: "t-rf",
      proposalId: propose.proposalId,
      startRunnerOverride: startRunner as never,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.code).toBe("MIGRATION_RESUME_FAILED");

    // Reverse-supersede: status restored from 'superseded' to 'success'
    const restored = db.prepare(
      `SELECT status FROM stage_attempts
       WHERE task_id = 't-rf' AND stage_name = ?`,
    ).get(firstAgent.name) as { status: string };
    expect(restored.status).toBe("success");

    // Two audit rows: the supersede 'success' and the resume 'failed'
    const audits = db.prepare(
      `SELECT status FROM hot_update_events
       WHERE task_id = 't-rf' ORDER BY started_at`,
    ).all() as Array<{ status: string }>;
    expect(audits.some((a) => a.status === "success")).toBe(true);
    expect(audits.some((a) => a.status === "failed")).toBe(true);

    db.close();
  });
});

describe("executeMigration — B13 parallel sibling not superseded", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("only supersedes stages wire-reachable from rerunFrom, preserving sibling branch", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");

    // Seed success attempts for all four diamond stages
    for (const s of diamondIR().stages) {
      seedAttempt(db, "t-par", submitted.versionHash, s.name, "success");
    }

    // Verify diamond structure assumption before using it in the test
    const ir = diamondIR();
    const hasWire = (from: string, to: string): boolean =>
      ir.wires.some(
        (w) =>
          (w.from.source === "stage" || w.from.source === undefined) &&
          (w.from as { stage: string }).stage === from &&
          w.to.stage === to,
      );
    if (!hasWire("B", "D") || hasWire("B", "C")) {
      throw new Error(
        "diamondIR shape drifted; update this test against the current IR",
      );
    }

    // Change B's promptRef; rerunFrom = B
    const stageB = ir.stages.find((s) => s.name === "B");
    const newPromptRef =
      stageB?.type === "agent" ? stageB.config.promptRef + "-v2" : "irrelevant";
    const propose = svc.propose({
      currentVersion: submitted.versionHash,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: "B",
          configPatch: { promptRef: newPromptRef },
        }],
      },
      actor: "test",
      rerunFrom: "B",
      migrateRunningTasks: ["t-par"],
      autoApprove: true,
    });
    if (!propose.ok) {
      throw new Error("propose failed: " + JSON.stringify(propose.diagnostics));
    }

    const startRunner = vi.fn(async () => ({
      ok: true as const,
      taskId: "t-par",
      versionHash: propose.proposedVersion,
    }));

    const r = await executeMigration({
      db,
      taskId: "t-par",
      proposalId: propose.proposalId,
      startRunnerOverride: startRunner as never,
    });
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r));

    // A and C stay success; B and D are superseded
    const statuses = db.prepare(
      `SELECT stage_name, status FROM stage_attempts
       WHERE task_id = 't-par'`,
    ).all() as Array<{ stage_name: string; status: string }>;
    const byStage = new Map(statuses.map((s) => [s.stage_name, s.status]));
    expect(byStage.get("A")).toBe("success");
    expect(byStage.get("B")).toBe("superseded");
    expect(byStage.get("C")).toBe("success"); // B13: parallel sibling intact
    expect(byStage.get("D")).toBe("superseded"); // wire-reachable from B
    db.close();
  });
});

describe("executeMigration — concurrent lock", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("second executeMigration on same task returns MIGRATION_IN_PROGRESS", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    seedAttempt(db, "t-cc", submitted.versionHash, firstAgent.name, "success");

    const newPromptRef =
      firstAgent.type === "agent"
        ? firstAgent.config.promptRef + "-vX"
        : "x";
    const propose = svc.propose({
      currentVersion: submitted.versionHash,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: firstAgent.name,
          configPatch: { promptRef: newPromptRef },
        }],
      },
      actor: "test",
      rerunFrom: firstAgent.name,
      migrateRunningTasks: ["t-cc"],
      autoApprove: true,
    });
    if (!propose.ok) throw new Error("propose failed");

    // Slow runner keeps the lock held for ~100ms
    const slowRunner = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return {
        ok: true as const,
        taskId: "t-cc",
        versionHash: propose.proposedVersion,
      };
    });

    const p1 = executeMigration({
      db,
      taskId: "t-cc",
      proposalId: propose.proposalId,
      startRunnerOverride: slowRunner as never,
    });
    // Fire second call while first is still running the slow runner
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await executeMigration({
      db,
      taskId: "t-cc",
      proposalId: propose.proposalId,
      startRunnerOverride: slowRunner as never,
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error("expected failure");
    expect(r2.code).toBe("MIGRATION_IN_PROGRESS");
    // First call completes successfully
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    db.close();
  });
});
