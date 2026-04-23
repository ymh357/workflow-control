// P6-11 audit: propose() must carry + merge prompts so the proposed
// version's pipeline_prompt_refs is populated. Pre-audit propose()
// wrote only pipeline_versions + stages + ports + wires, so
// DbPromptResolver on the new version raised "promptRef not found"
// the first time a migration or rerun hit the new hash. That made
// prompt iteration through propose() structurally impossible.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, getPromptsByVersion } from "../ir/sql.js";
import { KernelService } from "./kernel.js";
import { DbPromptResolver } from "../runtime/db-prompt-resolver.js";
import type { PipelineIR } from "../ir/schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function ir(promptRefs: Record<string, string>): PipelineIR {
  const [refA, refB] = Object.keys(promptRefs);
  return {
    name: "t",
    stages: [
      {
        name: "A", type: "agent",
        inputs: [], outputs: [{ name: "x", type: "string" }],
        config: { promptRef: refA! },
      },
      {
        name: "B", type: "agent",
        inputs: [{ name: "x", type: "string" }],
        outputs: [{ name: "y", type: "string" }],
        config: { promptRef: refB! },
      },
    ],
    wires: [
      { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
    ],
  };
}

describe("P6-11 audit: propose() persists prompts on the proposed version", () => {
  it("carries base prompts forward when the caller doesn't supply any", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const baseRefs = { "a-prompt": "hello from A", "b-prompt": "hello from B" };
      const submit = svc.submit(ir(baseRefs), { prompts: baseRefs });
      if (!submit.ok) throw new Error("submit failed");

      // Propose a structural-only change (add then remove no-op on config
      // would be a no-op IR; instead make a real IR delta by renaming
      // stage A's promptRef).
      const renamed = {
        ...ir(baseRefs),
        stages: ir(baseRefs).stages.map((s, i) =>
          i === 0 && s.type === "agent"
            ? { ...s, config: { promptRef: "a-prompt-v2" } }
            : s,
        ),
      };
      const propose = svc.propose({
        currentVersion: submit.versionHash,
        patch: {
          ops: [{
            op: "update_stage_config",
            stage: "A",
            configPatch: { promptRef: "a-prompt-v2" },
          }],
        },
        actor: "test",
        // No prompts supplied — relies on rename-carry for a-prompt-v2
        // and carry-forward for b-prompt.
      });
      expect(propose.ok).toBe(true);
      if (!propose.ok) return;

      const carried = getPromptsByVersion(db, propose.proposedVersion);
      // normalizePromptContent ensures a trailing LF; assert via trim.
      expect(carried["a-prompt-v2"]!.trimEnd()).toBe("hello from A");
      expect(carried["b-prompt"]!.trimEnd()).toBe("hello from B");

      // DbPromptResolver on the new version must be able to resolve
      // both agent stages end-to-end.
      const resolver = new DbPromptResolver(db, propose.proposedVersion);
      expect(resolver.resolve({
        stage: renamed.stages[0] as never,
        taskId: "t1", attemptId: "a1", inputs: {},
      }).trimEnd()).toBe("hello from A");
      expect(resolver.resolve({
        stage: renamed.stages[1] as never,
        taskId: "t1", attemptId: "a2", inputs: {},
      }).trimEnd()).toBe("hello from B");

      // versionHash must be in the pipeline-hash space (IR + prompts),
      // not the legacy IR-only space. Two different prompts under the
      // same IR shape MUST produce different version hashes.
      const propose2 = svc.propose({
        currentVersion: submit.versionHash,
        patch: {
          ops: [{
            op: "update_stage_config",
            stage: "A",
            configPatch: { promptRef: "a-prompt-v2" },
          }],
        },
        actor: "test",
        prompts: { "a-prompt-v2": "DIFFERENT content for A" },
      });
      expect(propose2.ok).toBe(true);
      if (!propose2.ok) return;
      expect(propose2.proposedVersion).not.toBe(propose.proposedVersion);
      expect(getPromptsByVersion(db, propose2.proposedVersion)["a-prompt-v2"]!.trimEnd())
        .toBe("DIFFERENT content for A");
    } finally {
      db.close();
    }
  });

  it("rejects proposals that introduce a new promptRef without matching content", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const baseRefs = { "a-prompt": "hello from A", "b-prompt": "hello from B" };
      const submit = svc.submit(ir(baseRefs), { prompts: baseRefs });
      if (!submit.ok) throw new Error("submit failed");

      const propose = svc.propose({
        currentVersion: submit.versionHash,
        patch: {
          ops: [{
            op: "add_stage",
            stage: {
              name: "C", type: "agent",
              inputs: [{ name: "y", type: "string" }],
              outputs: [],
              config: { promptRef: "c-prompt" },
            },
          }, {
            op: "add_wire",
            wire: { from: { stage: "B", port: "y" }, to: { stage: "C", port: "y" } },
          }],
        },
        actor: "test",
        // c-prompt not supplied; also no rename-carry path (new stage).
      });
      expect(propose.ok).toBe(false);
      if (propose.ok) return;
      expect(propose.diagnostics[0]!.code).toBe("PROMPT_REF_MISSING");
    } finally {
      db.close();
    }
  });

  it("prompts param overrides base content when provided", () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const baseRefs = { "a-prompt": "OLD content A", "b-prompt": "OLD content B" };
      const submit = svc.submit(ir(baseRefs), { prompts: baseRefs });
      if (!submit.ok) throw new Error("submit failed");

      const propose = svc.propose({
        currentVersion: submit.versionHash,
        // No IR-level patch beyond a minimal touch — structural change
        // optional. We want to test prompt override alone. add_stage
        // with downstream wire keeps the IR-diff non-empty so
        // propose() doesn't produce a duplicate hash.
        patch: {
          ops: [{
            op: "update_stage_config",
            stage: "A",
            configPatch: { promptRef: "a-prompt" },
          }],
        },
        actor: "test",
        prompts: { "a-prompt": "NEW content A" },
      });
      expect(propose.ok).toBe(true);
      if (!propose.ok) return;
      const carried = getPromptsByVersion(db, propose.proposedVersion);
      expect(carried["a-prompt"]!.trimEnd()).toBe("NEW content A");
      expect(carried["b-prompt"]!.trimEnd()).toBe("OLD content B");
    } finally {
      db.close();
    }
  });
});
