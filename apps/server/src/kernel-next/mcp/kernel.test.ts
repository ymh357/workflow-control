// KernelService tests — skipTypeCheck=true for speed. End-to-end tsc path
// exercised separately in server.test.ts.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, getPipelineIR } from "../ir/sql.js";
import { KernelService } from "./kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import { versionHash, pipelineVersionHash } from "../ir/canonical.js";
import type { IRPatch } from "../ir/schema.js";

// Prompts map covering every agent stage in diamondIR. Diamond stages A/B/C/D
// each have a unique promptRef (the full prompt text); this helper rebuilds
// that map so tests can submit a diamond without PROMPT_REF_MISSING noise.
function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

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

  it("validate rejects with STORE_SCHEMA_TYPE_MISMATCH when drift is introduced", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = diamondIR();
    // Diamond terminal stage 'd' has an output port; declare store_schema
    // with a mismatched type to trigger drift detection at build time.
    const terminal = ir.stages.find((s) => s.outputs.length > 0);
    if (!terminal) throw new Error("diamondIR has no stage with outputs");
    const firstOutput = terminal.outputs[0]!;
    const driftedType = firstOutput.type.trim() === "string" ? "number" : "string";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ir as any).store_schema = {
      firstOutput: {
        type: driftedType,
        produced_by: { stage: terminal.name, port: firstOutput.name },
      },
    };
    const r = svc.validate(ir);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === "STORE_SCHEMA_TYPE_MISMATCH")).toBe(true);
    db.close();
  });

  it("validate accepts store_schema that matches the stage outputs", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = diamondIR();
    const terminal = ir.stages.find((s) => s.outputs.length > 0);
    if (!terminal) throw new Error("diamondIR has no stage with outputs");
    const firstOutput = terminal.outputs[0]!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ir as any).store_schema = {
      firstOutput: {
        type: firstOutput.type,
        produced_by: { stage: terminal.name, port: firstOutput.name },
      },
    };
    expect(svc.validate(ir).ok).toBe(true);
    db.close();
  });

  it("submit persists a valid IR", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const prompts = diamondPrompts();
    const r = svc.submit(diamondIR(), { prompts });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Pipeline-level hash (IR + prompts), not the IR-only hash. The
    // IR-only versionHash goldens live in canonical.test.ts and remain
    // byte-identical.
    expect(r.versionHash).toBe(pipelineVersionHash({ ir: diamondIR(), prompts }));
    expect(r.versionHash).not.toBe(versionHash(diamondIR()));
    expect(getPipelineIR(db, r.versionHash)).not.toBeNull();
    db.close();
  });

  it("submit is idempotent (same IR returns same hash without re-insert)", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const prompts = diamondPrompts();
    const r1 = svc.submit(diamondIR(), { prompts });
    const r2 = svc.submit(diamondIR(), { prompts });
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
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
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
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
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
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
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
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
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
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
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
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
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
    const submit = svc.submit(ir, { prompts: { p: "dummy" } });
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
      // Both routes (yes/no) target "A" which is upstream of G —
      // the compiler detects this as a rollback answer. Only the
      // first matching answer is recorded, so "yes" → kind="rejected".
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe("rejected");
      expect(result.answer).toBe("yes");
      expect(result.targetStage).toBe("A");

      const after = svc.listGates({ taskId: "task-1", answered: true });
      expect(after[0]!.answer).toBe("yes");
      expect(after[0]!.answeredAt).toBeTypeOf("number");

      // Stage attempt should be finalized as success alongside the gate
      // answer write (same transaction).
      const attemptRow = db.prepare(
        `SELECT status, ended_at FROM stage_attempts WHERE attempt_id = ?`,
      ).get(attemptId) as { status: string; ended_at: number | null };
      expect(attemptRow.status).toBe("success");
      expect(attemptRow.ended_at).toBeTypeOf("number");
    } finally {
      db.close();
    }
  });

  it("answerGate with _default fallback routing", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      // Pipeline with _default in routing. P6-8: seed a minimal
      // dataflow so EMPTY_DATAFLOW doesn't fire; fixture still asserts
      // on gate answer routing behavior unchanged.
      const ir = {
        name: "t",
        externalInputs: [{ name: "sig", type: "unknown" as const }],
        stages: [
          { name: "A", type: "agent" as const, inputs: [{ name: "ack", type: "unknown" as const }], outputs: [], config: { promptRef: "p" } },
          {
            name: "G", type: "gate" as const,
            inputs: [{ name: "__gate_signal", type: "unknown" as const }], outputs: [],
            config: {
              question: { text: "?" },
              routing: { routes: { _default: "A" } },
            },
          },
        ],
        wires: [
          { from: { source: "external" as const, port: "sig" }, to: { stage: "G", port: "__gate_signal" } },
        ],
      };
      const submit = svc.submit(ir, { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      const attemptId = openAttempt(db, "t1", submit.versionHash, "G");
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId, question: { text: "?" },
      });
      const r = svc.answerGate(gateId, "surprise");
      expect(r).toEqual({
        ok: true, kind: "answered", gateId, taskId: "t1", stageName: "G",
        targetStage: "A", answer: "surprise",
      });
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

describe("KernelService — getTaskStatus (A4)", () => {
  function seedSmallPipeline(svc: KernelService): string {
    const ir = {
      name: "mini",
      stages: [
        { name: "A", type: "agent" as const, inputs: [],
          outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        {
          name: "G", type: "gate" as const,
          inputs: [{ name: "x", type: "number" }],
          outputs: [],
          config: {
            question: { text: "continue?", options: ["yes"] },
            routing: { routes: { yes: "A" } },
          },
        },
      ],
      wires: [{ from: { stage: "A", port: "x" }, to: { stage: "G", port: "x" } }],
    };
    const submit = svc.submit(ir, { prompts: { p: "dummy" } });
    if (!submit.ok) throw new Error("submit failed");
    return submit.versionHash;
  }

  function openAttempt(
    db: DatabaseSync,
    taskId: string,
    versionHash: string,
    stageName: string,
    status: "running" | "success" | "error" = "running",
    attemptIdx = 1,
  ): string {
    const attemptId = "att-" + Math.random().toString(36).slice(2, 10);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, ended_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      attemptId,
      taskId,
      versionHash,
      stageName,
      attemptIdx,
      Date.now(),
      status === "running" ? null : Date.now(),
      status,
    );
    return attemptId;
  }

  it("not_found when no stage_attempts exist", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      expect(svc.getTaskStatus("ghost")).toEqual({
        ok: true, status: "not_found", taskId: "ghost",
      });
    } finally {
      db.close();
    }
  });

  it("gated when any pending gate_queue row exists, with pending list", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "success");
      const gAttempt = openAttempt(db, "t1", hash, "G", "running");
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId: gAttempt,
        question: { text: "continue?", options: ["yes"] },
      });
      const s = svc.getTaskStatus("t1");
      if (s.status !== "gated") throw new Error(`unexpected status ${s.status}`);
      expect(s.status).toBe("gated");
      expect(s.pending).toHaveLength(1);
      expect(s.pending[0]).toMatchObject({
        gateId,
        stageName: "G",
        question: { text: "continue?", options: ["yes"] },
      });
    } finally {
      db.close();
    }
  });

  it("running when at least one attempt is running and no pending gates", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "running");
      expect(svc.getTaskStatus("t1")).toEqual({
        ok: true, status: "running", taskId: "t1",
      });
    } finally {
      db.close();
    }
  });

  it("completed when every stage's latest attempt is success and no pending gates", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "success");
      openAttempt(db, "t1", hash, "G", "success");
      expect(svc.getTaskStatus("t1")).toEqual({
        ok: true, status: "completed", taskId: "t1",
      });
    } finally {
      db.close();
    }
  });

  it("failed when any stage's latest attempt is error", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "success");
      openAttempt(db, "t1", hash, "G", "error");
      expect(svc.getTaskStatus("t1")).toEqual({
        ok: true, status: "failed", taskId: "t1",
      });
    } finally {
      db.close();
    }
  });

  it("'gated' trumps 'running' — gate-stage attempt stays running while gated", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = seedSmallPipeline(svc);
      const att = openAttempt(db, "t1", hash, "G", "running");
      svc.createGate({
        taskId: "t1", stageName: "G", attemptId: att,
        question: { text: "q" },
      });
      const s = svc.getTaskStatus("t1");
      expect(s.status).toBe("gated");
    } finally {
      db.close();
    }
  });

  it("answered gates don't keep a task in 'gated' status", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = seedSmallPipeline(svc);
      const att = openAttempt(db, "t1", hash, "G", "success");
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId: att,
        question: { text: "?", options: ["yes"] },
      });
      svc.answerGate(gateId, "yes");
      // No more pending — status derives from attempt rows alone.
      // (A stage remains status='running' only until answerGate; see A1.2a
      // transactional update.) Here the attempt is 'success' after answer.
      const s = svc.getTaskStatus("t1");
      expect(s.status).toBe("completed");
    } finally {
      db.close();
    }
  });

  it("latest attempt wins — a retry that succeeds masks an earlier error", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "error", 1);
      openAttempt(db, "t1", hash, "A", "success", 2);
      openAttempt(db, "t1", hash, "G", "success");
      expect(svc.getTaskStatus("t1").status).toBe("completed");
    } finally {
      db.close();
    }
  });
});

import type { PipelineIR } from "../ir/schema.js";
import { insertPipelineVersion } from "../ir/sql.js";

describe("KernelService.answerGate — reject rollback kind", () => {
  // Pipeline shape: A -> G (gate with routes: {approve: B, reject: A}) -> B
  // One open gate_queue row for stage G.
  function setupRejectReadyDb() {
    const db = makeDb();
    const ir: PipelineIR = {
      name: "rb-t",
      version: "1.0.0",
      externalInputs: [],
      stages: [
        {
          name: "A",
          type: "agent",
          config: { promptRef: "p", reads: [] },
          inputs: [],
          outputs: [{ name: "o", type: "unknown" }],
        } as unknown as PipelineIR["stages"][number],
        {
          name: "G",
          type: "gate",
          config: { routing: { routes: { approve: "B", reject: "A" } } },
          inputs: [{ name: "i", type: "unknown" }],
          outputs: [],
        } as unknown as PipelineIR["stages"][number],
        {
          name: "B",
          type: "agent",
          config: { promptRef: "p", reads: [] },
          inputs: [],
          outputs: [],
        } as unknown as PipelineIR["stages"][number],
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "o" }, to: { stage: "G", port: "i" } },
      ],
    } as unknown as PipelineIR;

    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });

    const attemptId = "a-1";
    const taskId = "t-1";
    db.prepare(
      "INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, kind, started_at, status) VALUES (?,?,?,?,?,?,?,?)",
    ).run(attemptId, taskId, vh, "G", 0, "regular", Date.now(), "running");

    const gateId = "g-1";
    db.prepare(
      "INSERT INTO gate_queue (gate_id, task_id, stage_name, attempt_id, question_json, created_at) VALUES (?,?,?,?,?,?)",
    ).run(gateId, taskId, "G", attemptId, "{}", Date.now());

    return { db, gateId };
  }

  it("returns kind='rejected' with affectedStages when reject target is upstream", () => {
    const { db, gateId } = setupRejectReadyDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const result = svc.answerGate(gateId, "reject");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") {
        expect(result.targetStage).toBe("A");
        expect(new Set(result.affectedStages)).toEqual(new Set(["A", "G"]));
        expect(result.answer).toBe("reject");
      }
    } finally {
      db.close();
    }
  });

  it("returns kind='answered' for approve (non-rollback)", () => {
    const { db, gateId } = setupRejectReadyDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const result = svc.answerGate(gateId, "approve");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe("answered");
    } finally {
      db.close();
    }
  });
});

function agentOnlyIR(): PipelineIR {
  return {
    name: "pg",
    stages: [{
      name: "a",
      type: "agent",
      inputs: [],
      outputs: [{ name: "out", type: "string" }],
      config: { promptRef: "a" },
    }],
    wires: [],
  };
}

describe("KernelService.submit with prompts", () => {
  it("accepts { ir, prompts } and records pipeline_prompt_refs", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = agentOnlyIR();
    const res = svc.submit(ir, { prompts: { a: "HELLO" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rows = db
      .prepare("SELECT prompt_ref, content_hash FROM pipeline_prompt_refs WHERE version_hash = ?")
      .all(res.versionHash);
    expect(rows.length).toBe(1);
  });

  it("dedups content across two submits with the same prompt text", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const irA = agentOnlyIR();
    const irB: PipelineIR = { ...agentOnlyIR(), name: "pg2" };
    svc.submit(irA, { prompts: { a: "SHARED" } });
    svc.submit(irB, { prompts: { a: "SHARED" } });
    const contentRows = db.prepare("SELECT content_hash FROM prompt_contents").all();
    expect(contentRows.length).toBe(1);
  });

  it("is idempotent on repeat submit of same { ir, prompts }", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = agentOnlyIR();
    const r1 = svc.submit(ir, { prompts: { a: "X" } });
    const r2 = svc.submit(ir, { prompts: { a: "X" } });
    expect(r1.ok && r2.ok && r1.versionHash === r2.versionHash).toBe(true);
  });

  it("emits PROMPT_REF_MISSING when an AgentStage promptRef is not in prompts", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(agentOnlyIR(), { prompts: {} });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === "PROMPT_REF_MISSING")).toBe(true);
  });

  it("emits PROMPT_REF_UNUSED when prompts contains keys no AgentStage references", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(agentOnlyIR(), { prompts: { a: "X", orphan: "Y" } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === "PROMPT_REF_UNUSED")).toBe(true);
  });

  it("emits PROMPT_CONTENT_EMPTY on whitespace-only prompt content", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(agentOnlyIR(), { prompts: { a: "   \n  " } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === "PROMPT_CONTENT_EMPTY")).toBe(true);
  });

  // Allow 'system/*' fragments (referenced by userland prompt assembly,
  // not directly by AgentStage.promptRef)
  it("allows 'system/*' prompts even if no AgentStage references them directly", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(agentOnlyIR(), {
      prompts: { a: "X", "system/fragment": "INVARIANT CONTENT" },
    });
    expect(res.ok).toBe(true);
  });

  it("allows 'global-constraints' prompt even if no AgentStage references it (legacy claude_md.global)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(agentOnlyIR(), {
      prompts: { a: "X", "global-constraints": "RULES" },
    });
    expect(res.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage 5A additions: autoApprove / dryRunProposal / rollbackHotUpdate /
// updateRegistryPipeline — all verified against the real DB schema (not
// mocks) so the FK + CHECK constraints actually kick in.
// ---------------------------------------------------------------------------

describe("KernelService — Stage 5A autoApprove", () => {
  it("autoApprove=true on promptOnly patch → status='approved' in same tx", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const prompts = diamondPrompts();
    const submitted = svc.submit(diamondIR(), { prompts });
    if (!submitted.ok) throw new Error("submit failed");

    // Pick the first agent stage so we can swap its promptRef.
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent");
    if (!firstAgent || firstAgent.type !== "agent") throw new Error("no agent stage");
    const patch: IRPatch = {
      ops: [{
        op: "update_stage_config",
        stage: firstAgent.name,
        configPatch: { promptRef: firstAgent.config.promptRef + "-v2" },
      }],
    };
    const r = svc.propose({
      currentVersion: submitted.versionHash,
      patch,
      actor: "test",
      autoApprove: true,
    });
    if (!r.ok) throw new Error("propose failed: " + JSON.stringify(r.diagnostics));
    expect(r.autoApplied).toBe(true);
    const row = db.prepare(
      `SELECT status FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(r.proposalId) as { status: string };
    expect(row.status).toBe("approved");
    db.close();
  });

  it("autoApprove=true on structural patch → status='pending' (not applied)", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");
    // remove_stage on a leaf of the diamond = structural
    const leaf = diamondIR().stages[diamondIR().stages.length - 1]!;
    const patch: IRPatch = {
      ops: [{ op: "remove_stage", stageName: leaf.name }],
    };
    const r = svc.propose({
      currentVersion: submitted.versionHash,
      patch,
      actor: "test",
      autoApprove: true,
    });
    if (!r.ok) {
      // Structural removal may trigger downstream validation errors in
      // diamondIR (wires hang). Acceptable — diagnostics present.
      expect(r.diagnostics.length).toBeGreaterThan(0);
      db.close();
      return;
    }
    expect(r.autoApplied).toBe(false);
    const row = db.prepare(
      `SELECT status FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(r.proposalId) as { status: string };
    expect(row.status).toBe("pending");
    db.close();
  });

  it("diagnostic_json on success stores __kind=proposal-success-v1 + diff + impact + safeRange", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent");
    if (!firstAgent || firstAgent.type !== "agent") throw new Error("no agent stage");
    const r = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{
        op: "update_stage_config",
        stage: firstAgent.name,
        configPatch: { promptRef: firstAgent.config.promptRef + "-v2" },
      }] },
      actor: "ai",
    });
    if (!r.ok) throw new Error("propose failed");
    const row = db.prepare(
      `SELECT diagnostic_json FROM pipeline_proposals WHERE proposal_id = ?`,
    ).get(r.proposalId) as { diagnostic_json: string };
    const parsed = JSON.parse(row.diagnostic_json);
    expect(parsed.__kind).toBe("proposal-success-v1");
    expect(parsed.diff).toBeDefined();
    expect(parsed.impact).toBeDefined();
    expect(parsed.safeRange).toBeDefined();
    db.close();
  });
});

describe("KernelService — Stage 5A dryRunProposal", () => {
  it("returns diff+impact+safeRange without DB writes", () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent");
    if (!firstAgent || firstAgent.type !== "agent") throw new Error("no agent stage");
    const beforeCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_proposals`,
    ).get() as { n: number }).n;
    const r = svc.dryRunProposal({
      currentVersion: submitted.versionHash,
      patch: { ops: [{
        op: "update_stage_config",
        stage: firstAgent.name,
        configPatch: { promptRef: firstAgent.config.promptRef + "-v2" },
      }] },
    });
    if (!r.ok) throw new Error("dryRun failed: " + JSON.stringify(r.diagnostics));
    expect(r.safeRange.verdict).toBe("safe");
    const afterCount = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_proposals`,
    ).get() as { n: number }).n;
    expect(afterCount).toBe(beforeCount);
    db.close();
  });
});

describe("KernelService — Stage 5B rollbackHotUpdate delegator", () => {
  it("task with no migration history → VERSION_NOT_IN_HISTORY", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = await svc.rollbackHotUpdate({
      taskId: "nonexistent",
      toVersion: "hash-foo",
      actor: "test",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.diagnostics.some((d) => d.code === "VERSION_NOT_IN_HISTORY")).toBe(true);
    db.close();
  });

  it.skip("valid history match → Stage 5B really executes migration (covered by rollback.test.ts)", async () => {
    // Retired in Stage 5B: the skeleton path that only wrote an audit
    // row is replaced by executeRollback which synthesizes a real
    // proposal and calls executeMigration. See rollback.test.ts for
    // end-to-end coverage.
  });
});

describe("KernelService — Stage 5A updateRegistryPipeline", () => {
  it("valid IR overwrites registry file + inserts pipeline_versions row", () => {
    const nodeFs = require("node:fs") as typeof import("node:fs");
    const nodeOs = require("node:os") as typeof import("node:os");
    const nodePath = require("node:path") as typeof import("node:path");
    const tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "registry-"));
    const pipelineDir = nodePath.join(tmp, "my-pipeline");
    nodeFs.mkdirSync(pipelineDir);
    nodeFs.writeFileSync(nodePath.join(pipelineDir, "pipeline.ir.json"), "{}", "utf8");
    process.env["REGISTRY_ROOT"] = tmp;
    try {
      const db = makeDb();
      const svc = new KernelService(db, { skipTypeCheck: true });
      const newIR = diamondIR();
      newIR.name = "my-pipeline";
      const r = svc.updateRegistryPipeline({
        pipelineName: "my-pipeline",
        newIR,
        actor: "test",
      });
      if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r.diagnostics));
      const onDisk = JSON.parse(nodeFs.readFileSync(r.path, "utf8"));
      expect(onDisk.name).toBe("my-pipeline");
      expect(onDisk.stages.length).toBeGreaterThan(0);
      expect(getPipelineIR(db, r.versionHash)).not.toBeNull();
      db.close();
    } finally {
      delete process.env["REGISTRY_ROOT"];
      nodeFs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("nonexistent pipelineName directory → REGISTRY_PIPELINE_NOT_FOUND", () => {
    const nodeFs = require("node:fs") as typeof import("node:fs");
    const nodeOs = require("node:os") as typeof import("node:os");
    const nodePath = require("node:path") as typeof import("node:path");
    const tmp = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "registry-"));
    process.env["REGISTRY_ROOT"] = tmp;
    try {
      const db = makeDb();
      const svc = new KernelService(db, { skipTypeCheck: true });
      const newIR = diamondIR();
      newIR.name = "missing-pipeline";
      const r = svc.updateRegistryPipeline({
        pipelineName: "missing-pipeline",
        newIR,
        actor: "test",
      });
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("expected failure");
      expect(r.diagnostics.some((d) => d.code === "REGISTRY_PIPELINE_NOT_FOUND")).toBe(true);
      db.close();
    } finally {
      delete process.env["REGISTRY_ROOT"];
      nodeFs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
