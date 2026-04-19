// REST tests for kernel-next task-status API.
// GET /api/kernel/tasks/:taskId/status.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelTasksRoute } from "./kernel-tasks.js";
import type { PipelineIR } from "../kernel-next/ir/schema.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelTasksRoute);
  return app;
}

function seedIR(): PipelineIR {
  return {
    name: "t-st",
    stages: [
      { name: "A", type: "agent", inputs: [],
        outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
      {
        name: "G", type: "gate",
        inputs: [{ name: "x", type: "number" }],
        outputs: [],
        config: {
          question: { text: "go?", options: ["yes"] },
          routing: { routes: { yes: "A" } },
        },
      },
    ],
    wires: [{ from: { stage: "A", port: "x" }, to: { stage: "G", port: "x" } }],
  };
}

function openAttempt(
  db: DatabaseSync,
  taskId: string,
  versionHash: string,
  stageName: string,
  status: "running" | "success" | "error" = "running",
): string {
  const id = "att-" + Math.random().toString(36).slice(2, 10);
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, ended_at, status)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(id, taskId, versionHash, stageName, Date.now(),
    status === "running" ? null : Date.now(), status);
  return id;
}

describe("REST /api/kernel/tasks/:taskId/status", () => {
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

  it("returns 404 + not_found when the task has no stage_attempts", async () => {
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/ghost/status"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: "not_found", taskId: "ghost" });
  });

  it("returns 200 + running when an attempt is running", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = svc.submit(seedIR());
    if (!submit.ok) throw new Error("seed submit failed");
    openAttempt(db, "t-run", submit.versionHash, "A", "running");
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-run/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "running", taskId: "t-run" });
  });

  it("returns 200 + gated with pending[] when a gate is open", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = svc.submit(seedIR());
    if (!submit.ok) throw new Error("seed submit failed");
    openAttempt(db, "t-gt", submit.versionHash, "A", "success");
    const gAtt = openAttempt(db, "t-gt", submit.versionHash, "G", "running");
    const { gateId } = svc.createGate({
      taskId: "t-gt", stageName: "G", attemptId: gAtt,
      question: { text: "go?", options: ["yes"] },
    });

    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-gt/status"));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; status: string; taskId: string;
      pending: Array<{ gateId: string; stageName: string }>;
    };
    expect(body.status).toBe("gated");
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]).toMatchObject({ gateId, stageName: "G" });
  });

  it("returns 200 + completed when all attempts succeeded and no gates pending", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = svc.submit(seedIR());
    if (!submit.ok) throw new Error("seed submit failed");
    openAttempt(db, "t-ok", submit.versionHash, "A", "success");
    openAttempt(db, "t-ok", submit.versionHash, "G", "success");
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-ok/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "completed", taskId: "t-ok" });
  });

  it("returns 200 + failed when any attempt has error status", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = svc.submit(seedIR());
    if (!submit.ok) throw new Error("seed submit failed");
    openAttempt(db, "t-err", submit.versionHash, "A", "error");
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-err/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "failed", taskId: "t-err" });
  });
});
