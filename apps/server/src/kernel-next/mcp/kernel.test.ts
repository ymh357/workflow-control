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

  it("approveProposal flips pending → approved", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR());
    if (!submitted.ok) throw new Error("setup failed");
    const proposed = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
      actor: "test",
    });
    if (!proposed.ok) throw new Error("propose failed");

    const r = svc.approveProposal(proposed.proposalId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("approved");

    const row = db.prepare(
      `SELECT status, diagnostic_json FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(proposed.proposalId) as { status: string; diagnostic_json: string | null };
    expect(row.status).toBe("approved");
    expect(row.diagnostic_json).toBeNull();
    db.close();
  });

  it("rejectProposal flips pending → rejected and persists reason", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR());
    if (!submitted.ok) throw new Error("setup failed");
    const proposed = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
      actor: "test",
    });
    if (!proposed.ok) throw new Error("propose failed");

    const r = svc.rejectProposal(proposed.proposalId, "not needed");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("rejected");

    const row = db.prepare(
      `SELECT status, diagnostic_json FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(proposed.proposalId) as { status: string; diagnostic_json: string };
    expect(row.status).toBe("rejected");
    expect(JSON.parse(row.diagnostic_json)).toEqual({ reason: "not needed" });
    db.close();
  });

  it("approveProposal rejects unknown proposalId", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = svc.approveProposal("nonexistent");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("PROPOSAL_NOT_FOUND");
    db.close();
  });

  it("approveProposal rejects an already-resolved proposal", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR());
    if (!submitted.ok) throw new Error("setup failed");
    const proposed = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
      actor: "test",
    });
    if (!proposed.ok) throw new Error("propose failed");

    const first = svc.approveProposal(proposed.proposalId);
    expect(first.ok).toBe(true);
    const second = svc.rejectProposal(proposed.proposalId);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.diagnostics[0]!.code).toBe("PROPOSAL_ALREADY_RESOLVED");
    expect(second.diagnostics[0]!.context).toEqual({
      proposalId: proposed.proposalId,
      currentStatus: "approved",
    });
    db.close();
  });

  it("listProposals returns newest-first and filters by status", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR());
    if (!submitted.ok) throw new Error("setup failed");
    const p1 = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{ op: "remove_stage", stageName: "D" }] },
      actor: "ai:a",
    });
    const p2 = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{ op: "remove_stage", stageName: "B" }] },
      actor: "ai:b",
    });
    if (!p1.ok || !p2.ok) throw new Error("propose failed");

    svc.rejectProposal(p1.proposalId);

    const all = svc.listProposals();
    expect(all.map((r) => r.proposalId)).toEqual([p2.proposalId, p1.proposalId]);
    expect(all[0]!.actor).toBe("ai:b");
    expect(all[1]!.status).toBe("rejected");

    const pending = svc.listProposals({ status: "pending" });
    expect(pending.map((r) => r.proposalId)).toEqual([p2.proposalId]);
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

// A1.2a: gate lifecycle — createGate + listGates + answerGate.
// These tests seed a pipeline containing a gate stage, manually open a
// stage_attempt row (bypassing the full runner), call createGate, then
// exercise the three query/answer paths including GATE_NOT_FOUND,
// GATE_ALREADY_ANSWERED, and GATE_ANSWER_INVALID diagnostics.
describe("KernelService — gate lifecycle (A1.2a)", () => {
  function seedGatePipeline(svc: KernelService) {
    const ir = {
      name: "t",
      stages: [
        { name: "A", type: "agent" as const, inputs: [],
          outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        {
          name: "G", type: "gate" as const,
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
    const submit = svc.submit(ir);
    if (!submit.ok) throw new Error("submit failed");
    return { ir, versionHash: submit.versionHash };
  }

  function openAttempt(db: DatabaseSync, taskId: string, versionHash: string, stageName: string): string {
    const attemptId = "attempt-" + Math.random().toString(36).slice(2, 10);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES (?, ?, ?, ?, 1, ?, 'running')`,
    ).run(attemptId, taskId, versionHash, stageName, Date.now());
    return attemptId;
  }

  it("createGate inserts a row; listGates returns it; answerGate resolves to the target", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const { versionHash } = seedGatePipeline(svc);
      const attemptId = openAttempt(db, "task-1", versionHash, "G");

      const { gateId } = svc.createGate({
        taskId: "task-1",
        stageName: "G",
        attemptId,
        question: { text: "continue?", options: ["yes", "no"] },
      });

      // Listable, unanswered.
      const pending = svc.listGates({ taskId: "task-1", answered: false });
      expect(pending.map((g) => g.gateId)).toEqual([gateId]);
      expect(pending[0]!.answer).toBeNull();
      expect(pending[0]!.question).toEqual({ text: "continue?", options: ["yes", "no"] });

      const result = svc.answerGate(gateId, "yes");
      expect(result).toEqual({ ok: true, gateId, targetStage: "A", answer: "yes" });

      const after = svc.listGates({ taskId: "task-1", answered: true });
      expect(after[0]!.answer).toBe("yes");
      expect(after[0]!.answeredAt).toBeTypeOf("number");
    } finally {
      db.close();
    }
  });

  it("answerGate with _default fallback routing", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      // Pipeline with _default in routing.
      const ir = {
        name: "t",
        stages: [
          { name: "A", type: "agent" as const, inputs: [], outputs: [], config: { promptRef: "p" } },
          {
            name: "G", type: "gate" as const,
            inputs: [], outputs: [],
            config: {
              question: { text: "?" },
              routing: { routes: { _default: "A" } },
            },
          },
        ],
        wires: [],
      };
      const submit = svc.submit(ir);
      if (!submit.ok) throw new Error("submit failed");
      const attemptId = openAttempt(db, "t1", submit.versionHash, "G");
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId, question: { text: "?" },
      });
      const r = svc.answerGate(gateId, "surprise");
      expect(r).toEqual({ ok: true, gateId, targetStage: "A", answer: "surprise" });
    } finally {
      db.close();
    }
  });

  it("answerGate rejects unknown gateId", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const r = svc.answerGate("ghost-gate", "yes");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.diagnostics[0]!.code).toBe("GATE_NOT_FOUND");
      }
    } finally {
      db.close();
    }
  });

  it("answerGate is idempotent: second call yields GATE_ALREADY_ANSWERED", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const { versionHash } = seedGatePipeline(svc);
      const attemptId = openAttempt(db, "t1", versionHash, "G");
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId,
        question: { text: "continue?", options: ["yes", "no"] },
      });
      const first = svc.answerGate(gateId, "yes");
      expect(first.ok).toBe(true);
      const second = svc.answerGate(gateId, "no");
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.diagnostics[0]!.code).toBe("GATE_ALREADY_ANSWERED");
      }
    } finally {
      db.close();
    }
  });

  it("answerGate rejects an answer not in the routing table", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const { versionHash } = seedGatePipeline(svc);
      const attemptId = openAttempt(db, "t1", versionHash, "G");
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId,
        question: { text: "continue?", options: ["yes", "no"] },
      });
      const r = svc.answerGate(gateId, "maybe");
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.diagnostics[0]!.code).toBe("GATE_ANSWER_INVALID");
        expect(r.diagnostics[0]!.context?.allowedAnswers).toEqual(["yes", "no"]);
      }
    } finally {
      db.close();
    }
  });

  it("listGates filters by taskId correctly", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const { versionHash } = seedGatePipeline(svc);
      const a1 = openAttempt(db, "task-A", versionHash, "G");
      const a2 = openAttempt(db, "task-B", versionHash, "G");
      const g1 = svc.createGate({ taskId: "task-A", stageName: "G", attemptId: a1, question: { text: "?" } });
      const g2 = svc.createGate({ taskId: "task-B", stageName: "G", attemptId: a2, question: { text: "?" } });
      expect(svc.listGates({ taskId: "task-A" }).map((g) => g.gateId)).toEqual([g1.gateId]);
      expect(svc.listGates({ taskId: "task-B" }).map((g) => g.gateId)).toEqual([g2.gateId]);
      const all = svc.listGates().map((g) => g.gateId).sort();
      expect(all).toEqual([g1.gateId, g2.gateId].sort());
    } finally {
      db.close();
    }
  });
});
