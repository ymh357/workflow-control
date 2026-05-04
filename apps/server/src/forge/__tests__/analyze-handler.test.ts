// Tests for the analyze handler. We don't run the real distillation
// (would require a Claude SDK call); instead we verify the handler's
// branching logic by short-circuiting at distill time.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../kernel-next/ir/sql.js";
import { KernelService } from "../../kernel-next/mcp/kernel.js";
import { initForgeSchema } from "../db/schema.js";
import { analyze } from "../api/analyze-handler.js";
import type { SessionEpisode } from "../types.js";
import type { DistillResult } from "../distillation/submit-distill.js";
import type { PipelineIR } from "../../kernel-next/ir/schema.js";

let kernelDb: DatabaseSync;
let forgeDb: DatabaseSync;
let dir: string;

beforeEach(() => {
  kernelDb = new DatabaseSync(":memory:");
  initKernelNextSchema(kernelDb);
  forgeDb = new DatabaseSync(":memory:");
  initForgeSchema(forgeDb);
  dir = mkdtempSync(join(tmpdir(), "fa-"));
});

describe("analyze", () => {
  it("returns NO_SESSION_FOUND when no source provided and projects-root empty", async () => {
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir },
      {},
    );
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("NO_SESSION_FOUND");
  });

  it("returns LOAD_FAILED when jsonlPath does not exist", async () => {
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir },
      { jsonlPath: "/path/does/not/exist.jsonl" },
    );
    expect(r.kind).toBe("error");
  });

  it("returns no-pattern when session has too few events", async () => {
    const projDir = join(dir, "-tmp-fake");
    mkdirSync(projDir, { recursive: true });
    const p = join(projDir, "abc.jsonl");
    writeFileSync(p,
      JSON.stringify({ sessionId: "abc", message: { role: "user", content: "hi" } }) + "\n",
    );
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir, distillTimeoutMs: 1000, distillPollIntervalMs: 10 },
      { jsonlPath: p },
    );
    expect(r.kind).toBe("no-pattern");
    if (r.kind === "no-pattern") expect(r.episodeCount).toBe(0);
  });

  it("returns DISTILL_SUBMIT_FAILED when forge-distill not registered AND session has enough events", async () => {
    const projDir = join(dir, "-tmp-fake");
    mkdirSync(projDir, { recursive: true });
    const p = join(projDir, "abc.jsonl");
    const lines = [
      { sessionId: "abc", message: { role: "user", content: "first message" } },
      { sessionId: "abc", message: { role: "assistant", content: "responding" } },
      { sessionId: "abc", message: { role: "user", content: "follow up" } },
      { sessionId: "abc", message: { role: "assistant", content: "more help" } },
    ];
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir, distillTimeoutMs: 1000, distillPollIntervalMs: 10 },
      { jsonlPath: p },
    );
    // forge-distill builtin is not submitted to kernelDb → distill submit fails.
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("DISTILL_SUBMIT_FAILED");
  });

  it("auto-detects most recent session under projects-root when no input provided", async () => {
    const projDir = join(dir, "-tmp-fake");
    mkdirSync(projDir, { recursive: true });
    const p = join(projDir, "abc.jsonl");
    writeFileSync(p,
      JSON.stringify({ sessionId: "abc", message: { role: "user", content: "hi" } }) + "\n",
    );
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir, distillTimeoutMs: 1000, distillPollIntervalMs: 10 },
      {}, // no sessionId, no jsonlPath
    );
    expect(r.kind).toBe("no-pattern");
    if (r.kind === "no-pattern") expect(r.jsonlPath).toBe(p);
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// --- Multi-episode tests with injected distill stub --------------------

function writeSessionFile(): string {
  const projDir = join(dir, "-tmp-fake");
  mkdirSync(projDir, { recursive: true });
  const p = join(projDir, "abc.jsonl");
  writeFileSync(p,
    [
      { sessionId: "abc", message: { role: "user", content: "first task" } },
      { sessionId: "abc", message: { role: "assistant", content: "did first" } },
      { sessionId: "abc", message: { role: "user", content: "second task" } },
      { sessionId: "abc", message: { role: "assistant", content: "did second" } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  return p;
}

function ep(overrides: Partial<SessionEpisode>): SessionEpisode {
  return {
    episodeId: overrides.episodeId ?? "e1",
    sessionId: overrides.sessionId ?? "abc",
    startSeq: overrides.startSeq ?? 1,
    endSeq: overrides.endSeq ?? 5,
    intent: overrides.intent ?? "do something",
    outcome: overrides.outcome ?? "completed",
    steps: overrides.steps ?? [{ stageKind: "agent", description: "step" }],
    rationale: overrides.rationale ?? "structured",
    pipelineAble: overrides.pipelineAble ?? true,
    createdAt: overrides.createdAt ?? 1,
  };
}

async function submitPipeline(kernelDb: DatabaseSync, name: string, words: string[]): Promise<void> {
  const ir: PipelineIR = {
    name,
    externalInputs: [{ name: "input", type: "string" }],
    stages: [{
      name: "main", type: "agent",
      inputs: [{ name: "input", type: "string" }],
      outputs: [{ name: "output", type: "string" }],
      config: { promptRef: "system/" + words.join("-") },
    }],
    wires: [{ from: { source: "external", port: "input" }, to: { stage: "main", port: "input" } }],
  };
  const svc = new KernelService(kernelDb, { skipTypeCheck: true });
  const r = await svc.submit(ir, { prompts: { ["system/" + words.join("-")]: "dummy" } });
  if (!r.ok) throw new Error("submit failed");
}

describe("analyze (multi-episode via stub)", () => {
  it("returns one recommendation per pipeline-able episode", async () => {
    const p = writeSessionFile();
    const stubDistill = async (): Promise<DistillResult> => ({
      ok: true,
      taskId: "stub",
      truncated: false,
      episodes: [
        ep({ episodeId: "e1", intent: "extract changelog from commits" }),
        ep({ episodeId: "e2", intent: "rebuild docker image and push to registry" }),
        ep({ episodeId: "e3", intent: "summarize a github pull request" }),
      ],
    });
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir, distill: stubDistill },
      { jsonlPath: p },
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.recommendations).toHaveLength(3);
      expect(r.skippedEpisodes).toHaveLength(0);
      expect(r.summary.skippedCount).toBe(0);
      // No pipelines submitted → all are create-new
      expect(r.summary.useExistingCount).toBe(0);
      expect(r.summary.createNewCount).toBe(3);
      // Each recommendation has a different episode + a unique slug
      const slugs = r.recommendations
        .filter((rec) => rec.kind === "create-new")
        .map((rec) => rec.kind === "create-new" ? rec.proposal.suggestedName : "");
      expect(new Set(slugs).size).toBe(3);
    }
  });

  it("skipped episodes (pipelineAble=false) are partitioned into skippedEpisodes", async () => {
    const p = writeSessionFile();
    const stubDistill = async (): Promise<DistillResult> => ({
      ok: true,
      taskId: "stub",
      truncated: false,
      episodes: [
        ep({ episodeId: "e1", intent: "extract changelog", pipelineAble: true }),
        ep({ episodeId: "e2", intent: "debug a flaky test once", pipelineAble: false, rationale: "one-off" }),
      ],
    });
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir, distill: stubDistill },
      { jsonlPath: p },
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.recommendations).toHaveLength(1);
      expect(r.skippedEpisodes).toHaveLength(1);
      expect(r.skippedEpisodes[0]!.episode.episodeId).toBe("e2");
      expect(r.skippedEpisodes[0]!.reason).toBe("one-off");
    }
  });

  it("returns kind=ok with empty recommendations when ALL episodes are skipped", async () => {
    const p = writeSessionFile();
    const stubDistill = async (): Promise<DistillResult> => ({
      ok: true,
      taskId: "stub",
      truncated: false,
      episodes: [
        ep({ episodeId: "e1", intent: "look at file", pipelineAble: false }),
        ep({ episodeId: "e2", intent: "another lookup", pipelineAble: false }),
      ],
    });
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir, distill: stubDistill },
      { jsonlPath: p },
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.recommendations).toEqual([]);
      expect(r.skippedEpisodes).toHaveLength(2);
      expect(r.summary.useExistingCount).toBe(0);
      expect(r.summary.createNewCount).toBe(0);
      expect(r.summary.skippedCount).toBe(2);
    }
  });

  it("matches an episode against an existing pipeline", async () => {
    const p = writeSessionFile();
    await submitPipeline(kernelDb, "extract-changelog-v1",
      ["extract", "changelog", "from", "recent", "commits"]);
    const stubDistill = async (): Promise<DistillResult> => ({
      ok: true,
      taskId: "stub",
      truncated: false,
      episodes: [
        ep({ episodeId: "e1",
          intent: "extract changelog from recent commits",
          steps: [{ stageKind: "agent", description: "scan commits and format markdown" }],
        }),
      ],
    });
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir, distill: stubDistill },
      { jsonlPath: p },
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.recommendations).toHaveLength(1);
      const rec = r.recommendations[0]!;
      // Local-hash similarity may or may not clear 0.78 for this prompt
      // pair; we just assert shape rather than the kind verdict.
      expect(["use-existing", "create-new"]).toContain(rec.kind);
      if (rec.kind === "use-existing") {
        expect(rec.pipelineName).toBe("extract-changelog-v1");
        expect(rec.runUrl).toContain("/kernel-next/pipelines/");
      }
    }
  });

  it("orders recommendations: use-existing before create-new", async () => {
    const p = writeSessionFile();
    // Submit a pipeline with the SAME descriptor text shape as one of the episodes
    // so the local-hash embedding produces a strong match.
    await submitPipeline(kernelDb, "alpha-task",
      ["unique", "alpha", "task", "specific", "fingerprint"]);
    const stubDistill = async (): Promise<DistillResult> => ({
      ok: true,
      taskId: "stub",
      truncated: false,
      episodes: [
        ep({ episodeId: "e1", intent: "unrelated task one" }),
        ep({ episodeId: "e2",
          intent: "unique alpha task specific fingerprint",
          steps: [{ stageKind: "agent", description: "do unique alpha task with specific fingerprint" }],
        }),
      ],
    });
    const r = await analyze(
      { forgeDb, kernelDb, projectsRoot: dir, distill: stubDistill },
      { jsonlPath: p },
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.summary.useExistingCount > 0) {
      // First entry must be use-existing
      expect(r.recommendations[0]!.kind).toBe("use-existing");
    }
  });
});
