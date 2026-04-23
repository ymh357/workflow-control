import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { PipelineGraph } from "./pipeline-graph";
import type { PipelineIRLike } from "../lib/ir-to-flow";


describe("PipelineGraph", () => {
  it("mounts without crashing for a 1-stage IR", () => {
    const ir: PipelineIRLike = {
      name: "p",
      stages: [{
        name: "only", type: "agent",
        inputs: [], outputs: [],
        config: { promptRef: "p" },
      }],
      wires: [],
      externalInputs: [],
    };
    const { container } = render(<PipelineGraph ir={ir} />);
    // Any root element indicates reactflow initialised. The `.react-flow`
    // wrapper is the top-level container; fall back to any child element
    // so we don't over-couple to the vendor's internal class names.
    expect(
      container.querySelector(".react-flow") ?? container.firstElementChild,
    ).toBeInTheDocument();
  });

  it("mounts with stageStates overlay and does not throw", () => {
    const ir: PipelineIRLike = {
      name: "p",
      stages: [
        {
          name: "a", type: "agent",
          inputs: [],
          outputs: [{ name: "x", type: "string" }],
          config: { promptRef: "pa" },
        },
        {
          name: "b", type: "agent",
          inputs: [{ name: "x", type: "string" }],
          outputs: [],
          config: { promptRef: "pb" },
        },
      ],
      wires: [{
        from: { source: "stage", stage: "a", port: "x" },
        to: { stage: "b", port: "x" },
      }],
      externalInputs: [],
    };
    const { container } = render(
      <PipelineGraph
        ir={ir}
        stageStates={{ a: "done", b: "executing" }}
      />,
    );
    expect(container.firstElementChild).toBeInTheDocument();
  });
});
