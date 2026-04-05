import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mocks (must be before imports that use them) ─────────────────────────────

vi.mock("../lib/logger.js", () => {
  const noop = vi.fn();
  const logObj = { info: noop, warn: noop, error: noop, debug: noop };
  return {
    logger: logObj,
    taskLogger: () => logObj,
  };
});

vi.mock("../agent/executor.js", () => ({
  runAgent: vi.fn().mockRejectedValue(new Error("runAgent should not be called in edge-only tests")),
  runScript: vi.fn().mockRejectedValue(new Error("runScript should not be called in edge-only tests")),
}));

vi.mock("../agent/pipeline-executor.js", () => ({
  runPipelineCall: vi.fn().mockRejectedValue(new Error("runPipelineCall should not be called in edge-only tests")),
}));

vi.mock("../agent/foreach-executor.js", () => ({
  runForeach: vi.fn().mockRejectedValue(new Error("runForeach should not be called in edge-only tests")),
}));

vi.mock("../lib/slack.js", () => ({
  notifyBlocked: vi.fn().mockResolvedValue(undefined),
  notifyStageComplete: vi.fn().mockResolvedValue(undefined),
  notifyCompleted: vi.fn().mockResolvedValue(undefined),
  notifyCancelled: vi.fn().mockResolvedValue(undefined),
  notifyGenericGate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/notion.js", () => ({
  updateNotionPageStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/artifacts.js", () => ({
  writeArtifact: vi.fn().mockResolvedValue(undefined),
}));

const mockStmtRun = vi.fn();
const mockStmtAll = vi.fn().mockReturnValue([]);
const mockStmtGet = vi.fn().mockReturnValue(undefined);
vi.mock("../lib/db.js", () => ({
  getDb: () => ({
    prepare: () => ({
      run: mockStmtRun,
      all: mockStmtAll,
      get: mockStmtGet,
    }),
    exec: vi.fn(),
  }),
}));

vi.mock("../lib/config-loader.js", () => ({
  loadPipelineConfig: vi.fn().mockReturnValue(null),
  loadSystemSettings: vi.fn().mockReturnValue({
    paths: { data_dir: "/tmp/test-edge-workflow" },
    agent: { default_engine: "claude" },
    sandbox: { enabled: false },
  }),
  loadMcpRegistry: vi.fn().mockReturnValue(null),
  loadPipelineConstraints: vi.fn().mockReturnValue(null),
  loadPipelineSystemPrompt: vi.fn().mockReturnValue(null),
  getFragmentRegistry: vi.fn().mockReturnValue({
    getAllEntries: () => new Map(),
  }),
  listAvailablePipelines: vi.fn().mockReturnValue([]),
  CONFIG_DIR: "/tmp/test-config",
  getNestedValue: (obj: Record<string, unknown>, path: string) => {
    if (!obj || !path) return undefined;
    return path.split(".").reduce((acc: unknown, key: string) => {
      if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
      return undefined;
    }, obj);
  },
  isParallelGroup: (entry: any) => entry && typeof entry === "object" && "parallel" in entry,
  flattenStages: (entries: any[]) => {
    const result: any[] = [];
    for (const e of entries) {
      if (e && typeof e === "object" && "parallel" in e) {
        result.push(...e.parallel.stages);
      } else {
        result.push(e);
      }
    }
    return result;
  },
}));

vi.mock("../lib/safe-fire.js", () => ({
  safeFire: (p: Promise<unknown>) => { p.catch(() => {}); },
}));

vi.mock("../lib/question-manager.js", () => ({
  questionManager: { cancelForTask: vi.fn() },
}));

vi.mock("../sse/task-list-broadcaster.js", () => ({
  taskListBroadcaster: { broadcastTaskUpdate: vi.fn() },
}));

vi.mock("../agent/query-tracker.js", () => ({
  cancelTask: vi.fn(),
  AgentError: class AgentError extends Error {
    readonly agentStatus: string;
    constructor(agentStatus: string, message: string) {
      super(message);
      this.name = "AgentError";
      this.agentStatus = agentStatus;
    }
  },
}));

vi.mock("../agent/context-builder.js", () => ({
  buildTier1Context: vi.fn().mockReturnValue("tier1-context-stub"),
}));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("../machine/persistence.js", () => ({
  loadAllPersistedTaskIds: vi.fn().mockReturnValue([]),
  persistSnapshot: vi.fn(),
  flushSnapshotSync: vi.fn(),
  loadSnapshot: vi.fn().mockReturnValue(null),
}));

// ── Real imports (after mocks) ───────────────────────────────────────────────

import { createActor, type AnyActor } from "xstate";
import { createWorkflowMachine } from "../machine/machine.js";
import { registerSideEffects } from "../machine/side-effects.js";
import {
  resolveSlot,
  getTaskSlots,
  getAllSlots,
  clearTaskSlots,
  getSlotNonce,
  waitForNextSlot,
} from "../edge/registry.js";
import { sseManager } from "../sse/manager.js";
import type { PipelineConfig, PipelineStageConfig } from "../lib/config-loader.js";
import type { WorkflowContext } from "../machine/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let taskCounter = 0;

function nextTaskId(): string {
  return `test-edge-${Date.now()}-${++taskCounter}`;
}

function makeEdgePipeline(stages: Partial<PipelineStageConfig>[]): PipelineConfig {
  return {
    name: "test-edge",
    default_execution_mode: "edge",
    stages: stages.map((s) => ({
      name: s.name!,
      type: s.type ?? "agent",
      execution_mode: s.type === "agent" || !s.type ? (s.execution_mode ?? "edge") : undefined,
      runtime: s.runtime ?? {
        engine: "llm" as const,
        system_prompt: "test prompt",
        writes: (s.runtime as any)?.writes ?? ["analysis"],
      },
      ...s,
    })) as PipelineStageConfig[],
  };
}

function makeConfig(pipeline: PipelineConfig): WorkflowContext["config"] {
  return {
    pipelineName: pipeline.name,
    pipeline,
    prompts: {
      system: {},
      fragments: {},
      globalConstraints: "",
      globalClaudeMd: "",
      globalGeminiMd: "",
        globalCodexMd: "",
    },
    skills: [],
    mcps: [],
  };
}

function makeResultText(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}

function startEdgeActor(pipeline: PipelineConfig, taskId: string): AnyActor {
  const machine = createWorkflowMachine(pipeline);
  const actor = createActor(machine);
  registerSideEffects(actor as any);
  actor.start();
  actor.send({
    type: "START_ANALYSIS",
    taskId,
    taskText: "test edge workflow",
    config: makeConfig(pipeline),
  });
  actor.send({ type: "LAUNCH" });
  return actor;
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Edge Workflow Integration", () => {
  const actors: AnyActor[] = [];
  const taskIds: string[] = [];

  afterEach(() => {
    for (const actor of actors) {
      try { actor.stop(); } catch { /* already stopped */ }
    }
    actors.length = 0;
    for (const tid of taskIds) {
      clearTaskSlots(tid);
    }
    taskIds.length = 0;
  });

  function track(actor: AnyActor, taskId: string) {
    actors.push(actor);
    taskIds.push(taskId);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. Edge slot lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  describe("Edge slot lifecycle", () => {
    it("creates a slot when the machine enters an edge stage", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "analyze", runtime: { engine: "llm", system_prompt: "analyze", writes: ["analysis"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      const slots = getTaskSlots(taskId);
      expect(slots).toHaveLength(1);
      expect(slots[0].stageName).toBe("analyze");
      expect(slots[0].taskId).toBe(taskId);

      // Also visible in global slot list
      const all = getAllSlots();
      expect(all.some((s) => s.taskId === taskId && s.stageName === "analyze")).toBe(true);
    });

    it("advances the machine when the slot is resolved with valid output", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "analyze", runtime: { engine: "llm", system_prompt: "analyze", writes: ["analysis"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      resolveSlot(taskId, "analyze", {
        resultText: makeResultText({ analysis: { plan: "test plan" } }),
        costUsd: 0.01,
        durationMs: 100,
      });

      await vi.waitFor(() => {
        const snap = actor.getSnapshot();
        expect(snap.context.status).toBe("completed");
      });

      const snap = actor.getSnapshot();
      expect(snap.context.store.analysis).toEqual({ plan: "test plan" });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Edge slot with nonce verification
  // ──────────────────────────────────────────────────────────────────────────

  describe("Edge slot nonce verification", () => {
    it("succeeds with the correct nonce", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "step1", runtime: { engine: "llm", system_prompt: "s", writes: ["result"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      const nonce = getSlotNonce(taskId, "step1");
      expect(nonce).toBeDefined();

      const ok = resolveSlot(
        taskId,
        "step1",
        { resultText: makeResultText({ result: "done" }), costUsd: 0, durationMs: 0 },
        nonce!,
      );
      expect(ok).toBe(true);

      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.status).toBe("completed");
      });
    });

    it("rejects submission with a wrong nonce", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "step1", runtime: { engine: "llm", system_prompt: "s", writes: ["result"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      const ok = resolveSlot(
        taskId,
        "step1",
        { resultText: makeResultText({ result: "done" }), costUsd: 0, durationMs: 0 },
        "wrong-nonce-12345",
      );
      expect(ok).toBe(false);

      // Slot should still exist (not consumed)
      expect(getTaskSlots(taskId).length).toBe(1);

      // Machine should still be on step1
      expect(actor.getSnapshot().context.status).toBe("step1");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Edge slot timeout
  // ──────────────────────────────────────────────────────────────────────────

  describe("Edge slot timeout", () => {
    it("rejects the slot and blocks the machine after 30 minutes", async () => {
      vi.useFakeTimers();
      try {
        const taskId = nextTaskId();
        const pipeline = makeEdgePipeline([
          { name: "slow_stage", runtime: { engine: "llm", system_prompt: "s", writes: ["output"] } },
        ]);
        const actor = startEdgeActor(pipeline, taskId);
        track(actor, taskId);

        // Flush microtasks to allow slot creation
        await vi.advanceTimersByTimeAsync(50);
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);

        // The machine retries failed stages up to MAX_STAGE_RETRIES (2) times.
        // Each retry re-invokes the edge actor, which creates a new slot with its own 30min timeout.
        // We need to advance past all retries: initial + 2 retries = 3 timeouts total.
        for (let attempt = 0; attempt < 3; attempt++) {
          // Advance past the 30-minute timeout for this attempt
          await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 500);
          // Allow promise rejection and machine transition to propagate
          await vi.advanceTimersByTimeAsync(500);
        }

        // Extra flush for side-effects
        await vi.advanceTimersByTimeAsync(500);

        const snap = actor.getSnapshot();
        expect(["blocked", "error"]).toContain(snap.context.status);
        expect(snap.context.error).toMatch(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Multiple edge stages in sequence
  // ──────────────────────────────────────────────────────────────────────────

  describe("Multiple edge stages in sequence", () => {
    it("processes edge_stage_1 then edge_stage_2 to completion", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "edge_stage_1", runtime: { engine: "llm", system_prompt: "s1", writes: ["plan"] } },
        { name: "edge_stage_2", runtime: { engine: "llm", system_prompt: "s2", writes: ["delivery"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      // Wait for first slot
      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });
      expect(getTaskSlots(taskId)[0].stageName).toBe("edge_stage_1");

      // Resolve first stage
      resolveSlot(taskId, "edge_stage_1", {
        resultText: makeResultText({ plan: "the plan" }),
        costUsd: 0.01,
        durationMs: 50,
      });

      // Wait for second slot
      await vi.waitFor(() => {
        const slots = getTaskSlots(taskId);
        return expect(slots.some((s) => s.stageName === "edge_stage_2")).toBe(true);
      });

      // Resolve second stage
      resolveSlot(taskId, "edge_stage_2", {
        resultText: makeResultText({ delivery: "complete" }),
        costUsd: 0.02,
        durationMs: 75,
      });

      // Wait for completion
      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.status).toBe("completed");
      });

      const snap = actor.getSnapshot();
      expect(snap.context.store.plan).toBe("the plan");
      expect(snap.context.store.delivery).toBe("complete");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Edge + gate combination
  // ──────────────────────────────────────────────────────────────────────────

  describe("Edge + gate combination", () => {
    it("handles edge -> gate -> edge -> completed", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "edge_1", type: "agent", runtime: { engine: "llm", system_prompt: "s1", writes: ["draft"] } },
        {
          name: "review_gate",
          type: "human_confirm",
          execution_mode: undefined,
          runtime: { engine: "human_gate" },
        },
        { name: "edge_2", type: "agent", runtime: { engine: "llm", system_prompt: "s2", writes: ["final"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      // Wait for first edge slot
      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      // Resolve first edge stage
      resolveSlot(taskId, "edge_1", {
        resultText: makeResultText({ draft: "v1" }),
        costUsd: 0.01,
        durationMs: 50,
      });

      // Wait for gate state
      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.status).toBe("review_gate");
      });

      // No edge slots during gate
      expect(getTaskSlots(taskId).length).toBe(0);

      // Confirm gate
      actor.send({ type: "CONFIRM" });

      // Wait for second edge slot
      await vi.waitFor(() => {
        const slots = getTaskSlots(taskId);
        return expect(slots.some((s) => s.stageName === "edge_2")).toBe(true);
      });

      // Resolve second edge stage
      resolveSlot(taskId, "edge_2", {
        resultText: makeResultText({ final: "shipped" }),
        costUsd: 0.02,
        durationMs: 60,
      });

      // Wait for completion
      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.status).toBe("completed");
      });

      const snap = actor.getSnapshot();
      expect(snap.context.store.draft).toBe("v1");
      expect(snap.context.store.final).toBe("shipped");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Edge interrupted
  // ──────────────────────────────────────────────────────────────────────────

  describe("Edge interrupted", () => {
    it("clears slots and transitions to blocked on INTERRUPT", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "long_task", runtime: { engine: "llm", system_prompt: "s", writes: ["output"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      // Send INTERRUPT
      actor.send({ type: "INTERRUPT", reason: "User requested stop" } as any);

      // Wait for blocked state
      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.status).toBe("blocked");
      });

      const snap = actor.getSnapshot();
      // The INTERRUPT handler sets error from event.reason or fallback "Interrupted by user"
      expect(snap.context.error).toMatch(/Interrupted|User requested stop/);
      expect(snap.context.lastStage).toBe("long_task");

      // Side effect: clearTaskSlots is called via wf.cancelAgent emission
      // Slots should be cleared synchronously by the side-effect handler
      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBe(0);
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 7. waitForNextSlot integration
  // ──────────────────────────────────────────────────────────────────────────

  describe("waitForNextSlot integration", () => {
    it("resolves immediately when a slot already exists", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "stage_a", runtime: { engine: "llm", system_prompt: "s", writes: ["out"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      // waitForNextSlot should resolve immediately since slot exists
      const slotInfo = await waitForNextSlot(taskId);
      expect(slotInfo.taskId).toBe(taskId);
      expect(slotInfo.stageName).toBe("stage_a");
    });

    it("waits and resolves when the next slot appears after resolution", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "s1", runtime: { engine: "llm", system_prompt: "s1", writes: ["r1"] } },
        { name: "s2", runtime: { engine: "llm", system_prompt: "s2", writes: ["r2"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      // Wait for first slot
      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      // Resolve first slot
      resolveSlot(taskId, "s1", {
        resultText: makeResultText({ r1: "done" }),
        costUsd: 0,
        durationMs: 0,
      });

      // Now wait for the next slot (s2) via the event-driven API
      const nextSlot = await waitForNextSlot(taskId);
      expect(nextSlot.stageName).toBe("s2");
      expect(nextSlot.taskId).toBe(taskId);

      // Clean up: resolve s2 to let machine complete
      resolveSlot(taskId, "s2", {
        resultText: makeResultText({ r2: "done" }),
        costUsd: 0,
        durationMs: 0,
      });

      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.status).toBe("completed");
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 8. SSE events during edge workflow
  // ──────────────────────────────────────────────────────────────────────────

  describe("SSE events during edge workflow", () => {
    it("pushes status events when stages transition", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "sse_stage", runtime: { engine: "llm", system_prompt: "s", writes: ["data"] } },
      ]);

      const capturedMessages: Array<{ type: string; data: unknown }> = [];
      const removeListener = sseManager.addListener(taskId, (msg) => {
        capturedMessages.push({ type: msg.type, data: msg.data });
      });

      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      // Should have at least a status event for entering sse_stage
      const statusEvents = capturedMessages.filter((m) => m.type === "status");
      expect(statusEvents.length).toBeGreaterThan(0);
      expect(statusEvents.some((e) => {
        const data = e.data as { status?: string };
        return data.status === "sse_stage";
      })).toBe(true);

      // Resolve and check for completion event
      resolveSlot(taskId, "sse_stage", {
        resultText: makeResultText({ data: "val" }),
        costUsd: 0,
        durationMs: 0,
      });

      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.status).toBe("completed");
      });

      const completionEvents = capturedMessages.filter((m) => {
        const data = m.data as { status?: string };
        return m.type === "status" && data.status === "completed";
      });
      expect(completionEvents.length).toBeGreaterThan(0);

      removeListener();
    });
  });
});
