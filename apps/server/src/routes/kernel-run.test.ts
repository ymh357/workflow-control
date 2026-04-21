import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { kernelRunRoute } from "./kernel-run.js";
import { __setKernelNextDbForTest } from "../lib/kernel-next-db.js";
import { getKernelNextDb } from "../lib/kernel-next-db.js";
import { initKernelNextSchema } from "../kernel-next/ir/sql.js";
import { kernelNextBroadcaster } from "../kernel-next/sse/singleton.js";
import type { KernelNextSSEEvent } from "../kernel-next/sse/types.js";
import { loadLegacyPipelineIR } from "../kernel-next/runtime/load-legacy-pipeline.js";

describe("POST /api/kernel/tasks/run", () => {
  let app: Hono;
  let db: DatabaseSync;

  beforeEach(() => {
    app = new Hono();
    app.route("/api", kernelRunRoute);
    db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    __setKernelNextDbForTest(undefined);
  });

  it("returns 202 with taskId + versionHash for a known pipeline", async () => {
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "diamond" }),
    });
    expect(res.status).toBe(202);
    const json = await res.json() as { ok: boolean; taskId: string; versionHash: string };
    expect(json.ok).toBe(true);
    expect(json.taskId).toMatch(/^kr-/);
    expect(json.versionHash).toMatch(/^[0-9a-f]+$/);
  });

  it("accepts a caller-provided taskId", async () => {
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "diamond", taskId: "custom-task-123" }),
    });
    expect(res.status).toBe(202);
    const json = await res.json() as { taskId: string };
    expect(json.taskId).toBe("custom-task-123");
  });

  it("rejects unknown pipeline names with UNKNOWN_PIPELINE", async () => {
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "not-real" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as {
      ok: boolean;
      diagnostics: Array<{ code: string; context?: { known: string[] } }>;
    };
    expect(json.ok).toBe(false);
    expect(json.diagnostics[0]!.code).toBe("UNKNOWN_PIPELINE");
    expect(json.diagnostics[0]!.context?.known).toContain("diamond");
    expect(json.diagnostics[0]!.context?.known).toContain("diamond-slow");
    expect(json.diagnostics[0]!.context?.known).toContain("diamond-real");
    expect(json.diagnostics[0]!.context?.known).toContain("smoke-test");
    expect(json.diagnostics[0]!.context?.known).toContain("tech-research-collector");
    expect(json.diagnostics[0]!.context?.known).toContain("tech-research-writer");
    expect(json.diagnostics[0]!.context?.known).toContain("pipeline-generator");
  });

  it("accepts real-executor overrides (model / maxTurns / maxBudgetUsd) without validation errors", async () => {
    // We don't actually want to invoke the SDK here — that's the
    // job of the browser verification step. Just prove the body
    // schema accepts the optional real-executor fields and the
    // route returns 202 (the fire-and-forget runPipeline is
    // already scheduled at this point; even if it errors later
    // because claude is not reachable, the response path is
    // already correct). We tag a unique taskId so the background
    // promise doesn't alias any other test's subscriber.
    const taskId = `kr-override-validation-${Date.now()}`;
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipeline: "diamond",
        taskId,
        model: "claude-haiku-4-5",
        maxTurns: 5,
        maxBudgetUsd: 0.1,
      }),
    });
    expect(res.status).toBe(202);
    // Let the microtask queue drain; the mock executor will finish
    // quickly since pipeline is "diamond", not "diamond-real". This
    // prevents the promise from leaking into the next test.
    await new Promise((r) => setTimeout(r, 50));
    kernelNextBroadcaster.clearTask(taskId);
  });

  it("rejects invalid override types with INVALID_REQUEST_BODY", async () => {
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipeline: "diamond",
        maxBudgetUsd: -1, // must be positive
      }),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(json.diagnostics[0]!.code).toBe("INVALID_REQUEST_BODY");
  });

  it("rejects malformed JSON body with INVALID_JSON_BODY", async () => {
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(json.diagnostics[0]!.code).toBe("INVALID_JSON_BODY");
  });

  it("rejects missing pipeline field with INVALID_REQUEST_BODY", async () => {
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json() as { diagnostics: Array<{ code: string }> };
    expect(json.diagnostics[0]!.code).toBe("INVALID_REQUEST_BODY");
  });

  it("dispatches runPipeline asynchronously and publishes events through the singleton broadcaster", async () => {
    const taskId = `kr-integration-${Date.now()}`;
    const events: KernelNextSSEEvent[] = [];
    // Subscribe BEFORE the POST so we capture history/live events.
    const unsub = kernelNextBroadcaster.subscribe(taskId, (e) => events.push(e));

    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "diamond", taskId }),
    });
    expect(res.status).toBe(202);

    // Give the event loop time for the fire-and-forget runPipeline
    // to finish. 'diamond' (no sleep) completes in well under 1s.
    // Poll up to ~3s for a run_final event.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === "run_final")) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    unsub();
    kernelNextBroadcaster.clearTask(taskId);

    const types = events.map((e) => e.type);
    expect(types).toContain("task_state");
    expect(types).toContain("stage_executing");
    expect(types).toContain("stage_done");
    expect(types).toContain("port_written");
    expect(types).toContain("run_final");

    const runFinal = events.find((e) => e.type === "run_final");
    const data = runFinal!.data as { finalState: string };
    expect(data.finalState).toBe("completed");
  });

  it("accepts seedValues in body without validation errors", async () => {
    const taskId = `kr-seed-${Date.now()}`;
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipeline: "diamond",
        taskId,
        seedValues: { foo: "bar" },
      }),
    });
    expect(res.status).toBe(202);
    // Drain fire-and-forget runPipeline
    await new Promise((r) => setTimeout(r, 50));
    kernelNextBroadcaster.clearTask(taskId);
  });

  it("accepts tech-research-collector pipeline with seedValues (body shape only)", async () => {
    // Body-validation check. We do NOT expect the real Claude SDK run
    // to complete here — we just prove the registry recognises the
    // name and the body shape is accepted (202).
    const taskId = `kr-trc-${Date.now()}`;
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipeline: "tech-research-collector",
        taskId,
        seedValues: {
          pipelineConfig: {},
          projectContext: {},
        },
      }),
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    kernelNextBroadcaster.clearTask(taskId);
  });

  it("accepts tech-research-writer pipeline with seedValues (body shape only)", async () => {
    const taskId = `kr-trw-${Date.now()}`;
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipeline: "tech-research-writer",
        taskId,
        seedValues: {
          pipelineConfig: {},
          outputPlan: {},
          domainKnowledge: {},
          verificationFacts: {},
          sourceCodeFacts: {},
          communityIntel: {},
          ossHealthFacts: {},
          benchmarkResults: {},
          projectContext: {},
          primarySources: {},
          landscapeResults: {},
          painPoints: {},
          solutionPlan: {},
        },
      }),
    });
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 50));
    kernelNextBroadcaster.clearTask(taskId);
  });

  it("rejects tech-research-collector WITHOUT required seedValues via run_final failed", async () => {
    const taskId = `kr-trc-miss-${Date.now()}`;
    const events: KernelNextSSEEvent[] = [];
    const unsub = kernelNextBroadcaster.subscribe(taskId, (e) => events.push(e));
    const res = await app.request("/api/kernel/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipeline: "tech-research-collector", taskId }),
    });
    expect(res.status).toBe(202);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === "run_final")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    unsub();
    kernelNextBroadcaster.clearTask(taskId);

    const runFinal = events.find((e) => e.type === "run_final");
    expect(runFinal).toBeDefined();
    const data = runFinal!.data as { finalState: string; stageErrors: Array<{ message: string }> };
    expect(data.finalState).toBe("failed");
    expect(data.stageErrors[0]!.message).toMatch(/SEED_VALUES_MISSING_KEY/);
  });

});

describe("registerLegacyPipeline populates pipeline_prompt_refs on module load", () => {
  it("at least one row exists for every registered legacy pipeline", () => {
    const db = getKernelNextDb();
    // Registry-key -> builtin-pipelines/<dir> name (both happen to match
    // for all current legacy entries). pipeline_versions.pipeline_name
    // is the pipeline's IR-level name (sourced from YAML `name:`), which
    // is NOT identical to the registry key — so look it up via the
    // loader rather than hard-coding display names.
    const dirs = ["smoke-test", "tech-research-collector", "tech-research-writer", "pipeline-generator"];
    for (const dir of dirs) {
      const fresh = loadLegacyPipelineIR(dir);
      const pipelineName = fresh.ir.name;
      const row = db
        .prepare(
          `SELECT pv.version_hash, COUNT(ppr.prompt_ref) AS n
           FROM pipeline_versions pv
           LEFT JOIN pipeline_prompt_refs ppr ON ppr.version_hash = pv.version_hash
           WHERE pv.pipeline_name = ?
           GROUP BY pv.version_hash
           ORDER BY pv.created_at DESC
           LIMIT 1`,
        )
        .get(pipelineName) as { version_hash: string; n: number } | undefined;
      expect(row, `pipeline ${pipelineName} (dir=${dir}) not found`).toBeDefined();

      // Cross-check: the count of pipeline_prompt_refs rows for the
      // latest version must be at least the number of distinct
      // AgentStage promptRefs in a fresh load. A stub-only submit
      // that only registered one bogus ref would fail this.
      const expectedAgentPromptCount = new Set(
        fresh.ir.stages
          .filter((s) => s.type === "agent")
          .map((s) => (s as { config: { promptRef: string } }).config.promptRef),
      ).size;
      expect(row!.n).toBeGreaterThanOrEqual(expectedAgentPromptCount);
    }
  });
});
