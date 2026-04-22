// Focused unit tests for PortRuntime. Most of PortRuntime's behavior is
// exercised indirectly through runner.test.ts and the executor tests; this
// file covers AttemptKind provenance tagging (including the 'external' kind
// introduced for the legacy-YAML converter's seed-phase attempt).

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { PortRuntime, type EventDispatcher } from "./port-runtime.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

const inertDispatcher: EventDispatcher = { send: () => { /* noop */ } };

describe("PortRuntime — AttemptKind provenance", () => {
  it("accepts kind='external' attempt and persists it", () => {
    // Port-runtime itself does not FK on version_hash, so a direct insert
    // without a pipeline_versions row is fine.
    const db = makeDb();
    const rt = new PortRuntime(db, inertDispatcher);
    const { attemptId, attemptIdx } = rt.startAttempt({
      taskId: "t-ext",
      versionHash: "v-ext",
      stageName: "__external__",
      kind: "external",
    });
    // attempt_idx is 1-based (MAX(attempt_idx)+1 with COALESCE default 0).
    expect(attemptIdx).toBe(1);
    const row = db.prepare(
      "SELECT kind, status FROM stage_attempts WHERE attempt_id = ?",
    ).get(attemptId) as { kind: string; status: string };
    expect(row.kind).toBe("external");
    expect(row.status).toBe("running");
    db.close();
  });

  describe("AttemptHooks", () => {
    it("invokes onAttemptStarted with attemptId after INSERT", () => {
      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);
      const seen: string[] = [];
      const dispatcher = { send: () => {} };
      const rt = new PortRuntime(db, dispatcher, "regular", undefined, {
        onAttemptStarted: (attemptId) => seen.push(attemptId),
      });
      const { attemptId } = rt.startAttempt({
        taskId: "t1", versionHash: "v1", stageName: "s1",
      });
      expect(seen).toEqual([attemptId]);
      // Row must already be in the DB when the hook fires so a
      // checkpoint INSERT with FK passes.
      const row = db.prepare(
        `SELECT attempt_id FROM stage_attempts WHERE attempt_id = ?`,
      ).get(attemptId);
      expect(row).toBeDefined();
    });

    it("invokes onAttemptFinishing with attemptId before UPDATE", () => {
      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);
      const dispatcher = { send: () => {} };
      let sawRunning = false;
      const rt = new PortRuntime(db, dispatcher, "regular", undefined, {
        onAttemptFinishing: (attemptId) => {
          const row = db.prepare(
            `SELECT status FROM stage_attempts WHERE attempt_id = ?`,
          ).get(attemptId) as { status: string } | undefined;
          // At hook-fire time, the UPDATE hasn't landed yet, so status
          // should still be 'running'.
          if (row?.status === "running") sawRunning = true;
        },
      });
      const { attemptId } = rt.startAttempt({
        taskId: "t1", versionHash: "v1", stageName: "s1",
      });
      rt.finishAttempt(attemptId, "success");
      expect(sawRunning).toBe(true);
    });
  });
});
