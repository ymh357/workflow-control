// Regression tests for GET /api/kernel/tasks list endpoint, focused on
// the c12+ review fixes:
//   - Bug 8: latest version_hash now via correlated subquery (no more
//     non-deterministic GROUP BY HAVING MAX)
//   - Bug 48: LIMIT * 2 post-filter no longer silently truncates
//   - Bug 64: secret_pending status surfaced in the response

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../kernel-next/ir/sql.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelTaskListRoute } from "./kernel-task-list.js";
import type { PipelineIR } from "../kernel-next/ir/schema.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelTaskListRoute);
  return app;
}

function makeIR(name: string): PipelineIR {
  return {
    name,
    stages: [
      { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "string" }], config: { promptRef: "p" } },
    ],
    wires: [],
  };
}

function insertAttempt(
  db: DatabaseSync,
  row: {
    attemptId: string;
    taskId: string;
    versionHash: string;
    stageName: string;
    attemptIdx: number;
    startedAt: number;
    status: "running" | "success" | "error" | "superseded" | "secret_pending";
    endedAt?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx,
      started_at, ended_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.attemptId,
    row.taskId,
    row.versionHash,
    row.stageName,
    row.attemptIdx,
    row.startedAt,
    row.endedAt ?? null,
    row.status,
  );
}

describe("GET /api/kernel/tasks (Bug 8 / 48 / 64 fixes)", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(() => {
    __setKernelNextDbForTest(undefined);
    db.close();
  });

  // Bug 8: HAVING MAX(started_at) was a no-op truthiness check; the
  // version_hash returned alongside was non-deterministic. Migrated
  // tasks (multiple version_hashes per task_id) showed a random
  // pipeline name in the list.
  it("Bug 8: returns the LATEST version_hash for migrated tasks", async () => {
    const irV1 = makeIR("Pipeline V1");
    const irV2 = makeIR("Pipeline V2");
    insertPipelineVersion(db, irV1, { versionHash: "hash-v1", tsSource: "" });
    insertPipelineVersion(db, irV2, { versionHash: "hash-v2", tsSource: "" });

    // Two attempts on same task with different versionHashes; v2 is later.
    insertAttempt(db, {
      attemptId: "a1", taskId: "t1", versionHash: "hash-v1",
      stageName: "A", attemptIdx: 1, startedAt: 1000, status: "superseded",
    });
    insertAttempt(db, {
      attemptId: "a2", taskId: "t1", versionHash: "hash-v2",
      stageName: "A", attemptIdx: 2, startedAt: 2000, status: "running",
    });

    const app = buildApp();
    const res = await app.request("/api/kernel/tasks");
    const body = await res.json() as { tasks: Array<{ taskId: string; versionHash: string; pipelineName: string }> };
    const t1 = body.tasks.find((t) => t.taskId === "t1");
    expect(t1).toBeDefined();
    // Pre-fix this could return either hash-v1 or hash-v2 randomly.
    expect(t1!.versionHash).toBe("hash-v2");
    expect(t1!.pipelineName).toBe("Pipeline V2");
  });

  // Bug 48: LIMIT * 2 + post-filter silently truncated; e.g. with
  // limit=10 and a status filter, only the first 20 raw rows were
  // searched, missing matches further back.
  it("Bug 48: status filter doesn't silently truncate", async () => {
    const ir = makeIR("Bulk");
    insertPipelineVersion(db, ir, { versionHash: "hash-bulk", tsSource: "" });

    // 50 tasks: every 3rd one is "running", the rest are "completed".
    // Pre-fix the over-fetch buffer was limit * 2; with limit=5 that's
    // 10 raw rows, of which only ~3 would be running, missing the rest.
    for (let i = 0; i < 50; i++) {
      insertAttempt(db, {
        attemptId: `a-${i}`,
        taskId: `t-${i}`,
        versionHash: "hash-bulk",
        stageName: "A",
        attemptIdx: 1,
        startedAt: 1000 - i, // newer first → t-0 is newest
        status: i % 3 === 0 ? "running" : "success",
      });
      if (i % 3 !== 0) {
        // mark non-running tasks as completed via task_finals
        db.prepare(
          `INSERT INTO task_finals (task_id, version_hash, final_state, reason, ended_at)
           VALUES (?, ?, 'completed', 'natural', ?)`,
        ).run(`t-${i}`, "hash-bulk", 2000);
      }
    }

    const app = buildApp();
    // Ask for 5 running tasks; with 50 raw tasks (~17 running), the
    // post-fix logic should find 5.
    const res = await app.request("/api/kernel/tasks?status=running&limit=5");
    const body = await res.json() as { tasks: Array<{ taskId: string; status: string }> };
    expect(body.tasks).toHaveLength(5);
    for (const t of body.tasks) expect(t.status).toBe("running");
  });

  // Bug 64: secret_pending must appear in the list response. Pre-fix
  // the status enum omitted it and the kernel emitted "orphaned" or
  // "running" for paused tasks needing a secret.
  it("Bug 64: surfaces secret_pending status when secret_gate_queue has unresolved row", async () => {
    const ir = makeIR("SecretPause");
    insertPipelineVersion(db, ir, { versionHash: "hash-sp", tsSource: "" });
    insertAttempt(db, {
      attemptId: "a1", taskId: "t-secret", versionHash: "hash-sp",
      stageName: "A", attemptIdx: 1, startedAt: 1000,
      status: "secret_pending", endedAt: 1100,
    });
    db.prepare(
      `INSERT INTO secret_gate_queue
        (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("sg-1", "t-secret", "A", "a1", JSON.stringify(["FAKE_KEY"]), 1100);

    const app = buildApp();
    const res = await app.request("/api/kernel/tasks");
    const body = await res.json() as { tasks: Array<{ taskId: string; status: string; currentStage: string | null }> };
    const t = body.tasks.find((x) => x.taskId === "t-secret");
    expect(t).toBeDefined();
    expect(t!.status).toBe("secret_pending");
    expect(t!.currentStage).toBe("A");
  });

  it("Bug 64: status enum accepts secret_pending as a filter value", async () => {
    const ir = makeIR("SecretPause");
    insertPipelineVersion(db, ir, { versionHash: "hash-sp", tsSource: "" });
    insertAttempt(db, {
      attemptId: "a1", taskId: "t-secret", versionHash: "hash-sp",
      stageName: "A", attemptIdx: 1, startedAt: 1000,
      status: "secret_pending",
    });
    db.prepare(
      `INSERT INTO secret_gate_queue
        (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("sg-1", "t-secret", "A", "a1", JSON.stringify(["X"]), 1100);

    const app = buildApp();
    const res = await app.request("/api/kernel/tasks?status=secret_pending");
    expect(res.status).toBe(200);
    const body = await res.json() as { tasks: Array<{ taskId: string }> };
    expect(body.tasks.map((t) => t.taskId)).toContain("t-secret");
  });
});
