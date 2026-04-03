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

describe("getStageBuilder", () => {
  it("returns a builder for agent + llm engine", () => {
    const stage: PipelineStageConfig = {
      name: "code",
      type: "agent",
      runtime: { engine: "llm", system_prompt: "do stuff" },
    };
    const builder = getStageBuilder(stage);
    expect(builder).toBeTypeOf("function");

    const result = builder!("next", "prev", stage);
    expect(mockBuildAgentState).toHaveBeenCalledWith("next", "prev", stage, undefined);
    expect(result).toEqual({ mocked: "agent" });
  });

  it("returns a builder for script + script engine", () => {
    const stage: PipelineStageConfig = {
      name: "setup",
      type: "script",
      runtime: { engine: "script", script_id: "init" },
    };
    const builder = getStageBuilder(stage);
    expect(builder).toBeTypeOf("function");

    const result = builder!("next", "prev", stage);
    expect(mockBuildScriptState).toHaveBeenCalledWith("next", "prev", stage, undefined);
    expect(result).toEqual({ mocked: "script" });
  });

  it("returns a builder for human_confirm + human_gate engine", () => {
    const stage: PipelineStageConfig = {
      name: "approval",
      type: "human_confirm",
      runtime: { engine: "human_gate" },
    };
    const builder = getStageBuilder(stage);
    expect(builder).toBeTypeOf("function");

    const result = builder!("next", "prev", stage);
    expect(mockBuildHumanGateState).toHaveBeenCalledWith("next", "prev", {
      engine: "human_gate",
      name: "approval",
    }, undefined);
    expect(result).toEqual({ mocked: "gate" });
  });

  it("returns null for agent with wrong engine", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "agent",
      runtime: { engine: "script" as any, script_id: "y" },
    };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null for script with wrong engine", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "script",
      runtime: { engine: "llm" as any, system_prompt: "y" },
    };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null for human_confirm with wrong engine", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "human_confirm",
      runtime: { engine: "llm" as any, system_prompt: "y" },
    };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null when runtime is undefined", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "agent",
    };
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns null for unknown stage type", () => {
    const stage = {
      name: "x",
      type: "unknown" as any,
      runtime: { engine: "llm", system_prompt: "y" },
    } as PipelineStageConfig;
    expect(getStageBuilder(stage)).toBeNull();
  });

  it("returns a builder for condition + condition engine", () => {
    const stage: PipelineStageConfig = {
      name: "route",
      type: "condition",
      runtime: { engine: "condition", branches: [{ when: "store.x == true", to: "a" }, { default: true, to: "b" }] },
    };
    const builder = getStageBuilder(stage);
    expect(builder).toBeTypeOf("function");

    const result = builder!("next", "prev", stage);
    expect(mockBuildConditionState).toHaveBeenCalledWith("next", "prev", stage, undefined);
    expect(result).toEqual({ mocked: "condition" });
  });

  it("returns a builder for pipeline + pipeline engine", () => {
    const stage: PipelineStageConfig = {
      name: "sub-call",
      type: "pipeline",
      runtime: { engine: "pipeline", pipeline_name: "child-pipeline" },
    };
    const builder = getStageBuilder(stage);
    expect(builder).toBeTypeOf("function");

    const result = builder!("next", "prev", stage);
    expect(mockBuildPipelineCallState).toHaveBeenCalledWith("next", "prev", stage, undefined);
    expect(result).toEqual({ mocked: "pipeline" });
  });

  it("returns a builder for foreach + foreach engine", () => {
    const stage: PipelineStageConfig = {
      name: "iterate",
      type: "foreach",
      runtime: { engine: "foreach", items: "store.list", item_var: "item", pipeline_name: "child" },
    };
    const builder = getStageBuilder(stage);
    expect(builder).toBeTypeOf("function");

    const result = builder!("next", "prev", stage);
    expect(mockBuildForeachState).toHaveBeenCalledWith("next", "prev", stage, undefined);
    expect(result).toEqual({ mocked: "foreach" });
  });

  it("returns null for condition with wrong engine", () => {
    const stage: PipelineStageConfig = {
      name: "x",
      type: "condition",
      runtime: { engine: "llm" as any, system_prompt: "y" },
    };
    expect(getStageBuilder(stage)).toBeNull();
  });
});
