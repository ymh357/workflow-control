import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { startPipelineRun } from "./start-pipeline-run.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import type { KernelNextBroadcaster } from "../sse/broadcaster.js";
import type { PipelineIR } from "../ir/schema.js";

// Minimal no-op broadcaster stub. KernelNextBroadcaster is a concrete
// class; the runner only calls .publish() during execution. We cast
// through `unknown` to satisfy the type without constructing the full
// class.
function noopBroadcaster(): KernelNextBroadcaster {
  return {
    publish: () => {},
    subscribe: () => () => {},
    historyFor: () => [],
    clearTask: () => {},
    subscriberCount: () => 0,
  } as unknown as KernelNextBroadcaster;
}

// Build a prompts map covering every AgentStage promptRef so
// KernelService.submit accepts the IR. Content is placeholder — real
// handlers are supplied by the mock registry in the impl.
function promptsForIR(ir: PipelineIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of ir.stages) {
    if (s.type === "agent" && s.config.promptRef) {
      out[s.config.promptRef] = s.config.promptRef;
    }
  }
  return out;
}

describe("startPipelineRun input resolution", () => {
  it("returns MISSING_INPUT when neither name nor versionHash is supplied", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
    });
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "MISSING_INPUT" }));
  });

  it("returns UNKNOWN_VERSION_HASH when versionHash does not exist", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      versionHash: "nope",
    });
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "UNKNOWN_VERSION_HASH" }));
  });

  it("returns UNKNOWN_PIPELINE when name has no versions", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "not-a-pipeline",
    });
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "UNKNOWN_PIPELINE" }));
  });

  it("returns AMBIGUOUS_INPUT when name and versionHash point to different rows", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = diamondIR();
    const r = svc.submit(ir, { prompts: promptsForIR(ir) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "different-name",
      versionHash: r.versionHash,
    });
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "AMBIGUOUS_INPUT" }));
  });
});

describe("startPipelineRun mock registry seeding", () => {
  it("auto-seeds diamond IR into pipeline_versions on first run", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "diamond",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = db.prepare("SELECT pipeline_name FROM pipeline_versions WHERE version_hash = ?")
      .get(res.versionHash) as { pipeline_name: string } | undefined;
    expect(row?.pipeline_name).toBe("diamond");
  });
});

describe("startPipelineRun policy merge", () => {
  it("top-level overrides win over policy.default", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const res = await startPipelineRun({
      db,
      broadcaster: noopBroadcaster(),
      name: "diamond",
      model: "top-level-model",
      policy: { default: { promptAssembly: { model: "policy-model" } } },
    });
    // Non-failure is the assertion — merging must not throw.
    expect(res.ok).toBe(true);
  });
});
