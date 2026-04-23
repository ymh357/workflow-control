// REST tests for GET /api/kernel/attempts/:attemptId/diff (P6.4 / D27).
// Seeds stage_attempts + stage_checkpoints rows directly so the route's
// SELECT can be exercised without spinning up the runner.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelDiffRoute } from "./kernel-diff.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelDiffRoute);
  return app;
}

function insertAttempt(db: DatabaseSync, attemptId: string): void {
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
     VALUES (?, 't1', 'v-test', 's1', 1, 1000, 'success')`,
  ).run(attemptId);
}

function insertCheckpoint(
  db: DatabaseSync,
  row: {
    attemptId: string;
    diffText: string | null;
    beforeSha?: string | null;
    afterSha?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO stage_checkpoints
     (attempt_id, workdir, before_sha, after_sha, diff_text, status, captured_before_at)
     VALUES (?, '/tmp/workdir', ?, ?, ?, 'captured', 1000)`,
  ).run(
    row.attemptId,
    row.beforeSha ?? null,
    row.afterSha ?? null,
    row.diffText,
  );
}

describe("GET /api/kernel/attempts/:attemptId/diff", () => {
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

  it("returns 404 { ok:false } when attempt has no checkpoint", async () => {
    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/attempts/missing/diff"),
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]?.code).toBe("CHECKPOINT_NOT_FOUND");
  });

  it("returns diff_text when checkpoint exists", async () => {
    insertAttempt(db, "a1");
    insertCheckpoint(db, {
      attemptId: "a1",
      diffText: "+++ b/foo.ts\n--- a/foo.ts\n+added line",
      beforeSha: "abcdef1234567890",
      afterSha: "fedcba0987654321",
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/attempts/a1/diff"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; diff: string; before_sha: string; after_sha: string };
    expect(body.ok).toBe(true);
    expect(body.diff).toContain("+++");
    expect(body.before_sha).toBe("abcdef1234567890");
    expect(body.after_sha).toBe("fedcba0987654321");
  });

  it("returns empty-string diff when diff_text is NULL", async () => {
    insertAttempt(db, "a-empty");
    insertCheckpoint(db, {
      attemptId: "a-empty",
      diffText: null,
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/attempts/a-empty/diff"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; diff: string };
    expect(body.ok).toBe(true);
    expect(body.diff).toBe("");
  });
});
