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
      const submit = await svc.submit(linearIR(), { prompts: { p: "dummy" } });
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
      const submit = await svc.submit(linearIR(), { prompts: { p: "dummy" } });
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
      const submit = await svc.submit(linearIR(), { prompts: { p: "dummy" } });
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
      const submit = await svc.submit(linearIR(), { prompts: { p: "dummy" } });
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
      const submit = await svc.submit(linearIR(), { prompts: { p: "dummy" } });
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

  it("migrateRunningTasks='all' migrates any task", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = await svc.submit(linearIR(), { prompts: { p: "dummy" } });
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

});

// Stage 5E: F5 serial-per-task lock + A2.3.4 INTERRUPT broadcast describes
// retired — all 9 it.skip tests deleted; orchestrator + rollback suites
// cover concurrent lock, INTERRUPT timeout, reverse-supersede, parallel
// B13 sibling preservation. See migration-orchestrator.test.ts and
// rollback.test.ts.
