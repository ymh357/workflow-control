// KernelService tests — skipTypeCheck=true for speed. End-to-end tsc path
// exercised separately in server.test.ts.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, getPipelineIR } from "../ir/sql.js";
import { KernelService } from "./kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import { versionHash } from "../ir/canonical.js";
import type { IRPatch } from "../ir/schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

describe("KernelService", () => {
  it("validate accepts a clean diamond IR", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    expect(svc.validate(diamondIR())).toEqual({ ok: true, diagnostics: [] });
    db.close();
  });

  it("validate rejects with ZOD_PARSE_ERROR on malformed input", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = svc.validate({ name: "bad", stages: "not-an-array" });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]!.code).toBe("ZOD_PARSE_ERROR");
    db.close();
  });

  it("validate rejects with structural error (duplicate stage)", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const bad = diamondIR();
    bad.stages.push({ ...bad.stages[0]! });
    const r = svc.validate(bad);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]!.code).toBe("DUPLICATE_STAGE_NAME");
    db.close();
  });

  it("submit persists a valid IR", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = svc.submit(diamondIR());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.versionHash).toBe(versionHash(diamondIR()));
    expect(getPipelineIR(db, r.versionHash)).not.toBeNull();
    db.close();
  });

  it("submit is idempotent (same IR returns same hash without re-insert)", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r1 = svc.submit(diamondIR());
    const r2 = svc.submit(diamondIR());
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.versionHash).toBe(r2.versionHash);
    const count = db.prepare("SELECT COUNT(*) AS n FROM pipeline_versions").get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it("propose rejects unknown currentVersion", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = svc.propose({
      currentVersion: "nonexistent-hash",
      patch: { ops: [{ op: "remove_stage", stageName: "A" }] },
      actor: "test",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("PATCH_APPLY_ERROR");
    db.close();
  });

  it("propose applies patch, persists new version, and records pending proposal", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR());
    if (!submitted.ok) throw new Error("setup failed");

    // Remove stage D (the leaf) — valid structural patch.
    const patch: IRPatch = { ops: [{ op: "remove_stage", stageName: "D" }] };
    const r = svc.propose({
      currentVersion: submitted.versionHash,
      patch,
      actor: "ai:pipeline-generator",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.autoApplied).toBe(false);
    expect(r.proposedVersion).not.toBe(submitted.versionHash);

    // Proposal row is stored with status='pending'.
    const row = db.prepare(
      `SELECT status, actor, base_version, proposed_version FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(r.proposalId) as {
      status: string; actor: string; base_version: string; proposed_version: string;
    };
    expect(row.status).toBe("pending");
    expect(row.actor).toBe("ai:pipeline-generator");
    expect(row.base_version).toBe(submitted.versionHash);
    expect(row.proposed_version).toBe(r.proposedVersion);

    // Proposed version IR is also persisted in pipeline_versions.
    expect(getPipelineIR(db, r.proposedVersion)).not.toBeNull();
    db.close();
  });

  it("propose fails validation when patch produces structurally invalid IR", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR());
    if (!submitted.ok) throw new Error("setup failed");

    // Remove A; this makes all wires from A cascade-deleted, but B/C still
    // declare an inbound port `x` with no wire — that is allowed structurally
    // (dangling input). So we instead add a wire targeting a port that
    // doesn't exist to force WIRE_TARGET_PORT_MISSING.
    const patch: IRPatch = { ops: [
      { op: "add_wire", wire: { from: { stage: "A", port: "x" }, to: { stage: "B", port: "ghost" } } },
    ]};
    const r = svc.propose({ currentVersion: submitted.versionHash, patch, actor: "test" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.some((d) => d.code === "WIRE_TARGET_PORT_MISSING")).toBe(true);
    db.close();
  });
});
