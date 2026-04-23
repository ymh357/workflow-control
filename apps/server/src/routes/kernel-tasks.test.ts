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
    const submit = svc.submit(seedIR(), { prompts: { p: "dummy" } });
    if (!submit.ok) throw new Error("seed submit failed");
    openAttempt(db, "t-run", submit.versionHash, "A", "running");
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-run/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "running", taskId: "t-run" });
  });

  it("returns 200 + gated with pending[] when a gate is open", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = svc.submit(seedIR(), { prompts: { p: "dummy" } });
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

  it("returns 200 + completed when task_finals says completed (post-audit: authoritative source)", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = svc.submit(seedIR(), { prompts: { p: "dummy" } });
    if (!submit.ok) throw new Error("seed submit failed");
    openAttempt(db, "t-ok", submit.versionHash, "A", "success");
    openAttempt(db, "t-ok", submit.versionHash, "G", "success");
    db.prepare(
      `INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
       VALUES ('t-ok', ?, 'completed', 'natural', NULL, ?)`,
    ).run(submit.versionHash, Date.now());
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-ok/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "completed", taskId: "t-ok" });
  });

  it("returns 200 + orphaned when stage_attempts say error but no task_finals (crashed runner case)", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = svc.submit(seedIR(), { prompts: { p: "dummy" } });
    if (!submit.ok) throw new Error("seed submit failed");
    openAttempt(db, "t-err", submit.versionHash, "A", "error");
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-err/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "orphaned", taskId: "t-err" });
  });

  it("returns 200 + failed when task_finals says failed (authoritative)", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = svc.submit(seedIR(), { prompts: { p: "dummy" } });
    if (!submit.ok) throw new Error("seed submit failed");
    openAttempt(db, "t-err2", submit.versionHash, "A", "error");
    db.prepare(
      `INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
       VALUES ('t-err2', ?, 'failed', 'error', 'run ended with failed verdict', ?)`,
    ).run(submit.versionHash, Date.now());
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-err2/status"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "failed", taskId: "t-err2" });
  });
});

// Linear pipeline for migrate tests: A → B, so rerunFrom: "B" exercises
// a non-trivial supersede set.
function linearIR(): PipelineIR {
  return {
    name: "t-mig",
    stages: [
      { name: "A", type: "agent", inputs: [],
        outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
      { name: "B", type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "y", type: "number" }], config: { promptRef: "p" } },
    ],
    wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
  };
}

describe("REST POST /api/kernel/tasks/:taskId/migrate", () => {
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

  // Helper: seed v1 + approved proposal with rerunFrom + task opt-in list,
  // then return the ids needed to exercise the migrate endpoint.
  function seedApprovedProposal(opts: {
    taskId: string;
    migrateList: "all" | "none" | string[];
    rerunFrom?: string;
  }): { v1: string; proposalId: string; proposedVersion: string } {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
    if (!submit.ok) throw new Error("seed submit failed");
    const v1 = submit.versionHash;
    openAttempt(db, opts.taskId, v1, "A", "success");
    const prop = svc.propose({
      currentVersion: v1,
      actor: "test",
      patch: { ops: [{ op: "update_stage_config", stage: "B", configPatch: { promptRef: "new-b" } }] },
      rerunFrom: opts.rerunFrom,
      migrateRunningTasks: opts.migrateList,
    });
    if (!prop.ok) throw new Error(`seed propose failed: ${JSON.stringify(prop.diagnostics)}`);
    const approve = svc.approveProposal(prop.proposalId);
    if (!approve.ok) throw new Error("seed approve failed");
    return { v1, proposalId: prop.proposalId, proposedVersion: prop.proposedVersion };
  }

  it("returns 200 + migration result on the happy path", async () => {
    const { proposalId, proposedVersion, v1 } = seedApprovedProposal({
      taskId: "t-mig1", migrateList: ["t-mig1"], rerunFrom: "B",
    });
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-mig1/migrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean; taskId: string; fromVersion: string; toVersion: string;
      rerunFrom: string; supersededStages: string[]; eventId: string;
    };
    expect(body).toMatchObject({
      ok: true, taskId: "t-mig1", fromVersion: v1,
      toVersion: proposedVersion, rerunFrom: "B",
      supersededStages: ["B"],
    });
    expect(body.eventId).toMatch(/^[0-9a-f-]+$/);
  });

  it("returns 404 when the proposal does not exist", async () => {
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-x/migrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: "ghost-proposal" }),
    }));
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("PROPOSAL_NOT_FOUND");
  });

  it("returns 409 when the proposal is not approved yet (still pending)", async () => {
    // Build a pending proposal manually without approveProposal.
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submit = svc.submit(linearIR(), { prompts: { p: "dummy" } });
    if (!submit.ok) throw new Error("seed submit failed");
    openAttempt(db, "t-p", submit.versionHash, "A", "success");
    const prop = svc.propose({
      currentVersion: submit.versionHash,
      actor: "test",
      patch: { ops: [{ op: "update_stage_config", stage: "B", configPatch: { promptRef: "new-b" } }] },
      migrateRunningTasks: ["t-p"],
    });
    if (!prop.ok) throw new Error("seed propose failed");

    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-p/migrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: prop.proposalId }),
    }));
    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("PROPOSAL_ALREADY_RESOLVED");
  });

  it("returns 409 when the task is not in the proposal's migrateRunningTasks list", async () => {
    // Approve a proposal whose migrate list is ['other-task'], then try
    // to migrate t-outsider against it.
    const { proposalId } = seedApprovedProposal({
      taskId: "t-other", migrateList: ["t-other"], rerunFrom: "B",
    });
    // Give t-outsider an attempt so its error path isn't the "no attempts" one.
    const svc = new KernelService(db, { skipTypeCheck: true });
    const latest = svc.listProposals({}).find((p) => p.proposalId === proposalId);
    openAttempt(db, "t-outsider", latest!.baseVersion, "A", "success");
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-outsider/migrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId }),
    }));
    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string; message: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("PATCH_APPLY_ERROR");
    expect(body.diagnostics[0]!.message).toMatch(/not in the proposal's migrateRunningTasks/);
  });

  it("returns 400 when the body is missing proposalId", async () => {
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-b/migrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("INVALID_REQUEST_BODY");
  });

  it("returns 400 on malformed JSON body", async () => {
    const res = await buildApp().fetch(new Request("http://t/api/kernel/tasks/t-j/migrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("INVALID_JSON_BODY");
  });
});
