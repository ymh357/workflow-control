// REST tests for GET /api/kernel/tasks/:taskId/ir (P7.1 / D21).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../kernel-next/ir/sql.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelTaskIrRoute } from "./kernel-task-ir.js";
import type { PipelineIR } from "../kernel-next/ir/schema.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelTaskIrRoute);
  return app;
}

function makeIR(name: string, stageName: string): PipelineIR {
  return {
    name,
    stages: [{
      name: stageName,
      type: "agent",
      inputs: [],
      outputs: [],
      config: { promptRef: "p" },
    }],
    wires: [],
    externalInputs: [],
  };
}

function seedVersion(db: DatabaseSync, versionHash: string, ir: PipelineIR): void {
  insertPipelineVersion(db, ir, { versionHash, tsSource: "// test" });
}

function insertAttempt(
  db: DatabaseSync,
  row: {
    attemptId: string;
    taskId: string;
    versionHash: string;
    stageName: string;
    startedAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx,
      started_at, ended_at, status)
     VALUES (?, ?, ?, ?, 1, ?, NULL, 'running')`,
  ).run(
    row.attemptId,
    row.taskId,
    row.versionHash,
    row.stageName,
    row.startedAt,
  );
}

describe("GET /api/kernel/tasks/:taskId/ir", () => {
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

  it("returns 404 with TASK_NOT_FOUND when no attempts exist for the task", async () => {
    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/nope/ir"),
    );
    expect(res.status).toBe(404);
    const body = await res.json() as {
      ok: boolean;
      diagnostics: Array<{ code: string; message: string }>;
    };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("TASK_NOT_FOUND");
  });

  it("returns the IR for a task with a single attempt", async () => {
    const ir = makeIR("my-pipeline", "stage-a");
    seedVersion(db, "v1", ir);
    insertAttempt(db, {
      attemptId: "a1", taskId: "t1", versionHash: "v1",
      stageName: "stage-a", startedAt: 1000,
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t1/ir"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      versionHash: string;
      ir: PipelineIR;
    };
    expect(body.ok).toBe(true);
    expect(body.versionHash).toBe("v1");
    expect(body.ir.name).toBe("my-pipeline");
    expect(body.ir.stages[0]!.name).toBe("stage-a");
  });

  it("returns the latest version's IR for a migrated (multi-version) task", async () => {
    const irOld = makeIR("pipeline", "stage-old");
    const irNew = makeIR("pipeline", "stage-new");
    seedVersion(db, "v-old", irOld);
    seedVersion(db, "v-new", irNew);

    // Earlier attempt on v-old, later attempt on v-new — the route
    // should pick v-new (ORDER BY started_at DESC LIMIT 1).
    insertAttempt(db, {
      attemptId: "a-old", taskId: "t-migrated", versionHash: "v-old",
      stageName: "stage-old", startedAt: 1000,
    });
    insertAttempt(db, {
      attemptId: "a-new", taskId: "t-migrated", versionHash: "v-new",
      stageName: "stage-new", startedAt: 2000,
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/t-migrated/ir"),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      versionHash: string;
      ir: PipelineIR;
    };
    expect(body.versionHash).toBe("v-new");
    expect(body.ir.stages[0]!.name).toBe("stage-new");
  });

  it("scopes by taskId — attempts on other tasks don't leak", async () => {
    const ir = makeIR("pipeline", "stage-a");
    seedVersion(db, "v1", ir);
    insertAttempt(db, {
      attemptId: "a-other", taskId: "other-task", versionHash: "v1",
      stageName: "stage-a", startedAt: 1000,
    });

    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/tasks/my-task/ir"),
    );
    expect(res.status).toBe(404);
  });
});
