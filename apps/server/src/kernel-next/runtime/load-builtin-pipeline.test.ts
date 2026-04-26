import { describe, it, expect } from "vitest";
import { loadBuiltinPipelineIR, BuiltinPipelineLoadError } from "./load-builtin-pipeline.js";

describe("loadBuiltinPipelineIR", () => {
  it("loads smoke-test IR + prompts", () => {
    const r = loadBuiltinPipelineIR("smoke-test");
    expect(r.ir.name).toBeTruthy();
    expect(r.ir.stages.length).toBeGreaterThan(0);
    expect(r.pipelineDir).toMatch(/smoke-test$/);
    expect(r.promptRoot).toMatch(/smoke-test\/prompts$/);
    expect(Object.keys(r.prompts).length).toBeGreaterThan(0);
    expect(r.warnings).toEqual([]);
  });

  it("loads pipeline-generator with nested system/ prompts", () => {
    const r = loadBuiltinPipelineIR("pipeline-generator");
    const keys = Object.keys(r.prompts);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k).not.toMatch(/\.md$/);
      expect(k).not.toMatch(/\\/);
    }
    expect(keys.some((k) => k.includes("/"))).toBe(true);
  });

  it("throws BuiltinPipelineLoadError when pipeline.ir.json is missing", () => {
    expect(() => loadBuiltinPipelineIR("no-such-pipeline-xyz")).toThrow(BuiltinPipelineLoadError);
    try {
      loadBuiltinPipelineIR("no-such-pipeline-xyz");
    } catch (err) {
      const e = err as BuiltinPipelineLoadError;
      expect(e.diagnostics[0]?.code).toBe("IR_READ_FAILED");
    }
  });

  it("loads tech-research-collector", () => {
    const r = loadBuiltinPipelineIR("tech-research-collector");
    expect(r.ir.stages.length).toBeGreaterThan(0);
    expect(Object.keys(r.prompts).length).toBeGreaterThan(0);
  });

  it("loads tech-research-writer", () => {
    const r = loadBuiltinPipelineIR("tech-research-writer");
    expect(r.ir.stages.length).toBeGreaterThan(0);
    expect(Object.keys(r.prompts).length).toBeGreaterThan(0);
  });

  it("loads pr-description-generator (Phase 6 dogfood pipeline)", () => {
    const r = loadBuiltinPipelineIR("pr-description-generator");
    expect(r.ir.name).toBe("PR Description Generator");
    expect(r.ir.stages.map((s) => s.name)).toEqual(["fetchDiff", "writePr"]);
    expect(r.ir.externalInputs?.map((e) => e.name).sort())
      .toEqual(["baseBranch", "branchName", "repoPath"]);
    expect(Object.keys(r.prompts).sort()).toEqual(["system/fetch-diff", "system/write-pr"]);
  });

  it("smoke-test declares session_mode='single' (Task 8 canary)", () => {
    const r = loadBuiltinPipelineIR("smoke-test");
    expect(r.ir.session_mode).toBe("single");
  });

  it("pr-description-generator declares session_mode='single' (Task 9 prod canary)", () => {
    const r = loadBuiltinPipelineIR("pr-description-generator");
    expect(r.ir.session_mode).toBe("single");
  });

  // 2026-04-27 A5 (F20 lock-in): the prompt-writer sub-agent inside the
  // pipeline-generator's analyzeRequirements stage MUST instruct the
  // model to inject a TEMPORAL ANCHOR rule into any research / fact-check
  // / claim-verification stage prompt it generates. The rule was added in
  // commit 6a80602 after the round-7 Arbitrum dogfood produced a
  // "Kelp DAO 资产冻结事件 (2026年5月)" hallucination that was a future-
  // dated projection treated as established fact. If anyone refactors the
  // prompt and accidentally drops this paragraph, every downstream
  // research pipeline regresses silently — only a live dogfood would
  // catch it. This test makes the regression a build failure instead.
  it("pipeline-generator prompt-writer sub-agent retains the TEMPORAL ANCHOR rule (F20)", () => {
    const r = loadBuiltinPipelineIR("pipeline-generator");
    type AgentStageWithSubAgents = {
      type: string;
      config: { subAgents?: Array<{ name: string; prompt: string }> };
    };
    let promptWriterPrompt: string | undefined;
    for (const stage of r.ir.stages) {
      const s = stage as unknown as AgentStageWithSubAgents;
      if (s.type !== "agent" || !s.config.subAgents) continue;
      const writer = s.config.subAgents.find((sa) => sa.name === "prompt-writer");
      if (writer) {
        promptWriterPrompt = writer.prompt;
        break;
      }
    }
    expect(promptWriterPrompt).toBeDefined();
    // The exact phrasing is what gets copied verbatim into generated
    // prompts; assert on the salient tokens so the test survives minor
    // wordsmithing while still failing if the rule is removed.
    expect(promptWriterPrompt).toContain("TEMPORAL ANCHOR");
    expect(promptWriterPrompt).toContain("research, fact-checking, or claim verification");
    expect(promptWriterPrompt).toContain("[Projection");
    expect(promptWriterPrompt).toContain("system date as the report date");
  });
});
