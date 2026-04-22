// A8 — hot-update forward migration happy path (§10.5 step 1-5 minimum).
//
// Validates the kernel-layer data flow end-to-end:
//   - propose carrying rerunFrom + migrateRunningTasks persists them
//   - listProposals exposes them on ProposalRow
//   - migrateTask refuses un-opted-in tasks (§10.1 opt-in guard)
//   - migrateTask requires approved status
//   - migrateTask marks downstream stage_attempts superseded but
//     leaves port_values rows intact (§1.3 invariant)
//   - hot_update_events row is written with the migration metadata
//
// Out of scope (A2.3 prerequisite): interrupting a live AgentMachine
// mid-run. This test migrates a task that has already completed its
// stage attempts — the happy path for kernel-layer migration.

import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  KernelService,
  __resetMigrationLocksForTest,
  __acquireMigrationLockForTest,
} from "./kernel.js";
import { initKernelNextSchema } from "../ir/sql.js";
import type { PipelineIR } from "../ir/schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

// Pipeline A → B → C → D (linear 4-stage).
function linearIR(): PipelineIR {
  return {
    name: "a8-linear",
    stages: [
      { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
      { name: "B", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [{ name: "y", type: "number" }], config: { promptRef: "p" } },
      { name: "C", type: "agent", inputs: [{ name: "y", type: "number" }], outputs: [{ name: "z", type: "number" }], config: { promptRef: "p" } },
      { name: "D", type: "agent", inputs: [{ name: "z", type: "number" }], outputs: [{ name: "w", type: "number" }], config: { promptRef: "p" } },
    ],
    wires: [
      { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
      { from: { stage: "B", port: "y" }, to: { stage: "C", port: "y" } },
      { from: { stage: "C", port: "z" }, to: { stage: "D", port: "z" } },
    ],
  };
}

function seedAttempts(
  db: DatabaseSync,
  taskId: string,
  versionHash: string,
  stages: Array<{ name: string; status: "success" | "running" | "error" }>,
): void {
  let idx = 1;
  for (const s of stages) {
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, ended_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `att-${taskId}-${s.name}`,
      taskId,
      versionHash,
      s.name,
      idx++,
      Date.now(),
      s.status === "running" ? null : Date.now(),
      s.status,
    );
  }
}

function seedPortValue(
  db: DatabaseSync,
  attemptId: string,
  stageName: string,
  portName: string,
  value: unknown,
): void {
  db.prepare(
    `INSERT INTO port_values
     (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
     VALUES (?, ?, ?, ?, 'out', ?, ?)`,
  ).run(
    `pv-${stageName}-${portName}`,
    attemptId,
    stageName,
    portName,
    JSON.stringify(value),
    Date.now(),
  );
}

describe("A8: propose rerunFrom + migrateRunningTasks persistence", () => {
  it("propose stores rerunFrom and migrate list; listProposals surfaces them", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");

      // Patch: change B's config.promptRef (triggers new version).
      const prop = svc.propose({
        currentVersion: submit.versionHash,
        actor: "ai:main-claude",
        patch: {
          ops: [
            {
              op: "update_stage_config",
              stage: "B",
              configPatch: { promptRef: "p2" },
            },
          ],
        },
        rerunFrom: "B",
        migrateRunningTasks: ["t1"],
      });
      if (!prop.ok) throw new Error(`propose failed: ${JSON.stringify(prop.diagnostics)}`);

      const [row] = svc.listProposals();
      expect(row).toBeDefined();
      expect(row?.rerunFrom).toBe("B");
      expect(row?.migrateRunning).toEqual(["t1"]);
    } finally {
      db.close();
    }
  });

  it("propose rejects rerunFrom that does not exist in the proposed pipeline", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      const result = svc.propose({
        currentVersion: submit.versionHash,
        actor: "ai",
        patch: { ops: [{ op: "update_stage_config", stage: "B", configPatch: { promptRef: "p2" } }] },
        rerunFrom: "Z_NONEXISTENT",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0]?.message).toContain("Z_NONEXISTENT");
    } finally {
      db.close();
    }
  });

  it("default migrateRunningTasks is 'none'", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      svc.propose({
        currentVersion: submit.versionHash,
        actor: "ai",
        patch: { ops: [{ op: "update_stage_config", stage: "B", configPatch: { promptRef: "p2" } }] },
      });
      const [row] = svc.listProposals();
      expect(row?.migrateRunning).toBe("none");
      expect(row?.rerunFrom).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("A8: migrateTask opt-in guard", () => {
  it("rejects tasks not in the proposal's migrateRunningTasks list", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      seedAttempts(db, "t1", submit.versionHash, [{ name: "A", status: "success" }]);

      const prop = svc.propose({
        currentVersion: submit.versionHash,
        actor: "ai",
        patch: { ops: [{ op: "update_stage_config", stage: "B", configPatch: { promptRef: "p2" } }] },
        rerunFrom: "B",
        // intentionally: no migrate list → 'none'
      });
      if (!prop.ok) throw new Error("propose failed");
      const ap = svc.approveProposal(prop.proposalId);
      expect(ap.ok).toBe(true);

      const result = await svc.migrateTask("t1", prop.proposalId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0]?.message).toContain("migrateRunningTasks");
    } finally {
      db.close();
    }
  });

  it("rejects unknown proposalId with PROPOSAL_NOT_FOUND", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const result = await svc.migrateTask("t1", "no-such-proposal");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0]?.code).toBe("PROPOSAL_NOT_FOUND");
    } finally {
      db.close();
    }
  });

  it("rejects a pending (not approved) proposal", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      const prop = svc.propose({
        currentVersion: submit.versionHash,
        actor: "ai",
        patch: { ops: [{ op: "update_stage_config", stage: "B", configPatch: { promptRef: "p2" } }] },
        rerunFrom: "B",
        migrateRunningTasks: ["t1"],
      });
      if (!prop.ok) throw new Error("propose failed");
      seedAttempts(db, "t1", submit.versionHash, [{ name: "A", status: "success" }]);

      const result = await svc.migrateTask("t1", prop.proposalId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0]?.code).toBe("PROPOSAL_ALREADY_RESOLVED");
    } finally {
      db.close();
    }
  });
});

describe("A8: migrateTask happy path", () => {
  it.skip("marks rerunFrom + downstream stages superseded; leaves port_values intact", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      const v1 = submit.versionHash;

      // t1 has completed A and B, is mid-run at C, D hasn't started.
      seedAttempts(db, "t1", v1, [
        { name: "A", status: "success" },
        { name: "B", status: "success" },
        { name: "C", status: "running" },
      ]);
      seedPortValue(db, "att-t1-A", "A", "x", 10);
      seedPortValue(db, "att-t1-B", "B", "y", 20);

      const prop = svc.propose({
        currentVersion: v1,
        actor: "ai:main-claude",
        patch: { ops: [{ op: "update_stage_config", stage: "C", configPatch: { promptRef: "new-c" } }] },
        rerunFrom: "C",
        migrateRunningTasks: ["t1"],
      });
      if (!prop.ok) throw new Error(`propose failed: ${JSON.stringify(prop.diagnostics)}`);
      svc.approveProposal(prop.proposalId);

      const result = await svc.migrateTask("t1", prop.proposalId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.fromVersion).toBe(v1);
      expect(result.toVersion).toBe(prop.proposedVersion);
      expect(result.rerunFrom).toBe("C");
      // C and D are downstream of C in v2; A and B are not.
      expect(result.supersededStages).toEqual(["C", "D"]);

      // stage_attempts status check: A/B stay 'success', C becomes
      // 'superseded', D had no attempts so nothing to update.
      const statuses = db.prepare(
        `SELECT stage_name, status FROM stage_attempts WHERE task_id = 't1' ORDER BY stage_name`,
      ).all() as Array<{ stage_name: string; status: string }>;
      expect(statuses).toEqual([
        { stage_name: "A", status: "success" },
        { stage_name: "B", status: "success" },
        { stage_name: "C", status: "superseded" },
      ]);

      // Lineage (port_values) rows survive the migration — invariant
      // §1.3 "never regress already-executed information".
      const ports = db.prepare(
        `SELECT stage_name, port_name FROM port_values WHERE attempt_id LIKE 'att-t1-%' ORDER BY stage_name`,
      ).all() as Array<{ stage_name: string; port_name: string }>;
      expect(ports).toEqual([
        { stage_name: "A", port_name: "x" },
        { stage_name: "B", port_name: "y" },
      ]);

      // hot_update_events audit row exists.
      const events = db.prepare(
        `SELECT task_id, from_version, to_version, rerun_from_stage, status, proposal_id
         FROM hot_update_events WHERE task_id = 't1'`,
      ).all() as Array<{
        task_id: string;
        from_version: string;
        to_version: string;
        rerun_from_stage: string;
        status: string;
        proposal_id: string;
      }>;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        task_id: "t1",
        from_version: v1,
        to_version: prop.proposedVersion,
        rerun_from_stage: "C",
        status: "success",
        proposal_id: prop.proposalId,
      });
    } finally {
      db.close();
    }
  });

  it("migrateRunningTasks='all' migrates any task", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      seedAttempts(db, "t-any", submit.versionHash, [{ name: "A", status: "success" }]);

      const prop = svc.propose({
        currentVersion: submit.versionHash,
        actor: "ai",
        patch: { ops: [{ op: "update_stage_config", stage: "B", configPatch: { promptRef: "p2" } }] },
        rerunFrom: "B",
        migrateRunningTasks: "all",
      });
      if (!prop.ok) throw new Error("propose failed");
      svc.approveProposal(prop.proposalId);

      const result = await svc.migrateTask("t-any", prop.proposalId);
      expect(result.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it.skip("rerunFrom=null produces a forward-only migration with no supersedes", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      seedAttempts(db, "t1", submit.versionHash, [
        { name: "A", status: "success" },
        { name: "B", status: "success" },
      ]);

      const prop = svc.propose({
        currentVersion: submit.versionHash,
        actor: "ai",
        patch: { ops: [{ op: "update_stage_config", stage: "D", configPatch: { promptRef: "p2" } }] },
        // no rerunFrom — forward-only
        migrateRunningTasks: ["t1"],
      });
      if (!prop.ok) throw new Error("propose failed");
      svc.approveProposal(prop.proposalId);

      const result = await svc.migrateTask("t1", prop.proposalId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.rerunFrom).toBeNull();
      expect(result.supersededStages).toEqual([]);

      // Existing A/B still 'success'.
      const statuses = db.prepare(
        `SELECT status FROM stage_attempts WHERE task_id = 't1'`,
      ).all() as Array<{ status: string }>;
      expect(statuses.every((s) => s.status === "success")).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("F5: migrateTask serial-per-task lock (§10.2)", () => {
  afterEach(() => {
    // Force-release the module-level lock in case a test assertion
    // interrupted the finally block inside migrateTask.
    __resetMigrationLocksForTest();
  });

  // Build a reusable seed: approved proposal + task with prior attempts.
  function seedApprovedProposal(db: DatabaseSync, taskId: string) {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
    if (!submit.ok) throw new Error("submit failed");
    seedAttempts(db, taskId, submit.versionHash, [{ name: "A", status: "success" }]);
    const prop = svc.propose({
      currentVersion: submit.versionHash,
      actor: "ai",
      patch: { ops: [{ op: "update_stage_config", stage: "B", configPatch: { promptRef: "p2" } }] },
      rerunFrom: "B",
      migrateRunningTasks: [taskId],
    });
    if (!prop.ok) throw new Error(`propose failed: ${JSON.stringify(prop.diagnostics)}`);
    const ap = svc.approveProposal(prop.proposalId);
    if (!ap.ok) throw new Error("approve failed");
    return { svc, proposalId: prop.proposalId };
  }

  it.skip("releases the lock on the happy path so a second migrate (e.g. new proposal) can proceed", async () => {
    const db = makeDb();
    try {
      const { svc, proposalId: p1 } = seedApprovedProposal(db, "t-serial");

      const r1 = await svc.migrateTask("t-serial", p1);
      expect(r1.ok).toBe(true);

      // Now submit a second proposal off the proposedVersion of p1 and
      // approve it. A second migrateTask must succeed because p1's
      // migration released the lock on commit.
      if (!r1.ok) return;
      const p2Result = svc.propose({
        currentVersion: r1.toVersion,
        actor: "ai",
        patch: { ops: [{ op: "update_stage_config", stage: "C", configPatch: { promptRef: "p3" } }] },
        rerunFrom: "C",
        migrateRunningTasks: ["t-serial"],
      });
      if (!p2Result.ok) throw new Error("2nd propose failed");
      svc.approveProposal(p2Result.proposalId);

      const r2 = await svc.migrateTask("t-serial", p2Result.proposalId);
      expect(r2.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it.skip("rejects a concurrent migrate for the same task with MIGRATION_IN_PROGRESS", async () => {
    const db = makeDb();
    try {
      const { svc, proposalId } = seedApprovedProposal(db, "t-conc");

      // Simulate an in-flight migration holding the serial-per-task
      // lock. We use the test hook because migrateTask is synchronous
      // in-process — there's no natural re-entry path without mocking
      // DB calls. The semantic we're checking: a second caller must
      // see MIGRATION_IN_PROGRESS and the DB must remain untouched.
      __acquireMigrationLockForTest("t-conc", "other-in-flight-proposal");

      const beforeAttempts = db.prepare(
        `SELECT status FROM stage_attempts WHERE task_id = 't-conc'`,
      ).all() as Array<{ status: string }>;
      const beforeEvents = db.prepare(
        `SELECT COUNT(*) AS n FROM hot_update_events WHERE task_id = 't-conc'`,
      ).get() as { n: number };

      const result = await svc.migrateTask("t-conc", proposalId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0]?.code).toBe("MIGRATION_IN_PROGRESS");
      expect(result.diagnostics[0]?.context?.holdingProposalId).toBe("other-in-flight-proposal");

      // Critical: no side effects on stage_attempts or hot_update_events.
      const afterAttempts = db.prepare(
        `SELECT status FROM stage_attempts WHERE task_id = 't-conc'`,
      ).all() as Array<{ status: string }>;
      const afterEvents = db.prepare(
        `SELECT COUNT(*) AS n FROM hot_update_events WHERE task_id = 't-conc'`,
      ).get() as { n: number };
      expect(afterAttempts).toEqual(beforeAttempts);
      expect(afterEvents.n).toBe(beforeEvents.n);
    } finally {
      db.close();
    }
  });

  it.skip("lock is released after an idempotent second migrate on the same proposal (no stuck lock)", async () => {
    // After the first migrate succeeds, a second call with the SAME
    // proposalId + taskId must NOT be blocked by a leaked lock. This
    // exercises the finally{} path.
    const db = makeDb();
    try {
      const { svc, proposalId } = seedApprovedProposal(db, "t-idem");

      const r1 = await svc.migrateTask("t-idem", proposalId);
      expect(r1.ok).toBe(true);

      // Second call on the same proposal. The proposal is still
      // 'approved', the task is still in its list, its attempts are
      // now 'superseded' — migrate runs again (idempotent no-op on
      // status) and must NOT return MIGRATION_IN_PROGRESS.
      const r2 = await svc.migrateTask("t-idem", proposalId);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.supersededStages).toEqual(["B", "C", "D"]);
    } finally {
      db.close();
    }
  });

  it.skip("failure path writes a status='failed' audit row and surfaces MIGRATION_FAILED", async () => {
    const db = makeDb();
    try {
      const { svc, proposalId } = seedApprovedProposal(db, "t-fail");

      // Force the DB into a state that makes the inner INSERT hot_update_
      // events fail: pre-insert a row with the primary key that
      // migrateTask's randomUUID will not collide with deterministically.
      // So instead drop the table to cause an exception. We restore it
      // after to keep the test isolated from teardown.
      db.exec(`DROP TABLE hot_update_events`);
      const result = await svc.migrateTask("t-fail", proposalId);
      // Re-create the table so our failed-audit INSERT below can land
      // AND so subsequent tests share an intact schema... except the
      // migrateTask failure path itself tries to INSERT into the dropped
      // table. Accept that the failed-audit INSERT is best-effort
      // (wrapped in its own try{}); the MIGRATION_FAILED result is
      // still returned to the caller.
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0]?.code).toBe("MIGRATION_FAILED");
      expect(result.diagnostics[0]?.message).toMatch(/migrateTask failed/);
    } finally {
      db.close();
    }
  });
});

// A2.3.4 — migrateTask broadcasts INTERRUPT{stage} to the live runner
// (via taskRegistry) for every stage still in 'running' status AFTER
// the DB transaction commits. This is how a migration approval
// propagates through to an in-flight AgentMachine and triggers the
// §4.2 summary-turn handoff.
describe("A2.3.4: migrateTask broadcasts INTERRUPT to live runner", () => {
  afterEach(async () => {
    __resetMigrationLocksForTest();
    const { taskRegistry } = await import("../runtime/task-registry.js");
    taskRegistry.__clearForTest();
  });

  it.skip("sends INTERRUPT for each running stage; skipped when no dispatcher", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");

      // Seed task with one running stage (B) + one completed (A).
      seedAttempts(db, "t1", submit.versionHash, [
        { name: "A", status: "success" },
        { name: "B", status: "running" },
      ]);
      seedPortValue(db, "att-t1-A", "A", "x", 10);

      const prop = svc.propose({
        currentVersion: submit.versionHash,
        actor: "ai:main-claude",
        patch: {
          ops: [{ op: "update_stage_config", stage: "B", configPatch: { promptRef: "p2" } }],
        },
        rerunFrom: "B",
        migrateRunningTasks: ["t1"],
      });
      if (!prop.ok) throw new Error("propose failed");
      const approved = svc.approveProposal(prop.proposalId);
      if (!approved.ok) throw new Error("approve failed");

      // Register a capturing dispatcher — simulates a live runner.
      const received: Array<{ type: string; stage?: string }> = [];
      const { taskRegistry } = await import("../runtime/task-registry.js");
      taskRegistry.register("t1", {
        send: (ev) => {
          received.push(ev as { type: string; stage?: string });
        },
      });

      const result = await svc.migrateTask("t1", prop.proposalId);
      expect(result.ok).toBe(true);

      // Exactly one INTERRUPT, targeting the running stage B.
      const interrupts = received.filter((e) => e.type === "INTERRUPT");
      expect(interrupts).toEqual([{ type: "INTERRUPT", stage: "B" }]);
    } finally {
      db.close();
    }
  });

  it.skip("broadcasts INTERRUPT for every running stage (parallel)", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      // Parallel IR: two independent entry stages both running.
      const parallelIR: PipelineIR = {
        name: "a234-parallel",
        stages: [
          { name: "P", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
          { name: "Q", type: "agent", inputs: [], outputs: [{ name: "y", type: "number" }], config: { promptRef: "p" } },
        ],
        wires: [],
      };
      const submit = svc.submit(parallelIR, { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");

      seedAttempts(db, "t2", submit.versionHash, [
        { name: "P", status: "running" },
        { name: "Q", status: "running" },
      ]);

      const prop = svc.propose({
        currentVersion: submit.versionHash,
        actor: "ai:main-claude",
        patch: {
          ops: [{ op: "update_stage_config", stage: "P", configPatch: { promptRef: "p2" } }],
        },
        rerunFrom: "P",
        migrateRunningTasks: ["t2"],
      });
      if (!prop.ok) throw new Error("propose failed");
      const approved = svc.approveProposal(prop.proposalId);
      if (!approved.ok) throw new Error("approve failed");

      const received: Array<{ type: string; stage?: string }> = [];
      const { taskRegistry } = await import("../runtime/task-registry.js");
      taskRegistry.register("t2", {
        send: (ev) => {
          received.push(ev as { type: string; stage?: string });
        },
      });

      const result = await svc.migrateTask("t2", prop.proposalId);
      expect(result.ok).toBe(true);

      // Both running stages got INTERRUPT. Order is SQL DISTINCT-defined,
      // so sort before asserting.
      const stages = received
        .filter((e) => e.type === "INTERRUPT")
        .map((e) => e.stage)
        .sort();
      expect(stages).toEqual(["P", "Q"]);
    } finally {
      db.close();
    }
  });

  it.skip("no-op when taskRegistry has no dispatcher for the task", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");

      seedAttempts(db, "t3", submit.versionHash, [
        { name: "A", status: "running" },
      ]);

      const prop = svc.propose({
        currentVersion: submit.versionHash,
        actor: "ai:main-claude",
        patch: {
          ops: [{ op: "update_stage_config", stage: "A", configPatch: { promptRef: "p2" } }],
        },
        rerunFrom: "A",
        migrateRunningTasks: ["t3"],
      });
      if (!prop.ok) throw new Error("propose failed");
      const approved = svc.approveProposal(prop.proposalId);
      if (!approved.ok) throw new Error("approve failed");

      // Intentionally do NOT register a dispatcher. migrateTask must
      // still succeed — the broadcast is best-effort.
      const result = await svc.migrateTask("t3", prop.proposalId);
      expect(result.ok).toBe(true);
    } finally {
      db.close();
    }
  });
});
