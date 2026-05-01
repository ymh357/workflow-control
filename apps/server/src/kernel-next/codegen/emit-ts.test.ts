import { describe, it, expect } from "vitest";
import { emitPipelineModule } from "./emit-ts.js";
import type { PipelineIR } from "../ir/schema.js";

function diamondIR(): PipelineIR {
  return {
    name: "diamond",
    stages: [
      { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: "number" }], config: { promptRef: "p" } },
      { name: "B", type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "y", type: "string" }],
        config: { promptRef: "p" } },
      { name: "C", type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "z", type: "string" }],
        config: { promptRef: "p" } },
      { name: "D", type: "agent",
        inputs: [{ name: "b", type: "string" }, { name: "c", type: "string" }],
        outputs: [],
        config: { promptRef: "p" } },
    ],
    wires: [
      { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
      { from: { stage: "A", port: "x" }, to: { stage: "C", port: "x" } },
      { from: { stage: "B", port: "y" }, to: { stage: "D", port: "b" } },
      { from: { stage: "C", port: "z" }, to: { stage: "D", port: "c" } },
    ],
  };
}

describe("emit-ts codegen", () => {
  it("emits a namespace per stage with Inputs/Outputs interfaces", () => {
    const { source } = emitPipelineModule(diamondIR());
    expect(source).toContain("export namespace Stages");
    expect(source).toContain("export namespace A");
    expect(source).toContain("export namespace B");
    expect(source).toMatch(/export namespace A \{\s+export interface Inputs \{\}/);
    expect(source).toContain("export interface Outputs {");
    expect(source).toMatch(/x: number;/);
  });

  it("emits one __wire__ dummy assignment per wire", () => {
    const { source } = emitPipelineModule(diamondIR());
    // Identifier format: __wire__<from>_<port>__TO__<to>_<port>__<8-hex-hash>
    const matches = source.match(/export const __wire__[A-Za-z0-9_]+__TO__[A-Za-z0-9_]+__[0-9a-f]{8}/g) ?? [];
    expect(matches.length).toBe(4);
    // Human-readable prefix still present (the hash just disambiguates).
    expect(source).toContain("__wire__A_x__TO__B_x__");
    expect(source).toContain("__wire__A_x__TO__C_x__");
    expect(source).toContain("__wire__B_y__TO__D_b__");
    expect(source).toContain("__wire__C_z__TO__D_c__");
  });

  it("wire assertion direction: target Input type = source Output type", () => {
    const { source } = emitPipelineModule(diamondIR());
    // Expected shape (hash suffix elided):
    //   export const __wire__A_x__TO__B_x__<hash>: Stages.B.Inputs["x"] =
    //     null as unknown as Stages.A.Outputs["x"];
    expect(source).toMatch(/export const __wire__A_x__TO__B_x__[0-9a-f]{8}: Stages\.B\.Inputs\["x"\] =/);
    expect(source).toContain(`null as unknown as Stages.A.Outputs["x"];`);
  });

  it("wire map contains one entry per wire with from/to metadata", () => {
    const { wireByIdentifier, wireByLine } = emitPipelineModule(diamondIR());
    expect(wireByIdentifier.size).toBe(4);
    // Look up by prefix match since hash suffix is content-derived.
    const abKey = [...wireByIdentifier.keys()].find((k) => k.startsWith("__wire__A_x__TO__B_x__"));
    expect(abKey).toBeDefined();
    const ab = wireByIdentifier.get(abKey!);
    expect(ab?.fromStage).toBe("A");
    expect(ab?.fromPort).toBe("x");
    expect(ab?.toStage).toBe("B");
    expect(ab?.toPort).toBe("x");
    expect(ab?.fromType).toBe("number");
    expect(ab?.toType).toBe("number");
    // Line-indexed map has at least as many entries as wires
    // (we index both declaration and assignment lines).
    expect(wireByLine.size).toBeGreaterThanOrEqual(4);
  });

  it("wire identifier disambiguates name-collision cases via hash suffix", () => {
    // Stage 'a_b' port 'c' vs stage 'a' port 'b_c' both encode to a_b_c
    // under the naive join-with-underscore scheme. Verify the hash suffix
    // makes them distinct.
    const ir = {
      name: "collision",
      stages: [
        { name: "a", type: "agent" as const, inputs: [], outputs: [{ name: "b_c", type: "string" }], config: { promptRef: "p" } },
        { name: "a_b", type: "agent" as const, inputs: [], outputs: [{ name: "c", type: "string" }], config: { promptRef: "p" } },
        { name: "sink", type: "agent" as const,
          inputs: [{ name: "p", type: "string" }, { name: "q", type: "string" }],
          outputs: [], config: { promptRef: "p" } },
      ],
      wires: [
        { from: { stage: "a", port: "b_c" }, to: { stage: "sink", port: "p" } },
        { from: { stage: "a_b", port: "c" }, to: { stage: "sink", port: "q" } },
      ],
    };
    const { wireByIdentifier } = emitPipelineModule(ir);
    expect(wireByIdentifier.size).toBe(2);
    const idents = [...wireByIdentifier.keys()];
    // Both identifiers share the same human prefix up to the hash suffix.
    expect(idents[0]!.slice(0, -8)).not.toBe(idents[1]!.slice(0, -8));
  });

  it("emits empty Inputs/Outputs blocks when stage has no ports", () => {
    const ir: PipelineIR = {
      name: "solo",
      stages: [{ name: "only", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } }],
      wires: [],
    };
    const { source } = emitPipelineModule(ir);
    expect(source).toContain("export interface Inputs {}");
    expect(source).toContain("export interface Outputs {}");
    // No wire assertions present.
    expect(source).not.toContain("__wire__");
  });

  it("preserves complex TS type expressions verbatim", () => {
    const ir: PipelineIR = {
      name: "complex",
      stages: [
        { name: "A", type: "agent",
          inputs: [],
          outputs: [{ name: "items", type: "Array<{ id: string; v: number }>" }],
          config: { promptRef: "p" } },
        { name: "B", type: "agent",
          inputs: [{ name: "items", type: "ReadonlyArray<{ id: string; v: number }>" }],
          outputs: [],
          config: { promptRef: "p" } },
      ],
      wires: [{ from: { stage: "A", port: "items" }, to: { stage: "B", port: "items" } }],
    };
    const { source } = emitPipelineModule(ir);
    expect(source).toContain("items: Array<{ id: string; v: number }>");
    expect(source).toContain("items: ReadonlyArray<{ id: string; v: number }>");
  });
});

describe("emitPipelineModule with externalInputs", () => {
  it("emits __external__ namespace for external inputs", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent",
          inputs: [{ name: "ctx", type: "unknown" }],
          outputs: [{ name: "x", type: "number" }],
          config: { promptRef: "p" } },
      ],
      externalInputs: [{ name: "ctx", type: "unknown" }],
      wires: [{ from: { source: "external", port: "ctx" }, to: { stage: "A", port: "ctx" } }],
    };
    const { source } = emitPipelineModule(ir);
    expect(source).toContain("export namespace __external__");
    expect(source).toContain("Outputs");
    expect(source).toContain(`__external__.Outputs["ctx"]`);
    expect(source).not.toContain("Stages.__external__");
  });

  it("does not emit __external__ namespace when externalInputs is empty", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [], outputs: [], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const { source } = emitPipelineModule(ir);
    expect(source).not.toContain("__external__");
  });

  it("skips fanout wrap/unwrap for external wires (seed passes through)", () => {
    const ir: PipelineIR = {
      name: "t",
      stages: [
        { name: "A", type: "agent",
          inputs: [{ name: "ctx", type: "unknown" }],
          outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "p" },
          fanout: { input: "ctx" },
        },
      ],
      externalInputs: [{ name: "ctx", type: "unknown" }],
      wires: [{ from: { source: "external", port: "ctx" }, to: { stage: "A", port: "ctx" } }],
    };
    const { source } = emitPipelineModule(ir);
    expect(source).toContain(`__external__.Outputs["ctx"]`);
    // External seed wire must NOT receive [0]! unwrap or [...] wrap.
    expect(source).not.toMatch(/__external__\.Outputs\["ctx"\]\)\[0\]/);
    expect(source).not.toMatch(/\[null as unknown as __external__/);
  });

  it("gate stages auto-emit __gate_feedback__ in generated Outputs interface", () => {
    // Regression for 2026-04-25 dogfood Finding 5: pipeline-generator
    // produced an IR with a wire `gate.__gate_feedback__ → upstream.rejectionFeedback`
    // (the canonical kernel-next pattern for gate-reject-with-comment).
    // Validator (structural.ts:283) accepts this — but emit-ts didn't put
    // `__gate_feedback__` in the gate's generated Outputs interface, so
    // tsc reported TS2339 ("Property '__gate_feedback__' does not exist
    // on type 'Outputs'"), which submit_pipeline mapped to
    // WIRE_TYPE_MISMATCH. The blocked the entire web3-research pipeline
    // generation. Codegen must mirror what the validator already trusts
    // as a builtin gate output.
    const ir: PipelineIR = {
      name: "g",
      stages: [
        { name: "scope", type: "agent",
          inputs: [{ name: "task", type: "string" }, { name: "rejectionFeedback", type: "string" }],
          outputs: [{ name: "out", type: "string" }],
          config: { promptRef: "p" } },
        { name: "approval", type: "gate",
          inputs: [{ name: "__gate_signal", type: "unknown" }],
          outputs: [],
          config: {
            question: { text: "approve?" },
            routing: { routes: { approve: "next", reject: "scope" } },
          } },
      ],
      wires: [
        { from: { stage: "scope", port: "out" }, to: { stage: "approval", port: "__gate_signal" } },
        { from: { stage: "approval", port: "__gate_feedback__" }, to: { stage: "scope", port: "rejectionFeedback" } },
      ],
    };
    const { source } = emitPipelineModule(ir);
    // The gate's generated Outputs interface now contains __gate_feedback__.
    expect(source).toMatch(/export namespace approval \{[\s\S]+__gate_feedback__: string;/);
    // The wire from gate.__gate_feedback__ now type-checks because the
    // declaration exists. (Full tsc run is exercised by validator/types.ts
    // integration tests; this unit test only checks the codegen emits the
    // right TS source.)
    expect(source).toContain("__wire__approval___gate_feedback____TO__scope_rejectionFeedback__");
  });

  it("non-gate stages do NOT receive __gate_feedback__ in their Outputs", () => {
    const ir: PipelineIR = {
      name: "n",
      stages: [
        { name: "X", type: "agent", inputs: [], outputs: [{ name: "y", type: "string" }], config: { promptRef: "p" } },
      ],
      wires: [],
    };
    const { source } = emitPipelineModule(ir);
    // Agent stage X must not have __gate_feedback__ (it's not a gate).
    expect(source).not.toMatch(/export namespace X \{[\s\S]+__gate_feedback__/);
  });
});

// Bug 31 (c12+ review) — PortIR.type code-injection guard.
//
// emit-ts inlines `${p.type}` verbatim into emitted TS. A malicious or
// hallucinated LLM-generated type that breaks out of its surrounding
// `interface { ... }` body could persist arbitrary top-level code into
// pipeline_versions.ts_source. The pre-fix code had no validation; the
// post-fix code throws on:
//   - newlines / carriage returns
//   - comment markers ("//", "/*", "*/")
//   - "=" / backtick (variable initializer / template literal escape)
//   - characters outside the conservative TS type-expression set
//   - unbalanced brackets ({} [] () <>)
describe("emitPipelineModule — Bug 31 PortIR.type injection guard", () => {
  function makeIR(typeStr: string): PipelineIR {
    return {
      name: "t",
      stages: [
        { name: "A", type: "agent", inputs: [], outputs: [{ name: "x", type: typeStr }], config: { promptRef: "p" } },
      ],
      wires: [],
    } as PipelineIR;
  }

  it("rejects a type containing a newline", () => {
    expect(() => emitPipelineModule(makeIR("string\n malicious")))
      .toThrowError(/forbidden substring/);
  });

  it("rejects a type containing a // comment marker", () => {
    expect(() => emitPipelineModule(makeIR("string // injected")))
      .toThrowError(/forbidden substring/);
  });

  it("rejects a type containing a /* */ block comment", () => {
    expect(() => emitPipelineModule(makeIR("string /* x */")))
      .toThrowError(/forbidden substring/);
  });

  it("rejects a type containing an = (assignment)", () => {
    expect(() => emitPipelineModule(makeIR("string = injected")))
      .toThrowError(/forbidden substring/);
  });

  it("rejects a type with an unbalanced } that would close the host interface", () => {
    // The classic injection: `string; }; export const rce = ...; namespace n {`.
    // Even with `=` allowed, the imbalanced `}` is enough to catch this class.
    expect(() => emitPipelineModule(makeIR("string }")))
      .toThrowError(/unbalanced/);
  });

  it("rejects a type with characters outside the allowed set", () => {
    expect(() => emitPipelineModule(makeIR("string + number")))
      .toThrowError(/outside the allowed/);
  });

  it("accepts a complex object/array type", () => {
    expect(() => emitPipelineModule(makeIR("Array<{ id: string; n: number }>")))
      .not.toThrow();
  });

  it("accepts a discriminated union literal type", () => {
    expect(() => emitPipelineModule(makeIR('"a" | "b" | "c"')))
      .not.toThrow();
  });
});
