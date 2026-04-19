// Phase 2 P2.4 — End-to-end acceptance: the AI-authored proposal loop.
//
// Validates that the full cycle works:
//
//   1. task T1 runs a diamond pipeline to completion on version V1
//   2. during / after T1, propose_pipeline_change patches V1 → V2
//   3. REST POST /kernel/proposals/:id/approve flips the proposal
//      to 'approved' without touching running tasks (no migration in P2)
//   4. task T2 explicitly uses the approved proposedVersion (V2) and
//      runs successfully with the modified shape
//   5. approve cannot be replayed; list reflects terminal state
//
// Hits REST routes through Hono's in-memory .fetch so the MCP-side
// KernelService and the HTTP-side KernelService genuinely share a DB
// via __setKernelNextDbForTest.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import { runPipeline } from "../runtime/runner.js";
import { __setKernelNextDbForTest } from "../../lib/kernel-next-db.js";
import { kernelProposalsRoute } from "../../routes/kernel-proposals.js";
import type { PipelineIR, IRPatch } from "../ir/schema.js";
import type { StageHandlerMap } from "../runtime/mock-executor.js";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api", kernelProposalsRoute);
  return app;
}

function baseHandlers(): StageHandlerMap {
  return {
    A: () => ({ x: 10 }),
    B: (i) => ({ y: `B:${i.x as number}` }),
    C: (i) => ({ z: `C:${i.x as number}` }),
    D: (i) => ({ final: `${i.b as string}|${i.c as string}` }),
  };
}

describe("P2.4 end-to-end proposal acceptance", () => {
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

  it("full cycle: run T1 → propose → approve via REST → run T2 on approved version", async () => {
    const svc = new KernelService(db, { skipTypeCheck: true });
    const app = buildApp();

    // --- 1. Submit baseline pipeline V1 ---
    const submitted = svc.submit(diamondIR());
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const versionV1 = submitted.versionHash;

    // --- 2. Run T1 on V1. Completes cleanly. ---
    const t1Result = await runPipeline({
      db,
      ir: diamondIR(),
      taskId: "T1",
      versionHash: versionV1,
      handlers: baseHandlers(),
    });
    expect(t1Result.finalState).toBe("completed");
    expect(t1Result.portValues["D.final"]).toBe("B:10|C:10");

    // --- 3. Propose a structural change (V1 → V2): drop stage D. ---
    //     A structural patch makes this more than a prompt tweak — it is
    //     exactly the kind of change that MUST be human-approved.
    const patch: IRPatch = { ops: [{ op: "remove_stage", stageName: "D" }] };
    const proposed = svc.propose({
      currentVersion: versionV1,
      patch,
      actor: "ai:pipeline-generator",
    });
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    expect(proposed.autoApplied).toBe(false);
    const versionV2 = proposed.proposedVersion;
    expect(versionV2).not.toBe(versionV1);

    // --- 4. List via REST shows one pending. ---
    const pendingRes = await app.fetch(
      new Request("http://t/api/kernel/proposals?status=pending"),
    );
    expect(pendingRes.status).toBe(200);
    const pendingBody = await pendingRes.json() as {
      ok: true;
      proposals: Array<{ proposalId: string; baseVersion: string; proposedVersion: string; status: string }>;
    };
    expect(pendingBody.proposals).toHaveLength(1);
    expect(pendingBody.proposals[0]).toMatchObject({
      proposalId: proposed.proposalId,
      baseVersion: versionV1,
      proposedVersion: versionV2,
      status: "pending",
    });

    // --- 5. Approve via REST. Response carries the terminal status. ---
    const approveRes = await app.fetch(
      new Request(`http://t/api/kernel/proposals/${proposed.proposalId}/approve`, { method: "POST" }),
    );
    expect(approveRes.status).toBe(200);
    const approveBody = await approveRes.json() as { ok: boolean; status: string };
    expect(approveBody).toEqual({ ok: true, proposalId: proposed.proposalId, status: "approved" });

    // --- 6. DB reflects approved state; list(pending) is now empty. ---
    const pendingAfter = await app.fetch(
      new Request("http://t/api/kernel/proposals?status=pending"),
    );
    const pendingAfterBody = await pendingAfter.json() as { proposals: unknown[] };
    expect(pendingAfterBody.proposals).toHaveLength(0);

    const approvedList = await app.fetch(
      new Request("http://t/api/kernel/proposals?status=approved"),
    );
    const approvedBody = await approvedList.json() as { proposals: Array<{ proposedVersion: string }> };
    expect(approvedBody.proposals).toHaveLength(1);
    expect(approvedBody.proposals[0]!.proposedVersion).toBe(versionV2);

    // --- 7. New task T2 can run on V2. ---
    //     Reconstruct the V2 IR by fetching it via svc (round-trip proves
    //     the version is fully persisted, not a ghost row in proposals).
    const v2Ir = getPipelineIrByHash(db, versionV2);
    expect(v2Ir).not.toBeNull();
    if (!v2Ir) return;
    expect(v2Ir.stages.some((s) => s.name === "D")).toBe(false);

    // V2 has no D, so handlers only need A/B/C. D's wires were
    // cascade-dropped by remove_stage (patch.ts), so runner should
    // terminate after B+C complete.
    const t2Handlers: StageHandlerMap = {
      A: () => ({ x: 99 }),
      B: (i) => ({ y: `B:${i.x as number}` }),
      C: (i) => ({ z: `C:${i.x as number}` }),
    };
    const t2Result = await runPipeline({
      db,
      ir: v2Ir,
      taskId: "T2",
      versionHash: versionV2,
      handlers: t2Handlers,
    });
    expect(t2Result.finalState).toBe("completed");
    expect(t2Result.portValues["B.y"]).toBe("B:99");
    expect(t2Result.portValues["C.z"]).toBe("C:99");
    expect(t2Result.portValues["D.final"]).toBeUndefined();

    // --- 8. T1's lineage is intact and untouched. Running tasks on V1
    //        are not rewritten by approve — design §13. ---
    const t1AttemptRow = db.prepare(
      `SELECT COUNT(*) AS n FROM stage_attempts WHERE task_id = 'T1'`,
    ).get() as { n: number };
    expect(t1AttemptRow.n).toBe(4); // A, B, C, D
    const t1FinalRow = db.prepare(
      `SELECT value_json FROM port_values
       JOIN stage_attempts sa ON sa.attempt_id = port_values.attempt_id
       WHERE sa.task_id = 'T1' AND port_values.stage_name = 'D' AND port_name = 'final'`,
    ).get() as { value_json: string };
    expect(JSON.parse(t1FinalRow.value_json)).toBe("B:10|C:10");

    // --- 9. Re-approve is idempotent-rejected with 409. ---
    const reApprove = await app.fetch(
      new Request(`http://t/api/kernel/proposals/${proposed.proposalId}/approve`, { method: "POST" }),
    );
    expect(reApprove.status).toBe(409);
    const reBody = await reApprove.json() as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(reBody.ok).toBe(false);
    expect(reBody.diagnostics[0]!.code).toBe("PROPOSAL_ALREADY_RESOLVED");
  });

  it("running task and proposal review are on disjoint data paths", async () => {
    // Explicit invariant: approve/reject only touch pipeline_proposals;
    // a task launched on V1 before approval continues to read V1's stages/
    // wires and writes to stage_attempts/port_values — never observes V2.
    const svc = new KernelService(db, { skipTypeCheck: true });
    const app = buildApp();

    const v1 = svc.submit(diamondIR());
    if (!v1.ok) throw new Error("submit failed");
    const proposed = svc.propose({
      currentVersion: v1.versionHash,
      patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
      actor: "test",
    });
    if (!proposed.ok) throw new Error("propose failed");

    // Start T1 and approve concurrently. Await both; verify T1 completes on V1.
    const t1Promise = runPipeline({
      db,
      ir: diamondIR(),
      taskId: "T1",
      versionHash: v1.versionHash,
      handlers: baseHandlers(),
    });
    const approveRes = await app.fetch(
      new Request(`http://t/api/kernel/proposals/${proposed.proposalId}/approve`, { method: "POST" }),
    );
    expect(approveRes.status).toBe(200);

    const t1 = await t1Promise;
    expect(t1.finalState).toBe("completed");

    // T1's attempts all reference V1.
    const versions = db.prepare(
      `SELECT DISTINCT version_hash FROM stage_attempts WHERE task_id = 'T1'`,
    ).all() as Array<{ version_hash: string }>;
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version_hash).toBe(v1.versionHash);
  });
});

function getPipelineIrByHash(db: DatabaseSync, hash: string): PipelineIR | null {
  const row = db.prepare(
    `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
  ).get(hash) as { ir_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.ir_json) as PipelineIR;
}
