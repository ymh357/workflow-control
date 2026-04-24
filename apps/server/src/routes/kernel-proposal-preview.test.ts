// REST tests for kernel-next proposal-preview API (P7.2 / D22).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { KernelService } from "../kernel-next/mcp/kernel.js";
import { diamondIR } from "../kernel-next/generator-mock/mini-generator.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { kernelProposalPreviewRoute } from "./kernel-proposal-preview.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelProposalPreviewRoute);
  return app;
}

function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

async function seedRemoveStageProposal(db: DatabaseSync): Promise<{
  proposalId: string;
  baseVersion: string;
  proposedVersion: string;
}> {
  const svc = new KernelService(db, { skipTypeCheck: true });
  const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
  if (!submitted.ok) throw new Error("setup submit failed");
  const proposed = svc.propose({
    currentVersion: submitted.versionHash,
    // D is a leaf — removing it is a clean cascade (wires that touch it
    // are dropped). Avoids SAFE_RANGE rejecting the proposal in dry-run.
    patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
    actor: "ai:test",
  });
  if (!proposed.ok) throw new Error("setup propose failed");
  return {
    proposalId: proposed.proposalId,
    baseVersion: submitted.versionHash,
    proposedVersion: proposed.proposedVersion,
  };
}

describe("POST /api/kernel/proposals/:id/preview", () => {
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

  it("returns 404 for unknown proposal id", async () => {
    const app = buildApp();
    const res = await app.fetch(new Request("http://t/api/kernel/proposals/missing/preview", {
      method: "POST",
    }));
    expect(res.status).toBe(404);
    const body = await res.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.diagnostics[0]?.code).toBe("PROPOSAL_NOT_FOUND");
  });

  it("returns baseIr + projectedIr for a pending proposal", async () => {
    const { proposalId, baseVersion, proposedVersion } = await seedRemoveStageProposal(db);
    const app = buildApp();
    const res = await app.fetch(
      new Request(`http://t/api/kernel/proposals/${proposalId}/preview`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      ok: boolean;
      baseVersion: string;
      projectedVersion: string;
      status: string;
      baseIr: { name: string; stages: Array<{ name: string }> };
      projectedIr: { name: string; stages: Array<{ name: string }> };
    };
    expect(body.ok).toBe(true);
    expect(body.baseVersion).toBe(baseVersion);
    expect(body.projectedVersion).toBe(proposedVersion);
    expect(body.status).toBe("pending");
    expect(body.baseIr.name).toBe("diamond");
    expect(body.projectedIr.name).toBe("diamond");
    // Base has 4 stages (A, B, C, D). Projected had D removed.
    expect(body.baseIr.stages.map((s) => s.name).sort()).toEqual(["A", "B", "C", "D"]);
    expect(body.projectedIr.stages.map((s) => s.name).sort()).toEqual(["A", "B", "C"]);
  });

  it("is a DRY run — does not insert new rows into pipeline_versions or pipeline_proposals", async () => {
    const { proposalId } = await seedRemoveStageProposal(db);
    const countVersions = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM pipeline_versions").get() as { n: number }).n;
    const countProposals = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM pipeline_proposals").get() as { n: number }).n;
    const versionsBefore = countVersions();
    const proposalsBefore = countProposals();

    const app = buildApp();
    // Call preview twice to be extra sure.
    await app.fetch(new Request(`http://t/api/kernel/proposals/${proposalId}/preview`, {
      method: "POST",
    }));
    await app.fetch(new Request(`http://t/api/kernel/proposals/${proposalId}/preview`, {
      method: "POST",
    }));

    expect(countVersions()).toBe(versionsBefore);
    expect(countProposals()).toBe(proposalsBefore);
  });

  it("returns correct status for approved proposal", async () => {
    const { proposalId } = await seedRemoveStageProposal(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const approved = svc.approveProposal(proposalId);
    if (!approved.ok) throw new Error("setup approve failed");

    const app = buildApp();
    const res = await app.fetch(
      new Request(`http://t/api/kernel/proposals/${proposalId}/preview`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("approved");
  });
});
