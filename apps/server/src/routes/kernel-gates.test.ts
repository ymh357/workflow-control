// REST tests for kernel-next gate lifecycle API. Seeds a pipeline
// containing a gate stage, opens a stage_attempt row, creates a gate via
// KernelService, then exercises GET + POST through Hono's .fetch.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelGatesRoute } from "./kernel-gates.js";
import { taskRegistry } from "../kernel-next/runtime/task-registry.js";
import type { PipelineIR } from "../kernel-next/ir/schema.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelGatesRoute);
  return app;
}

function gateIR(): PipelineIR {
  return {
    name: "gate-fixture",
    stages: [
      {
        name: "A",
        type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { promptRef: "p" },
      },
      {
        name: "G",
        type: "gate",
        inputs: [{ name: "x", type: "number" }],
        outputs: [],
        config: {
          question: { text: "continue?", options: ["yes", "no"] },
          routing: { routes: { yes: "A", no: "A" } },
        },
      },
    ],
    wires: [{ from: { stage: "A", port: "x" }, to: { stage: "G", port: "x" } }],
  };
}

function seedGateRow(
  db: DatabaseSync,
  svc: KernelService,
  taskId: string,
): { gateId: string } {
  const submit = svc.submit(gateIR(), { prompts: { p: "dummy" } });
  if (!submit.ok) throw new Error("seed submit failed");
  const attemptId = "a-" + Math.random().toString(36).slice(2, 10);
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
     VALUES (?, ?, ?, 'G', 1, ?, 'running')`,
  ).run(attemptId, taskId, submit.versionHash, Date.now());
  return svc.createGate({
    taskId,
    stageName: "G",
    attemptId,
    question: { text: "continue?", options: ["yes", "no"] },
  });
}

describe("REST /api/kernel/gates", () => {
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

  it("GET /api/kernel/gates returns empty list initially", async () => {
    const res = await buildApp().fetch(new Request("http://t/api/kernel/gates"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, gates: [] });
  });

  it("GET /api/kernel/gates lists pending gates, filterable by task and answered", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const { gateId: g1 } = seedGateRow(db, svc, "task-A");
    const { gateId: g2 } = seedGateRow(db, svc, "task-B");
    svc.answerGate(g1, "yes");

    const app = buildApp();

    const all = await (await app.fetch(new Request("http://t/api/kernel/gates"))).json() as {
      gates: Array<{ gateId: string; answer: string | null }>;
    };
    expect(all.gates.map((g) => g.gateId).sort()).toEqual([g1, g2].sort());

    const pending = await (await app.fetch(new Request("http://t/api/kernel/gates?answered=false"))).json() as {
      gates: Array<{ gateId: string }>;
    };
    expect(pending.gates.map((g) => g.gateId)).toEqual([g2]);

    const onlyA = await (await app.fetch(new Request("http://t/api/kernel/gates?taskId=task-A"))).json() as {
      gates: Array<{ gateId: string }>;
    };
    expect(onlyA.gates.map((g) => g.gateId)).toEqual([g1]);
  });

  it("GET rejects invalid answered parameter with 400 INVALID_ANSWERED_PARAM", async () => {
    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/gates?answered=maybe"),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("INVALID_ANSWERED_PARAM");
  });

  it("POST /api/kernel/gates/:id/answer resolves an open gate", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const { gateId } = seedGateRow(db, svc, "task-1");

    const res = await buildApp().fetch(
      new Request(`http://t/api/kernel/gates/${gateId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; targetStage: string };
    expect(body).toMatchObject({ ok: true, targetStage: "A" });
  });

  it("POST returns 404 GATE_NOT_FOUND for unknown gateId", async () => {
    const res = await buildApp().fetch(
      new Request("http://t/api/kernel/gates/ghost/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "yes" }),
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("GATE_NOT_FOUND");
  });

  it("POST returns 409 GATE_ALREADY_ANSWERED on double-answer", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const { gateId } = seedGateRow(db, svc, "task-1");
    svc.answerGate(gateId, "yes");

    const res = await buildApp().fetch(
      new Request(`http://t/api/kernel/gates/${gateId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "no" }),
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("GATE_ALREADY_ANSWERED");
  });

  it("POST returns 422 GATE_ANSWER_INVALID for answer outside the routing table", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const { gateId } = seedGateRow(db, svc, "task-1");

    const res = await buildApp().fetch(
      new Request(`http://t/api/kernel/gates/${gateId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "maybe" }),
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("GATE_ANSWER_INVALID");
  });

  it("POST requires a body (empty is INVALID_REQUEST_BODY 400)", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const { gateId } = seedGateRow(db, svc, "task-1");

    const res = await buildApp().fetch(
      new Request(`http://t/api/kernel/gates/${gateId}/answer`, { method: "POST" }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("INVALID_REQUEST_BODY");
  });

  it("POST rejects invalid JSON body with 400 INVALID_JSON_BODY", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const { gateId } = seedGateRow(db, svc, "task-1");

    const res = await buildApp().fetch(
      new Request(`http://t/api/kernel/gates/${gateId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("INVALID_JSON_BODY");
  });

  it("POST rejects missing answer field with 400 INVALID_REQUEST_BODY", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const { gateId } = seedGateRow(db, svc, "task-1");

    const res = await buildApp().fetch(
      new Request(`http://t/api/kernel/gates/${gateId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notAnswer: "yes" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("INVALID_REQUEST_BODY");
  });

  it("GET /:id/context returns 200 with gate payload + upstreams", async () => {
    const app = buildApp();
    const svc = new KernelService(db, { skipTypeCheck: true });

    // Seed upstream A (success attempt writing x=7).
    const sub = svc.submit(gateIR(), { prompts: { p: "dummy" } });
    if (!sub.ok) throw new Error("seed submit failed");
    const aAttempt = "a-" + Math.random().toString(36).slice(2, 10);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, ended_at, status, kind)
       VALUES (?, 't-ctx', ?, 'A', 1, 100, 200, 'success', 'regular')`,
    ).run(aAttempt, sub.versionHash);
    db.prepare(
      `INSERT INTO port_values
       (value_id, attempt_id, stage_name, port_name, direction,
        value_json, written_at)
       VALUES ('v-ctx-x', ?, 'A', 'x', 'out', '7', 150)`,
    ).run(aAttempt);

    // Open a gate on G.
    const gAttempt = "g-" + Math.random().toString(36).slice(2, 10);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, status)
       VALUES (?, 't-ctx', ?, 'G', 1, 300, 'running')`,
    ).run(gAttempt, sub.versionHash);
    const { gateId } = svc.createGate({
      taskId: "t-ctx", stageName: "G", attemptId: gAttempt,
      question: { text: "continue?", options: ["yes", "no"] },
    });

    const res = await app.fetch(
      new Request(`http://test/api/kernel/gates/${gateId}/context`),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      gateId: string;
      answerOptions: string[];
      upstreams: Array<{ stage: string; outputs: Array<{ port: string; value: unknown }> }>;
    };
    expect(body.ok).toBe(true);
    expect(body.gateId).toBe(gateId);
    expect(body.answerOptions.sort()).toEqual(["no", "yes"]);
    expect(body.upstreams).toHaveLength(1);
    expect(body.upstreams[0]!.stage).toBe("A");
    expect(body.upstreams[0]!.outputs[0]!.value).toBe(7);
  });

  it("GET /:id/context returns 404 with GATE_NOT_FOUND for unknown gate", async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request(`http://test/api/kernel/gates/nonexistent/context`),
    );
    expect(res.status).toBe(404);
    const body = await res.json() as {
      ok: boolean;
      diagnostics: Array<{ code: string }>;
    };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("GATE_NOT_FOUND");
  });
});

// Seeds a pipeline with gate G whose routes include a rollback:
//   { approve: "B", reject: "A" }
// with a wire A.out -> G.i, making "reject" a rollback answer (kernel
// returns kind="rejected"). Mirrors setupRejectReadyDb() in server.test.ts.
function seedRejectableGate(
  db: DatabaseSync,
): { gateId: string; taskId: string } {
  const taskId = "http-reject-" + Math.random().toString(36).slice(2, 10);
  const svc = new KernelService(db, { skipTypeCheck: true });

  const ir = {
    name: "http-reject-fixture",
    stages: [
      {
        name: "A",
        type: "agent" as const,
        inputs: [],
        outputs: [{ name: "out", type: "unknown" }],
        config: { promptRef: "p", reads: [] },
      },
      {
        name: "G",
        type: "gate" as const,
        inputs: [{ name: "i", type: "unknown" }],
        outputs: [],
        config: {
          question: { text: "approve or reject?", options: ["approve", "reject"] },
          routing: { routes: { approve: "B", reject: "A" } },
        },
      },
      {
        name: "B",
        type: "agent" as const,
        inputs: [],
        outputs: [],
        config: { promptRef: "p", reads: [] },
      },
    ],
    wires: [
      { from: { stage: "A", port: "out" }, to: { stage: "G", port: "i" } },
    ],
  };

  const submit = svc.submit(ir, { prompts: { p: "dummy" } });
  if (!submit.ok) throw new Error("seedRejectableGate: submit failed");

  const attemptId = "attempt-g-" + taskId;
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
     VALUES (?, ?, ?, 'G', 1, ?, 'running')`,
  ).run(attemptId, taskId, submit.versionHash, Date.now());

  const { gateId } = svc.createGate({
    taskId,
    stageName: "G",
    attemptId,
    question: { text: "approve or reject?", options: ["approve", "reject"] },
  });

  return { gateId, taskId };
}

describe("REST /api/kernel/gates — GATE_REJECTED dispatch", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(() => {
    taskRegistry.__clearForTest();
    __setKernelNextDbForTest(undefined);
    db.close();
  });

  it("POST /api/kernel/gates/:id/answer dispatches GATE_REJECTED for rollback answers", async () => {
    const { gateId, taskId } = seedRejectableGate(db);

    const captured: unknown[] = [];
    taskRegistry.register(taskId, { send: (ev: unknown) => captured.push(ev) } as never);

    const res = await buildApp().fetch(
      new Request(`http://t/api/kernel/gates/${gateId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "reject" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const ev = captured[0] as Record<string, unknown>;
    expect(ev["type"]).toBe("GATE_REJECTED");
    expect(ev["targetStage"]).toBe("A");
    expect(new Set(ev["affectedStages"] as string[])).toEqual(new Set(["A", "G"]));
  });

  it("POST /api/kernel/gates/:id/answer dispatches GATE_ANSWERED for approve", async () => {
    const { gateId, taskId } = seedRejectableGate(db);

    const captured: unknown[] = [];
    taskRegistry.register(taskId, { send: (ev: unknown) => captured.push(ev) } as never);

    const res = await buildApp().fetch(
      new Request(`http://t/api/kernel/gates/${gateId}/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "approve" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const ev = captured[0] as Record<string, unknown>;
    expect(ev["type"]).toBe("GATE_ANSWERED");
  });
});
