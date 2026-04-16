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
});
