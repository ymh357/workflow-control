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
});
