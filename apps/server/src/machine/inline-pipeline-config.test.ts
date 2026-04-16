import { describe, it, expect } from "vitest";
import { buildInlinePipelineConfig } from "./inline-pipeline-config.js";
import type { PipelineConfig } from "../lib/config/types.js";
import type { WorkflowContext } from "./types.js";

describe("buildInlinePipelineConfig", () => {
  const parentConfig: WorkflowContext["config"] = {
    pipelineName: "meta-pipeline",
    pipeline: { name: "Meta", stages: [] },
    prompts: {
      system: {},
      fragments: { "frag-1": "Fragment content" },
      fragmentMeta: { "frag-1": { id: "frag-1", keywords: [], stages: "*" as const, always: true } },
      globalConstraints: "Be careful",
      globalClaudeMd: "# Project",
      globalGeminiMd: "",
      globalCodexMd: "",
    },
    skills: [],
    mcps: ["notion"],
  };

  const inlinePipeline: PipelineConfig = {
    name: "Phase 1",
    engine: "claude",
    stages: [
      { name: "analyze", type: "agent", runtime: { engine: "llm" as const, system_prompt: "analyze" } },
    ],
    inline_prompts: {
      analyze: "You are analyzing the task.",
    },
  };

  it("builds config with inline prompts", () => {
    const config = buildInlinePipelineConfig(inlinePipeline, parentConfig);
    expect(config.pipelineName).toBe("Phase 1");
    expect(config.pipeline).toBe(inlinePipeline);
    expect(config.prompts.system.analyze).toBe("You are analyzing the task.");
  });

  it("inherits fragments from parent", () => {
    const config = buildInlinePipelineConfig(inlinePipeline, parentConfig);
    expect(config.prompts.fragments["frag-1"]).toBe("Fragment content");
  });

  it("inherits global constraints from parent", () => {
    const config = buildInlinePipelineConfig(inlinePipeline, parentConfig);
    expect(config.prompts.globalConstraints).toBe("Be careful");
  });

  it("inherits mcps from parent", () => {
    const config = buildInlinePipelineConfig(inlinePipeline, parentConfig);
    expect(config.mcps).toContain("notion");
  });

  it("works without inline_prompts", () => {
    const noPrompts = { ...inlinePipeline, inline_prompts: undefined };
    const config = buildInlinePipelineConfig(noPrompts, parentConfig);
    expect(config.prompts.system).toEqual({});
  });

  it("works without parent config", () => {
    const config = buildInlinePipelineConfig(inlinePipeline, undefined);
    expect(config.prompts.fragments).toEqual({});
    expect(config.prompts.globalConstraints).toBe("");
  });
});
