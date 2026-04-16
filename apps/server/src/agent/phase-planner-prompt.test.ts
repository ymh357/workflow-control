import { describe, it, expect } from "vitest";
import { buildPhasePlannerPrompt } from "./phase-planner-prompt.js";

describe("buildPhasePlannerPrompt", () => {
  it("includes phase name and goal", () => {
    const prompt = buildPhasePlannerPrompt({
      phaseName: "Research",
      phaseGoal: "Collect and verify primary sources",
      availableContext: ["pipelineConfig", "projectContext"],
    });
    expect(prompt).toContain("Research");
    expect(prompt).toContain("Collect and verify primary sources");
  });

  it("lists available context keys", () => {
    const prompt = buildPhasePlannerPrompt({
      phaseName: "X",
      phaseGoal: "Y",
      availableContext: ["analysis", "plan"],
    });
    expect(prompt).toContain("`analysis`");
    expect(prompt).toContain("`plan`");
  });

  it("uses default maxStages and engine", () => {
    const prompt = buildPhasePlannerPrompt({
      phaseName: "X",
      phaseGoal: "Y",
      availableContext: [],
    });
    expect(prompt).toContain("Maximum 8 stages");
    expect(prompt).toContain('"claude"');
  });

  it("respects custom maxStages and engine", () => {
    const prompt = buildPhasePlannerPrompt({
      phaseName: "X",
      phaseGoal: "Y",
      availableContext: [],
      maxStages: 5,
      enginePreference: "gemini",
    });
    expect(prompt).toContain("Maximum 5 stages");
    expect(prompt).toContain('"gemini"');
  });

  it("includes store_schema guidance", () => {
    const prompt = buildPhasePlannerPrompt({
      phaseName: "X",
      phaseGoal: "Y",
      availableContext: [],
    });
    expect(prompt).toContain("store_schema");
    expect(prompt).toContain("inline_prompts");
  });
});
