import { describe, it, expect } from "vitest";
import { planSegments } from "./segment-planner.js";
import type { PipelineIR } from "../ir/schema.js";

const agentStage = (
  name: string,
  inputs: string[] = [],
  outputs: string[] = [],
  extra: Record<string, unknown> = {},
) => ({
  name,
  type: "agent" as const,
  inputs: inputs.map((p) => ({ name: p, type: "unknown" })),
  outputs: outputs.map((p) => ({ name: p, type: "unknown" })),
  config: { promptRef: "p/r" },
  ...extra,
});

const scriptStage = (
  name: string,
  inputs: string[] = [],
  outputs: string[] = [],
) => ({
  name,
  type: "script" as const,
  inputs: inputs.map((p) => ({ name: p, type: "unknown" })),
  outputs: outputs.map((p) => ({ name: p, type: "unknown" })),
  config: { source: "registry" as const, moduleId: "x" },
});

const gateStage = (
  name: string,
  inputs: string[] = [],
  outputs: string[] = [],
) => ({
  name,
  type: "gate" as const,
  inputs: inputs.map((p) => ({ name: p, type: "unknown" })),
  outputs: outputs.map((p) => ({ name: p, type: "unknown" })),
  config: { question: { text: "q" }, routing: { routes: {} } },
});

const wire = (fromStage: string, fromPort: string, toStage: string, toPort: string) => ({
  from: { source: "stage" as const, stage: fromStage, port: fromPort },
  to: { stage: toStage, port: toPort },
});

const externalWire = (fromPort: string, toStage: string, toPort: string) => ({
  from: { source: "external" as const, port: fromPort },
  to: { stage: toStage, port: toPort },
});

describe("planSegments", () => {
  it("returns size-1 segments for every stage when session_mode='multi'", () => {
    const ir = {
      name: "p",
      session_mode: "multi" as const,
      stages: [agentStage("a", [], ["x"]), agentStage("b", ["x"], [])],
      wires: [wire("a", "x", "b", "x")],
    } as PipelineIR;
    expect(planSegments(ir)).toEqual([["a"], ["b"]]);
  });

  it("merges linear agent chain in single mode", () => {
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [
        agentStage("a", [], ["x"]),
        agentStage("b", ["x"], ["y"]),
        agentStage("c", ["y"], []),
      ],
      wires: [wire("a", "x", "b", "x"), wire("b", "y", "c", "y")],
    } as PipelineIR;
    expect(planSegments(ir)).toEqual([["a", "b", "c"]]);
  });

  it("merges 4-stage linear chain (regression fence: predecessor- vs segment-closed)", () => {
    // Regression test for the predecessorConsumed implementation choice.
    // A naive "close segment after first extension" reading of spec §6.1
    // would yield [["a","b"],["c","d"]] here instead of one segment.
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [
        agentStage("a", [], ["x"]),
        agentStage("b", ["x"], ["y"]),
        agentStage("c", ["y"], ["z"]),
        agentStage("d", ["z"], []),
      ],
      wires: [
        wire("a", "x", "b", "x"),
        wire("b", "y", "c", "y"),
        wire("c", "z", "d", "z"),
      ],
    } as PipelineIR;
    expect(planSegments(ir)).toEqual([["a", "b", "c", "d"]]);
  });

  it("breaks segment at script stage", () => {
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [
        agentStage("a", [], ["x"]),
        scriptStage("s", ["x"], ["y"]),
        agentStage("c", ["y"], []),
      ],
      wires: [wire("a", "x", "s", "x"), wire("s", "y", "c", "y")],
    } as PipelineIR;
    expect(planSegments(ir)).toEqual([["a"], ["s"], ["c"]]);
  });

  it("breaks segment at gate stage", () => {
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [
        agentStage("a", [], ["x"]),
        gateStage("g", ["x"], ["y"]),
        agentStage("c", ["y"], []),
      ],
      wires: [wire("a", "x", "g", "x"), wire("g", "y", "c", "y")],
    } as PipelineIR;
    expect(planSegments(ir)).toEqual([["a"], ["g"], ["c"]]);
  });

  it("breaks segment when fanout flag present", () => {
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [
        agentStage("a", [], ["x"]),
        agentStage("b", ["x"], [], { fanout: { input: "x" } }),
      ],
      wires: [wire("a", "x", "b", "x")],
    } as PipelineIR;
    expect(planSegments(ir)).toEqual([["a"], ["b"]]);
  });

  it("starts new segment on multi-input agent fan-in", () => {
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [
        agentStage("a", [], ["x"]),
        agentStage("b", [], ["y"]),
        agentStage("c", ["x", "y"], []),
      ],
      wires: [wire("a", "x", "c", "x"), wire("b", "y", "c", "y")],
    } as PipelineIR;
    expect(planSegments(ir)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("at-most-one continuation per segment (first downstream wins)", () => {
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [
        agentStage("a", [], ["x"]),
        agentStage("b", ["x"], []),
        agentStage("c", ["x"], []),
      ],
      wires: [wire("a", "x", "b", "x"), wire("a", "x", "c", "x")],
    } as PipelineIR;
    const segs = planSegments(ir);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual(["a", "b"]);
    expect(segs[1]).toEqual(["c"]);
  });

  it("agent with one upstream agent + one external input is still eligible to continue", () => {
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [agentStage("a", [], ["x"]), agentStage("b", ["x", "ext"], [])],
      wires: [wire("a", "x", "b", "x"), externalWire("ext", "b", "ext")],
      externalInputs: [{ name: "ext", type: "string" }],
    } as PipelineIR;
    expect(planSegments(ir)).toEqual([["a", "b"]]);
  });

  it("agent with upstream script (only) starts new segment in single mode", () => {
    const ir = {
      name: "p",
      session_mode: "single" as const,
      stages: [scriptStage("s", [], ["x"]), agentStage("a", ["x"], [])],
      wires: [wire("s", "x", "a", "x")],
    } as PipelineIR;
    expect(planSegments(ir)).toEqual([["s"], ["a"]]);
  });
});
