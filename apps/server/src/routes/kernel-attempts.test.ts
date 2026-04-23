// REST tests for GET /api/kernel/tasks/:taskId/attempts (P6.2 / D24).
// Seeds stage_attempts rows directly so the route's SELECT + duration_ms
// computation can be exercised without spinning up the runner.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelAttemptsRoute } from "./kernel-attempts.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelAttemptsRoute);
  return app;
}

// stage_attempts rows require a version_hash FK-free string (the schema
// does not declare a FK on stage_attempts.version_hash), so any string
// works for these routing-only tests.
function insertAttempt(
  db: DatabaseSync,
  row: {
    attemptId: string;
    taskId: string;
    stageName: string;
    attemptIdx: number;
    startedAt: number;
    endedAt: number | null;
    status: "running" | "success" | "error" | "superseded";
  },
): void {
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx,
      started_at, ended_at, status)
     VALUES (?, ?, 'v-test', ?, ?, ?, ?, ?)`,
  ).run(
    row.attemptId,
    row.taskId,
    row.stageName,
    row.attemptIdx,
    row.startedAt,
    row.endedAt,
    row.status,
  );
}

describe("GET /api/kernel/tasks/:taskId/attempts", () => {
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

  it("returns empty array for unknown taskId", async () => {
    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/unknown/attempts"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, attempts: [] });
  });

  it("returns stage_attempts with duration_ms for a task", async () => {
    insertAttempt(db, {
      attemptId: "a1", taskId: "t1", stageName: "s1", attemptIdx: 1,
      startedAt: 1000, endedAt: 1500, status: "success",
    });
    insertAttempt(db, {
      attemptId: "a2", taskId: "t1", stageName: "s1", attemptIdx: 2,
      startedAt: 2000, endedAt: 2800, status: "success",
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t1/attempts"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      attempts: Array<{
        attempt_id: string; stage_name: string; attempt_idx: number;
        status: string; started_at: number; ended_at: number | null;
        duration_ms: number | null;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.attempts).toHaveLength(2);
    expect(body.attempts[0]).toMatchObject({
      stage_name: "s1",
      attempt_idx: 1,
      started_at: 1000,
      ended_at: 1500,
      duration_ms: 500,
      status: "success",
    });
    expect(body.attempts[1]!.duration_ms).toBe(800);
  });

  it("returns null duration_ms for still-running attempt (ended_at IS NULL)", async () => {
    insertAttempt(db, {
      attemptId: "a-running", taskId: "t2", stageName: "s1", attemptIdx: 1,
      startedAt: 1000, endedAt: null, status: "running",
    });
    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t2/attempts"),
    );
    const body = await res.json() as {
      attempts: Array<{ duration_ms: number | null; ended_at: number | null }>;
    };
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0]!.ended_at).toBe(null);
    expect(body.attempts[0]!.duration_ms).toBe(null);
  });

  it("sorts by started_at ASC", async () => {
    // Seed out of order; ensure route orders by started_at ASC.
    insertAttempt(db, {
      attemptId: "mid", taskId: "t3", stageName: "s1", attemptIdx: 2,
      startedAt: 2000, endedAt: 2100, status: "success",
    });
    insertAttempt(db, {
      attemptId: "first", taskId: "t3", stageName: "s1", attemptIdx: 1,
      startedAt: 1000, endedAt: 1100, status: "success",
    });
    insertAttempt(db, {
      attemptId: "last", taskId: "t3", stageName: "s2", attemptIdx: 1,
      startedAt: 3000, endedAt: 3100, status: "success",
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t3/attempts"),
    );
    const body = await res.json() as {
      attempts: Array<{ attempt_id: string; started_at: number }>;
    };
    expect(body.attempts.map((a) => a.attempt_id)).toEqual(["first", "mid", "last"]);
  });

  it("includes status + attempt_id fields", async () => {
    insertAttempt(db, {
      attemptId: "full-row", taskId: "t4", stageName: "s1", attemptIdx: 1,
      startedAt: 500, endedAt: 900, status: "error",
    });
    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t4/attempts"),
    );
    const body = await res.json() as {
      attempts: Array<{ attempt_id: string; status: string }>;
    };
    expect(body.attempts[0]!.attempt_id).toBe("full-row");
    expect(body.attempts[0]!.status).toBe("error");
  });
});
