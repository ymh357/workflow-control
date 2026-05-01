import { describe, it, expect } from "vitest";
import { validateStructural } from "./structural.js";
import type { PipelineIR } from "../ir/schema.js";

function base(): PipelineIR {
  return {
    name: "t",
    stages: [
      { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
      { name: "B", type: "agent", inputs: [{ name: "x", type: "number" }], outputs: [], config: { promptRef: "p" } },
    ],
    wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
  };
}

describe("structural validator", () => {
  it("accepts a valid diamond-like IR", () => {
    expect(validateStructural(base())).toEqual({ ok: true });
  });

  it("rejects duplicate stage names", () => {
    const ir = base();
    ir.stages.push({ ...ir.stages[0]! });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("DUPLICATE_STAGE_NAME");
  });

  it("rejects duplicate input port names within a stage", () => {
    const ir = base();
    ir.stages[1]!.inputs.push({ name: "x", type: "string" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "DUPLICATE_PORT_NAME")).toBe(true);
  });

  it("rejects duplicate output port names within a stage", () => {
    const ir = base();
    ir.stages[0]!.outputs.push({ name: "x", type: "string" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "DUPLICATE_PORT_NAME")).toBe(true);
  });

  it("rejects wire pointing to nonexistent source port", () => {
    const ir = base();
    ir.wires[0]!.from.port = "ghost";
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("WIRE_SOURCE_PORT_MISSING");
  });

  it("rejects wire pointing to nonexistent target port", () => {
    const ir = base();
    ir.wires[0]!.to.port = "ghost";
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("WIRE_TARGET_PORT_MISSING");
  });

  it("rejects wire whose source is an input port", () => {
    // wire from B.x (input) -> A.x is bogus
    const ir = base();
    ir.wires = [{ from: { stage: "B", port: "x" }, to: { stage: "A", port: "x" } }];
    // First give A an input so the target exists but still flags source direction.
    ir.stages[0]!.inputs.push({ name: "x", type: "number" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.diagnostics.map((d) => d.code);
      expect(codes).toContain("WIRE_SOURCE_DIRECTION_WRONG");
    }
  });

  it("rejects wire whose target is an output port", () => {
    const ir = base();
    // add z output on B so target resolves
    ir.stages[1]!.outputs.push({ name: "z", type: "string" });
    ir.wires = [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "z" } }];
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.diagnostics.map((d) => d.code);
      expect(codes).toContain("WIRE_TARGET_DIRECTION_WRONG");
    }
  });

  it("rejects two wires driving the same input port", () => {
    const ir = base();
    ir.stages.push({
      name: "C",
      type: "agent",
      inputs: [],
      outputs: [{ name: "x", type: "number" }],
      config: { promptRef: "p" },
    });
    // Both A.x and C.x drive B.x — conflict.
    ir.wires.push({ from: { stage: "C", port: "x" }, to: { stage: "B", port: "x" } });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.diagnostics.map((d) => d.code);
      expect(codes).toContain("WIRE_TARGET_ALREADY_DRIVEN");
    }
  });

  it("rejects entry pointing to missing stage", () => {
    const ir = base();
    ir.entry = "ZZZ";
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics[0]!.code).toBe("ENTRY_STAGE_MISSING");
  });

  it("accumulates multiple diagnostics in one pass", () => {
    const ir = base();
    ir.stages.push({ ...ir.stages[0]! });                          // duplicate stage
    ir.wires[0]!.from.port = "ghost";                              // missing source
    ir.wires.push({ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }); // double-drive B.x
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = new Set(r.diagnostics.map((d) => d.code));
      expect(codes).toContain("DUPLICATE_STAGE_NAME");
      expect(codes).toContain("WIRE_SOURCE_PORT_MISSING");
      expect(codes).toContain("WIRE_TARGET_ALREADY_DRIVEN");
    }
  });

  // --- Stage-type specific rules (A0.1) ---

  it("accepts a pipeline with a gate stage and valid routing", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        {
          name: "G",
          type: "gate",
          inputs: [{ name: "x", type: "number" }],
          outputs: [],
          config: {
            question: { text: "continue?" },
            routing: { routes: { yes: "A" } },
          },
        },
      ],
      wires: [{ from: { stage: "A", port: "x" }, to: { stage: "G", port: "x" } }],
    };
    expect(validateStructural(ir)).toEqual({ ok: true });
  });

  it("rejects gate routing target that is not a declared stage", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        {
          name: "G",
          type: "gate",
          inputs: [{ name: "x", type: "number" }],
          outputs: [],
          config: {
            question: { text: "pick" },
            routing: { routes: { yes: "ZZZ" } },
          },
        },
      ],
      wires: [{ from: { stage: "A", port: "x" }, to: { stage: "G", port: "x" } }],
    };
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.some((d) => d.code === "GATE_ROUTING_TARGET_MISSING")).toBe(true);
    }
  });

  it("rejects a stage whose fanout names a non-existent input port", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [{ name: "x", type: "number" }],
          outputs: [],
          config: { promptRef: "p" },
          fanout: { input: "nope" },
        },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.some((d) => d.code === "FANOUT_INPUT_MISSING")).toBe(true);
    }
  });

  it("accepts a stage with fanout naming an existing input port", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [{ name: "item", type: "number" }],
          outputs: [{ name: "out", type: "string" }],
          config: { promptRef: "p" },
          fanout: { input: "item" },
        },
      ],
      wires: [],
    };
    expect(validateStructural(ir)).toEqual({ ok: true });
  });

  // F6 / concern C3 (RELAXED 2026-04-29) — a stage routed to by more
  // than one gate is now ALLOWED. The investigation-pipeline 12-stage
  // skeleton legitimately has e.g. prereqExtraction shared as
  // framingGate.approve AND prereqGate.reject. See validator/structural.ts
  // for runtime-safety analysis.
  it("accepts a stage routed to by two different gates (formerly GATE_TARGET_SHARED)", () => {
    const ir: PipelineIR = {
      name: "t-shared",
      stages: [
        { name: "SRC", type: "agent", inputs: [],
          outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
        { name: "G1", type: "gate",
          inputs: [{ name: "x", type: "number" }], outputs: [],
          config: {
            question: { text: "?", options: [{ value: "a" }, { value: "b" }] },
            routing: { routes: { a: "SHARED", b: "OTHER" } },
          } },
        { name: "G2", type: "gate",
          inputs: [{ name: "x", type: "number" }], outputs: [],
          config: {
            question: { text: "?", options: [{ value: "c" }, { value: "d" }] },
            routing: { routes: { c: "SHARED", d: "ELSE" } },
          } },
        { name: "SHARED", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
        { name: "OTHER", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
        { name: "ELSE", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
      ],
      wires: [
        { from: { source: "stage", stage: "SRC", port: "x" }, to: { stage: "G1", port: "x" } },
        { from: { source: "stage", stage: "SRC", port: "x" }, to: { stage: "G2", port: "x" } },
      ],
    };
    const r = validateStructural(ir);
    if (!r.ok) {
      // No GATE_TARGET_SHARED diagnostic — that rule is relaxed.
      const shared = r.diagnostics.find((d) => d.code === "GATE_TARGET_SHARED");
      expect(shared).toBeUndefined();
    } else {
      expect(r.ok).toBe(true);
    }
  });

  // Corner case: one gate routing multiple answers to the same stage is
  // NOT a conflict — it's legitimate ("yes" and "confirm" both advance
  // to SUMMARY). Only cross-gate overlap is rejected.
  it("accepts the same target for multiple answers of a single gate", () => {
    // P6-8: fixture now seeds a minimal external-driven dataflow so
    // EMPTY_DATAFLOW doesn't fire. The assertion target (gate routing
    // with repeated same-target) is unchanged.
    const ir: PipelineIR = {
      name: "t-same-gate",
      externalInputs: [{ name: "sig", type: "unknown" }],
      stages: [
        { name: "G", type: "gate",
          inputs: [{ name: "__gate_signal", type: "unknown" }], outputs: [],
          config: {
            question: { text: "?", options: [{ value: "yes" }, { value: "confirm" }, { value: "no" }] },
            routing: { routes: { yes: "OK", confirm: "OK", no: "CANCEL" } },
          } },
        { name: "OK", type: "agent", inputs: [{ name: "ack", type: "unknown" }], outputs: [], config: { promptRef: "p" } },
        { name: "CANCEL", type: "agent", inputs: [{ name: "ack", type: "unknown" }], outputs: [], config: { promptRef: "p" } },
      ],
      wires: [
        { from: { source: "external", port: "sig" }, to: { stage: "G", port: "__gate_signal" } },
      ],
    };
    expect(validateStructural(ir)).toEqual({ ok: true });
  });
});

describe("structural validator — externalInputs", () => {
  function baseWithExt(): PipelineIR {
    return {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [{ name: "ctx", type: "unknown" }], outputs: [], config: { promptRef: "p" } },
      ],
      externalInputs: [{ name: "ctx", type: "unknown" }],
      wires: [{ from: { source: "external", port: "ctx" }, to: { stage: "A", port: "ctx" } }],
    };
  }

  it("accepts a valid external wire", () => {
    expect(validateStructural(baseWithExt())).toEqual({ ok: true });
  });

  it("rejects external wire pointing at an undeclared external port", () => {
    const ir = baseWithExt();
    ir.wires[0]!.from = { source: "external", port: "ghost" };
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "WIRE_EXTERNAL_SOURCE_PORT_MISSING")).toBe(true);
  });

  it("rejects duplicate externalInputs name", () => {
    const ir = baseWithExt();
    ir.externalInputs!.push({ name: "ctx", type: "string" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "DUPLICATE_EXTERNAL_INPUT_NAME")).toBe(true);
  });

  it("rejects external port name colliding with stage name", () => {
    const ir = baseWithExt();
    ir.externalInputs!.push({ name: "A", type: "string" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "EXTERNAL_INPUT_COLLIDES_WITH_STAGE")).toBe(true);
  });

  it("rejects stage named __external__", () => {
    const ir = baseWithExt();
    ir.stages.push({ name: "__external__", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "RESERVED_STAGE_NAME")).toBe(true);
  });

  it("rejects externalInputs named __external__", () => {
    const ir = baseWithExt();
    ir.externalInputs!.push({ name: "__external__", type: "string" });
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.diagnostics.some((d) => d.code === "RESERVED_STAGE_NAME")).toBe(true);
  });
});

describe("structural validator — script moduleId resolution (D'-1)", () => {
  function baseWithScript(moduleId: string): PipelineIR {
    return {
      name: "t",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [],
          outputs: [{ name: "raw", type: "string" }],
          config: { promptRef: "p" },
        },
        {
          name: "B",
          type: "script",
          inputs: [{ name: "raw", type: "string" }],
          outputs: [{ name: "value", type: "unknown" }],
          config: { source: "registry", moduleId },
        },
      ],
      wires: [{ from: { stage: "A", port: "raw" }, to: { stage: "B", port: "raw" } }],
    };
  }

  it("accepts a ScriptStage whose moduleId is in the allowed set", () => {
    const r = validateStructural(baseWithScript("json_parse"), {
      allowedScriptModuleIds: new Set(["json_parse", "json_stringify"]),
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a ScriptStage whose moduleId is missing from the allowed set", () => {
    const r = validateStructural(baseWithScript("hallucinated"), {
      allowedScriptModuleIds: new Set(["json_parse", "json_stringify"]),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const d = r.diagnostics.find((x) => x.code === "SCRIPT_MODULE_NOT_REGISTERED");
      expect(d).toBeDefined();
      expect(d!.message).toContain("hallucinated");
      expect(d!.message).toContain("json_parse");
      expect((d!.context as { stage: string }).stage).toBe("B");
    }
  });

  it("skips the registry check when allowedScriptModuleIds is omitted", () => {
    // Dry-run semantics: validate_pipeline called without the option
    // doesn't enforce registry membership (used by hot-update preview
    // paths that don't care whether the module resolves).
    const r = validateStructural(baseWithScript("hallucinated"));
    expect(r.ok).toBe(true);
  });

  it("rejects with an explicit empty registry (every moduleId unknown)", () => {
    const r = validateStructural(baseWithScript("json_parse"), {
      allowedScriptModuleIds: new Set(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.diagnostics.some((d) => d.code === "SCRIPT_MODULE_NOT_REGISTERED"),
      ).toBe(true);
    }
  });
});

describe("validateStructural: cross_segment_resume_from", () => {
  it("accepts a valid cross-segment resume target", () => {
    // a → gate → b. a and b are in different segments because gate
    // breaks segments. b names a as cross_segment_resume_from.
    const ir = {
      name: "p",
      session_mode: "single" as const,
      externalInputs: [{ name: "seed", type: "string" as const }],
      stages: [
        { name: "a", type: "agent" as const, inputs: [{ name: "seed", type: "string" }], outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "pa" } },
        { name: "g", type: "gate" as const, inputs: [{ name: "x", type: "string" }], outputs: [{ name: "x", type: "string" }],
          config: { question: { text: "ok?" }, routing: { routes: { approve: "b", _default: "b" } } } },
        { name: "b", type: "agent" as const, inputs: [{ name: "x", type: "string" }], outputs: [],
          config: { promptRef: "pb", cross_segment_resume_from: "a" } },
      ],
      wires: [
        { from: { source: "external" as const, port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage" as const, stage: "a", port: "x" }, to: { stage: "g", port: "x" } },
        { from: { source: "stage" as const, stage: "g", port: "x" }, to: { stage: "b", port: "x" } },
      ],
    };
    const r = validateStructural(ir);
    expect(r).toEqual({ ok: true });
  });

  it("CROSS_SEGMENT_TARGET_NOT_FOUND: target stage doesn't exist", () => {
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [
        { name: "a", type: "agent" as const, inputs: [], outputs: [],
          config: { promptRef: "p", cross_segment_resume_from: "ghost" } },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    const diags = !r.ok ? r.diagnostics : [];
    expect(diags.find((d) => d.code === "CROSS_SEGMENT_TARGET_NOT_FOUND"))
      .toBeDefined();
  });

  it("CROSS_SEGMENT_TARGET_NOT_AGENT: target exists but is a script/gate stage", () => {
    // b names s as the target, but s is a script stage. Script and
    // gate stages have no session_id, so resuming makes no sense.
    // Validator catches this at authoring time.
    const ir = {
      name: "p",
      session_mode: "single" as const,
      externalInputs: [{ name: "seed", type: "string" as const }],
      stages: [
        { name: "s", type: "script" as const, inputs: [{ name: "seed", type: "string" }], outputs: [{ name: "x", type: "string" }],
          config: { source: "registry" as const, moduleId: "noop" } },
        { name: "b", type: "agent" as const, inputs: [{ name: "x", type: "string" }], outputs: [],
          config: { promptRef: "pb", cross_segment_resume_from: "s" } },
      ],
      wires: [
        { from: { source: "external" as const, port: "seed" }, to: { stage: "s", port: "seed" } },
        { from: { source: "stage" as const, stage: "s", port: "x" }, to: { stage: "b", port: "x" } },
      ],
    };
    const r = validateStructural(ir);
    const diags = !r.ok ? r.diagnostics : [];
    expect(diags.find((d) => d.code === "CROSS_SEGMENT_TARGET_NOT_AGENT"))
      .toBeDefined();
  });

  it("CROSS_SEGMENT_TARGET_NOT_REACHABLE: target exists but is not wire-upstream", () => {
    // a and b are independent (no wires between them). b names a but
    // can't reach a via wires.
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [
        { name: "a", type: "agent" as const, inputs: [], outputs: [],
          config: { promptRef: "pa" } },
        { name: "b", type: "agent" as const, inputs: [], outputs: [],
          config: { promptRef: "pb", cross_segment_resume_from: "a" } },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    const diags = !r.ok ? r.diagnostics : [];
    expect(diags.find((d) => d.code === "CROSS_SEGMENT_TARGET_NOT_REACHABLE"))
      .toBeDefined();
  });

  it("CROSS_SEGMENT_TARGET_SAME_SEGMENT: target is in the same segment", () => {
    // a → b, both agent stages, no break between them, single mode →
    // segment-planner places them in the same segment. b cannot resume
    // a cross-segment.
    const ir = {
      name: "p",
      session_mode: "single" as const,
      externalInputs: [{ name: "seed", type: "string" as const }],
      stages: [
        { name: "a", type: "agent" as const, inputs: [{ name: "seed", type: "string" }], outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "pa" } },
        { name: "b", type: "agent" as const, inputs: [{ name: "x", type: "string" }], outputs: [],
          config: { promptRef: "pb", cross_segment_resume_from: "a" } },
      ],
      wires: [
        { from: { source: "external" as const, port: "seed" }, to: { stage: "a", port: "seed" } },
        { from: { source: "stage" as const, stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
      ],
    };
    const r = validateStructural(ir);
    const diags = !r.ok ? r.diagnostics : [];
    expect(diags.find((d) => d.code === "CROSS_SEGMENT_TARGET_SAME_SEGMENT"))
      .toBeDefined();
  });

  it("CROSS_SEGMENT_RESUME_FROM_REQUIRES_SINGLE: multi-mode pipeline uses the field", () => {
    const ir = {
      name: "p",
      // session_mode omitted → defaults to "multi" via Zod
      stages: [
        { name: "a", type: "agent" as const, inputs: [], outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "pa" } },
        { name: "b", type: "agent" as const, inputs: [{ name: "x", type: "string" }], outputs: [],
          config: { promptRef: "pb", cross_segment_resume_from: "a" } },
      ],
      wires: [
        { from: { source: "stage" as const, stage: "a", port: "x" }, to: { stage: "b", port: "x" } },
      ],
    };
    const r = validateStructural(ir);
    const diags = !r.ok ? r.diagnostics : [];
    expect(diags.find((d) => d.code === "CROSS_SEGMENT_RESUME_FROM_REQUIRES_SINGLE"))
      .toBeDefined();
  });
});

// Bug G (D4 dogfood, 2026-04-30): cross-check between mcpServer.envKeys
// and the ${VAR} references that actually appear in command/args/env.
//
// Failure mode: an IR that lists envKeys but forgets the matching env
// entry passes pre-flight (warns the operator) and submit, but at
// runtime expandMcpServers finds no ${VAR} to expand, returns ok=true,
// and the secret-gate path is skipped entirely. The MCP child spawns
// without the value and fails its own handshake. The user is then stuck:
// provide_task_secrets is rejected because there is no secret_gate_queue
// row, and the error message bubbled up is opaque (SDK-side).
describe("validateStructural: mcpServers envKeys ⊆ ${VAR} refs (Bug G)", () => {
  it("accepts envKeys that are referenced via env: { KEY: '${KEY}' }", () => {
    const ir: PipelineIR = {
      name: "ok-envkeys-with-env",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [],
          outputs: [{ name: "out", type: "string" }],
          config: {
            promptRef: "p",
            mcpServers: [
              {
                name: "etherscan",
                command: "npx",
                args: ["-y", "@everimbaq/etherscan-mcp"],
                env: { ETHERSCAN_API_KEY: "${ETHERSCAN_API_KEY}" },
                envKeys: ["ETHERSCAN_API_KEY"],
              },
            ],
          },
        },
      ],
      wires: [],
    };
    expect(validateStructural(ir)).toEqual({ ok: true });
  });

  it("accepts envKeys referenced via args[*] (rare but legal)", () => {
    const ir: PipelineIR = {
      name: "ok-envkeys-via-args",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [],
          outputs: [{ name: "out", type: "string" }],
          config: {
            promptRef: "p",
            mcpServers: [
              {
                name: "weird",
                command: "npx",
                args: ["-y", "weird-mcp", "--token", "${WEIRD_TOKEN}"],
                envKeys: ["WEIRD_TOKEN"],
              },
            ],
          },
        },
      ],
      wires: [],
    };
    expect(validateStructural(ir)).toEqual({ ok: true });
  });

  it("rejects envKey that is declared but never referenced (the D4 footgun)", () => {
    const ir: PipelineIR = {
      name: "broken-envkeys-no-env",
      stages: [
        {
          name: "queryEthBalance",
          type: "agent",
          inputs: [],
          outputs: [{ name: "out", type: "string" }],
          config: {
            promptRef: "p",
            mcpServers: [
              {
                name: "etherscan",
                command: "npx",
                args: ["-y", "@everimbaq/etherscan-mcp"],
                envKeys: ["ETHERSCAN_API_KEY"],
                // env field intentionally omitted — this is the bug
                // shape D4 dogfood produced on 2026-04-30.
              },
            ],
          },
        },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const diag = r.diagnostics.find((d) => d.code === "ENVKEY_NOT_REFERENCED");
      expect(diag).toBeDefined();
      expect(diag!.context).toMatchObject({
        stage: "queryEthBalance",
        server: "etherscan",
        envKey: "ETHERSCAN_API_KEY",
      });
    }
  });

  it("reports each unreferenced envKey separately when multiple are missing", () => {
    const ir: PipelineIR = {
      name: "broken-multi",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [],
          outputs: [{ name: "out", type: "string" }],
          config: {
            promptRef: "p",
            mcpServers: [
              {
                name: "srv",
                command: "npx",
                args: ["-y", "x"],
                env: { KEY1: "${KEY1}" },
                envKeys: ["KEY1", "KEY2", "KEY3"],
              },
            ],
          },
        },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const codes = r.diagnostics.filter((d) => d.code === "ENVKEY_NOT_REFERENCED");
      expect(codes.length).toBe(2);
      const missingKeys = codes.map((d) => (d.context as { envKey: string }).envKey).sort();
      expect(missingKeys).toEqual(["KEY2", "KEY3"]);
    }
  });

  it("accepts an empty envKeys array (no constraint to enforce)", () => {
    const ir: PipelineIR = {
      name: "ok-empty",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [],
          outputs: [{ name: "out", type: "string" }],
          config: {
            promptRef: "p",
            mcpServers: [
              {
                name: "fetch",
                command: "npx",
                args: ["-y", "fetch-mcp"],
                envKeys: [],
              },
            ],
          },
        },
      ],
      wires: [],
    };
    expect(validateStructural(ir)).toEqual({ ok: true });
  });

  it("ignores ${VAR} references in env that don't appear in envKeys (e.g. ${HOME})", () => {
    // Reverse direction: env references something not declared in envKeys.
    // This is allowed — system-level vars like HOME/PATH should not require
    // an envKeys entry.
    const ir: PipelineIR = {
      name: "ok-system-var",
      stages: [
        {
          name: "A",
          type: "agent",
          inputs: [],
          outputs: [{ name: "out", type: "string" }],
          config: {
            promptRef: "p",
            mcpServers: [
              {
                name: "srv",
                command: "npx",
                args: ["-y", "x"],
                env: { CACHE_DIR: "${HOME}/.cache" },
                envKeys: [],
              },
            ],
          },
        },
      ],
      wires: [],
    };
    expect(validateStructural(ir)).toEqual({ ok: true });
  });
});

// Bug 28 (c12+ review) — multi-target rollback coherence.
//
// A gate routing answer with `[a, b]` syntax must be either all-rollback
// (every target is a transitive ancestor of the gate) or all-forward
// (no target is an ancestor). Mixed semantics — one ancestor + one not —
// is rejected so the LLM regenerates a coherent route rather than the
// runner silently classifying it as forward and skipping rollback.
describe("validateStructural — Bug 28 multi-target rollback coherence", () => {
  it("accepts an all-ancestor multi-target rollback answer", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [], outputs: [{ name: "oa", type: "string" }], config: { promptRef: "p" } },
        { name: "B", type: "agent", inputs: [], outputs: [{ name: "ob", type: "string" }], config: { promptRef: "p" } },
        {
          name: "G",
          type: "gate",
          inputs: [{ name: "ia", type: "string" }, { name: "ib", type: "string" }],
          outputs: [],
          config: {
            question: { text: "?", options: [{ value: "approve" }, { value: "reject" }] },
            routing: { routes: { approve: "C", reject: ["A", "B"] } },
          },
        },
        { name: "C", type: "agent", inputs: [], outputs: [{ name: "x", type: "string" }], config: { promptRef: "p" } },
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "oa" }, to: { stage: "G", port: "ia" } },
        { from: { source: "stage", stage: "B", port: "ob" }, to: { stage: "G", port: "ib" } },
      ],
    };
    const r = validateStructural(ir);
    if (!r.ok) {
      expect(r.diagnostics.find((d) => d.code === "GATE_ROLLBACK_MIXED_TARGETS")).toBeUndefined();
    } else {
      expect(r.ok).toBe(true);
    }
  });

  it("accepts an all-forward multi-target route", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        {
          name: "G",
          type: "gate",
          inputs: [],
          outputs: [],
          config: {
            question: { text: "?", options: [{ value: "approve" }] },
            routing: { routes: { approve: ["X", "Y"] } },
          },
        },
        { name: "X", type: "agent", inputs: [], outputs: [{ name: "o", type: "string" }], config: { promptRef: "p" } },
        { name: "Y", type: "agent", inputs: [], outputs: [{ name: "o", type: "string" }], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const r = validateStructural(ir);
    if (!r.ok) {
      expect(r.diagnostics.find((d) => d.code === "GATE_ROLLBACK_MIXED_TARGETS")).toBeUndefined();
    } else {
      expect(r.ok).toBe(true);
    }
  });

  it("rejects a mixed-semantics multi-target answer", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        // A is an ancestor of G; X is NOT an ancestor of G — mixed semantics.
        { name: "A", type: "agent", inputs: [], outputs: [{ name: "oa", type: "string" }], config: { promptRef: "p" } },
        {
          name: "G",
          type: "gate",
          inputs: [{ name: "ia", type: "string" }],
          outputs: [],
          config: {
            question: { text: "?", options: [{ value: "approve" }, { value: "reject" }] },
            routing: { routes: { approve: "C", reject: ["A", "X"] } },
          },
        },
        { name: "C", type: "agent", inputs: [], outputs: [{ name: "o", type: "string" }], config: { promptRef: "p" } },
        { name: "X", type: "agent", inputs: [], outputs: [{ name: "o", type: "string" }], config: { promptRef: "p" } },
      ],
      wires: [
        { from: { source: "stage", stage: "A", port: "oa" }, to: { stage: "G", port: "ia" } },
      ],
    };
    const r = validateStructural(ir);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.diagnostics.some((d) => d.code === "GATE_ROLLBACK_MIXED_TARGETS")).toBe(true);
    }
  });
});
