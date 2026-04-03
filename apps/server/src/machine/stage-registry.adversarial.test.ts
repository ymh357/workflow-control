import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../lib/config-loader.js", () => ({
  getNestedValue: vi.fn(),
  loadSystemSettings: vi.fn(() => ({})),
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

const mockBuildAgentState = vi.fn((..._args: any[]) => ({ mocked: "agent" }));
const mockBuildScriptState = vi.fn((..._args: any[]) => ({ mocked: "script" }));
const mockBuildHumanGateState = vi.fn((..._args: any[]) => ({ mocked: "gate" }));
const mockBuildConditionState = vi.fn((..._args: any[]) => ({ mocked: "condition" }));
const mockBuildPipelineCallState = vi.fn((..._args: any[]) => ({ mocked: "pipeline" }));
const mockBuildForeachState = vi.fn((..._args: any[]) => ({ mocked: "foreach" }));

vi.mock("./state-builders.js", () => ({
  buildAgentState: (...args: any[]) => mockBuildAgentState(...args),
  buildScriptState: (...args: any[]) => mockBuildScriptState(...args),
  buildHumanGateState: (...args: any[]) => mockBuildHumanGateState(...args),
  buildConditionState: (...args: any[]) => mockBuildConditionState(...args),
  buildPipelineCallState: (...args: any[]) => mockBuildPipelineCallState(...args),
  buildForeachState: (...args: any[]) => mockBuildForeachState(...args),
}));

import { getStageBuilder } from "./stage-registry.js";
import type { PipelineStageConfig } from "../lib/config-loader.js";

describe("stage-registry adversarial", () => {
  it("returns null for agent type with engine=human_gate (mismatched type+engine)", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "agent",
      runtime: { engine: "human_gate" as any },
    };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null for human_confirm with engine=script", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "human_confirm",
      runtime: { engine: "script" as any, script_id: "y" },
    };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null for script type with engine=human_gate", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "script",
      runtime: { engine: "human_gate" as any },
    };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("human_confirm builder merges runtime props and name onto config passed to buildHumanGateState", () => {
    const stage: PipelineStageConfig = {
      name: "my-gate",
      type: "human_confirm",
      runtime: { engine: "human_gate", timeout: 300 } as any,
    };
    const builder = getStageBuilder(stage)!;
    expect(builder).toBeTypeOf("function");

    builder("next", "prev", stage);
    expect(mockBuildHumanGateState).toHaveBeenCalledWith("next", "prev", {
      engine: "human_gate",
      timeout: 300,
      name: "my-gate",
    }, undefined);
  });

  it("agent builder passes stage config directly (not spread)", () => {
    const stage: PipelineStageConfig = {
      name: "code",
      type: "agent",
      runtime: { engine: "llm", system_prompt: "build" },
    };
    const builder = getStageBuilder(stage)!;
    builder("next", "prev", stage);
    // buildAgentState receives the stage config as-is
    expect(mockBuildAgentState).toHaveBeenCalledWith("next", "prev", stage, undefined);
  });

  it("script builder passes stage config directly", () => {
    const stage: PipelineStageConfig = {
      name: "init",
      type: "script",
      runtime: { engine: "script", script_id: "setup" },
    };
    const builder = getStageBuilder(stage)!;
    builder("next", "prev", stage);
    expect(mockBuildScriptState).toHaveBeenCalledWith("next", "prev", stage, undefined);
  });

  it("returns null for empty type string", () => {
    const stage = {
      name: "x",
      type: "" as any,
      runtime: { engine: "llm", system_prompt: "y" },
    } as PipelineStageConfig;
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null when type is correct but runtime is null", () => {
    const stage = {
      name: "x",
      type: "agent",
      runtime: null,
    } as any;
    // runtime?.engine is undefined when runtime is null
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null when runtime.engine is empty string", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "agent",
      runtime: { engine: "" as any },
    };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null for condition type with engine=llm (mismatched)", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "condition",
      runtime: { engine: "llm" as any, system_prompt: "y" },
    };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null for pipeline type with engine=script (mismatched)", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "pipeline",
      runtime: { engine: "script" as any, script_id: "y" },
    };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null for foreach type with engine=human_gate (mismatched)", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "foreach",
      runtime: { engine: "human_gate" as any },
    };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null for condition type with undefined runtime", () => {
    const stage: PipelineStageConfig = { name: "x", type: "condition" };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null for foreach type with null runtime", () => {
    const stage = { name: "x", type: "foreach", runtime: null } as any;
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("builder function uses the third argument (stageConfig) not the closure stage", () => {
    const closureStage: PipelineStageConfig = {
      name: "original",
      type: "agent",
      runtime: { engine: "llm", system_prompt: "original" },
    };
    const builder = getStageBuilder(closureStage)!;

    // Call with a different stageConfig argument
    const differentStage: PipelineStageConfig = {
      name: "different",
      type: "agent",
      runtime: { engine: "llm", system_prompt: "different" },
    };
    builder("next", "prev", differentStage);
    // buildAgentState should receive the argument, not the closure stage
    expect(mockBuildAgentState).toHaveBeenCalledWith("next", "prev", differentStage, undefined);
  });
});
