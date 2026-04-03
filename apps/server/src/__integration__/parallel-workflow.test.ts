/**
 * Integration tests for PARALLEL GROUP pipeline support using the REAL XState
 * state machine with FAKE agent/script executors.
 *
 * These tests exercise the actual buildParallelGroupState, buildAgentState,
 * handleStageError, and machine routing — nothing is mocked at the machine level.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createActor, waitFor, type AnyActor } from "xstate";

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE any import that transitively touches them.
// ---------------------------------------------------------------------------

vi.mock("../lib/logger.js", () => {
  const noop = () => noopLogger;
  const noopLogger: Record<string, any> = new Proxy({}, {
    get: () => noop,
  });
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

vi.mock("../machine/persistence.js", () => ({
  loadAllPersistedTaskIds: vi.fn().mockReturnValue([]),
  persistSnapshot: vi.fn(),
  flushSnapshotSync: vi.fn(),
  loadSnapshot: vi.fn().mockReturnValue(null),
}));

// Real imports (after mocks)
import { createWorkflowMachine } from "../machine/machine.js";
import type { PipelineConfig, PipelineStageEntry } from "../lib/config-loader.js";
import type { WorkflowContext } from "../machine/types.js";
import type { AgentResult } from "../agent/query-tracker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(pipeline: PipelineConfig): WorkflowContext["config"] {
  return {
    pipelineName: pipeline.name,
    pipeline,
    prompts: { system: {}, fragments: {}, globalConstraints: "", globalClaudeMd: "", globalGeminiMd: "" },
    skills: [],
    mcps: [],
  };
}

function agentResult(fields: Record<string, any>, cost = 0.01): AgentResult {
  return {
    resultText: JSON.stringify(fields),
    costUsd: cost,
    durationMs: 100,
    sessionId: `session-${Date.now()}-${Math.random()}`,
  };
}

function startMachine(pipeline: PipelineConfig, taskId = "par-test-1") {
  const machine = createWorkflowMachine(pipeline);
  const actor = createActor(machine);
  actor.start();
  actor.send({
    type: "START_ANALYSIS",
    taskId,
    taskText: "Parallel test task",
    config: makeConfig(pipeline),
  });
  actor.send({ type: "LAUNCH" });
  return actor;
}

async function waitForStatus(actor: AnyActor, status: string, timeoutMs = 5000): Promise<void> {
  await waitFor(actor, (snap) => snap.context.status === status, { timeout: timeoutMs });
}

// ---------------------------------------------------------------------------
// Pipeline factories
// ---------------------------------------------------------------------------

/** analysis -> parallel(techPrep, apiReview) -> implementing */
function parallelPipeline(): PipelineConfig {
  return {
    name: "parallel-test",
    stages: [
      {
        name: "analysis",
        type: "agent",
        runtime: { engine: "llm" as const, system_prompt: "analyze", writes: ["analysis"] },
      },
      {
        parallel: {
          name: "research",
          stages: [
            {
              name: "techPrep",
              type: "agent",
              runtime: { engine: "llm" as const, system_prompt: "tech", writes: ["techContext"] },
            },
            {
              name: "apiReview",
              type: "agent",
              runtime: { engine: "llm" as const, system_prompt: "api", writes: ["apiAudit"] },
            },
          ],
        },
      },
      {
        name: "implementing",
        type: "agent",
        runtime: { engine: "llm" as const, system_prompt: "impl", writes: ["impl"] },
      },
    ] as PipelineStageEntry[],
  };
}

/** parallel(A, B) -> gate -> implementing */
function parallelThenGatePipeline(): PipelineConfig {
  return {
    name: "par-gate",
    stages: [
      {
        parallel: {
          name: "research",
          stages: [
            { name: "stageA", type: "agent", runtime: { engine: "llm" as const, system_prompt: "a", writes: ["resultA"] } },
            { name: "stageB", type: "agent", runtime: { engine: "llm" as const, system_prompt: "b", writes: ["resultB"] } },
          ],
        },
      },
      {
        name: "gate",
        type: "human_confirm",
        runtime: { engine: "human_gate" as const },
      },
      {
        name: "implementing",
        type: "agent",
        runtime: { engine: "llm" as const, system_prompt: "impl", writes: ["impl"] },
      },
    ] as PipelineStageEntry[],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Parallel workflow integration", () => {
  let actor: AnyActor;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    actor?.stop();
  });

  // ── 1. Happy path ──────────────────────────────────────────────────────

  describe("happy path: parallel group completes and advances", () => {
    it("analysis -> parallel(techPrep, apiReview) -> implementing -> completed", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "test" } }))          // analysis
        .mockResolvedValueOnce(agentResult({ techContext: { libs: ["react"] } }))     // techPrep
        .mockResolvedValueOnce(agentResult({ apiAudit: { endpoints: ["/api"] } }))   // apiReview
        .mockResolvedValueOnce(agentResult({ impl: { pr: "http://pr" } }));           // implementing

      actor = startMachine(parallelPipeline());

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      // All parallel child outputs should be in store
      expect(ctx.store.analysis).toEqual({ plan: "test" });
      expect(ctx.store.techContext).toEqual({ libs: ["react"] });
      expect(ctx.store.apiAudit).toEqual({ endpoints: ["/api"] });
      expect(ctx.store.impl).toEqual({ pr: "http://pr" });
      // parallelDone should be cleaned up
      expect(ctx.parallelDone).toBeUndefined();
    });
  });

  // ── 2. Parallel group as first stage ───────────────────────────────────

  describe("parallel group as first stage", () => {
    it("starts directly in parallel group and completes", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ resultA: "done" }))
        .mockResolvedValueOnce(agentResult({ resultB: "done" }))
        .mockResolvedValueOnce(agentResult({ impl: "ok" }));

      actor = startMachine(parallelThenGatePipeline());

      // Wait for gate (parallel group + gate)
      await waitForStatus(actor, "gate");

      const ctx = actor.getSnapshot().context;
      expect(ctx.store.resultA).toBe("done");
      expect(ctx.store.resultB).toBe("done");

      // Approve gate
      mockRunAgent.mockResolvedValueOnce(agentResult({ impl: "shipped" }));
      actor.send({ type: "CONFIRM" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
      expect(actor.getSnapshot().context.status).toBe("completed");
    });
  });

  // ── 3. One child fails, retries, then succeeds ─────────────────────────

  describe("child stage error with auto-retry", () => {
    it("retries failed child within parallel group, other child already done", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "go" } }))             // analysis
        .mockResolvedValueOnce(agentResult({ techContext: { ready: true } }))          // techPrep succeeds
        .mockRejectedValueOnce(new Error("transient API error"))                       // apiReview fails
        .mockResolvedValueOnce(agentResult({ apiAudit: { ok: true } }))               // apiReview retry succeeds
        .mockResolvedValueOnce(agentResult({ impl: { done: true } }));                 // implementing

      actor = startMachine(parallelPipeline());

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      expect(ctx.store.techContext).toEqual({ ready: true });
      expect(ctx.store.apiAudit).toEqual({ ok: true });
    });
  });

  // ── 4. Child exhausts retries -> blocked ───────────────────────────────

  describe("child stage exhausts retries -> blocked", () => {
    it("blocks the entire workflow when a parallel child exhausts retries", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "go" } }))  // analysis
        .mockResolvedValueOnce(agentResult({ techContext: { ok: true } })) // techPrep succeeds
        .mockRejectedValueOnce(new Error("fail 1"))                        // apiReview fail
        .mockRejectedValueOnce(new Error("fail 2"))                        // apiReview retry 1
        .mockRejectedValueOnce(new Error("fail 3"));                       // apiReview retry 2

      actor = startMachine(parallelPipeline());

      await waitForStatus(actor, "blocked");

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("blocked");
      expect(ctx.lastStage).toBe("apiReview");
      expect(ctx.error).toContain("fail");
    });
  });

  // ── 5. RETRY from blocked re-enters parallel group, skips done child ──

  describe("RETRY from blocked skips completed children", () => {
    it("only re-runs the failed child, skipping the one already done", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "go" } }))  // analysis
        .mockResolvedValueOnce(agentResult({ techContext: { ok: true } })) // techPrep
        .mockRejectedValueOnce(new Error("fail 1"))                        // apiReview fail
        .mockRejectedValueOnce(new Error("fail 2"))                        // apiReview retry 1
        .mockRejectedValueOnce(new Error("fail 3"));                       // apiReview retry 2 -> blocked

      actor = startMachine(parallelPipeline());

      await waitForStatus(actor, "blocked");
      expect(actor.getSnapshot().context.lastStage).toBe("apiReview");

      // Count agent calls so far
      const callsBefore = mockRunAgent.mock.calls.length;

      // RETRY
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ apiAudit: { fixed: true } }))  // apiReview succeeds
        .mockResolvedValueOnce(agentResult({ impl: { done: true } }));       // implementing

      actor.send({ type: "RETRY" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      expect(ctx.store.apiAudit).toEqual({ fixed: true });

      // After RETRY: only apiReview + implementing should have been called (techPrep skipped)
      const callsAfter = mockRunAgent.mock.calls.length;
      expect(callsAfter - callsBefore).toBe(2);
    });
  });

  // ── 6. INTERRUPT during parallel group ─────────────────────────────────

  describe("INTERRUPT during parallel group", () => {
    it("transitions to blocked and RETRY routes back to the group", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "go" } }))
        .mockImplementation(() => new Promise<AgentResult>(() => {})); // all parallel children hang

      actor = startMachine(parallelPipeline());

      // Wait until a parallel child stage is running
      await vi.waitFor(() => {
        const s = actor.getSnapshot().context.status;
        expect(s === "techPrep" || s === "apiReview" || s === "research").toBe(true);
      }, { timeout: 3000 });

      actor.send({ type: "INTERRUPT", reason: "User paused" } as any);

      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.status).toBe("blocked");
      }, { timeout: 3000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("blocked");
      // lastStage is a child stage name (whichever set status last)
      expect(["techPrep", "apiReview", "research"]).toContain(ctx.lastStage);
      expect(ctx.error).toBe("User paused");

      // Key: RETRY should route back to the parallel group via childToGroup mapping
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ techContext: { ok: true } }))
        .mockResolvedValueOnce(agentResult({ apiAudit: { ok: true } }))
        .mockResolvedValueOnce(agentResult({ impl: { done: true } }));

      actor.send({ type: "RETRY" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
      expect(actor.getSnapshot().context.status).toBe("completed");
    });
  });

  // ── 7. Gate feedback loop routes back to parallel group ────────────────

  describe("gate REJECT_WITH_FEEDBACK after parallel group", () => {
    it("routes back to parallel group (prevAgentTarget)", async () => {
      // First run
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ resultA: "v1" }))
        .mockResolvedValueOnce(agentResult({ resultB: "v1" }));

      actor = startMachine(parallelThenGatePipeline());

      await waitForStatus(actor, "gate");
      expect(actor.getSnapshot().context.store.resultA).toBe("v1");

      // Send feedback -> should go back to parallel group
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ resultA: "v2" }))
        .mockResolvedValueOnce(agentResult({ resultB: "v2" }));

      actor.send({ type: "REJECT_WITH_FEEDBACK", feedback: "Fix issues" } as any);

      await waitForStatus(actor, "gate");

      const ctx = actor.getSnapshot().context;
      expect(ctx.store.resultA).toBe("v2");
      expect(ctx.store.resultB).toBe("v2");
      expect(ctx.qaRetryCount).toBe(1);

      // Now approve
      mockRunAgent.mockResolvedValueOnce(agentResult({ impl: "done" }));
      actor.send({ type: "CONFIRM" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
      expect(actor.getSnapshot().context.status).toBe("completed");
    });
  });

  // ── 8. Parallel child with retry.back_to external stage ────────────────

  describe("parallel child with retry.back_to pointing to external stage", () => {
    it("rejects at compile time — back_to cannot point outside the parallel group", () => {
      // XState parallel regions cannot transition to states outside the group,
      // so this must be caught at pipeline compilation time.
      const pipeline: PipelineConfig = {
        name: "par-backto",
        stages: [
          {
            name: "implementing",
            type: "agent",
            runtime: { engine: "llm" as const, system_prompt: "impl", writes: ["code"] },
          },
          {
            parallel: {
              name: "qa",
              stages: [
                {
                  name: "securityCheck",
                  type: "agent",
                  runtime: {
                    engine: "llm" as const,
                    system_prompt: "security",
                    writes: ["secResult"],
                    retry: { back_to: "implementing", max_retries: 1 },
                  },
                },
                {
                  name: "perfCheck",
                  type: "agent",
                  runtime: { engine: "llm" as const, system_prompt: "perf", writes: ["perfResult"] },
                },
              ],
            },
          },
        ] as PipelineStageEntry[],
      };

      expect(() => createWorkflowMachine(pipeline)).toThrow(/back_to "implementing" is outside the parallel group/);
    });
  });

  // ── 9. Parallel child output missing required fields triggers retry ────

  describe("parallel child output validation retry", () => {
    it("retries child when output is missing writes fields", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { ok: true } }))         // analysis
        .mockResolvedValueOnce(agentResult({ techContext: { done: true } }))    // techPrep
        .mockResolvedValueOnce(agentResult({ wrong_key: "oops" }))              // apiReview: missing apiAudit
        .mockResolvedValueOnce(agentResult({ apiAudit: { fixed: true } }))      // apiReview retry: correct
        .mockResolvedValueOnce(agentResult({ impl: { done: true } }));          // implementing

      actor = startMachine(parallelPipeline());

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      expect(ctx.store.apiAudit).toEqual({ fixed: true });
    });
  });

  // ── 10. CANCEL during parallel group -> cancelled -> RESUME ────────────

  describe("CANCEL during parallel -> RESUME", () => {
    it("cancels, then resumes from the parallel group", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "go" } }))
        .mockImplementation(() => new Promise<AgentResult>(() => {})); // all parallel children hang

      actor = startMachine(parallelPipeline());

      await vi.waitFor(() => {
        const s = actor.getSnapshot().context.status;
        expect(s === "techPrep" || s === "apiReview" || s === "research").toBe(true);
      }, { timeout: 3000 });

      actor.send({ type: "CANCEL" });
      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.status).toBe("cancelled");
      }, { timeout: 3000 });

      // lastStage is a child stage name since children overwrite status
      expect(["techPrep", "apiReview", "research"]).toContain(actor.getSnapshot().context.lastStage);

      // RESUME
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ techContext: { ok: true } }))
        .mockResolvedValueOnce(agentResult({ apiAudit: { ok: true } }))
        .mockResolvedValueOnce(agentResult({ impl: { done: true } }));

      actor.send({ type: "RESUME" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
      expect(actor.getSnapshot().context.status).toBe("completed");
    });
  });

  // ── 11. Parallel child produces empty resultText ─────────────────────
  describe("parallel child produces empty resultText", () => {
    it("triggers output-missing retry logic when a child returns empty resultText", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "go" } }))             // analysis
        .mockResolvedValueOnce(agentResult({ techContext: { libs: ["vue"] } }))        // techPrep succeeds
        .mockResolvedValueOnce({ resultText: "", costUsd: 0, durationMs: 0, sessionId: "s1" })  // apiReview: empty
        .mockResolvedValueOnce(agentResult({ apiAudit: { endpoints: ["/v2"] } }))     // apiReview retry succeeds
        .mockResolvedValueOnce(agentResult({ impl: { shipped: true } }));              // implementing

      actor = startMachine(parallelPipeline());

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      expect(ctx.store.apiAudit).toEqual({ endpoints: ["/v2"] });
      // Verify the empty result triggered a retry (agent called 5 times, not 4)
      expect(mockRunAgent).toHaveBeenCalledTimes(5);
    });
  });

  // ── 12. All parallel children fail simultaneously ────────────────────
  describe("all parallel children fail simultaneously", () => {
    it("reaches blocked (not stuck) when both children reject", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "go" } }))  // analysis
        // Both children fail all retries
        .mockRejectedValueOnce(new Error("techPrep boom"))
        .mockRejectedValueOnce(new Error("apiReview boom"))
        .mockRejectedValueOnce(new Error("techPrep boom 2"))
        .mockRejectedValueOnce(new Error("apiReview boom 2"))
        .mockRejectedValueOnce(new Error("techPrep boom 3"))
        .mockRejectedValueOnce(new Error("apiReview boom 3"));

      actor = startMachine(parallelPipeline());

      await waitForStatus(actor, "blocked");

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("blocked");
      expect(ctx.error).toBeTruthy();
      // One of the children should be recorded as lastStage
      expect(["techPrep", "apiReview"]).toContain(ctx.lastStage);
    });
  });

  // ── 13. Parallel group with only script stages ───────────────────────
  describe("parallel group with only script stages", () => {
    it("scripts run concurrently and outputs merge correctly", async () => {
      const pipeline: PipelineConfig = {
        name: "par-scripts",
        stages: [
          {
            parallel: {
              name: "dataPrep",
              stages: [
                {
                  name: "fetchUsers",
                  type: "script",
                  runtime: { engine: "script" as const, script_id: "fetch-users", writes: ["users"] },
                },
                {
                  name: "fetchProducts",
                  type: "script",
                  runtime: { engine: "script" as const, script_id: "fetch-products", writes: ["products"] },
                },
              ],
            },
          },
          {
            name: "summary",
            type: "agent",
            runtime: { engine: "llm" as const, system_prompt: "summarize", writes: ["report"] },
          },
        ] as PipelineStageEntry[],
      };

      mockRunScript
        .mockResolvedValueOnce({ users: ["alice", "bob"] })
        .mockResolvedValueOnce({ products: ["widget", "gadget"] });
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ report: "all good" }));

      actor = startMachine(pipeline);

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      expect(ctx.store.users).toEqual(["alice", "bob"]);
      expect(ctx.store.products).toEqual(["widget", "gadget"]);
      expect(ctx.store.report).toBe("all good");
      expect(mockRunScript).toHaveBeenCalledTimes(2);
    });
  });

  // ── 14. Parallel child returns extra unexpected keys ─────────────────
  describe("parallel child returns extra unexpected keys", () => {
    it("only writes declared fields to store, ignoring extra keys", async () => {
      const pipeline: PipelineConfig = {
        name: "par-extra-keys",
        stages: [
          {
            parallel: {
              name: "research",
              stages: [
                { name: "stageA", type: "agent", runtime: { engine: "llm" as const, system_prompt: "a", writes: ["resultA"] } },
                { name: "stageB", type: "agent", runtime: { engine: "llm" as const, system_prompt: "b", writes: ["resultB"] } },
              ],
            },
          },
        ] as PipelineStageEntry[],
      };

      mockRunAgent
        .mockResolvedValueOnce(agentResult({ resultA: "ok", extraStuff: "ignored", secretData: 42 }))
        .mockResolvedValueOnce(agentResult({ resultB: "fine", anotherExtra: "nope" }));

      actor = startMachine(pipeline);

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      expect(ctx.store.resultA).toBe("ok");
      expect(ctx.store.resultB).toBe("fine");
      // Extra keys must NOT leak into store
      expect(ctx.store.extraStuff).toBeUndefined();
      expect(ctx.store.secretData).toBeUndefined();
      expect(ctx.store.anotherExtra).toBeUndefined();
    });
  });

  // ── 15. Deeply nested store reads after parallel ─────────────────────
  describe("deeply nested store reads after parallel", () => {
    it("downstream agent receives nested value via dot notation reads", async () => {
      const pipeline: PipelineConfig = {
        name: "par-nested-read",
        stages: [
          {
            parallel: {
              name: "research",
              stages: [
                {
                  name: "techPrep",
                  type: "agent",
                  runtime: { engine: "llm" as const, system_prompt: "tech", writes: ["techContext"] },
                },
                {
                  name: "apiReview",
                  type: "agent",
                  runtime: { engine: "llm" as const, system_prompt: "api", writes: ["apiAudit"] },
                },
              ],
            },
          },
          {
            name: "implementing",
            type: "agent",
            runtime: {
              engine: "llm" as const,
              system_prompt: "impl",
              writes: ["impl"],
              reads: { tech: "techContext.libs", endpoints: "apiAudit.endpoints" },
            },
          },
        ] as PipelineStageEntry[],
      };

      mockRunAgent
        .mockResolvedValueOnce(agentResult({ techContext: { libs: ["react", "next"], version: "18" } }))
        .mockResolvedValueOnce(agentResult({ apiAudit: { endpoints: ["/api/v1", "/api/v2"], score: 95 } }))
        .mockResolvedValueOnce(agentResult({ impl: { done: true } }));

      actor = startMachine(pipeline);

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      // Verify the nested data is in the store (dot-notation reads work at the context-builder level)
      expect(ctx.store.techContext.libs).toEqual(["react", "next"]);
      expect(ctx.store.apiAudit.endpoints).toEqual(["/api/v1", "/api/v2"]);
      expect(ctx.store.impl).toEqual({ done: true });
    });
  });

  // ── 16. Parallel group followed immediately by another parallel group ─
  describe("parallel group followed immediately by another parallel group", () => {
    it("second group reads from first group's outputs", async () => {
      const pipeline: PipelineConfig = {
        name: "par-then-par",
        stages: [
          {
            parallel: {
              name: "phase1",
              stages: [
                { name: "gather1", type: "agent", runtime: { engine: "llm" as const, system_prompt: "g1", writes: ["data1"] } },
                { name: "gather2", type: "agent", runtime: { engine: "llm" as const, system_prompt: "g2", writes: ["data2"] } },
              ],
            },
          },
          {
            parallel: {
              name: "phase2",
              stages: [
                {
                  name: "process1",
                  type: "agent",
                  runtime: { engine: "llm" as const, system_prompt: "p1", writes: ["output1"], reads: { input: "data1" } },
                },
                {
                  name: "process2",
                  type: "agent",
                  runtime: { engine: "llm" as const, system_prompt: "p2", writes: ["output2"], reads: { input: "data2" } },
                },
              ],
            },
          },
        ] as PipelineStageEntry[],
      };

      mockRunAgent
        .mockResolvedValueOnce(agentResult({ data1: { items: [1, 2] } }))    // gather1
        .mockResolvedValueOnce(agentResult({ data2: { items: [3, 4] } }))    // gather2
        .mockResolvedValueOnce(agentResult({ output1: "processed-1" }))      // process1
        .mockResolvedValueOnce(agentResult({ output2: "processed-2" }));     // process2

      actor = startMachine(pipeline);

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      // First group's outputs remain in store
      expect(ctx.store.data1).toEqual({ items: [1, 2] });
      expect(ctx.store.data2).toEqual({ items: [3, 4] });
      // Second group's outputs are merged
      expect(ctx.store.output1).toBe("processed-1");
      expect(ctx.store.output2).toBe("processed-2");
    });
  });

  // ── 17. Parallel child retries exhaust then sibling data persists ────
  describe("parallel child retries exhaust then sibling already done — RETRY re-enters group", () => {
    it("already-completed sibling's data persists in store through retry cycle", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "go" } }))             // analysis
        .mockResolvedValueOnce(agentResult({ techContext: { libs: ["svelte"] } }))    // techPrep succeeds
        .mockRejectedValueOnce(new Error("apiReview fail 1"))                          // apiReview fail
        .mockRejectedValueOnce(new Error("apiReview fail 2"))                          // apiReview retry 1
        .mockRejectedValueOnce(new Error("apiReview fail 3"));                         // apiReview retry 2 -> blocked

      actor = startMachine(parallelPipeline());

      await waitForStatus(actor, "blocked");

      // Verify sibling data persists in store while blocked
      let ctx = actor.getSnapshot().context;
      expect(ctx.store.techContext).toEqual({ libs: ["svelte"] });
      expect(ctx.lastStage).toBe("apiReview");

      // RETRY: apiReview should re-run; techPrep should be skipped
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ apiAudit: { recovered: true } }))   // apiReview succeeds
        .mockResolvedValueOnce(agentResult({ impl: { done: true } }));            // implementing

      actor.send({ type: "RETRY" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });

      ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("completed");
      // Sibling data from before the retry MUST still be in store
      expect(ctx.store.techContext).toEqual({ libs: ["svelte"] });
      expect(ctx.store.apiAudit).toEqual({ recovered: true });
      expect(ctx.store.impl).toEqual({ done: true });
    });
  });

  // ── 18. Rapid INTERRUPT during parallel group entry ──────────────────
  describe("rapid INTERRUPT during parallel group entry", () => {
    it("does not deadlock when INTERRUPT sent immediately after entering parallel group", async () => {
      // analysis completes, then parallel children hang forever
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ analysis: { plan: "go" } }))
        .mockImplementation(() => new Promise<AgentResult>(() => {}));

      actor = startMachine(parallelPipeline());

      // Wait for the machine to enter the parallel group
      await vi.waitFor(() => {
        const s = actor.getSnapshot().context.status;
        expect(s === "techPrep" || s === "apiReview" || s === "research").toBe(true);
      }, { timeout: 3000 });

      // Send INTERRUPT immediately — no delay
      actor.send({ type: "INTERRUPT", reason: "Immediate abort" } as any);

      // Should reach blocked, not deadlock
      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.status).toBe("blocked");
      }, { timeout: 3000 });

      const ctx = actor.getSnapshot().context;
      expect(ctx.status).toBe("blocked");
      expect(ctx.error).toBe("Immediate abort");

      // Verify recovery is possible
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ techContext: { ok: true } }))
        .mockResolvedValueOnce(agentResult({ apiAudit: { ok: true } }))
        .mockResolvedValueOnce(agentResult({ impl: { ok: true } }));

      actor.send({ type: "RETRY" });

      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
      expect(actor.getSnapshot().context.status).toBe("completed");
    });
  });

  // ── Selective re-run: gate on_reject_to targets parallel child ──────────

  describe("gate REJECT with on_reject_to pointing to parallel child", () => {
    /** parallel(stageA, stageB) -> gate(on_reject_to: stageA) -> implementing */
    function selectiveRejectPipeline(): PipelineConfig {
      return {
        name: "selective-reject",
        stages: [
          {
            parallel: {
              name: "research",
              stages: [
                { name: "stageA", type: "agent", runtime: { engine: "llm" as const, system_prompt: "a", writes: ["resultA"] } },
                { name: "stageB", type: "agent", runtime: { engine: "llm" as const, system_prompt: "b", writes: ["resultB"] } },
              ],
            },
          },
          {
            name: "gate",
            type: "human_confirm",
            runtime: { engine: "human_gate" as const, on_reject_to: "stageA" },
          },
          {
            name: "implementing",
            type: "agent",
            runtime: { engine: "llm" as const, system_prompt: "impl", writes: ["impl"] },
          },
        ] as PipelineStageEntry[],
      };
    }

    it("REJECT only re-runs the targeted child, skips the other", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ resultA: "v1" }))
        .mockResolvedValueOnce(agentResult({ resultB: "v1" }));

      actor = startMachine(selectiveRejectPipeline());
      await waitForStatus(actor, "gate");

      expect(actor.getSnapshot().context.store.resultA).toBe("v1");
      expect(actor.getSnapshot().context.store.resultB).toBe("v1");

      // REJECT — should only re-run stageA
      mockRunAgent.mockResolvedValueOnce(agentResult({ resultA: "v2" }));

      actor.send({ type: "REJECT", reason: "stageA needs fixing" } as any);
      await waitForStatus(actor, "gate");

      const ctx = actor.getSnapshot().context;
      expect(ctx.store.resultA).toBe("v2");
      expect(ctx.store.resultB).toBe("v1"); // stageB was NOT re-run
      expect(mockRunAgent).toHaveBeenCalledTimes(3); // 2 initial + 1 re-run

      // Approve and complete
      mockRunAgent.mockResolvedValueOnce(agentResult({ impl: "done" }));
      actor.send({ type: "CONFIRM" });
      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
      expect(actor.getSnapshot().context.status).toBe("completed");
    });

    it("REJECT_WITH_FEEDBACK only re-runs the targeted child with resume", async () => {
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ resultA: "v1" }))
        .mockResolvedValueOnce(agentResult({ resultB: "v1" }));

      actor = startMachine(selectiveRejectPipeline());
      await waitForStatus(actor, "gate");

      // REJECT_WITH_FEEDBACK — should only re-run stageA
      mockRunAgent.mockResolvedValueOnce(agentResult({ resultA: "v2" }));

      actor.send({ type: "REJECT_WITH_FEEDBACK", feedback: "Fix stageA output" } as any);
      await waitForStatus(actor, "gate");

      const ctx = actor.getSnapshot().context;
      expect(ctx.store.resultA).toBe("v2");
      expect(ctx.store.resultB).toBe("v1"); // stageB was NOT re-run
      expect(ctx.qaRetryCount).toBe(1);
      expect(mockRunAgent).toHaveBeenCalledTimes(3); // 2 initial + 1 re-run

      // Approve and complete
      mockRunAgent.mockResolvedValueOnce(agentResult({ impl: "done" }));
      actor.send({ type: "CONFIRM" });
      await waitFor(actor, (snap) => snap.status === "done", { timeout: 5000 });
      expect(actor.getSnapshot().context.status).toBe("completed");
    });

    it("without on_reject_to, REJECT_WITH_FEEDBACK still re-runs all children", async () => {
      // Use the original parallelThenGatePipeline (no on_reject_to)
      mockRunAgent
        .mockResolvedValueOnce(agentResult({ resultA: "v1" }))
        .mockResolvedValueOnce(agentResult({ resultB: "v1" }));

      actor = startMachine(parallelThenGatePipeline());
      await waitForStatus(actor, "gate");

      mockRunAgent
        .mockResolvedValueOnce(agentResult({ resultA: "v2" }))
        .mockResolvedValueOnce(agentResult({ resultB: "v2" }));

      actor.send({ type: "REJECT_WITH_FEEDBACK", feedback: "Fix all" } as any);
      await waitForStatus(actor, "gate");

      const ctx = actor.getSnapshot().context;
      expect(ctx.store.resultA).toBe("v2");
      expect(ctx.store.resultB).toBe("v2"); // both re-run
      expect(mockRunAgent).toHaveBeenCalledTimes(4); // 2 initial + 2 re-run
    });
  });
});
