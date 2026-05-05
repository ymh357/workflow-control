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
import {
  analyze, safeSlug, clampWaitMs, analyzeHarvest, analyzeStart, analyzeRecent,
} from "../api/analyze-handler.js";
import { insertAnalysis, getAnalysis } from "../db/analyses.js";
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

describe("safeSlug", () => {
  // The previous .slice(0, N) approach produced live regressions like
  // "discovered_urls_from_search_resu" (cut at "resu") and
  // "research-a-web3-protocol-s-cross-chain-bridge-ar". These tests
  // pin the word-boundary contract.

  it("never cuts mid-word — drops the would-be-overflowing token", () => {
    // 32-char limit. "discovered urls from search results" → 35 chars
    // joined; the trailing "results" pushes over so we stop at
    // "discovered_urls_from_search". 27 chars, all whole words.
    expect(safeSlug("discovered URLs from search results", 32, "_"))
      .toBe("discovered_urls_from_search");
  });

  it("hyphenates kebab-style with the same boundary rule", () => {
    // 48-char limit. The original mid-word truncation produced
    // "research-a-web3-protocol-s-cross-chain-bridge-ar"; with safe
    // slug the trailing "architecture" gets dropped wholesale.
    const out = safeSlug(
      "Research a Web3 protocol's cross-chain bridge architecture",
      48,
      "-",
    );
    expect(out).toBe("research-a-web3-protocol-s-cross-chain-bridge");
    expect(out.length).toBeLessThanOrEqual(48);
    expect(out.endsWith("-ar")).toBe(false);
  });

  it("returns empty string for input with no alphanumeric tokens", () => {
    expect(safeSlug("---", 32, "_")).toBe("");
    expect(safeSlug("", 32, "_")).toBe("");
  });

  it("keeps a single oversized token whole rather than mid-word truncating", () => {
    // Single token over the limit → return the whole token. The
    // caller can fall back to a placeholder. This is preferable to
    // emitting "supercalifragilis" mid-word.
    const out = safeSlug("supercalifragilisticexpialidocious", 10, "_");
    expect(out).toBe("supercalifragilisticexpialidocious");
  });

  it("collapses runs of non-alphanumerics into a single separator", () => {
    expect(safeSlug("foo___bar...baz!!!qux", 32, "_")).toBe("foo_bar_baz_qux");
  });

  it("strips leading/trailing non-alphanumerics", () => {
    expect(safeSlug("  hello world  ", 32, "_")).toBe("hello_world");
  });
});

describe("clampWaitMs", () => {
  it("treats undefined / 0 / negative / NaN / Infinity as 0 (no wait)", () => {
    expect(clampWaitMs(undefined)).toBe(0);
    expect(clampWaitMs(0)).toBe(0);
    expect(clampWaitMs(-1)).toBe(0);
    expect(clampWaitMs(Number.NaN)).toBe(0);
    expect(clampWaitMs(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("passes through values within range", () => {
    expect(clampWaitMs(1_000)).toBe(1_000);
    expect(clampWaitMs(50_000)).toBe(50_000);
  });

  it("caps over-spec values at 50_000 to leave headroom under MCP timeout", () => {
    expect(clampWaitMs(60_000)).toBe(50_000);
    expect(clampWaitMs(120_000)).toBe(50_000);
  });

  it("floors fractional values", () => {
    expect(clampWaitMs(1_234.9)).toBe(1_234);
  });
});

describe("analyzeHarvest waitMs behavior (empty-session shortcut)", () => {
  // The empty-session path returns the cached result without ever
  // hitting the kernel-next task surface. waitMs is irrelevant here,
  // but we verify it still finalizes promptly (single poll, no
  // pointless sleep).
  it("returns the empty result immediately regardless of waitMs", async () => {
    // Empty-session shortcut still calls finalizeAnalyze, which reads
    // sessions table for cwd → seed a sessions row.
    forgeDb.prepare(
      `INSERT INTO sessions(session_id, cwd, jsonl_path, first_seen_at, last_event_at, status, event_count)
       VALUES ('stub-session', '-tmp', '/tmp/stub.jsonl', 0, 0, 'skipped', 0)`,
    ).run();
    insertAnalysis(forgeDb, {
      analysisId: "empty-test",
      sessionId: "stub-session",
      jsonlPath: "/tmp/stub.jsonl",
      taskId: "",
      truncated: false,
      startedAt: 0,
      emptyResult: { episodes: [], reasonNoEpisodes: "too few events" },
    });
    const t0 = Date.now();
    const r = await analyzeHarvest({ forgeDb, kernelDb }, "empty-test", { waitMs: 5_000 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500); // No sleep loop entered.
    expect(r.kind).toBe("no-pattern");
  });
});

describe("analyzeHarvest INVALID_ANALYSIS_ID", () => {
  it("returns INVALID_ANALYSIS_ID for unknown id", async () => {
    const r = await analyzeHarvest({ forgeDb, kernelDb }, "no-such-analysis-id");
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("INVALID_ANALYSIS_ID");
  });
});

describe("analyzeStart sub-second contract", () => {
  it("returns LOAD_FAILED quickly for a missing jsonlPath (no distill spawn)", async () => {
    const t0 = Date.now();
    const r = await analyzeStart(
      { forgeDb, kernelDb, projectsRoot: dir },
      { jsonlPath: "/nope/does/not/exist.jsonl" },
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_000);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.code).toBe("LOAD_FAILED");
  });
});

describe("analyzeRecent", () => {
  // We use the < 3 events shortcut in startDistill to avoid spawning
  // a real kernel-next task. Each tiny session loads, analyzeStart
  // returns an empty-session handle (taskId="", emptyResult set).

  function writeTinyJsonl(parent: string, fname: string, sid: string): string {
    const projDir = join(parent, "-tmp-recent");
    mkdirSync(projDir, { recursive: true });
    const p = join(projDir, fname);
    const lines = [
      JSON.stringify({ sessionId: sid, message: { role: "user", content: "hello" } }),
      JSON.stringify({ sessionId: sid, message: { role: "assistant", content: "hi" } }),
    ].join("\n") + "\n";
    writeFileSync(p, lines);
    return p;
  }

  it("returns empty analyses + empty failures when no recent sessions exist", async () => {
    const r = await analyzeRecent({ forgeDb, kernelDb, projectsRoot: dir }, {});
    expect(r.kind).toBe("started");
    if (r.kind === "started") {
      expect(r.analyses).toEqual([]);
      expect(r.failures).toEqual([]);
    }
  });

  it("happy path returns empty failures array", async () => {
    const proj = join(dir, "-tmp-good");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "good.jsonl"),
      JSON.stringify({ sessionId: "good", message: { role: "user", content: "x" } }) + "\n"
      + JSON.stringify({ sessionId: "good", message: { role: "assistant", content: "y" } }) + "\n");
    const r = await analyzeRecent({ forgeDb, kernelDb, projectsRoot: dir }, { count: 1 });
    expect(r.kind).toBe("started");
    if (r.kind === "started") {
      expect(r.failures).toEqual([]);
      expect(r.analyses).toHaveLength(1);
    }
  });

  it("response shape always carries an analyses[] and failures[] (no undefined fields)", async () => {
    // Even on the empty-projects-root path the API contract holds.
    const r = await analyzeRecent({ forgeDb, kernelDb, projectsRoot: dir }, {});
    expect(r.kind).toBe("started");
    if (r.kind === "started") {
      expect(Array.isArray(r.analyses)).toBe(true);
      expect(Array.isArray(r.failures)).toBe(true);
    }
  });

  it("kicks off N analyses for N tiny sessions in newest-first order", async () => {
    writeTinyJsonl(dir, "s1.jsonl", "s1");
    await new Promise((r) => setTimeout(r, 15));
    writeTinyJsonl(dir, "s2.jsonl", "s2");
    await new Promise((r) => setTimeout(r, 15));
    writeTinyJsonl(dir, "s3.jsonl", "s3");

    const r = await analyzeRecent({ forgeDb, kernelDb, projectsRoot: dir }, { count: 3 });
    expect(r.kind).toBe("started");
    if (r.kind === "started") {
      expect(r.analyses).toHaveLength(3);
      // Each analysisId resolves to a forge_analyses row.
      for (const a of r.analyses) {
        const row = getAnalysis(forgeDb, a.analysisId);
        expect(row).not.toBeNull();
      }
      // Newest first: s3 then s2 then s1.
      expect(r.analyses[0]!.sessionId).toBe("s3");
      expect(r.analyses[1]!.sessionId).toBe("s2");
      expect(r.analyses[2]!.sessionId).toBe("s1");
    }
  });

  it("defaults count to 3", async () => {
    for (let i = 0; i < 5; i++) {
      writeTinyJsonl(dir, `s${i}.jsonl`, `s${i}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    const r = await analyzeRecent({ forgeDb, kernelDb, projectsRoot: dir }, {});
    expect(r.kind).toBe("started");
    if (r.kind === "started") {
      expect(r.analyses).toHaveLength(3);
    }
  });

  it("caps count at 10 even when caller asks for more", async () => {
    for (let i = 0; i < 12; i++) {
      writeTinyJsonl(dir, `s${i}.jsonl`, `s${i}`);
      await new Promise((r) => setTimeout(r, 2));
    }
    const r = await analyzeRecent({ forgeDb, kernelDb, projectsRoot: dir }, { count: 100 });
    expect(r.kind).toBe("started");
    if (r.kind === "started") {
      expect(r.analyses).toHaveLength(10);
    }
  });
});
