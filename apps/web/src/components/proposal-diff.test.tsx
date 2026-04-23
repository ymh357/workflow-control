import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ProposalDiff } from "./proposal-diff";
import type { PipelineIRLike } from "../lib/ir-to-flow";

describe("ProposalDiff", () => {
  it("mounts two PipelineGraph instances side-by-side", () => {
    const base: PipelineIRLike = {
      name: "p",
      stages: [
        {
          name: "a",
          type: "agent",
          inputs: [],
          outputs: [],
          config: { promptRef: "pa" },
        },
      ],
      wires: [],
      externalInputs: [],
    };
    const projected: PipelineIRLike = {
      name: "p",
      stages: [
        {
          name: "a",
          type: "agent",
          inputs: [],
          outputs: [],
          config: { promptRef: "pa" },
        },
        {
          name: "b",
          type: "agent",
          inputs: [],
          outputs: [],
          config: { promptRef: "pb" },
        },
      ],
      wires: [],
      externalInputs: [],
    };
    const { container, getByText } = render(
      <ProposalDiff baseIr={base} projectedIr={projected} />,
    );
    // Each PipelineGraph renders a `.react-flow` wrapper — two graphs
    // means two instances. Headings distinguish the sides.
    expect(getByText("Base version")).toBeInTheDocument();
    expect(getByText("After proposed patch")).toBeInTheDocument();
    const flows = container.querySelectorAll(".react-flow");
    expect(flows.length).toBe(2);
  });
});
