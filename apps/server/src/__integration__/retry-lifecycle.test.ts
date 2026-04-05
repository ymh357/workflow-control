/**
 * Integration tests for RETRY / RESUME / BLOCKED lifecycle scenarios.
 *
 * Covers the gaps left by task-lifecycle.test.ts:
 * - Retry after cancel (full re-run from blocked)
 * - Multiple sequential retries
 * - Retry succeeds partway through a multi-stage pipeline (resumes from correct stage)
 * - INTERRUPT → RETRY (not RESUME) — re-runs lastStage fresh
 * - Cancel during script stage (not just agent)
 * - Error in second-stage; first-stage output preserved in store
 * - UPDATE_CONFIG during blocked state takes effect on retry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createActor, waitFor, type AnyActor } from "xstate";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/logger.js", () => {
  const noop = () => noopLogger;
  const noopLogger: Record<string, any> = new Proxy({}, { get: () => noop });
  return { logger: noopLogger, taskLogger: () => noopLogger };
});

vi.mock("../lib/slack.js", () => ({
  notifyStageComplete: vi.fn(async () => {}),
  notifyBlocked: vi.fn(async () => {}),
  notifyCompleted: vi.fn(async () => {}),
  notifyQuestionAsked: vi.fn(async () => {}),
  notifyCancelled: vi.fn(async () => {}),
  notifyGenericGate: vi.fn(async () => {}),
  withRetry: vi.fn(async (fn: () => Promise<any>) => fn()),
}));

vi.mock("../lib/notion.js", () => ({
  updateNotionPageStatus: vi.fn(async () => {}),
}));

vi.mock("../lib/artifacts.js", () => ({
  writeArtifact: vi.fn(async () => {}),
  readArtifact: vi.fn(async () => null),
  appendProgress: vi.fn(async () => {}),
  stageCompleted: vi.fn(async () => {}),
  artifactExists: vi.fn(async () => false),
}));

vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    exec: vi.fn(),
    prepare: () => ({ run: vi.fn(), get: vi.fn(), all: vi.fn(() => []) }),
  }),
}));

vi.mock("../sse/manager.js", () => {
  const mgr = { pushMessage: vi.fn(), addListener: vi.fn(() => () => {}) };
  return { sseManager: mgr };
});

const mockRunAgent = vi.fn<(...args: any[]) => any>();
const mockRunScript = vi.fn<(...args: any[]) => any>();

vi.mock("../agent/executor.js", () => ({
  runAgent: (...args: any[]) => mockRunAgent(...args),
  runScript: (...args: any[]) => mockRunScript(...args),
  cancelTask: vi.fn(),
  queueInterruptMessage: vi.fn(),
  interruptActiveQuery: vi.fn(async () => undefined),
  getActiveQueryInfo: vi.fn(),
  buildTier1Context: vi.fn(() => ""),
  generateSchemaPrompt: vi.fn(() => ""),
  AgentResult: {},
}));

vi.mock("../edge/actor.js", async () => {
  const registry = await import("../edge/registry.js");
  return {
    runEdgeAgent: vi.fn(
      (taskId: string, input: { stageName: string }) =>
        registry.createSlot(taskId, input.stageName, 30_000),
    ),
  };
});

import { createWorkflowMachine } from "../machine/machine.js";
import type { PipelineConfig } from "../lib/config-loader.js";
import type { WorkflowContext } from "../machine/types.js";
import type { AgentResult } from "../agent/query-tracker.js";

// ---------------------------------------------------------------------------
// Helpers (shared with task-lifecycle.test.ts style)
// ---------------------------------------------------------------------------

function makeConfig(pipeline: PipelineConfig): WorkflowContext["config"] {
  return {
    pipelineName: pipeline.name,
    pipeline,
    prompts: { system: {}, fragments: {}, globalConstraints: "", globalClaudeMd: "", globalGeminiMd: "",
        globalCodexMd: "" },
    skills: [],
    mcps: [],
  };
}

function agentResult(fields: Record<string, any>, cost = 0.01): AgentResult {
  return {
    resultText: JSON.stringify(fields),
    costUsd: cost,
    durationMs: 100,
    sessionId: `sess-${Date.now()}`,
  };
}

function startMachine(pipeline: PipelineConfig, taskId = "retry-test") {
  const machine = createWorkflowMachine(pipeline);
  const actor = createActor(machine);
  actor.start();
  actor.send({ type: "START_ANALYSIS", taskId, taskText: "Retry test", config: makeConfig(pipeline) });
  actor.send({ type: "LAUNCH" });
  return actor;
}

async function waitForStatus(actor: AnyActor, status: string, timeoutMs = 5000) {
  await waitFor(actor, (snap) => snap.context.status === status, { timeout: timeoutMs });
}

function twoStagePipeline(): PipelineConfig {
  return {
    name: "two-stage",
    stages: [
      { name: "analyzing", type: "agent", runtime: { engine: "llm" as const, system_prompt: "analyze", writes: ["analysis"] } },
      { name: "implementing", type: "agent", runtime: { engine: "llm" as const, system_prompt: "implement", writes: ["implementation"] } },
    ],
  };
}

function threeStageWithScript(): PipelineConfig {
  return {
    name: "three-stage",
    stages: [
      { name: "setup", type: "script", runtime: { engine: "script" as const, script_id: "init", writes: ["branch"] } },
      { name: "coding", type: "agent", runtime: { engine: "llm" as const, system_prompt: "code", writes: ["code"] } },
      { name: "review", type: "agent", runtime: { engine: "llm" as const, system_prompt: "review", writes: ["review_result"] } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Retry / Resume / Blocked lifecycle", () => {
  let actor: AnyActor;

  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { actor?.stop(); });

  // ── 1. RETRY restarts from lastStage (not from beginning) ──────────────────

  describe("RETRY after auto-block restarts from lastStage", () => {
    it("retries from 'implementing' when implementing was the failing stage", async () => {
      // analyzing succeeds, implementing fails 3 times → blocked at implementing
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "ok" } }))
        .mockRejectedValueOnce(new Error("impl fail 1"))
        .mockRejectedValueOnce(new Error("impl fail 2"))
        .mockRejectedValueOnce(new Error("impl fail 3"));

      actor = startMachine(twoStagePipeline());
      await waitForStatus(actor, "blocked");

      const ctx = actor.getSnapshot().context;
      expect(ctx.lastStage).toBe("implementing");
      // store from analyzing should still be present
      expect(ctx.store.analysis).toEqual({ plan: "ok" });

      // Now retry — should restart only implementing, not analyzing
      mockRunAgent.mockResolvedValueOnce(agentResult({ implementation: { pr: "url" } }));
      actor.send({ type: "RETRY" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const finalCtx = actor.getSnapshot().context;
      expect(finalCtx.status).toBe("completed");
      expect(finalCtx.store.analysis).toEqual({ plan: "ok" }); // preserved from before
      expect(finalCtx.store.implementation).toEqual({ pr: "url" });
      // analyzing was called once, implementing was called 3 (fail) + 1 (retry success) = 4
      expect(mockRunAgent).toHaveBeenCalledTimes(5);
    });
  });

  // ── 2. Multiple sequential RETRY cycles ────────────────────────────────────

  describe("multiple sequential RETRY cycles", () => {
    it("can retry twice: fail → blocked → retry → fail again → blocked → retry → success", async () => {
      // Fail 3 times → blocked
      mockRunAgent
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockRejectedValueOnce(new Error("fail 3"));

      const pipeline: PipelineConfig = {
        name: "single-stage",
        stages: [{ name: "work", type: "agent", runtime: { engine: "llm" as const, system_prompt: "work", writes: ["result"] } }],
      };

      actor = startMachine(pipeline);
      await waitForStatus(actor, "blocked");
      expect(actor.getSnapshot().context.lastStage).toBe("work");

      // First retry — fail 3 more times → blocked again
      mockRunAgent
        .mockRejectedValueOnce(new Error("retry fail 1"))
        .mockRejectedValueOnce(new Error("retry fail 2"))
        .mockRejectedValueOnce(new Error("retry fail 3"));

      actor.send({ type: "RETRY" });
      await waitForStatus(actor, "blocked");

      // Second retry — succeed
      mockRunAgent.mockResolvedValueOnce(agentResult({ result: { done: true } }));
      actor.send({ type: "RETRY" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
      expect(actor.getSnapshot().context.status).toBe("completed");
      expect(actor.getSnapshot().context.store.result).toEqual({ done: true });
    });
  });

  // ── 3. Cancel during script stage ──────────────────────────────────────────

  describe("cancel during script stage", () => {
    it("cancels to cancelled when CANCEL sent during script execution", async () => {
      let resolveScript!: (v: Record<string, unknown>) => void;
      mockRunScript.mockImplementationOnce(
        () => new Promise<Record<string, unknown>>((res) => { resolveScript = res; }),
      );

      actor = startMachine(threeStageWithScript());
      await waitForStatus(actor, "setup");

      actor.send({ type: "CANCEL" });
      await waitForStatus(actor, "cancelled");

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("cancelled");
      expect(ctx.lastStage).toBe("setup");
      // Downstream stages never ran
      expect(mockRunAgent).not.toHaveBeenCalled();
    });
  });

  // ── 4. RESUME after cancel during script preserves nothing downstream ──────

  describe("RESUME after cancel during script", () => {
    it("resumes from setup stage and completes full pipeline", async () => {
      let resolveScript!: (v: Record<string, unknown>) => void;
      mockRunScript.mockImplementationOnce(
        () => new Promise<Record<string, unknown>>((res) => { resolveScript = res; }),
      );

      actor = startMachine(threeStageWithScript());
      await waitForStatus(actor, "setup");

      actor.send({ type: "CANCEL" });
      await waitForStatus(actor, "cancelled");

      // Resume — should re-run setup, coding, review
      mockRunScript.mockResolvedValueOnce({ branch: "feat/test" });
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ code: { files: ["a.ts"] } }))
        .mockResolvedValueOnce(agentResult({ review_result: { approved: true } }));

      actor.send({ type: "RESUME" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      expect(ctx.store.branch).toBe("feat/test");
      expect(ctx.store.code).toEqual({ files: ["a.ts"] });
    });
  });

  // ── 5. First-stage store preserved after second-stage blocks ───────────────

  describe("store preservation across blocked stages", () => {
    it("first-stage output remains in store when second stage blocks", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "good plan" } }))
        // implementing fails → blocked
        .mockRejectedValueOnce(new Error("impl fail 1"))
        .mockRejectedValueOnce(new Error("impl fail 2"))
        .mockRejectedValueOnce(new Error("impl fail 3"));

      actor = startMachine(twoStagePipeline());
      await waitForStatus(actor, "blocked");

      const ctx = actor.getSnapshot().context;
      expect(ctx.lastStage).toBe("implementing");
      expect(ctx.store.analysis).toEqual({ plan: "good plan" });
      expect(ctx.store.implementation).toBeUndefined();
    });
  });

  // ── 6. UPDATE_CONFIG during blocked — takes effect on next retry ───────────

  describe("UPDATE_CONFIG during blocked takes effect on RETRY", () => {
    it("updated config is visible in context after RETRY", async () => {
      mockRunAgent
        .mockRejectedValueOnce(new Error("f1"))
        .mockRejectedValueOnce(new Error("f2"))
        .mockRejectedValueOnce(new Error("f3"));

      actor = startMachine(twoStagePipeline());
      await waitForStatus(actor, "blocked");

      // Send UPDATE_CONFIG while blocked
      actor.send({ type: "UPDATE_CONFIG", config: { pipelineName: "two-stage-v2" } } as any);
      expect(actor.getSnapshot().context.config?.pipelineName).toBe("two-stage-v2");

      // Retry
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "ok" } }))
        .mockResolvedValueOnce(agentResult({ implementation: { pr: "url" } }));

      actor.send({ type: "RETRY" });
      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      expect(ctx.config?.pipelineName).toBe("two-stage-v2");
    });
  });

  // ── 7. INTERRUPT during second stage → RETRY resumes from second stage ─────

  describe("INTERRUPT during second stage, RETRY from second stage", () => {
    it("RETRY after interrupt at implementing skips re-running analyzing", async () => {
      mockRunAgent.mockResolvedValueOnce(agentResult({ analysis: { plan: "done" } }));

      let resolveImpl!: (v: AgentResult) => void;
      mockRunAgent.mockImplementationOnce(
        () => new Promise<AgentResult>((res) => { resolveImpl = res; }),
      );

      actor = startMachine(twoStagePipeline());
      await waitForStatus(actor, "implementing");

      actor.send({ type: "INTERRUPT", reason: "manual pause" } as any);
      await waitForStatus(actor, "blocked");

      const ctx = actor.getSnapshot().context;
      expect(ctx.lastStage).toBe("implementing");
      expect(ctx.store.analysis).toEqual({ plan: "done" });

      // RETRY should restart implementing only
      mockRunAgent.mockResolvedValueOnce(agentResult({ implementation: { pr: "url" } }));
      actor.send({ type: "RETRY" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
      expect(actor.getSnapshot().context.status).toBe("completed");
      // analyzing: 1, implementing: 1 (interrupted, never counted) + 1 (retry success) = 3
      expect(mockRunAgent).toHaveBeenCalledTimes(3);
    });
  });

  // ── 8. CANCEL during gate → RESUME back to gate ────────────────────────────

  describe("cancel at human_confirm gate then RESUME", () => {
    it("RESUME from gate-cancelled returns to awaitingConfirm", async () => {
      const gatePipeline: PipelineConfig = {
        name: "gate-resume",
        stages: [
          { name: "coding", type: "agent", runtime: { engine: "llm" as const, system_prompt: "code", writes: ["code"] } },
          { name: "review", type: "human_confirm", runtime: { engine: "human_gate" as const, on_approve_to: "deploy", on_reject_to: "error" } },
          { name: "deploy", type: "agent", runtime: { engine: "llm" as const, system_prompt: "deploy", writes: ["deploy_result"] } },
        ],
      };

      mockRunAgent.mockResolvedValueOnce(agentResult({ code: { files: ["main.ts"] } }));
      actor = startMachine(gatePipeline);

      await waitForStatus(actor, "review");
      actor.send({ type: "CANCEL" });
      await waitForStatus(actor, "cancelled");
      expect(actor.getSnapshot().context.lastStage).toBe("review");

      // RESUME — should go back to review gate
      actor.send({ type: "RESUME" });
      await waitForStatus(actor, "review");

      // Now approve
      mockRunAgent.mockResolvedValueOnce(agentResult({ deploy_result: { success: true } }));
      actor.send({ type: "CONFIRM" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
      expect(actor.getSnapshot().context.status).toBe("completed");
    });
  });

  // ── 9. Script error → blocked → RETRY runs script again ───────────────────

  describe("script stage error → blocked → RETRY", () => {
    it("RETRY re-runs failed script stage", async () => {
      mockRunScript
        .mockRejectedValueOnce(new Error("git error 1"))
        .mockRejectedValueOnce(new Error("git error 2"))
        .mockRejectedValueOnce(new Error("git error 3"));

      actor = startMachine(threeStageWithScript());
      await waitForStatus(actor, "blocked");

      const ctx = actor.getSnapshot().context;
      expect(ctx.lastStage).toBe("setup");

      // Retry — script succeeds, then coding and review
      mockRunScript.mockResolvedValueOnce({ branch: "feat/new" });
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ code: { v: 1 } }))
        .mockResolvedValueOnce(agentResult({ review_result: { ok: true } }));

      actor.send({ type: "RETRY" });
      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      expect(actor.getSnapshot().context.status).toBe("completed");
      expect(actor.getSnapshot().context.store.branch).toBe("feat/new");
    });
  });

  // ── 10. Cost accumulation across retries ───────────────────────────────────

  describe("cost accumulation across retries", () => {
    it("total cost accumulates from original run and retry", async () => {
      // First run: analyzing succeeds (0.10), implementing fails 3 times (0.01 each)
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { ok: true } }, 0.10))
        .mockRejectedValueOnce(new Error("f1"))
        .mockRejectedValueOnce(new Error("f2"))
        .mockRejectedValueOnce(new Error("f3"));

      actor = startMachine(twoStagePipeline());
      await waitForStatus(actor, "blocked");

      const blockedCost = actor.getSnapshot().context.totalCostUsd;
      expect(blockedCost).toBeGreaterThanOrEqual(0.10); // at least analyzing cost

      // Retry — implementing succeeds (0.20)
      mockRunAgent.mockResolvedValueOnce(agentResult({ implementation: { pr: "url" } }, 0.20));
      actor.send({ type: "RETRY" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const finalCost = actor.getSnapshot().context.totalCostUsd;
      // Final cost should include all stages from both runs
      expect(finalCost).toBeGreaterThan(blockedCost);
    });
  });
});
