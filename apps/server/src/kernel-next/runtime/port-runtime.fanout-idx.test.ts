// B17 full: PortRuntime writes fanout_element_idx when caller supplies it.
//
// Runner.orchestrateFanoutStage passes the 0-based loop index per element.
// The silent runtime (defaultKind='fanout_element') must persist it to
// satisfy the schema CHECK constraint added in the T1 step.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { PortRuntime } from "./port-runtime.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

const silentDispatcher = { send() { /* inert */ } };

describe("PortRuntime — fanout_element_idx", () => {
  it("persists fanoutElementIdx for fanout_element attempts", () => {
    const db = makeDb();
    const rt = new PortRuntime(db, silentDispatcher, "fanout_element");
    const { attemptId } = rt.startAttempt({
      taskId: "t1", versionHash: "v1", stageName: "S",
      fanoutElementIdx: 3,
    });
    const row = db.prepare(
      `SELECT kind, fanout_element_idx FROM stage_attempts WHERE attempt_id = ?`,
    ).get(attemptId) as { kind: string; fanout_element_idx: number };
    expect(row.kind).toBe("fanout_element");
    expect(row.fanout_element_idx).toBe(3);
    db.close();
  });

  it("leaves fanout_element_idx NULL for non-fanout kinds even when caller accidentally supplies it", () => {
    // Defensive: a caller that misuses the API on a non-fanout_element kind
    // should not end up with stray idx values. Rationale: the only legitimate
    // writer is runner.orchestrateFanoutStage, which uses a silent runtime
    // with defaultKind='fanout_element'. Any other caller passing idx is a
    // bug — silently dropping protects the invariant.
    const db = makeDb();
    const rt = new PortRuntime(db, silentDispatcher, "regular");
    const { attemptId } = rt.startAttempt({
      taskId: "t1", versionHash: "v1", stageName: "S",
      fanoutElementIdx: 7,
    });
    const row = db.prepare(
      `SELECT kind, fanout_element_idx FROM stage_attempts WHERE attempt_id = ?`,
    ).get(attemptId) as { kind: string; fanout_element_idx: number | null };
    expect(row.kind).toBe("regular");
    expect(row.fanout_element_idx).toBeNull();
    db.close();
  });

  it("refuses to start a fanout_element attempt without an idx (schema CHECK)", () => {
    const db = makeDb();
    const rt = new PortRuntime(db, silentDispatcher, "fanout_element");
    expect(() => rt.startAttempt({
      taskId: "t1", versionHash: "v1", stageName: "S",
    })).toThrow(/CHECK constraint failed/);
    db.close();
  });
});
