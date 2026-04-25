import { describe, it, expect } from "vitest";
import { PipelineIRSchema } from "./schema.js";

describe("PipelineIRSchema.session_mode", () => {
  const minimalIR = {
    name: "p",
    stages: [
      {
        name: "s1",
        type: "agent",
        inputs: [],
        outputs: [],
        config: { promptRef: "p/r" },
      },
    ],
  };

  it("defaults to 'multi' when omitted", () => {
    const parsed = PipelineIRSchema.parse(minimalIR);
    expect(parsed.session_mode).toBe("multi");
  });

  it("accepts 'single'", () => {
    const parsed = PipelineIRSchema.parse({
      ...minimalIR,
      session_mode: "single",
    });
    expect(parsed.session_mode).toBe("single");
  });

  it("rejects unknown values", () => {
    expect(() =>
      PipelineIRSchema.parse({ ...minimalIR, session_mode: "foo" })
    ).toThrow();
  });
});
