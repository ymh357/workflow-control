import { describe, it, expect } from "vitest";
import { topoDownstream } from "./topo-downstream.js";
import type { WireIR } from "../ir/schema.js";

const wire = (fromStage: string, toStage: string): WireIR => ({
  from: { source: "stage", stage: fromStage, port: "x" },
  to: { stage: toStage, port: "x" },
});

describe("topoDownstream", () => {
  it("returns empty set for a stage with no outgoing wires", () => {
    expect(topoDownstream([], "A")).toEqual([]);
  });

  it("returns direct downstream", () => {
    expect(topoDownstream([wire("A", "B")], "A")).toEqual(["B"]);
  });

  it("returns transitive closure", () => {
    const wires = [wire("A", "B"), wire("B", "C"), wire("C", "D")];
    const result = topoDownstream(wires, "A");
    expect(result.sort()).toEqual(["B", "C", "D"]);
  });

  it("handles diamonds without duplicates", () => {
    const wires = [wire("A", "B"), wire("A", "C"), wire("B", "D"), wire("C", "D")];
    const result = topoDownstream(wires, "A");
    expect(result.sort()).toEqual(["B", "C", "D"]);
  });

  it("skips external wires (external sources have no producer stage)", () => {
    const wires: WireIR[] = [
      { from: { source: "external", port: "seed" }, to: { stage: "A", port: "x" } },
      wire("A", "B"),
    ];
    const result = topoDownstream(wires, "A");
    expect(result).toEqual(["B"]);
  });

  it("does not include the start stage itself", () => {
    expect(topoDownstream([wire("A", "B")], "A")).not.toContain("A");
  });

  it("handles cycles defensively (returns finite set)", () => {
    // Cycles are structurally forbidden by DAG validator, but the helper
    // must not hang if called on malformed input.
    const wires = [wire("A", "B"), wire("B", "A")];
    const result = topoDownstream(wires, "A");
    expect(result).toContain("B");
    expect(result.length).toBeLessThan(10);
  });
});
