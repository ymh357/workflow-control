import { describe, it, expect } from "vitest";
import { buildPipelineDescriptor } from "../matching/pipeline-descriptor.js";
import type { PipelineIR } from "../../kernel-next/ir/schema.js";

const SAMPLE: PipelineIR = {
  name: "extract-changelog",
  externalInputs: [
    { name: "branch", type: "string" },
    { name: "since", type: "string" },
  ],
  stages: [
    {
      name: "scan",
      type: "agent",
      inputs: [{ name: "branch", type: "string" }, { name: "since", type: "string" }],
      outputs: [{ name: "commits", type: "string[]" }],
      config: { promptRef: "system/scan-commits" },
    },
    {
      name: "format",
      type: "agent",
      inputs: [{ name: "commits", type: "string[]" }],
      outputs: [{ name: "markdown", type: "string" }],
      config: { promptRef: "system/format-changelog" },
    },
  ],
  wires: [],
};

describe("buildPipelineDescriptor", () => {
  it("returns descriptor with the pipeline name and structure", () => {
    const d = buildPipelineDescriptor(SAMPLE);
    expect(d.name).toBe("extract-changelog");
    expect(d.text).toContain("pipeline extract-changelog");
    expect(d.text).toContain("inputs branch:string since:string");
    expect(d.text).toContain("stage scan agent");
    expect(d.text).toContain("scan commits");
    expect(d.text).toContain("format changelog");
    expect(d.text).toContain("stage format agent");
  });

  it("two pipelines with similar shape produce more-similar descriptors than disparate ones", () => {
    const A = buildPipelineDescriptor(SAMPLE).text;
    const similar: PipelineIR = {
      name: "extract-release-notes",
      externalInputs: SAMPLE.externalInputs,
      stages: [
        {
          name: "scan",
          type: "agent",
          inputs: [{ name: "branch", type: "string" }, { name: "since", type: "string" }],
          outputs: [{ name: "commits", type: "string[]" }],
          config: { promptRef: "system/scan-commits-since" },
        },
        {
          name: "format",
          type: "agent",
          inputs: [{ name: "commits", type: "string[]" }],
          outputs: [{ name: "markdown", type: "string" }],
          config: { promptRef: "system/format-release-notes" },
        },
      ],
      wires: [],
    };
    const B = buildPipelineDescriptor(similar).text;
    expect(A).not.toBe(B);
    expect(B).toContain("scan commits since");
  });

  it("handles pipeline with no externalInputs", () => {
    const ir: PipelineIR = { ...SAMPLE, externalInputs: [], wires: [] };
    const d = buildPipelineDescriptor(ir);
    expect(d.text).not.toContain("inputs");
  });

  it("handles pipeline with no stage inputs/outputs", () => {
    const ir: PipelineIR = {
      name: "minimal",
      externalInputs: [],
      stages: [
        { name: "alone", type: "agent", inputs: [], outputs: [], config: { promptRef: "system/alone" } },
      ],
      wires: [],
    };
    const d = buildPipelineDescriptor(ir);
    expect(d.text).toContain("stage alone agent");
  });
});
