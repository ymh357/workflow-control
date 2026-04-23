// P6-5 / P6-6: pipeline name ergonomics.
//
// Before this fix, HTTP `POST /api/kernel/tasks/run` required the
// caller to pass the pipeline's display name (IR.name verbatim,
// often containing spaces). And the synthesized taskId embedded that
// display name directly, yielding values like
// `Pipeline Generator-1776...` that needed URL-encoding at every
// subsequent /status, /migrate, /stream call.
//
// After the fix:
//   - startPipelineRun accepts both the display name and its slug
//     form (lowercase, non-alphanumeric -> '-', trimmed).
//   - Synthesized taskIds use the slug form so they are URL-safe and
//     readable in logs without escaping.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { slugifyPipelineName } from "./name-slug.js";
import { startPipelineRun } from "./start-pipeline-run.js";
import { KernelService } from "../mcp/kernel.js";
import type { PipelineIR } from "../ir/schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function minimalIR(name: string): PipelineIR {
  return {
    name,
    externalInputs: [{ name: "seed", type: "string" }],
    stages: [
      {
        name: "s1",
        type: "agent",
        inputs: [{ name: "seed", type: "string" }],
        outputs: [{ name: "out", type: "string" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { source: "external", port: "seed" }, to: { stage: "s1", port: "seed" } },
    ],
  };
}

describe("slugifyPipelineName", () => {
  it("lowercases + replaces non-alphanumerics with dashes + trims", () => {
    expect(slugifyPipelineName("PR Description Generator")).toBe("pr-description-generator");
    expect(slugifyPipelineName("Pipeline Generator")).toBe("pipeline-generator");
    expect(slugifyPipelineName("smoke-test")).toBe("smoke-test");
    expect(slugifyPipelineName("Tech Research Collector")).toBe("tech-research-collector");
    expect(slugifyPipelineName("  leading and trailing  ")).toBe("leading-and-trailing");
    expect(slugifyPipelineName("multi   spaces")).toBe("multi-spaces");
  });

  it("idempotent: slug of slug is the same slug", () => {
    const once = slugifyPipelineName("Pipeline Generator");
    expect(slugifyPipelineName(once)).toBe(once);
  });

  it("empty / non-alphanumeric-only input returns empty string", () => {
    expect(slugifyPipelineName("")).toBe("");
    expect(slugifyPipelineName("   ")).toBe("");
    expect(slugifyPipelineName("!!!???")).toBe("");
  });
});

describe("startPipelineRun name resolution (P6-5)", () => {
  it("accepts the slug form even though pipeline_name in DB is the display name", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const sub = svc.submit(minimalIR("PR Description Generator"), {
        prompts: { p: "dummy" },
      });
      if (!sub.ok) throw new Error("submit failed");

      // Run by slug.
      const broadcaster = { publish: () => { /* no-op */ } };
      const r = await startPipelineRun({
        db,
        broadcaster: broadcaster as unknown as Parameters<typeof startPipelineRun>[0]["broadcaster"],
        name: "pr-description-generator",
        seedValues: { seed: "x" },
      });
      // We don't expect the pipeline to actually complete here (no
      // executor provided for real run), but the lookup must succeed
      // past UNKNOWN_PIPELINE.
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.versionHash).toBe(sub.versionHash);
    } finally {
      db.close();
    }
  });

  it("still accepts the display name verbatim (back-compat)", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const sub = svc.submit(minimalIR("Tech Research Collector"), {
        prompts: { p: "dummy" },
      });
      if (!sub.ok) throw new Error("submit failed");

      const broadcaster = { publish: () => { /* no-op */ } };
      const r = await startPipelineRun({
        db,
        broadcaster: broadcaster as unknown as Parameters<typeof startPipelineRun>[0]["broadcaster"],
        name: "Tech Research Collector",
        seedValues: { seed: "x" },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.versionHash).toBe(sub.versionHash);
    } finally {
      db.close();
    }
  });
});

describe("startPipelineRun taskId synthesis (P6-6)", () => {
  it("synthesizes a URL-safe slug-form taskId (no spaces)", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const sub = svc.submit(minimalIR("PR Description Generator"), {
        prompts: { p: "dummy" },
      });
      if (!sub.ok) throw new Error("submit failed");

      const broadcaster = { publish: () => { /* no-op */ } };
      const r = await startPipelineRun({
        db,
        broadcaster: broadcaster as unknown as Parameters<typeof startPipelineRun>[0]["broadcaster"],
        name: "PR Description Generator",
        seedValues: { seed: "x" },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Before fix: "PR Description Generator-1776...-abcd"
      // After fix:  "pr-description-generator-1776...-abcd"
      expect(r.taskId).not.toMatch(/\s/);
      expect(r.taskId).toMatch(/^pr-description-generator-\d+-[a-f0-9]{8}$/);
    } finally {
      db.close();
    }
  });

  it("explicit caller-supplied taskId is passed through verbatim (escape hatch)", async () => {
    const db = makeDb();
    try {
      const svc = new KernelService(db, { skipTypeCheck: true });
      const sub = svc.submit(minimalIR("Smoke"), {
        prompts: { p: "dummy" },
      });
      if (!sub.ok) throw new Error("submit failed");

      const broadcaster = { publish: () => { /* no-op */ } };
      const r = await startPipelineRun({
        db,
        broadcaster: broadcaster as unknown as Parameters<typeof startPipelineRun>[0]["broadcaster"],
        name: "Smoke",
        taskId: "Custom Task Id With Spaces",
        seedValues: { seed: "x" },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.taskId).toBe("Custom Task Id With Spaces");
    } finally {
      db.close();
    }
  });
});
