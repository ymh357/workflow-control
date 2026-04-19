// REST tests for kernel-next proposals API. Uses Hono's .fetch to drive
// requests directly; DB is swapped to in-memory via
// __setKernelNextDbForTest.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { diamondIR } from "../kernel-next/generator-mock/mini-generator.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelProposalsRoute } from "./kernel-proposals.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelProposalsRoute);
  return app;
}

function seedProposal(db: DatabaseSync, actor = "ai:test"): { proposalId: string; baseVersion: string } {
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitted = svc.submit(diamondIR());
  if (!submitted.ok) throw new Error("setup submit failed");
  const proposed = svc.propose({
    currentVersion: submitted.versionHash,
    patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
    actor,
  });
  if (!proposed.ok) throw new Error("setup propose failed");
  return { proposalId: proposed.proposalId, baseVersion: submitted.versionHash };
}

describe("REST /api/kernel/proposals", () => {
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

  it("GET /api/kernel/proposals returns empty list initially", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/proposals"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, proposals: [] });
  });

  it("GET /api/kernel/proposals returns newest-first, filters by status", async () => {
    const { proposalId: p1 } = seedProposal(db, "ai:a");

    // Second proposal with a different patch to avoid version-hash collision.
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR());
    if (!submitted.ok) throw new Error("submit failed");
    const p2 = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{ op: "remove_stage", stageName: "B" }] },
      actor: "ai:b",
    });
    if (!p2.ok) throw new Error("propose failed");
    svc.rejectProposal(p1);

    const app = buildApp();
    const all = await app.fetch(new Request("http://t/api/kernel/proposals"));
    const allBody = await all.json() as {
      ok: boolean;
      proposals: Array<{ proposalId: string; status: string; actor: string }>;
    };
    expect(allBody.proposals.map((r) => r.proposalId)).toEqual([p2.proposalId, p1]);

    const pending = await app.fetch(new Request("http://t/api/kernel/proposals?status=pending"));
    const pendingBody = await pending.json() as {
      proposals: Array<{ proposalId: string }>;
    };
    expect(pendingBody.proposals.map((r) => r.proposalId)).toEqual([p2.proposalId]);
  });

  it("GET rejects invalid status query with unified error envelope", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/proposals?status=bogus"));
    expect(res.status).toBe(400);
    const body = await res.json() as {
      ok: boolean;
      diagnostics: Array<{ code: string; message: string; context?: Record<string, unknown> }>;
    };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("INVALID_STATUS_PARAM");
    expect(body.diagnostics[0]!.message).toContain("invalid status");
    expect(body.diagnostics[0]!.context).toEqual({ received: "bogus" });
  });

  it("POST approve flips pending -> approved", async () => {
    const { proposalId } = seedProposal(db);
    const app = buildApp();
    const res = await app.fetch(
      new Request(`http://t/api/kernel/proposals/${proposalId}/approve`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; status: string };
    expect(body).toEqual({ ok: true, proposalId, status: "approved" });
  });

  it("POST approve returns 404 when proposal is unknown", async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://t/api/kernel/proposals/does-not-exist/approve", { method: "POST" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("PROPOSAL_NOT_FOUND");
  });

  it("POST approve returns 409 when proposal already resolved", async () => {
    const { proposalId } = seedProposal(db);
    new KernelService(db, { skipTypeCheck: true }).rejectProposal(proposalId);

    const app = buildApp();
    const res = await app.fetch(
      new Request(`http://t/api/kernel/proposals/${proposalId}/approve`, { method: "POST" }),
    );
    expect(res.status).toBe(409);
    const body = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("PROPOSAL_ALREADY_RESOLVED");
  });

  it("POST reject persists reason from body", async () => {
    const { proposalId } = seedProposal(db);
    const app = buildApp();
    const res = await app.fetch(
      new Request(`http://t/api/kernel/proposals/${proposalId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "breaks contract" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("rejected");

    const row = db.prepare(
      `SELECT diagnostic_json FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(proposalId) as { diagnostic_json: string };
    expect(JSON.parse(row.diagnostic_json)).toEqual({ reason: "breaks contract" });
  });

  it("POST reject accepts empty body (no reason)", async () => {
    const { proposalId } = seedProposal(db);
    const app = buildApp();
    const res = await app.fetch(
      new Request(`http://t/api/kernel/proposals/${proposalId}/reject`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("rejected");

    const row = db.prepare(
      `SELECT diagnostic_json FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(proposalId) as { diagnostic_json: string | null };
    expect(row.diagnostic_json).toBeNull();
  });

  it("POST reject rejects malformed JSON body with 400 and INVALID_JSON_BODY diagnostic", async () => {
    const { proposalId } = seedProposal(db);
    const app = buildApp();
    const res = await app.fetch(
      new Request(`http://t/api/kernel/proposals/${proposalId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("INVALID_JSON_BODY");
  });

  it("POST reject rejects unknown fields with 400 and INVALID_REQUEST_BODY diagnostic", async () => {
    const { proposalId } = seedProposal(db);
    const app = buildApp();
    const res = await app.fetch(
      new Request(`http://t/api/kernel/proposals/${proposalId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "ok", surprise: 1 }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string; context?: unknown }> };
    expect(body.diagnostics[0]!.code).toBe("INVALID_REQUEST_BODY");
  });
});
