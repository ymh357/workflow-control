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

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { KernelService } from "./kernel.js";
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
  it("propose stores rerunFrom and migrate list; listProposals surfaces them", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR());
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

  it("propose rejects rerunFrom that does not exist in the proposed pipeline", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR());
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

  it("default migrateRunningTasks is 'none'", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR());
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
  it("rejects tasks not in the proposal's migrateRunningTasks list", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR());
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

      const result = svc.migrateTask("t1", prop.proposalId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0]?.message).toContain("migrateRunningTasks");
    } finally {
      db.close();
    }
  });

  it("rejects unknown proposalId with PROPOSAL_NOT_FOUND", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const result = svc.migrateTask("t1", "no-such-proposal");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0]?.code).toBe("PROPOSAL_NOT_FOUND");
    } finally {
      db.close();
    }
  });

  it("rejects a pending (not approved) proposal", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR());
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

      const result = svc.migrateTask("t1", prop.proposalId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.diagnostics[0]?.code).toBe("PROPOSAL_ALREADY_RESOLVED");
    } finally {
      db.close();
    }
  });
});

describe("A8: migrateTask happy path", () => {
  it("marks rerunFrom + downstream stages superseded; leaves port_values intact", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR());
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

      const result = svc.migrateTask("t1", prop.proposalId);
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

  it("migrateRunningTasks='all' migrates any task", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR());
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

      const result = svc.migrateTask("t-any", prop.proposalId);
      expect(result.ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("rerunFrom=null produces a forward-only migration with no supersedes", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = svc.submit(linearIR());
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

      const result = svc.migrateTask("t1", prop.proposalId);
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
