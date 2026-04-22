// dry-run.test.ts — Task 6 of Stage 5A hot-update plan.
// Verifies that dryRunProposal() is a read-only orchestrator combining
// diff + impact + safeRange, never writes to the DB, and surfaces
// diagnostics for CONFLICT / PATCH_APPLY_ERROR branches.

import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { dryRunProposal } from "./dry-run.js";
import type { PipelineIR, IRPatch } from "../ir/schema.js";
import { pipelineVersionHash } from "../ir/canonical.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

const baseIR: PipelineIR = {
  name: "p",
  stages: [
    {
      name: "a",
      type: "agent",
      config: { promptRef: "p-a" },
      inputs: [],
      outputs: [{ name: "out", type: "string" }],
    },
  ],
  wires: [],
};

function seedBase(db: DatabaseSync): string {
  // pipelineVersionHash takes { ir, prompts: Record<ref, content> }.
  const hash = pipelineVersionHash({
    ir: baseIR,
    prompts: { "p-a": "prompt body" },
  });
  insertPipelineVersion(db, baseIR, {
    versionHash: hash,
    tsSource: "// ts",
  });
  db.prepare(
    `INSERT INTO prompt_contents (content_hash, content, created_at) VALUES (?, ?, ?)`,
  ).run("abc", "prompt body", Date.now());
  db.prepare(
    `INSERT INTO pipeline_prompt_refs (version_hash, prompt_ref, content_hash) VALUES (?, ?, ?)`,
  ).run(hash, "p-a", "abc");
  return hash;
}

describe("dryRunProposal", () => {
  let db: DatabaseSync;
  beforeEach(() => { db = makeDb(); });

  it("promptOnly change -> ok + verdict=safe + wouldAutoApprove=true", () => {
    const base = seedBase(db);
    const patch: IRPatch = {
      ops: [{
        op: "update_stage_config",
        stage: "a",
        configPatch: { promptRef: "p-a-v2" },
      }],
    };
    const r = dryRunProposal(db, { currentVersion: base, patch });
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r.diagnostics));
    expect(r.safeRange.verdict).toBe("safe");
    expect(r.safeRange.category).toBe("promptOnly");
    expect(r.wouldAutoApprove).toBe(true);
    expect(r.diff.stages.modified).toHaveLength(1);
  });

  it("structural change (add stage) -> verdict=unsafe + wouldAutoApprove=false", () => {
    const base = seedBase(db);
    const patch: IRPatch = {
      ops: [{
        op: "add_stage",
        stage: {
          name: "b",
          type: "agent",
          config: { promptRef: "p-b" },
          inputs: [],
          outputs: [],
        },
      }],
    };
    const r = dryRunProposal(db, { currentVersion: base, patch });
    if (!r.ok) throw new Error("expected ok: " + JSON.stringify(r.diagnostics));
    expect(r.safeRange.verdict).toBe("unsafe");
    expect(r.wouldAutoApprove).toBe(false);
  });

  it("currentVersion mismatch -> CONFLICT diagnostic, no diff", () => {
    seedBase(db);
    const patch: IRPatch = { ops: [{ op: "remove_stage", stageName: "a" }] };
    const r = dryRunProposal(db, {
      currentVersion: "nonexistent-hash",
      patch,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected ok: false");
    expect(r.diagnostics.some((d) => d.code === "CONFLICT")).toBe(true);
  });

  it("invalid patch (add_stage duplicate) -> PATCH_APPLY_ERROR diagnostic", () => {
    const base = seedBase(db);
    const patch: IRPatch = {
      ops: [{
        op: "add_stage",
        stage: {
          name: "a",
          type: "agent",
          config: { promptRef: "p-a" },
          inputs: [],
          outputs: [],
        },
      }],
    };
    const r = dryRunProposal(db, { currentVersion: base, patch });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected ok: false");
    expect(r.diagnostics.some((d) => d.code === "PATCH_APPLY_ERROR")).toBe(true);
  });

  it("dry-run writes nothing - pipeline_proposals + pipeline_versions unchanged", () => {
    const base = seedBase(db);
    const beforeProposals = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_proposals`,
    ).get() as { n: number }).n;
    const beforeVersions = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_versions`,
    ).get() as { n: number }).n;
    const patch: IRPatch = {
      ops: [{
        op: "update_stage_config",
        stage: "a",
        configPatch: { promptRef: "p-a-v2" },
      }],
    };
    dryRunProposal(db, { currentVersion: base, patch });
    dryRunProposal(db, { currentVersion: base, patch });
    dryRunProposal(db, { currentVersion: base, patch });
    const afterProposals = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_proposals`,
    ).get() as { n: number }).n;
    const afterVersions = (db.prepare(
      `SELECT COUNT(*) AS n FROM pipeline_versions`,
    ).get() as { n: number }).n;
    expect(afterProposals).toBe(beforeProposals);
    expect(afterVersions).toBe(beforeVersions);
  });
});
