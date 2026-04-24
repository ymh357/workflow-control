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
import { kernelProposalsRoute, __setProposalsBroadcasterForTest } from "./kernel-proposals.js";
import { ProposalsBroadcaster, type ProposalEvent } from "../kernel-next/sse/proposals-broadcaster.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelProposalsRoute);
  return app;
}

function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

async function seedProposal(db: DatabaseSync, actor = "ai:test"): Promise<{ proposalId: string; baseVersion: string }> {
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
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

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(async () => {
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
    const { proposalId: p1 } = await seedProposal(db, "ai:a");

    // Second proposal with a different patch to avoid version-hash collision.
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
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
    const { proposalId } = await seedProposal(db);
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
    const { proposalId } = await seedProposal(db);
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
    const { proposalId } = await seedProposal(db);
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
    const { proposalId } = await seedProposal(db);
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
    const { proposalId } = await seedProposal(db);
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
    const { proposalId } = await seedProposal(db);
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

  // Phase 6 audit: POST /proposals (create). Closes the HTTP surface gap
  // where propose() was only reachable through MCP. Body mirrors the
  // service signature.
  it("POST /api/kernel/proposals creates a pending proposal with structural-only patch", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://t/api/kernel/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentVersion: submitted.versionHash,
          patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
          actor: "ai:test",
        }),
      }),
    );
    expect(res.status).toBe(202);
    const body = await res.json() as {
      ok: boolean; proposalId: string; proposedVersion: string; autoApplied: boolean;
    };
    expect(body.ok).toBe(true);
    expect(typeof body.proposalId).toBe("string");
    expect(body.proposedVersion).not.toBe(submitted.versionHash);
    expect(body.autoApplied).toBe(false);
  });

  it("POST /api/kernel/proposals accepts a prompts override and returns a new version hash", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent");
    if (!firstAgent || firstAgent.type !== "agent") throw new Error("no agent stage in fixture");
    const oldRef = firstAgent.config.promptRef;

    const app = buildApp();
    const res = await app.fetch(
      new Request("http://t/api/kernel/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentVersion: submitted.versionHash,
          // No IR patch needed — a pure prompt-content change is
          // expressed by keeping the IR identical and overriding the
          // ref's content. propose() still demands a non-empty patch.
          // Use a no-op config merge that preserves the existing
          // promptRef (same ref, but the prompts override changes the
          // content and therefore the pipeline-hash).
          patch: {
            ops: [{
              op: "update_stage_config",
              stage: firstAgent.name,
              configPatch: { promptRef: oldRef },
            }],
          },
          actor: "ai:test",
          prompts: { [oldRef]: "REVISED content" },
        }),
      }),
    );
    expect(res.status).toBe(202);
    const body = await res.json() as { ok: boolean; proposedVersion: string };
    expect(body.ok).toBe(true);
    expect(body.proposedVersion).not.toBe(submitted.versionHash);
  });

  it("POST /api/kernel/proposals returns 400 on invalid body", async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://t/api/kernel/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ missing: "everything" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("INVALID_REQUEST_BODY");
  });

  it("POST /api/kernel/proposals surfaces service-side PATCH_APPLY_ERROR for unknown currentVersion", async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request("http://t/api/kernel/proposals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentVersion: "nonexistent-hash",
          patch: { ops: [{ op: "remove_stage", stageName: "A" }] },
          actor: "test",
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.diagnostics[0]!.code).toBe("PATCH_APPLY_ERROR");
  });

  it("GET /api/kernel/proposals enriches rows with pipelineName", async () => {
    await seedProposal(db, "ai:test-enrich");

    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/proposals"));
    const body = await res.json() as {
      ok: boolean;
      proposals: Array<{ proposalId: string; pipelineName: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]!.pipelineName).toBe(diamondIR().name);
  });

  it("POST /api/kernel/proposals returns 400 NO_OP_PROPOSAL for empty patch + empty prompts", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentVersion: submitted.versionHash,
        patch: { ops: [] },
        actor: "ai:http-noop",
      }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]!.code).toBe("NO_OP_PROPOSAL");
  });

  it("POST /api/kernel/proposals accepts ops:[] at the route layer (service layer's NO_OP check is the gatekeeper)", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const firstPromptRef = Object.keys(diamondPrompts())[0]!;
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentVersion: submitted.versionHash,
        patch: { ops: [] },
        actor: "ai:route-empty-ops",
        prompts: { ...diamondPrompts(), [firstPromptRef]: "new content body" },
      }),
    }));
    // Route accepts; service returns 202 since prompts override flips
    // proposedHash off baseline.
    expect(res.status).toBe(202);
  });
});

describe("REST /api/kernel/proposals — broadcast (B5 wf.hotUpdatePending)", () => {
  let db: DatabaseSync;
  let captured: ProposalEvent[];
  let broadcaster: ProposalsBroadcaster;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
    broadcaster = new ProposalsBroadcaster();
    captured = [];
    broadcaster.subscribe((e) => captured.push(e));
    __setProposalsBroadcasterForTest(broadcaster);
  });

  afterEach(async () => {
    __setProposalsBroadcasterForTest(undefined);
    __setKernelNextDbForTest(undefined);
    db.close();
  });

  it("POST /api/kernel/proposals publishes proposal_created with pipelineName", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentVersion: submitted.versionHash,
        patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
        actor: "ai:broadcast-test",
      }),
    }));
    expect(res.status).toBe(202);
    const live = captured.filter((e) => e.type === "proposal_created");
    expect(live).toHaveLength(1);
    expect(live[0]!.data.pipelineName).toBe(diamondIR().name);
    expect(live[0]!.data.actor).toBe("ai:broadcast-test");
    expect(live[0]!.data.status).toBe("pending");
  });

  it("POST /approve publishes proposal_approved; reject publishes proposal_rejected", async () => {
    const { proposalId: p1 } = await seedProposal(db, "ai:a");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted2 = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted2.ok) throw new Error("submit2 failed");
    const p2 = svc.propose({
      currentVersion: submitted2.versionHash,
      patch: { ops: [{ op: "remove_stage", stageName: "B" }] },
      actor: "ai:b",
    });
    if (!p2.ok) throw new Error("propose2 failed");

    const app = buildApp();
    await app.fetch(new Request(`http://t/api/kernel/proposals/${p1}/approve`, { method: "POST" }));
    await app.fetch(new Request(`http://t/api/kernel/proposals/${p2.proposalId}/reject`, {
      method: "POST", body: JSON.stringify({ reason: "nope" }),
      headers: { "content-type": "application/json" },
    }));

    const approved = captured.filter((e) => e.type === "proposal_approved");
    const rejected = captured.filter((e) => e.type === "proposal_rejected");
    expect(approved).toHaveLength(1);
    expect(approved[0]!.data.proposalId).toBe(p1);
    expect(approved[0]!.data.status).toBe("approved");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.data.proposalId).toBe(p2.proposalId);
    expect(rejected[0]!.data.status).toBe("rejected");
  });

  it("broadcast does NOT fire on failure paths (NO_OP_PROPOSAL)", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentVersion: submitted.versionHash,
        patch: { ops: [] },
        actor: "ai:noop",
      }),
    }));
    expect(res.status).toBe(400);
    expect(captured).toHaveLength(0);
  });
});
