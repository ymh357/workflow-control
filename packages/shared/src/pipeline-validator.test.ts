import { describe, it, expect } from "vitest";
import { validatePipelineLogic, getValidationErrors, validatePromptAlignment } from "./pipeline-validator.js";

// ── Helpers ──

function agent(name: string, runtime?: Record<string, unknown>): {
  name: string; type: "agent"; runtime?: Record<string, unknown>
} {
  return { name, type: "agent", ...(runtime ? { runtime } : {}) };
}

function script(name: string, runtime?: Record<string, unknown>): {
  name: string; type: "script"; runtime?: Record<string, unknown>
} {
  return { name, type: "script", ...(runtime ? { runtime } : {}) };
}

function humanConfirm(name: string, runtime?: Record<string, unknown>): {
  name: string; type: "human_confirm"; runtime?: Record<string, unknown>
} {
  return { name, type: "human_confirm", ...(runtime ? { runtime } : {}) };
}

function condition(name: string, runtime?: Record<string, unknown>): {
  name: string; type: "condition"; runtime: Record<string, unknown>
} {
  const defaultRuntime = {
    engine: "condition",
    branches: [
      { when: "store.x == true", to: "completed" },
      { default: true, to: "error" },
    ],
  };
  return { name, type: "condition", runtime: runtime ?? defaultRuntime };
}

function pipelineCall(name: string, runtime?: Record<string, unknown>): {
  name: string; type: "pipeline"; runtime: Record<string, unknown>
} {
  const defaultRuntime = { engine: "pipeline", pipeline_name: "child" };
  return { name, type: "pipeline", runtime: runtime ?? defaultRuntime };
}

function foreach(name: string, runtime?: Record<string, unknown>): {
  name: string; type: "foreach"; runtime: Record<string, unknown>
} {
  const defaultRuntime = { engine: "foreach", items: "store.list", item_var: "item", pipeline_name: "child" };
  return { name, type: "foreach", runtime: runtime ?? defaultRuntime };
}

function parallel(name: string, stages: Array<{ name: string; type: "agent" | "script" | "human_confirm" | "condition" | "pipeline" | "foreach"; runtime?: Record<string, unknown> }>): { parallel: { name: string; stages: typeof stages } } {
  return { parallel: { name, stages } };
}

// ── Basic scenarios ──

describe("basic scenarios", () => {
  it("empty stages array returns zero issues", () => {
    expect(validatePipelineLogic([])).toHaveLength(0);
  });

  it("single valid agent stage with no reads/writes/routing returns zero issues", () => {
    expect(validatePipelineLogic([agent("analyze")])).toHaveLength(0);
  });

  it("omitting promptKeys skips prompt existence check", () => {
    const issues = validatePipelineLogic([agent("analyze")]);
    expect(issues).toHaveLength(0);
  });

  it("omitting knownMcps skips MCP reference check", () => {
    const stage = { ...agent("analyze"), mcps: ["nonexistent-mcp"] };
    const issues = validatePipelineLogic([stage]);
    expect(issues).toHaveLength(0);
  });

  it("getValidationErrors filters out warning and info, keeps only error", () => {
    const stages = [
      agent("stageA", { writes: ["key1"] }),
      agent("stageB", { writes: ["key1"] }),
    ];
    const issues = validatePipelineLogic(stages);
    const warnings = issues.filter(i => i.severity === "warning");
    expect(warnings.length).toBeGreaterThan(0);
    const errors = getValidationErrors(issues);
    expect(errors.every(i => i.severity === "error")).toBe(true);
  });
});

// ── Agent prompt existence ──

describe("agent prompt existence", () => {
  it("stage name matching a prompt key returns no error", () => {
    const issues = validatePipelineLogic(
      [agent("analyze")],
      new Set(["analyze"]),
    );
    expect(issues.filter(i => i.field === "system_prompt")).toHaveLength(0);
  });

  it("stage name not matching any prompt key returns error with field=system_prompt", () => {
    const issues = validatePipelineLogic(
      [agent("analyze")],
      new Set(["other-prompt"]),
    );
    const errs = issues.filter(i => i.field === "system_prompt");
    expect(errs).toHaveLength(1);
    expect(errs[0].severity).toBe("error");
  });

  it("runtime.system_prompt takes priority over stage name as prompt key", () => {
    const issues = validatePipelineLogic(
      [agent("analyze", { system_prompt: "custom-prompt" })],
      new Set(["custom-prompt"]),
    );
    expect(issues.filter(i => i.field === "system_prompt")).toHaveLength(0);
  });

  it("camelCase stage name normalizes to kebab-case for prompt lookup", () => {
    const issues = validatePipelineLogic(
      [agent("analyzeCode")],
      new Set(["analyze-code"]),
    );
    expect(issues.filter(i => i.field === "system_prompt")).toHaveLength(0);
  });

  it("script type does not check prompt existence", () => {
    const issues = validatePipelineLogic(
      [script("buildStep")],
      new Set(["other"]),
    );
    expect(issues.filter(i => i.field === "system_prompt")).toHaveLength(0);
  });

  it("human_confirm type does not check prompt existence", () => {
    const issues = validatePipelineLogic(
      [humanConfirm("approvalStep")],
      new Set(["other"]),
    );
    expect(issues.filter(i => i.field === "system_prompt")).toHaveLength(0);
  });
});

// ── MCP reference existence ──

describe("MCP reference existence", () => {
  it("referencing a registered MCP returns no error", () => {
    const stage = { ...agent("analyze"), mcps: ["notion"] };
    const issues = validatePipelineLogic([stage], undefined, new Set(["notion"]));
    expect(issues.filter(i => i.field === "mcps")).toHaveLength(0);
  });

  it("referencing an unregistered MCP returns warning with field=mcps and MCP name in message", () => {
    const stage = { ...agent("analyze"), mcps: ["nonexistent"] };
    const issues = validatePipelineLogic([stage], undefined, new Set(["notion"]));
    const errs = issues.filter(i => i.field === "mcps");
    expect(errs).toHaveLength(1);
    expect(errs[0].severity).toBe("warning");
    expect(errs[0].message).toContain("nonexistent");
  });

  it("stage with no mcps field returns no MCP errors", () => {
    const issues = validatePipelineLogic([agent("analyze")], undefined, new Set(["notion"]));
    expect(issues.filter(i => i.field === "mcps")).toHaveLength(0);
  });
});

// ── Reads reference upstream writes ──

describe("reads reference upstream writes", () => {
  it("stageB reads key written by stageA returns no error", () => {
    const issues = validatePipelineLogic([
      agent("stageA", { writes: ["result"] }),
      agent("stageB", { reads: { data: "result" } }),
    ]);
    expect(issues.filter(i => i.field === "reads")).toHaveLength(0);
  });

  it("stageB reads a key not written by any prior stage returns error with field=reads", () => {
    const issues = validatePipelineLogic([
      agent("stageB", { reads: { data: "nonexistent" } }),
    ]);
    const errs = issues.filter(i => i.field === "reads");
    expect(errs).toHaveLength(1);
    expect(errs[0].severity).toBe("error");
  });

  it("dot-path source only checks root key (stageA.result.name checks 'stageA')", () => {
    const issues = validatePipelineLogic([
      agent("stageA", { writes: ["stageA"] }),
      agent("stageB", { reads: { name: "stageA.result.name" } }),
    ]);
    expect(issues.filter(i => i.field === "reads")).toHaveLength(0);
  });

  it("reads referencing writes from inside a preceding parallel group returns no error", () => {
    const issues = validatePipelineLogic([
      parallel("group1", [
        agent("subA", { writes: ["groupOutput"] }),
        agent("subB", { writes: ["otherKey"] }),
      ]),
      agent("stageC", { reads: { data: "groupOutput" } }),
    ]);
    expect(issues.filter(i => i.field === "reads")).toHaveLength(0);
  });
});

// ── Writes duplication ──

describe("writes duplication across stages", () => {
  it("two serial stages writing the same key — second stage gets warning with field=writes", () => {
    const issues = validatePipelineLogic([
      agent("stageA", { writes: ["key1"] }),
      agent("stageB", { writes: ["key1"] }),
    ]);
    const warnings = issues.filter(i => i.field === "writes" && i.severity === "warning");
    expect(warnings).toHaveLength(1);
  });

  it("two stages writing different keys returns no duplicate warning", () => {
    const issues = validatePipelineLogic([
      agent("stageA", { writes: ["key1"] }),
      agent("stageB", { writes: ["key2"] }),
    ]);
    expect(issues.filter(i => i.field === "writes")).toHaveLength(0);
  });

  it("first stage writing a key does not get a warning", () => {
    const issues = validatePipelineLogic([
      agent("stageA", { writes: ["key1"] }),
    ]);
    expect(issues.filter(i => i.field === "writes")).toHaveLength(0);
  });
});

// ── on_reject_to routing ──

describe("on_reject_to routing", () => {
  it("on_reject_to pointing to an existing stage returns no error", () => {
    const issues = validatePipelineLogic([
      agent("stageA", { on_reject_to: "stageB" }),
      agent("stageB"),
    ]);
    expect(issues.filter(i => i.field === "on_reject_to")).toHaveLength(0);
  });

  it("on_reject_to pointing to a non-existent stage returns error", () => {
    const issues = validatePipelineLogic([
      agent("stageA", { on_reject_to: "missing" }),
    ]);
    const errs = issues.filter(i => i.field === "on_reject_to");
    expect(errs).toHaveLength(1);
    expect(errs[0].severity).toBe("error");
  });

  it("on_reject_to 'error' is a reserved value and returns no error", () => {
    const issues = validatePipelineLogic([
      agent("stageA", { on_reject_to: "error" }),
    ]);
    expect(issues.filter(i => i.field === "on_reject_to")).toHaveLength(0);
  });
});

// ── on_approve_to routing ──

describe("on_approve_to routing", () => {
  it("on_approve_to pointing to an existing stage returns no error", () => {
    const issues = validatePipelineLogic([
      humanConfirm("review", { on_approve_to: "deploy" }),
      agent("deploy"),
    ]);
    expect(issues.filter(i => i.field === "on_approve_to")).toHaveLength(0);
  });

  it("on_approve_to pointing to a non-existent stage returns error", () => {
    const issues = validatePipelineLogic([
      humanConfirm("review", { on_approve_to: "missing" }),
    ]);
    const errs = issues.filter(i => i.field === "on_approve_to");
    expect(errs).toHaveLength(1);
    expect(errs[0].severity).toBe("error");
  });
});

// ── retry.back_to routing ──

describe("retry.back_to routing", () => {
  it("retry.back_to pointing to an existing stage returns no error", () => {
    const issues = validatePipelineLogic([
      agent("stageA"),
      agent("stageB", { retry: { back_to: "stageA" } }),
    ]);
    expect(issues.filter(i => i.field === "retry")).toHaveLength(0);
  });

  it("retry.back_to pointing to a non-existent stage returns error", () => {
    const issues = validatePipelineLogic([
      agent("stageA", { retry: { back_to: "missing" } }),
    ]);
    const errs = issues.filter(i => i.field === "retry");
    expect(errs).toHaveLength(1);
    expect(errs[0].severity).toBe("error");
  });
});

// ── outputs field key duplication ──

describe("outputs field key duplication", () => {
  it("fields with no duplicate keys returns no warning", () => {
    const stage = {
      ...agent("stageA"),
      outputs: {
        result: {
          type: "object",
          fields: [{ key: "title" }, { key: "body" }],
        },
      },
    };
    const issues = validatePipelineLogic([stage]);
    expect(issues.filter(i => i.field === "outputs")).toHaveLength(0);
  });

  it("duplicate field keys in same storeKey returns warning", () => {
    const stage = {
      ...agent("stageA"),
      outputs: {
        result: {
          type: "object",
          fields: [{ key: "title" }, { key: "title" }],
        },
      },
    };
    const issues = validatePipelineLogic([stage]);
    const warnings = issues.filter(i => i.field === "outputs" && i.severity === "warning");
    expect(warnings).toHaveLength(1);
  });

  it("outputs with no fields array returns no warning", () => {
    const stage = {
      ...agent("stageA"),
      outputs: { result: { type: "string" } },
    };
    const issues = validatePipelineLogic([stage]);
    expect(issues.filter(i => i.field === "outputs")).toHaveLength(0);
  });
});

// ── writes/outputs consistency ──

describe("writes/outputs consistency", () => {
  it("no warning when writes and outputs keys match", () => {
    const stage = {
      ...agent("stageA", { writes: ["analysis"] }),
      outputs: { analysis: { type: "object", fields: [{ key: "summary" }] } },
    };
    const issues = validatePipelineLogic([stage]);
    expect(issues.filter(i => i.message.includes("no matching outputs"))).toHaveLength(0);
    expect(issues.filter(i => i.message.includes("does not include it in writes"))).toHaveLength(0);
  });

  it("warning when writes key has no matching outputs entry", () => {
    const stage = {
      ...agent("stageA", { writes: ["analysis"] }),
      outputs: { report: { type: "object", fields: [{ key: "summary" }] } },
    };
    const issues = validatePipelineLogic([stage]);
    const warnings = issues.filter(i => i.severity === "warning" && i.message.includes('"analysis"') && i.message.includes("no matching outputs"));
    expect(warnings).toHaveLength(1);
  });

  it("warning when outputs key is not in writes", () => {
    const stage = {
      ...agent("stageA", { writes: ["analysis"] }),
      outputs: {
        analysis: { type: "object", fields: [{ key: "summary" }] },
        report: { type: "object", fields: [{ key: "body" }] },
      },
    };
    const issues = validatePipelineLogic([stage]);
    const warnings = issues.filter(i => i.severity === "warning" && i.message.includes('"report"') && i.message.includes("does not include it in writes"));
    expect(warnings).toHaveLength(1);
  });

  it("no warning for stages without writes", () => {
    const stage = {
      ...agent("stageA"),
      outputs: { report: { type: "object", fields: [{ key: "body" }] } },
    };
    const issues = validatePipelineLogic([stage]);
    expect(issues.filter(i => i.message.includes("no matching outputs") || i.message.includes("does not include it in writes"))).toHaveLength(0);
  });

  it("no warning for stages with empty writes", () => {
    const stage = {
      ...agent("stageA", { writes: [] }),
      outputs: { report: { type: "object", fields: [{ key: "body" }] } },
    };
    const issues = validatePipelineLogic([stage]);
    expect(issues.filter(i => i.message.includes("does not include it in writes"))).toHaveLength(0);
  });

  it("applies to script stages too", () => {
    const stage = {
      ...script("buildStep", { writes: ["build"] }),
      outputs: { deploy: { type: "object", fields: [{ key: "url" }] } },
    };
    const issues = validatePipelineLogic([stage]);
    const warnings = issues.filter(i => i.severity === "warning" && (i.message.includes("no matching outputs") || i.message.includes("does not include it in writes")));
    expect(warnings).toHaveLength(2);
  });

  it("does not apply to condition or pipeline stages", () => {
    const stage1 = {
      ...condition("route"),
      outputs: { result: { type: "string" } },
    };
    const stage2 = {
      ...pipelineCall("sub"),
      outputs: { result: { type: "string" } },
    };
    const issues = validatePipelineLogic([stage1, stage2]);
    expect(issues.filter(i => i.message.includes("no matching outputs") || i.message.includes("does not include it in writes"))).toHaveLength(0);
  });
});

// ── Parallel group: minimum stage count ──

describe("parallel group minimum stage count", () => {
  it("parallel group with 2 stages returns no error", () => {
    const issues = validatePipelineLogic([
      parallel("group1", [agent("subA"), agent("subB")]),
    ]);
    expect(issues.filter(i => i.message.includes("at least 2"))).toHaveLength(0);
  });

  it("parallel group with only 1 stage returns error", () => {
    const issues = validatePipelineLogic([
      parallel("group1", [agent("subA")]),
    ]);
    const errs = issues.filter(i => i.severity === "error" && i.message.includes("at least 2"));
    expect(errs).toHaveLength(1);
  });
});

// ── Parallel group: human_confirm forbidden ──

describe("parallel group human_confirm forbidden", () => {
  it("parallel group containing human_confirm returns error", () => {
    const issues = validatePipelineLogic([
      parallel("group1", [agent("subA"), humanConfirm("review")]),
    ]);
    const errs = issues.filter(i => i.severity === "error" && i.message.includes("human_confirm"));
    expect(errs).toHaveLength(1);
  });

  it("parallel group with only agent and script stages returns no human_confirm error", () => {
    const issues = validatePipelineLogic([
      parallel("group1", [agent("subA"), script("build")]),
    ]);
    expect(issues.filter(i => i.message.includes("human_confirm"))).toHaveLength(0);
  });
});

// ── Parallel group: writes overlap ──

describe("parallel group internal writes overlap", () => {
  it("two sub-stages writing different keys returns no overlap error", () => {
    const issues = validatePipelineLogic([
      parallel("group1", [
        agent("subA", { writes: ["keyA"] }),
        agent("subB", { writes: ["keyB"] }),
      ]),
    ]);
    expect(issues.filter(i => i.message.includes("overlaps"))).toHaveLength(0);
  });

  it("two sub-stages writing the same key returns error with both stage names", () => {
    const issues = validatePipelineLogic([
      parallel("group1", [
        agent("subA", { writes: ["sharedKey"] }),
        agent("subB", { writes: ["sharedKey"] }),
      ]),
    ]);
    const errs = issues.filter(i => i.severity === "error" && i.message.includes("overlaps"));
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain("subA");
    expect(errs[0].message).toContain("subB");
  });

  it("writes overlap check only applies within the parallel group, not with outer serial stages", () => {
    const issues = validatePipelineLogic([
      agent("before", { writes: ["sharedKey"] }),
      parallel("group1", [
        agent("subA", { writes: ["sharedKey"] }),
        agent("subB", { writes: ["otherKey"] }),
      ]),
    ]);
    // Should not get overlap error (different rule: serial dup gets warning, not this rule)
    expect(issues.filter(i => i.message.includes("overlaps"))).toHaveLength(0);
  });
});

// ── Parallel group: retry.back_to boundary ──

describe("parallel group retry.back_to boundary", () => {
  it("retry.back_to pointing to another sub-stage within the group returns no error", () => {
    const issues = validatePipelineLogic([
      parallel("group1", [
        agent("subA"),
        agent("subB", { retry: { back_to: "subA" } }),
      ]),
    ]);
    expect(issues.filter(i => i.message.includes("outside the parallel group"))).toHaveLength(0);
  });

  it("retry.back_to pointing to a stage outside the group returns error", () => {
    const issues = validatePipelineLogic([
      agent("outerStage"),
      parallel("group1", [
        agent("subA"),
        agent("subB", { retry: { back_to: "outerStage" } }),
      ]),
    ]);
    const errs = issues.filter(i => i.severity === "error" && i.message.includes("outside the parallel group"));
    expect(errs).toHaveLength(1);
  });

  it("sub-stage with no retry returns no error", () => {
    const issues = validatePipelineLogic([
      parallel("group1", [agent("subA"), agent("subB")]),
    ]);
    expect(issues.filter(i => i.message.includes("outside the parallel group"))).toHaveLength(0);
  });
});

// ── Parallel group: reads cannot reference sibling writes ──

describe("parallel group reads cannot reference sibling writes", () => {
  it("reads referencing a key outside the group returns no sibling error", () => {
    const issues = validatePipelineLogic([
      agent("outer", { writes: ["externalKey"] }),
      parallel("group1", [
        agent("subA", { reads: { data: "externalKey" } }),
        agent("subB"),
      ]),
    ]);
    expect(issues.filter(i => i.message.includes("written by a sibling"))).toHaveLength(0);
  });

  it("reads referencing a key written by a sibling sub-stage returns error", () => {
    const issues = validatePipelineLogic([
      parallel("group1", [
        agent("subA", { writes: ["siblingKey"] }),
        agent("subB", { reads: { data: "siblingKey" } }),
      ]),
    ]);
    const errs = issues.filter(i => i.severity === "error" && i.message.includes("written by a sibling"));
    expect(errs).toHaveLength(1);
  });

  it("a stage reading its own write key is not flagged as sibling dependency", () => {
    const issues = validatePipelineLogic([
      agent("outer", { writes: ["selfKey"] }),
      parallel("group1", [
        agent("subA", { writes: ["selfKey"], reads: { data: "selfKey" } }),
        agent("subB"),
      ]),
    ]);
    // subA reads "selfKey" which it also writes — should not be flagged as sibling issue
    expect(issues.filter(i => i.message.includes("written by a sibling"))).toHaveLength(0);
  });
});

// ── stageIndex correctness ──

describe("stageIndex correctness", () => {
  it("parallel group issue has stageIndex matching its position in the stages array", () => {
    const issues = validatePipelineLogic([
      agent("first"),
      agent("second"),
      parallel("group1", [agent("subA")]), // index 2
    ]);
    const errs = issues.filter(i => i.message.includes("at least 2"));
    expect(errs[0].stageIndex).toBe(2);
  });

  it("child stage validate error inside parallel group uses the group's entry index", () => {
    const issues = validatePipelineLogic(
      [
        parallel("group1", [
          agent("subA"),
          agent("subB"),
        ]),
      ],
      new Set(["other-prompt"]), // neither subA nor subB match
    );
    const promptErrs = issues.filter(i => i.field === "system_prompt");
    expect(promptErrs.length).toBeGreaterThan(0);
    // All errors should use stageIndex=0 (the parallel group is at index 0)
    for (const err of promptErrs) {
      expect(err.stageIndex).toBe(0);
    }
  });
});

// ── New stage types ──

describe("new stage types (condition, pipeline, foreach)", () => {
  it("condition stage produces no issues when well-formed", () => {
    const issues = validatePipelineLogic([
      agent("work", { engine: "llm", system_prompt: "work", writes: ["result"] }),
      condition("route"),
    ]);
    expect(getValidationErrors(issues)).toHaveLength(0);
  });

  it("pipeline stage produces no issues when well-formed", () => {
    const issues = validatePipelineLogic([
      agent("work", { engine: "llm", system_prompt: "work", writes: ["data"] }),
      pipelineCall("sub", { engine: "pipeline", pipeline_name: "child", reads: { input: "data" } }),
    ]);
    expect(getValidationErrors(issues)).toHaveLength(0);
  });

  it("foreach stage produces no issues when well-formed", () => {
    const issues = validatePipelineLogic([
      agent("work", { engine: "llm", system_prompt: "work", writes: ["items"] }),
      foreach("loop", { engine: "foreach", items: "items", item_var: "item", pipeline_name: "child", reads: { list: "items" } }),
    ]);
    expect(getValidationErrors(issues)).toHaveLength(0);
  });

  it("condition stage does not require prompt validation", () => {
    const issues = validatePipelineLogic(
      [condition("route")],
      new Set(["some-prompt"]),
    );
    const promptErrs = issues.filter(i => i.field === "system_prompt");
    expect(promptErrs).toHaveLength(0);
  });

  it("pipeline/foreach stages do not require prompt validation", () => {
    const issues = validatePipelineLogic(
      [
        pipelineCall("sub", { engine: "pipeline", pipeline_name: "child" }),
        foreach("loop", { engine: "foreach", items: "store.list", item_var: "item", pipeline_name: "child" }),
      ],
      new Set(["some-prompt"]),
    );
    const promptErrs = issues.filter(i => i.field === "system_prompt");
    expect(promptErrs).toHaveLength(0);
  });

  it("condition: error when no default branch", () => {
    const issues = validatePipelineLogic([
      condition("route", { engine: "condition", branches: [{ when: "store.x", to: "completed" }] }),
    ]);
    const errors = getValidationErrors(issues);
    expect(errors.some(e => e.message.includes("exactly 1 default branch"))).toBe(true);
  });

  it("condition: error when no non-default branch", () => {
    const issues = validatePipelineLogic([
      condition("route", { engine: "condition", branches: [{ default: true, to: "completed" }] }),
    ]);
    const errors = getValidationErrors(issues);
    expect(errors.some(e => e.message.includes("at least 1 non-default"))).toBe(true);
  });

  it("condition: error when branch.to references non-existent stage", () => {
    const issues = validatePipelineLogic([
      condition("route", { engine: "condition", branches: [
        { when: "store.x", to: "ghost" },
        { default: true, to: "completed" },
      ] }),
    ]);
    const errors = getValidationErrors(issues);
    expect(errors.some(e => e.message.includes("ghost"))).toBe(true);
  });

  it("pipeline: error when missing pipeline_name", () => {
    const issues = validatePipelineLogic([
      pipelineCall("sub", { engine: "pipeline" }),
    ]);
    const errors = getValidationErrors(issues);
    expect(errors.some(e => e.message.includes("pipeline_name"))).toBe(true);
  });

  it("foreach: error when missing items", () => {
    const issues = validatePipelineLogic([
      foreach("loop", { engine: "foreach", item_var: "x", pipeline_name: "c" }),
    ]);
    const errors = getValidationErrors(issues);
    expect(errors.some(e => e.message.includes("runtime.items"))).toBe(true);
  });

  it("foreach: error when missing item_var", () => {
    const issues = validatePipelineLogic([
      foreach("loop", { engine: "foreach", items: "store.list", pipeline_name: "c" }),
    ]);
    const errors = getValidationErrors(issues);
    expect(errors.some(e => e.message.includes("runtime.item_var"))).toBe(true);
  });

  it("foreach: error when missing pipeline_name", () => {
    const issues = validatePipelineLogic([
      foreach("loop", { engine: "foreach", items: "store.list", item_var: "x" }),
    ]);
    const errors = getValidationErrors(issues);
    expect(errors.some(e => e.message.includes("pipeline_name"))).toBe(true);
  });

  it("foreach: collect_to tracked as implicit write", () => {
    const issues = validatePipelineLogic([
      foreach("loop", { engine: "foreach", items: "store.list", item_var: "x", pipeline_name: "c", collect_to: "results" }),
      agent("summarize", { engine: "llm", system_prompt: "summarize", reads: { r: "results" } }),
    ]);
    // "results" should be recognized as written by foreach's collect_to
    const readErrors = issues.filter(i => i.field === "reads");
    expect(readErrors).toHaveLength(0);
  });
});

// ── Prompt alignment validation ──

describe("validatePromptAlignment", () => {
  it("returns no issues when prompt content is clean", () => {
    const stages = [
      agent("analyze", { system_prompt: "analyze", writes: ["analysis"] }),
    ];
    const prompts = new Map([
      ["analyze", "You are an analyst.\n\n## Workflow\n\n### Step 1 — Analyze\nExamine the data."],
    ]);
    const issues = validatePromptAlignment(stages, prompts);
    expect(issues).toHaveLength(0);
  });

  it("warns when plan mode prompt references tool usage", () => {
    const stages = [
      { ...agent("analyze", { system_prompt: "analyze", writes: ["analysis"] }), permission_mode: "plan" },
    ];
    const prompts = new Map([
      ["analyze", "You are an analyst.\n\n## Workflow\n\nRead the file src/index.ts and analyze it."],
    ]);
    const issues = validatePromptAlignment(stages as any, prompts);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].severity).toBe("warning");
    expect(issues[0].message).toContain("permission_mode:plan");
  });

  it("warns when plan mode prompt references get_store_value", () => {
    const stages = [
      { ...agent("analyze", { system_prompt: "analyze", writes: ["analysis"] }), permission_mode: "plan" },
    ];
    const prompts = new Map([
      ["analyze", "Use get_store_value to fetch additional context if needed."],
    ]);
    const issues = validatePromptAlignment(stages as any, prompts);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain("permission_mode:plan");
  });

  it("warns when disallowed tool is referenced in prompt", () => {
    const stages = [
      agent("review", { system_prompt: "review", writes: ["result"], disallowed_tools: ["Edit", "Write", "Bash"] }),
    ];
    const prompts = new Map([
      ["review", "You are a reviewer.\n\n## Workflow\n\nUse Edit to fix any issues you find."],
    ]);
    const issues = validatePromptAlignment(stages, prompts);
    const editWarning = issues.filter(i => i.message.includes('"Edit"'));
    expect(editWarning).toHaveLength(1);
    expect(editWarning[0].severity).toBe("warning");
  });

  it("does not warn for allowed tools", () => {
    const stages = [
      agent("review", { system_prompt: "review", writes: ["result"], disallowed_tools: ["Edit"] }),
    ];
    const prompts = new Map([
      ["review", "Use Read and Grep to explore the codebase."],
    ]);
    const issues = validatePromptAlignment(stages, prompts);
    expect(issues).toHaveLength(0);
  });

  it("skips non-agent stages", () => {
    const stages = [
      script("build", { writes: ["result"] }),
    ];
    const prompts = new Map([
      ["build", "Read the file and Edit it — this should not trigger warnings."],
    ]);
    const issues = validatePromptAlignment(stages, prompts);
    expect(issues).toHaveLength(0);
  });

  it("skips stages with no matching prompt", () => {
    const stages = [
      agent("analyze", { system_prompt: "analyze", writes: ["analysis"] }),
    ];
    const prompts = new Map<string, string>();
    const issues = validatePromptAlignment(stages, prompts);
    expect(issues).toHaveLength(0);
  });

  it("handles camelCase to kebab-case prompt name normalization", () => {
    const stages = [
      { ...agent("analyzeCode", { system_prompt: "analyzeCode", writes: ["analysis"] }), permission_mode: "plan" },
    ];
    const prompts = new Map([
      ["analyze-code", "Read the file and analyze it."],
    ]);
    const issues = validatePromptAlignment(stages as any, prompts);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain("analyzeCode");
  });

  it("handles parallel group children", () => {
    const stages = [
      parallel("group1", [
        { ...agent("subA", { system_prompt: "sub-a", writes: ["resultA"] }), permission_mode: "plan" } as any,
        agent("subB", { system_prompt: "sub-b", writes: ["resultB"] }),
      ]),
    ];
    const prompts = new Map([
      ["sub-a", "Search for patterns in the codebase using Grep."],
      ["sub-b", "You are an analyst. Examine the provided data."],
    ]);
    const issues = validatePromptAlignment(stages, prompts);
    // subA is plan mode and references Grep — should warn
    const subAIssues = issues.filter(i => i.message.includes("subA"));
    expect(subAIssues.length).toBeGreaterThan(0);
    // subB has no issues
    const subBIssues = issues.filter(i => i.message.includes("subB"));
    expect(subBIssues).toHaveLength(0);
  });

  it("only triggers one warning per plan-mode stage (breaks on first match)", () => {
    const stages = [
      { ...agent("analyze", { system_prompt: "analyze", writes: ["analysis"] }), permission_mode: "plan" },
    ];
    const prompts = new Map([
      ["analyze", "Read the file, then Search for patterns, then use Bash to run tests."],
    ]);
    const issues = validatePromptAlignment(stages as any, prompts);
    // Should only have 1 warning (breaks after first match)
    const planIssues = issues.filter(i => i.message.includes("permission_mode:plan"));
    expect(planIssues).toHaveLength(1);
  });
});
