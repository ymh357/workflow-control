import { describe, it, expect } from "vitest";
import { computeWireTransitiveReaders } from "./wire-reachable.js";
import type { PipelineIR } from "../ir/schema.js";

function ir(
  stages: PipelineIR["stages"],
  wires: PipelineIR["wires"] = [],
): PipelineIR {
  return { name: "t", stages, wires };
}

function agentStage(name: string): PipelineIR["stages"][number] {
  return {
    name, type: "agent",
    config: { promptRef: "p-" + name },
    inputs: [], outputs: [{ name: "out", type: "string" }],
  };
}

describe("computeWireTransitiveReaders", () => {
  it("returns {start} when start has no outgoing wires", () => {
    const r = computeWireTransitiveReaders(ir([agentStage("a")]), "a");
    expect(Array.from(r).sort()).toEqual(["a"]);
  });

  it("follows single-edge chain", () => {
    const p = ir(
      [agentStage("a"), agentStage("b"), agentStage("c")],
      [
        { from: { source: "stage", stage: "a", port: "out" }, to: { stage: "b", port: "out" } },
        { from: { source: "stage", stage: "b", port: "out" }, to: { stage: "c", port: "out" } },
      ],
    );
    const r = computeWireTransitiveReaders(p, "a");
    expect(Array.from(r).sort()).toEqual(["a", "b", "c"]);
  });

  it("excludes parallel sibling (B13 key case)", () => {
    const p = ir(
      [agentStage("fork"), agentStage("branch1"), agentStage("branch2"), agentStage("join")],
      [
        { from: { source: "stage", stage: "fork", port: "out" }, to: { stage: "branch1", port: "out" } },
        { from: { source: "stage", stage: "fork", port: "out" }, to: { stage: "branch2", port: "out" } },
        { from: { source: "stage", stage: "branch1", port: "out" }, to: { stage: "join", port: "out" } },
        { from: { source: "stage", stage: "branch2", port: "out" }, to: { stage: "join", port: "out" } },
      ],
    );
    const r = computeWireTransitiveReaders(p, "branch1");
    expect(Array.from(r).sort()).toEqual(["branch1", "join"]);
    expect(r.has("branch2")).toBe(false);
  });

  it("shared downstream included once", () => {
    const p = ir(
      [agentStage("a"), agentStage("b"), agentStage("c")],
      [
        { from: { source: "stage", stage: "a", port: "out" }, to: { stage: "c", port: "out" } },
        { from: { source: "stage", stage: "b", port: "out" }, to: { stage: "c", port: "out" } },
      ],
    );
    const r = computeWireTransitiveReaders(p, "a");
    expect(Array.from(r).sort()).toEqual(["a", "c"]);
  });

  it("ignores external-source wires", () => {
    const p = ir(
      [agentStage("a")],
      [
        { from: { source: "external", port: "x" }, to: { stage: "a", port: "out" } },
      ],
    );
    const r = computeWireTransitiveReaders(p, "a");
    expect(Array.from(r).sort()).toEqual(["a"]);
  });

  it("rerunFrom absent in IR returns empty set", () => {
    const p = ir([agentStage("a")]);
    const r = computeWireTransitiveReaders(p, "nonexistent");
    expect(r.size).toBe(0);
  });

  it("guard-bearing wires included (guard is runtime concern)", () => {
    const p = ir(
      [agentStage("a"), agentStage("b")],
      [
        {
          from: { source: "stage", stage: "a", port: "out" },
          to: { stage: "b", port: "out" },
          guard: "value === 'approved'",
        },
      ],
    );
    const r = computeWireTransitiveReaders(p, "a");
    expect(Array.from(r).sort()).toEqual(["a", "b"]);
  });
});
