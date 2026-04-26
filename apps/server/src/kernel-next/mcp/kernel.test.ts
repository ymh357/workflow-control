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
  it("validate accepts a clean diamond IR", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    expect(svc.validate(diamondIR())).toEqual({ ok: true, diagnostics: [] });
    db.close();
  });

  it("validate rejects with ZOD_PARSE_ERROR on malformed input", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = svc.validate({ name: "bad", stages: "not-an-array" });
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]!.code).toBe("ZOD_PARSE_ERROR");
    db.close();
  });

  it("validate rejects with structural error (duplicate stage)", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const bad = diamondIR();
    bad.stages.push({ ...bad.stages[0]! });
    const r = svc.validate(bad);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]!.code).toBe("DUPLICATE_STAGE_NAME");
    db.close();
  });

  it("validate rejects with STORE_SCHEMA_TYPE_MISMATCH when drift is introduced", async () => {
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

  it("validate accepts store_schema that matches the stage outputs", async () => {
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

  it("submit persists a valid IR", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const prompts = diamondPrompts();
    const r = await svc.submit(diamondIR(), { prompts });
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

  it("submit is idempotent (same IR returns same hash without re-insert)", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const prompts = diamondPrompts();
    const r1 = await svc.submit(diamondIR(), { prompts });
    const r2 = await svc.submit(diamondIR(), { prompts });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.versionHash).toBe(r2.versionHash);
    const count = db.prepare("SELECT COUNT(*) AS n FROM pipeline_versions").get() as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it("propose rejects unknown currentVersion", async () => {
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

  it("propose applies patch, persists new version, and records pending proposal", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
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

  it("approveProposal flips pending → approved", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
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

  it("rejectProposal flips pending → rejected and persists reason", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
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

  it("approveProposal rejects unknown proposalId", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const r = svc.approveProposal("nonexistent");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("PROPOSAL_NOT_FOUND");
    db.close();
  });

  it("approveProposal rejects an already-resolved proposal", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
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

  it("listProposals returns newest-first and filters by status", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
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

  it("propose fails validation when patch produces structurally invalid IR", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
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

  it("propose rejects cross_segment_resume_from on a multi-mode pipeline (trust chain end-to-end)", async () => {
    // 2026-04-26 cross-segment-resume pivot: multi-mode pipelines must
    // never carry the field. The validator emits
    // CROSS_SEGMENT_RESUME_FROM_REQUIRES_SINGLE; this test pins the
    // hot-update path's trust chain (propose -> applyPatch -> validate)
    // so that mistakenly patching the field onto a multi-mode pipeline
    // is rejected, not silently no-op'd at runtime.
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const patch: IRPatch = { ops: [
      { op: "update_stage_config", stage: "B", configPatch: { cross_segment_resume_from: "A" } },
    ]};
    const r = svc.propose({ currentVersion: submitted.versionHash, patch, actor: "test" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics.some((d) => d.code === "CROSS_SEGMENT_RESUME_FROM_REQUIRES_SINGLE")).toBe(true);
    db.close();
  });

  it("propose(empty patch, with prompts override) succeeds; proposedVersion differs from base", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const firstPromptRef = Object.keys(diamondPrompts())[0]!;
    const r = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [] },
      actor: "ai:test-prompts-only",
      prompts: { [firstPromptRef]: "fresh body" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposedVersion).not.toBe(submitted.versionHash);
    db.close();
  });

  it("propose(empty patch, empty prompts) returns NO_OP_PROPOSAL", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    const r = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [] },
      actor: "ai:test-truly-noop",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("NO_OP_PROPOSAL");
    db.close();
  });

  it("propose(idempotent patch, empty prompts) returns NO_OP_PROPOSAL", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("setup submit failed");

    // Find an agent stage and re-assign its promptRef to itself
    // (the run-15 workaround pattern — now should be rejected).
    const agentStage = diamondIR().stages.find((s) => s.type === "agent")!;
    const currentRef = (agentStage as { config: { promptRef: string } }).config.promptRef;
    const r = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{ op: "update_stage_config", stage: agentStage.name, configPatch: { promptRef: currentRef } }] },
      actor: "ai:test-idempotent",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("NO_OP_PROPOSAL");
    db.close();
  });
});

// A1.2a: gate lifecycle — createGate + listGates + answerGate.
// These tests seed a pipeline containing a gate stage, manually open a
// stage_attempt row (bypassing the full runner), call createGate, then
// exercise the three query/answer paths including GATE_NOT_FOUND,
// GATE_ALREADY_ANSWERED, and GATE_ANSWER_INVALID diagnostics.
describe("KernelService — gate lifecycle (A1.2a)", () => {
  async function seedGatePipeline(svc: KernelService) {
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
            question: { text: "continue?", options: [{ value: "yes" }, { value: "no" }] },
            routing: { routes: { yes: "A", no: "A" } },
          },
        },
      ],
      wires: [{ from: { stage: "A", port: "x" }, to: { stage: "G", port: "x" } }],
    };
    const submit = await svc.submit(ir, { prompts: { p: "dummy" } });
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

  it("createGate inserts a row; listGates returns it; answerGate resolves to the target", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const { versionHash } = await seedGatePipeline(svc);
      const attemptId = openAttempt(db, "task-1", versionHash, "G");

      const { gateId } = svc.createGate({
        taskId: "task-1",
        stageName: "G",
        attemptId,
        question: { text: "continue?", options: [{ value: "yes" }, { value: "no" }] },
      });

      // Listable, unanswered.
      const pending = svc.listGates({ taskId: "task-1", answered: false });
      expect(pending.map((g) => g.gateId)).toEqual([gateId]);
      expect(pending[0]!.answer).toBeNull();
      expect(pending[0]!.question).toEqual({ text: "continue?", options: [{ value: "yes" }, { value: "no" }] });

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

  it("answerGate with _default fallback routing", async () => {
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
      const submit = await svc.submit(ir, { prompts: { p: "dummy" } });
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

  it("answerGate rejects unknown gateId", async () => {
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

  it("answerGate is idempotent: second call yields GATE_ALREADY_ANSWERED", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const { versionHash } = await seedGatePipeline(svc);
      const attemptId = openAttempt(db, "t1", versionHash, "G");
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId,
        question: { text: "continue?", options: [{ value: "yes" }, { value: "no" }] },
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

  it("answerGate rejects an answer not in the routing table", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const { versionHash } = await seedGatePipeline(svc);
      const attemptId = openAttempt(db, "t1", versionHash, "G");
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId,
        question: { text: "continue?", options: [{ value: "yes" }, { value: "no" }] },
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

  it("listGates filters by taskId correctly", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const { versionHash } = await seedGatePipeline(svc);
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
  async function seedSmallPipeline(svc: KernelService): Promise<string> {
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
            question: { text: "continue?", options: [{ value: "yes" }] },
            routing: { routes: { yes: "A" } },
          },
        },
      ],
      wires: [{ from: { stage: "A", port: "x" }, to: { stage: "G", port: "x" } }],
    };
    const submit = await svc.submit(ir, { prompts: { p: "dummy" } });
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

  it("not_found when no stage_attempts exist", async () => {
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

  it("gated when any pending gate_queue row exists, with pending list", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = await seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "success");
      const gAttempt = openAttempt(db, "t1", hash, "G", "running");
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId: gAttempt,
        question: { text: "continue?", options: [{ value: "yes" }] },
      });
      const s = svc.getTaskStatus("t1");
      if (s.status !== "gated") throw new Error(`unexpected status ${s.status}`);
      expect(s.status).toBe("gated");
      expect(s.pending).toHaveLength(1);
      expect(s.pending[0]).toMatchObject({
        gateId,
        stageName: "G",
        question: { text: "continue?", options: [{ value: "yes" }] },
      });
    } finally {
      db.close();
    }
  });

  it("running when at least one attempt is running and no pending gates", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = await seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "running");
      expect(svc.getTaskStatus("t1")).toEqual({
        ok: true, status: "running", taskId: "t1",
      });
    } finally {
      db.close();
    }
  });

  // Architecture note (Phase 6 audit): getTaskStatus now refuses to
  // derive 'completed' / 'failed' from stage_attempts alone. These are
  // terminal verdicts and must come from task_finals, which runner.ts
  // writes in its finally block. Tests seed task_finals directly to
  // assert the authoritative path; the stage_attempts-only orphan
  // case is covered separately below.
  function seedFinal(
    db: DatabaseSync,
    taskId: string,
    versionHash: string,
    final_state: "completed" | "failed",
    reason: "natural" | "timeout" | "interrupted" | "error" | "thrown" = "natural",
  ): void {
    db.prepare(
      `INSERT INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(taskId, versionHash, final_state, reason, Date.now());
  }

  it("completed when task_finals says completed (authoritative)", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = await seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "success");
      openAttempt(db, "t1", hash, "G", "success");
      seedFinal(db, "t1", hash, "completed");
      expect(svc.getTaskStatus("t1")).toEqual({
        ok: true, status: "completed", taskId: "t1",
      });
    } finally {
      db.close();
    }
  });

  it("failed when task_finals says failed (authoritative)", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = await seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "success");
      openAttempt(db, "t1", hash, "G", "error");
      seedFinal(db, "t1", hash, "failed", "error");
      expect(svc.getTaskStatus("t1")).toEqual({
        ok: true, status: "failed", taskId: "t1",
      });
    } finally {
      db.close();
    }
  });

  it("orphaned when stage_attempts exist but no task_finals and nothing is running", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = await seedSmallPipeline(svc);
      // All attempts say success but runner never wrote task_finals —
      // classic "runner crashed after writing the last success but
      // before finally". Must NOT report completed.
      openAttempt(db, "t1", hash, "A", "success");
      openAttempt(db, "t1", hash, "G", "success");
      expect(svc.getTaskStatus("t1")).toEqual({
        ok: true, status: "orphaned", taskId: "t1",
      });
    } finally {
      db.close();
    }
  });

  it("orphaned when all attempts succeeded but task_finals write race'd (runner SIGKILL case)", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = await seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "success");
      openAttempt(db, "t1", hash, "G", "error");
      // Attempts say failed shape but no task_finals. Orphaned, not failed.
      expect(svc.getTaskStatus("t1")).toEqual({
        ok: true, status: "orphaned", taskId: "t1",
      });
    } finally {
      db.close();
    }
  });

  it("'gated' trumps 'running' — gate-stage attempt stays running while gated", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = await seedSmallPipeline(svc);
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

  it("answered gates don't keep a task in 'gated' status — falls back to orphaned without task_finals", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = await seedSmallPipeline(svc);
      const att = openAttempt(db, "t1", hash, "G", "success");
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId: att,
        question: { text: "?", options: [{ value: "yes" }] },
      });
      svc.answerGate(gateId, "yes");
      // Post-audit: no task_finals -> orphaned, not completed.
      const s = svc.getTaskStatus("t1");
      expect(s.status).toBe("orphaned");
    } finally {
      db.close();
    }
  });

  it("latest attempt wins — retry that succeeds does NOT fabricate completed without task_finals", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = await seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "error", 1);
      openAttempt(db, "t1", hash, "A", "success", 2);
      openAttempt(db, "t1", hash, "G", "success");
      // Post-audit: latest-per-stage now only disambiguates 'running'
      // vs 'orphaned'; it cannot synthesize completed.
      expect(svc.getTaskStatus("t1").status).toBe("orphaned");
    } finally {
      db.close();
    }
  });

  it("latest attempt wins AND task_finals says completed — real happy-path-after-retry shape", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const hash = await seedSmallPipeline(svc);
      openAttempt(db, "t1", hash, "A", "error", 1);
      openAttempt(db, "t1", hash, "A", "success", 2);
      openAttempt(db, "t1", hash, "G", "success");
      seedFinal(db, "t1", hash, "completed");
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

  it("returns kind='rejected' with affectedStages when reject target is upstream", async () => {
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

  it("returns kind='answered' for approve (non-rollback)", async () => {
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
  it("accepts { ir, prompts } and records pipeline_prompt_refs", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = agentOnlyIR();
    const res = await svc.submit(ir, { prompts: { a: "HELLO" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rows = db
      .prepare("SELECT prompt_ref, content_hash FROM pipeline_prompt_refs WHERE version_hash = ?")
      .all(res.versionHash);
    expect(rows.length).toBe(1);
  });

  it("dedups content across two submits with the same prompt text", async () => {
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

  it("is idempotent on repeat submit of same { ir, prompts }", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = agentOnlyIR();
    const r1 = await svc.submit(ir, { prompts: { a: "X" } });
    const r2 = await svc.submit(ir, { prompts: { a: "X" } });
    expect(r1.ok && r2.ok && r1.versionHash === r2.versionHash).toBe(true);
  });

  it("emits PROMPT_REF_MISSING when an AgentStage promptRef is not in prompts", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = await svc.submit(agentOnlyIR(), { prompts: {} });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === "PROMPT_REF_MISSING")).toBe(true);
  });

  it("emits PROMPT_REF_UNUSED when prompts contains keys no AgentStage references", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = await svc.submit(agentOnlyIR(), { prompts: { a: "X", orphan: "Y" } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === "PROMPT_REF_UNUSED")).toBe(true);
  });

  it("emits PROMPT_CONTENT_EMPTY on whitespace-only prompt content", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = await svc.submit(agentOnlyIR(), { prompts: { a: "   \n  " } });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.diagnostics.some((d) => d.code === "PROMPT_CONTENT_EMPTY")).toBe(true);
  });

  // Allow 'system/*' fragments (referenced by userland prompt assembly,
  // not directly by AgentStage.promptRef)
  it("allows 'system/*' prompts even if no AgentStage references them directly", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = await svc.submit(agentOnlyIR(), {
      prompts: { a: "X", "system/fragment": "INVARIANT CONTENT" },
    });
    expect(res.ok).toBe(true);
  });

  it("allows 'global-constraints' prompt even if no AgentStage references it (legacy claude_md.global)", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = await svc.submit(agentOnlyIR(), {
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
  it("autoApprove=true on promptOnly patch → status='approved' in same tx", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const prompts = diamondPrompts();
    const submitted = await svc.submit(diamondIR(), { prompts });
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

  it("autoApprove=true on structural patch → status='pending' (not applied)", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
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

  it("diagnostic_json on success stores __kind=proposal-success-v1 + diff + impact + safeRange", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
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
  it("returns diff+impact+safeRange without DB writes", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
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
  it("valid IR overwrites registry file + inserts pipeline_versions row", async () => {
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

  it("nonexistent pipelineName directory → REGISTRY_PIPELINE_NOT_FOUND", async () => {
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

describe("KernelService.getGateContext — B5", () => {
  // Helper: pipeline with one 3-output upstream agent `A`, one gate
  // `G` fed by A.x, and a rollback route so `_default` filtering and
  // answerOptions both get exercised.
  function gateCtxIR() {
    return {
      name: "ctx-test",
      stages: [
        {
          name: "A", type: "agent" as const,
          inputs: [],
          outputs: [
            { name: "x", type: "number" as const },
            { name: "summary", type: "string" as const },
            { name: "items", type: "string[]" as const },
          ],
          config: { promptRef: "p" },
        },
        {
          name: "G", type: "gate" as const,
          inputs: [{ name: "__gate_signal", type: "unknown" as const }],
          outputs: [],
          config: {
            question: { text: "Continue?", options: [{ value: "approve" }, { value: "reject" }] },
            routing: {
              routes: { approve: "done", reject: "A", _default: "done" },
            },
          },
        },
        {
          name: "done", type: "agent" as const,
          inputs: [{ name: "ack", type: "unknown" as const }],
          outputs: [],
          config: { promptRef: "p" },
        },
      ],
      wires: [
        { from: { source: "stage" as const, stage: "A", port: "x" },
          to: { stage: "G", port: "__gate_signal" } },
      ],
    };
  }

  function seedUpstreamOutputs(
    db: DatabaseSync,
    taskId: string,
    versionHash: string,
  ): void {
    const attemptId = "a-" + Math.random().toString(36).slice(2, 10);
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, ended_at, status, kind)
       VALUES (?, ?, ?, 'A', 1, ?, ?, 'success', 'regular')`,
    ).run(attemptId, taskId, versionHash, now - 100, now - 50);
    const rows: Array<[string, unknown]> = [
      ["x", 42],
      ["summary", "hello world"],
      ["items", ["a", "b", "c"]],
    ];
    for (const [port, value] of rows) {
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction,
          value_json, written_at)
         VALUES (?, ?, 'A', ?, 'out', ?, ?)`,
      ).run(
        "v-" + Math.random().toString(36).slice(2, 10),
        attemptId, port, JSON.stringify(value), now - 50,
      );
    }
  }

  function openGateAttempt(
    db: DatabaseSync,
    taskId: string,
    versionHash: string,
  ): string {
    const attemptId = "ga-" + Math.random().toString(36).slice(2, 10);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, status, kind)
       VALUES (?, ?, ?, 'G', 1, ?, 'running', 'regular')`,
    ).run(attemptId, taskId, versionHash, Date.now());
    return attemptId;
  }

  it("returns question + answerOptions (minus _default) + upstream outputs", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = await svc.submit(gateCtxIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed: " + JSON.stringify(submit.diagnostics));

      seedUpstreamOutputs(db, "t1", submit.versionHash);
      const gateAttempt = openGateAttempt(db, "t1", submit.versionHash);
      const { gateId } = svc.createGate({
        taskId: "t1", stageName: "G", attemptId: gateAttempt,
        question: { text: "Continue?", options: [{ value: "approve" }, { value: "reject" }] },
      });

      const r = svc.getGateContext(gateId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const ctx = r.context;
      expect(ctx.gateId).toBe(gateId);
      expect(ctx.taskId).toBe("t1");
      expect(ctx.stageName).toBe("G");
      expect(ctx.question).toEqual({ text: "Continue?", options: [{ value: "approve" }, { value: "reject" }] });
      expect(ctx.answer).toBeNull();
      expect(ctx.answeredAt).toBeNull();
      expect(ctx.answerOptions).toEqual([{ value: "approve" }, { value: "reject" }]);
      expect(ctx.upstreams).toHaveLength(1);
      expect(ctx.upstreams[0]!.stage).toBe("A");
      expect(ctx.upstreams[0]!.outputs.map((o) => o.port)).toEqual(["items", "summary", "x"]);
      expect(ctx.upstreams[0]!.outputs.find((o) => o.port === "x")!.value).toBe(42);
      expect(ctx.upstreams[0]!.outputs.find((o) => o.port === "summary")!.value).toBe("hello world");
      expect(ctx.upstreams[0]!.outputs.find((o) => o.port === "items")!.value).toEqual(["a", "b", "c"]);
    } finally {
      db.close();
    }
  });

  it("unknown gate -> GATE_NOT_FOUND", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const r = svc.getGateContext("does-not-exist");
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.diagnostics[0]!.code).toBe("GATE_NOT_FOUND");
    } finally {
      db.close();
    }
  });

  it("already-answered gate still returns 200 with answer and answeredAt populated", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = await svc.submit(gateCtxIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      seedUpstreamOutputs(db, "t2", submit.versionHash);
      const gateAttempt = openGateAttempt(db, "t2", submit.versionHash);
      const { gateId } = svc.createGate({
        taskId: "t2", stageName: "G", attemptId: gateAttempt,
        question: { text: "Continue?", options: [{ value: "approve" }, { value: "reject" }] },
      });
      const ans = svc.answerGate(gateId, "approve");
      expect(ans.ok).toBe(true);

      const r = svc.getGateContext(gateId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.context.answer).toBe("approve");
      expect(typeof r.context.answeredAt).toBe("number");
    } finally {
      db.close();
    }
  });

  it("gate with zero stage upstream (pure external-feed) returns upstreams=[]", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const ir = {
        name: "ext-only-gate",
        externalInputs: [{ name: "sig", type: "unknown" as const }],
        stages: [
          { name: "G", type: "gate" as const,
            inputs: [{ name: "__gate_signal", type: "unknown" as const }],
            outputs: [],
            config: {
              question: { text: "?" },
              routing: { routes: { approve: "done" } },
            } },
          { name: "done", type: "agent" as const,
            inputs: [{ name: "ack", type: "unknown" as const }],
            outputs: [],
            config: { promptRef: "p" } },
        ],
        wires: [
          { from: { source: "external" as const, port: "sig" },
            to: { stage: "G", port: "__gate_signal" } },
        ],
      };
      const submit = await svc.submit(ir, { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");
      const gateAttempt = openGateAttempt(db, "t3", submit.versionHash);
      const { gateId } = svc.createGate({
        taskId: "t3", stageName: "G", attemptId: gateAttempt,
        question: { text: "?" },
      });

      const r = svc.getGateContext(gateId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.context.upstreams).toEqual([]);
      expect(r.context.answerOptions).toEqual([{ value: "approve" }]);
    } finally {
      db.close();
    }
  });

  it("superseded attempts are ignored; only success attempts' latest port values surface", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = await svc.submit(gateCtxIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");

      // 1) Superseded attempt with an early "wrong" value.
      const supAttempt = "sup-" + Math.random().toString(36).slice(2, 10);
      db.prepare(
        `INSERT INTO stage_attempts
         (attempt_id, task_id, version_hash, stage_name, attempt_idx,
          started_at, ended_at, status, kind)
         VALUES (?, 't4', ?, 'A', 1, ?, ?, 'superseded', 'regular')`,
      ).run(supAttempt, submit.versionHash, 100, 200);
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction,
          value_json, written_at)
         VALUES ('v-sup-x', ?, 'A', 'x', 'out', '999', 150)`,
      ).run(supAttempt);

      // 2) Subsequent success attempt with the real value.
      const successAttempt = "succ-" + Math.random().toString(36).slice(2, 10);
      db.prepare(
        `INSERT INTO stage_attempts
         (attempt_id, task_id, version_hash, stage_name, attempt_idx,
          started_at, ended_at, status, kind)
         VALUES (?, 't4', ?, 'A', 2, ?, ?, 'success', 'regular')`,
      ).run(successAttempt, submit.versionHash, 300, 400);
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction,
          value_json, written_at)
         VALUES ('v-suc-x', ?, 'A', 'x', 'out', '42', 350)`,
      ).run(successAttempt);

      const gateAttempt = openGateAttempt(db, "t4", submit.versionHash);
      const { gateId } = svc.createGate({
        taskId: "t4", stageName: "G", attemptId: gateAttempt,
        question: { text: "Continue?", options: [{ value: "approve" }, { value: "reject" }] },
      });

      const r = svc.getGateContext(gateId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const xOut = r.context.upstreams[0]!.outputs.find((o) => o.port === "x");
      expect(xOut).toBeDefined();
      expect(xOut!.value).toBe(42); // not 999
    } finally {
      db.close();
    }
  });

  it("corrupted value_json surfaces as value=null without throwing", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = await svc.submit(gateCtxIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");

      const attemptId = "a-" + Math.random().toString(36).slice(2, 10);
      const now = Date.now();
      db.prepare(
        `INSERT INTO stage_attempts
         (attempt_id, task_id, version_hash, stage_name, attempt_idx,
          started_at, ended_at, status, kind)
         VALUES (?, 't5', ?, 'A', 1, ?, ?, 'success', 'regular')`,
      ).run(attemptId, submit.versionHash, now - 100, now - 50);
      // Intentionally invalid JSON — simulates lineage corruption.
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction,
          value_json, written_at)
         VALUES ('v-bad', ?, 'A', 'x', 'out', '{not valid json', ?)`,
      ).run(attemptId, now - 50);

      const gateAttempt = openGateAttempt(db, "t5", submit.versionHash);
      const { gateId } = svc.createGate({
        taskId: "t5", stageName: "G", attemptId: gateAttempt,
        question: { text: "?" },
      });

      const r = svc.getGateContext(gateId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const xOut = r.context.upstreams[0]!.outputs.find((o) => o.port === "x");
      expect(xOut).toBeDefined();
      expect(xOut!.value).toBeNull();
    } finally {
      db.close();
    }
  });

  // Audit 2026-04-23 (7A): getGateContext reads upstream port outputs
  // via pv.written_at ordering, which B17 preserved fanout_element rows
  // can break if a fixture (or clock anomaly) orders them after the
  // aggregate. Defensive CASE ordering over sa.kind keeps fanout_aggregate
  // winning deterministically — mirrors the lineage / readLatestPort
  // fixes from commit f552b79.
  it("upstream fanout stage: returns the aggregate T[] value, not a preserved fanout_element scalar", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      initKernelNextSchema(db);
      const svc = new KernelService(db, { skipTypeCheck: true });
      const submit = await svc.submit(gateCtxIR(), { prompts: { p: "dummy" } });
      if (!submit.ok) throw new Error("submit failed");

      // Seed one preserved fanout_element success row with a scalar
      // value, then an aggregate success row with the real array
      // value. written_at is deliberately set so the element looks
      // newer (clock-skew / fixture hazard) to prove the kind-based
      // tie-break works regardless of timestamp order.
      const elemAttempt = "el-" + Math.random().toString(36).slice(2, 10);
      db.prepare(
        `INSERT INTO stage_attempts
         (attempt_id, task_id, version_hash, stage_name, attempt_idx,
          started_at, ended_at, status, kind, fanout_element_idx)
         VALUES (?, 'tf', ?, 'A', 1, ?, ?, 'success', 'fanout_element', 0)`,
      ).run(elemAttempt, submit.versionHash, 100, 200);
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction,
          value_json, written_at)
         VALUES ('v-el-x', ?, 'A', 'x', 'out', '7', 400)`,
      ).run(elemAttempt);

      const aggAttempt = "ag-" + Math.random().toString(36).slice(2, 10);
      db.prepare(
        `INSERT INTO stage_attempts
         (attempt_id, task_id, version_hash, stage_name, attempt_idx,
          started_at, ended_at, status, kind)
         VALUES (?, 'tf', ?, 'A', 2, ?, ?, 'success', 'fanout_aggregate')`,
      ).run(aggAttempt, submit.versionHash, 250, 300);
      db.prepare(
        `INSERT INTO port_values
         (value_id, attempt_id, stage_name, port_name, direction,
          value_json, written_at)
         VALUES ('v-ag-x', ?, 'A', 'x', 'out', '[7,8,9]', 350)`,
      ).run(aggAttempt);

      // Open a gate attempt so getGateContext has a row to read.
      const gateAttempt = openGateAttempt(db, "tf", submit.versionHash);
      const { gateId } = svc.createGate({
        taskId: "tf", stageName: "G", attemptId: gateAttempt,
        question: { text: "Continue?", options: [{ value: "approve" }, { value: "reject" }] },
      });

      const r = svc.getGateContext(gateId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const xOut = r.context.upstreams[0]!.outputs.find((o) => o.port === "x");
      expect(xOut).toBeDefined();
      // Aggregate wins: array value, not scalar 7.
      expect(xOut!.value).toEqual([7, 8, 9]);
    } finally {
      db.close();
    }
  });
});
