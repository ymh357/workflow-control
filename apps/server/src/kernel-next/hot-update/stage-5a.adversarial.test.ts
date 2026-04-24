// Stage 5A adversarial — verifies dry-run has no side effects and
// autoApprove/propose behave correctly on edge patches. Uses the real
// KernelService + real SQLite schema so FK/CHECK constraints actually
// fire; no mocks.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import type { IRPatch } from "../ir/schema.js";

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

describe("Stage 5A adversarial — dry-run idempotence", () => {
  let db: DatabaseSync;
  let svc: KernelService;
  let baseVersion: string;

  beforeEach(async () => {
    db = makeDb();
    svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = await svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");
    baseVersion = submitted.versionHash;
  });

  it("100 dry-runs produce zero DB writes", async () => {
    const beforeProposals = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_proposals`,
    ).get() as { n: number }).n;
    const beforeVersions = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_versions`,
    ).get() as { n: number }).n;
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent");
    if (!firstAgent || firstAgent.type !== "agent") throw new Error("no agent stage");
    for (let i = 0; i < 100; i++) {
      const r = svc.dryRunProposal({
        currentVersion: baseVersion,
        patch: {
          ops: [{
            op: "update_stage_config",
            stage: firstAgent.name,
            configPatch: { promptRef: firstAgent.config.promptRef + "-v" + i },
          }],
        },
      });
      expect(r.ok).toBe(true);
    }
    const afterProposals = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_proposals`,
    ).get() as { n: number }).n;
    const afterVersions = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_versions`,
    ).get() as { n: number }).n;
    expect(afterProposals).toBe(beforeProposals);
    expect(afterVersions).toBe(beforeVersions);
  });

  it("dry-run on mismatched currentVersion returns CONFLICT without diff", async () => {
    const r = svc.dryRunProposal({
      currentVersion: "wrong-hash-doesnt-exist",
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: "stageA",
          configPatch: { promptRef: "anything" },
        }],
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.diagnostics.some((d) => d.code === "CONFLICT")).toBe(true);
  });

  it("two autoApprove proposals on same baseVersion — both succeed (no DB uniqueness constraint)", async () => {
    // Documents current behaviour: kernel-next has no UNIQUE constraint on
    // pipeline_proposals.base_version, so two concurrent autoApprove calls
    // against the same base both succeed. Stage 5B migration will enforce
    // serial-per-task locks; 5A surface is still safe because pre-migration
    // consumers only read from the approved row they created.
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent");
    if (!firstAgent || firstAgent.type !== "agent") throw new Error("no agent stage");
    const p1 = svc.propose({
      currentVersion: baseVersion,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: firstAgent.name,
          configPatch: { promptRef: firstAgent.config.promptRef + "-ai1" },
        }],
      },
      actor: "ai-1",
      autoApprove: true,
    });
    const p2 = svc.propose({
      currentVersion: baseVersion,
      patch: {
        ops: [{
          op: "update_stage_config",
          stage: firstAgent.name,
          configPatch: { promptRef: firstAgent.config.promptRef + "-ai2" },
        }],
      },
      actor: "ai-2",
      autoApprove: true,
    });
    expect(p1.ok && p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) return;
    expect(p1.proposalId).not.toBe(p2.proposalId);
    expect(p1.autoApplied).toBe(true);
    expect(p2.autoApplied).toBe(true);
    const rows = db.prepare(
      `SELECT status FROM pipeline_proposals WHERE base_version = ?`,
    ).all(baseVersion) as Array<{ status: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "approved")).toBe(true);
  });

  it("autoApprove on invalid patch (duplicate stage) → PATCH_APPLY_ERROR, no pending row created", async () => {
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent");
    if (!firstAgent || firstAgent.type !== "agent") throw new Error("no agent stage");
    const beforeCount = (db.prepare(`SELECT COUNT(*) AS n FROM pipeline_proposals`).get() as { n: number }).n;
    const r = svc.propose({
      currentVersion: baseVersion,
      patch: {
        ops: [{
          op: "add_stage",
          stage: {
            name: firstAgent.name,       // duplicate with existing stage
            type: "agent",
            config: { promptRef: "whatever" },
            inputs: [], outputs: [],
          },
        }],
      },
      actor: "ai",
      autoApprove: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.diagnostics.some((d) => d.code === "PATCH_APPLY_ERROR")).toBe(true);
    const afterCount = (db.prepare(`SELECT COUNT(*) AS n FROM pipeline_proposals`).get() as { n: number }).n;
    expect(afterCount).toBe(beforeCount);
  });

  it("dry-run on same patch returns byte-stable proposedVersion (hash deterministic)", async () => {
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent");
    if (!firstAgent || firstAgent.type !== "agent") throw new Error("no agent stage");
    const patch: IRPatch = {
      ops: [{
        op: "update_stage_config",
        stage: firstAgent.name,
        configPatch: { promptRef: firstAgent.config.promptRef + "-deterministic" },
      }],
    };
    const r1 = svc.dryRunProposal({ currentVersion: baseVersion, patch });
    const r2 = svc.dryRunProposal({ currentVersion: baseVersion, patch });
    if (!r1.ok || !r2.ok) throw new Error("unexpected failure");
    expect(r1.proposedVersion).toBe(r2.proposedVersion);
    expect(r1.diff).toEqual(r2.diff);
    expect(r1.safeRange).toEqual(r2.safeRange);
  });
});
