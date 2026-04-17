import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../machine/actor-registry.js", () => {
  const mockActor = {
    subscribe: vi.fn((cb: any) => {
      setTimeout(() => cb({
        context: { status: "completed", store: { result: "done" } },
      }), 10);
      return { unsubscribe: vi.fn() };
    }),
    // runPipelineCall now synchronously re-checks the child's current snapshot
    // after subscribing (closes a race where a synchronous pipeline completes
    // before subscribe() attaches). Return a non-terminal status so the
    // promise resolves via the delayed subscribe callback above.
    getSnapshot: vi.fn(() => ({ context: { status: "running" } })),
  };
  return {
    createTaskDraft: vi.fn().mockReturnValue(mockActor),
    launchTask: vi.fn().mockReturnValue(true),
    getWorkflow: vi.fn().mockReturnValue(mockActor),
    sendEvent: vi.fn(),
  };
});

vi.mock("./query-tracker.js", () => ({
  cancelTask: vi.fn(),
}));

vi.mock("../lib/config-loader.js", () => ({
  getNestedValue: (obj: Record<string, unknown>, path: string) => {
    return path.split(".").reduce((acc: unknown, key: string) => {
      if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[key];
      return undefined;
    }, obj);
  },
}));

import { runPipelineCall } from "./pipeline-executor.js";
import { createTaskDraft } from "../machine/actor-registry.js";
import type { WorkflowContext } from "../machine/types.js";
import type { PipelineCallRuntimeConfig } from "../lib/config/types.js";

describe("runPipelineCall with pipeline_source: store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseContext: Partial<WorkflowContext> = {
    taskId: "parent-1",
    store: {},
    config: {
      pipelineName: "meta",
      pipeline: { name: "Meta", stages: [] },
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
    },
  };

  it("reads pipeline definition from store and passes inline config", async () => {
    const inlinePipeline = {
      name: "Dynamic Phase",
      engine: "claude",
      stages: [
        { name: "work", type: "agent", runtime: { engine: "llm", system_prompt: "work" } },
      ],
      inline_prompts: { work: "Do the work." },
    };

    const context = {
      ...baseContext,
      store: { phase_pipeline: inlinePipeline },
    } as WorkflowContext;

    const runtime: PipelineCallRuntimeConfig = {
      engine: "pipeline",
      pipeline_source: "store",
      pipeline_key: "phase_pipeline",
      writes: [{ key: "result" }],
    };

    await runPipelineCall("parent-1", {
      taskId: "parent-1",
      stageName: "execute-phase",
      context,
      runtime,
    });

    expect(createTaskDraft).toHaveBeenCalledWith(
      expect.stringContaining("parent-1-sub-execute-phase"),
      undefined,
      "Dynamic Phase",
      undefined,
      expect.objectContaining({
        inlineConfig: expect.objectContaining({
          pipelineName: "Dynamic Phase",
        }),
      }),
    );
  });

  it("throws when store key is missing", async () => {
    const context = { ...baseContext, store: {} } as WorkflowContext;

    const runtime: PipelineCallRuntimeConfig = {
      engine: "pipeline",
      pipeline_source: "store",
      pipeline_key: "missing_key",
    };

    await expect(
      runPipelineCall("parent-2", {
        taskId: "parent-2",
        stageName: "exec",
        context,
        runtime,
      }),
    ).rejects.toThrow(/does not contain a valid pipeline definition/);
  });

  it("throws on invalid pipeline definition", async () => {
    const context = {
      ...baseContext,
      store: { bad_pipeline: { name: "Bad", stages: "not-an-array" } },
    } as WorkflowContext;

    const runtime: PipelineCallRuntimeConfig = {
      engine: "pipeline",
      pipeline_source: "store",
      pipeline_key: "bad_pipeline",
    };

    await expect(
      runPipelineCall("parent-3", {
        taskId: "parent-3",
        stageName: "exec",
        context,
        runtime,
      }),
    ).rejects.toThrow(/failed schema validation/);
  });

  it("throws when pipeline_key is not specified", async () => {
    const context = baseContext as WorkflowContext;

    const runtime: PipelineCallRuntimeConfig = {
      engine: "pipeline",
      pipeline_source: "store",
      // no pipeline_key
    };

    await expect(
      runPipelineCall("parent-4", {
        taskId: "parent-4",
        stageName: "exec",
        context,
        runtime,
      }),
    ).rejects.toThrow(/no pipeline_key/);
  });

  it("rejects store-sourced pipeline that declares a script stage", async () => {
    const inline = {
      name: "Bad",
      stages: [
        { name: "w", type: "script", runtime: { engine: "script", script_id: "git_worktree" } },
      ],
    };
    const context = { ...baseContext, store: { p: inline } } as WorkflowContext;
    await expect(runPipelineCall("p-5", {
      taskId: "p-5", stageName: "s", context,
      runtime: { engine: "pipeline", pipeline_source: "store", pipeline_key: "p" },
    })).rejects.toThrow(/disallowed type "script"/);
  });

  it("rejects store-sourced pipeline that references an unknown MCP", async () => {
    const inline = {
      name: "Bad",
      stages: [
        { name: "a", type: "agent", mcps: ["secret_mcp"], runtime: { engine: "llm", system_prompt: "x" } },
      ],
    };
    const ctx = {
      ...baseContext,
      store: { p: inline },
      config: { ...baseContext.config!, mcps: ["safe_mcp"] },
    } as WorkflowContext;
    await expect(runPipelineCall("p-6", {
      taskId: "p-6", stageName: "s", context: ctx,
      runtime: { engine: "pipeline", pipeline_source: "store", pipeline_key: "p" },
    })).rejects.toThrow(/not declared by the parent pipeline/);
  });

  it("rejects store-sourced pipeline with oversized inline_prompts entry", async () => {
    const huge = "x".repeat(9 * 1024); // 9KB > 8KB limit
    const inline = {
      name: "Bad",
      stages: [
        { name: "a", type: "agent", runtime: { engine: "llm", system_prompt: "a" } },
      ],
      inline_prompts: { a: huge },
    };
    const ctx = { ...baseContext, store: { p: inline } } as WorkflowContext;
    await expect(runPipelineCall("p-7", {
      taskId: "p-7", stageName: "s", context: ctx,
      runtime: { engine: "pipeline", pipeline_source: "store", pipeline_key: "p" },
    })).rejects.toThrow(/exceeds limit of/);
  });

  it("enforces depth limit via store counter rather than taskId substring", async () => {
    const inline = {
      name: "Child",
      stages: [
        { name: "a", type: "agent", runtime: { engine: "llm", system_prompt: "a" } },
      ],
    };
    // Simulate that this call is already at depth 3 (MAX)
    const ctx = {
      ...baseContext,
      store: { p: inline, __pipeline_depth: 3 },
    } as WorkflowContext;
    await expect(runPipelineCall("parent", {
      taskId: "parent", stageName: "s", context: ctx,
      runtime: { engine: "pipeline", pipeline_source: "store", pipeline_key: "p" },
    })).rejects.toThrow(/exceeds maximum/);
  });
});
