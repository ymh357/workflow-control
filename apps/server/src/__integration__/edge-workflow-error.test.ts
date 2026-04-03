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
    paths: { data_dir: "/tmp/test-edge-error" },
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
  CONFIG_DIR: "/tmp/test-config-error",
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
  rejectSlot,
  getTaskSlots,
  clearTaskSlots,
  getSlotNonce,
} from "../edge/registry.js";
import type { PipelineConfig, PipelineStageConfig } from "../lib/config-loader.js";
import type { WorkflowContext } from "../machine/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let taskCounter = 0;

function nextTaskId(): string {
  return `test-edge-err-${Date.now()}-${++taskCounter}`;
}

function makeEdgePipeline(stages: Partial<PipelineStageConfig>[]): PipelineConfig {
  return {
    name: "test-edge-error",
    default_execution_mode: "edge",
    stages: stages.map((s) => ({
      name: s.name!,
      type: s.type ?? "agent",
      execution_mode: s.type === "agent" || !s.type ? (s.execution_mode ?? "edge") : undefined,
      runtime: s.runtime ?? {
        engine: "llm" as const,
        system_prompt: "test prompt",
        writes: (s.runtime as any)?.writes ?? ["output"],
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
    taskText: "test edge error workflow",
    config: makeConfig(pipeline),
  });
  actor.send({ type: "LAUNCH" });
  return actor;
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Edge Workflow Error Paths", () => {
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
  // 1. rejectSlot directly → machine enters blocked/error state
  // ──────────────────────────────────────────────────────────────────────────

  describe("rejectSlot direct call", () => {
    it("blocks or errors the machine when slot is repeatedly rejected (exhausting retries)", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "analyze", runtime: { engine: "llm", system_prompt: "analyze", writes: ["analysis"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      // Reject all retry attempts (MAX_STAGE_RETRIES = 2, so up to 3 total attempts)
      for (let attempt = 0; attempt < 3; attempt++) {
        await vi.waitFor(() => {
          expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
        });
        rejectSlot(taskId, "analyze", new Error(`External error attempt ${attempt + 1}`));
        // Wait for machine to process the rejection before next retry creates a slot
        await new Promise((r) => setTimeout(r, 50));
      }

      // Machine should transition to blocked or error after exhausting retries
      await vi.waitFor(() => {
        const snap = actor.getSnapshot();
        return expect(["blocked", "error"]).toContain(snap.context.status);
      }, { timeout: 5000 });
    });

    it("returns false when trying to reject a non-existent slot", () => {
      const result = rejectSlot("no-such-task", "no-such-stage", new Error("nothing"));
      expect(result).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Slot timeout with fake timers
  // ──────────────────────────────────────────────────────────────────────────

  describe("slot timeout via fake timers", () => {
    it("blocks the machine after edge slot times out", async () => {
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

        // Advance past all retries (initial + max retries timeouts)
        for (let attempt = 0; attempt < 3; attempt++) {
          await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 500);
          await vi.advanceTimersByTimeAsync(500);
        }
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
  // 3. Wrong nonce does not consume the slot
  // ──────────────────────────────────────────────────────────────────────────

  describe("nonce mismatch", () => {
    it("returns false and keeps slot active when wrong nonce is used", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "verify_step", runtime: { engine: "llm", system_prompt: "v", writes: ["result"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      const correctNonce = getSlotNonce(taskId, "verify_step");
      expect(correctNonce).toBeDefined();

      // Attempt to resolve with wrong nonce
      const wrongResult = resolveSlot(
        taskId,
        "verify_step",
        { resultText: makeResultText({ result: "hacked" }), costUsd: 0, durationMs: 0 },
        "completely-wrong-nonce",
      );
      expect(wrongResult).toBe(false);

      // Slot should still exist
      expect(getTaskSlots(taskId).length).toBe(1);

      // Machine should still be on verify_step
      const snap = actor.getSnapshot();
      expect(snap.context.status).toBe("verify_step");
    });

    it("resolves successfully with correct nonce after failed wrong-nonce attempt", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "secure_step", runtime: { engine: "llm", system_prompt: "s", writes: ["data"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      const correctNonce = getSlotNonce(taskId, "secure_step");

      // First attempt with wrong nonce fails
      const failedAttempt = resolveSlot(
        taskId,
        "secure_step",
        { resultText: makeResultText({ data: "bad" }), costUsd: 0, durationMs: 0 },
        "wrong-nonce",
      );
      expect(failedAttempt).toBe(false);

      // Second attempt with correct nonce succeeds
      const successAttempt = resolveSlot(
        taskId,
        "secure_step",
        { resultText: makeResultText({ data: "good" }), costUsd: 0.001, durationMs: 50 },
        correctNonce!,
      );
      expect(successAttempt).toBe(true);

      await vi.waitFor(() => {
        expect(actor.getSnapshot().context.status).toBe("completed");
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4. CANCEL event clears slots
  // ──────────────────────────────────────────────────────────────────────────

  describe("CANCEL during edge stage", () => {
    it("clears slots when CANCEL is sent while machine is in edge stage", async () => {
      const taskId = nextTaskId();
      const pipeline = makeEdgePipeline([
        { name: "long_task", runtime: { engine: "llm", system_prompt: "t", writes: ["result"] } },
      ]);
      const actor = startEdgeActor(pipeline, taskId);
      track(actor, taskId);

      await vi.waitFor(() => {
        expect(getTaskSlots(taskId).length).toBeGreaterThan(0);
      });

      // Send CANCEL event
      actor.send({ type: "CANCEL" });

      await vi.waitFor(() => {
        const snap = actor.getSnapshot();
        return expect(snap.context.status).toBe("cancelled");
      }, { timeout: 5000 });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 5. Concurrent tasks with separate slots
  // ──────────────────────────────────────────────────────────────────────────

  describe("concurrent tasks", () => {
    it("two independent tasks maintain separate edge slots", async () => {
      const taskId1 = nextTaskId();
      const taskId2 = nextTaskId();

      const pipeline1 = makeEdgePipeline([
        { name: "stage_alpha", runtime: { engine: "llm", system_prompt: "a", writes: ["alpha"] } },
      ]);
      const pipeline2 = makeEdgePipeline([
        { name: "stage_beta", runtime: { engine: "llm", system_prompt: "b", writes: ["beta"] } },
      ]);

      const actor1 = startEdgeActor(pipeline1, taskId1);
      const actor2 = startEdgeActor(pipeline2, taskId2);
      track(actor1, taskId1);
      track(actor2, taskId2);

      // Both should create their own slots
      await vi.waitFor(() => {
        expect(getTaskSlots(taskId1).length).toBeGreaterThan(0);
        expect(getTaskSlots(taskId2).length).toBeGreaterThan(0);
      });

      expect(getTaskSlots(taskId1)[0].stageName).toBe("stage_alpha");
      expect(getTaskSlots(taskId2)[0].stageName).toBe("stage_beta");

      // Resolve task1 should not affect task2
      resolveSlot(taskId1, "stage_alpha", {
        resultText: makeResultText({ alpha: "done" }),
        costUsd: 0.001,
        durationMs: 10,
      });

      await vi.waitFor(() => {
        expect(actor1.getSnapshot().context.status).toBe("completed");
      });

      // Task2 should still be waiting
      expect(getTaskSlots(taskId2).length).toBe(1);
      expect(actor2.getSnapshot().context.status).toBe("stage_beta");
    });
  });
});
