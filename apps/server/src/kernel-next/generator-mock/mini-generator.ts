// Stand-in for pipeline-generator. Returns a hardcoded IR for a specific
// task description. In phase 2 this is replaced by the LLM-driven version.
//
// The generator is kept deliberately dumb: it maps a name -> IR, then the
// caller submits via submit_pipeline just like a real LLM-produced IR would.

import type { PipelineIR } from "../ir/schema.js";

export interface GenerateArgs {
  task: string;
}

export interface GenerateResult {
  ir: PipelineIR;
  rationale: string;
}

export function generatePipeline(args: GenerateArgs): GenerateResult {
  const task = args.task.toLowerCase();

  if (task.includes("diamond") || task.includes("fan-out") || task.includes("fan out")) {
    return {
      ir: diamondIR(),
      rationale:
        "User asked for a fan-out/fan-in pattern. Returning the canonical " +
        "diamond: A -> {B, C in parallel} -> D.",
    };
  }

  if (task.includes("linear") || task.includes("two-stage") || task.includes("minimal")) {
    return {
      ir: linearIR(),
      rationale: "Minimal linear pipeline: greet -> echoBack.",
    };
  }

  // Default fallback.
  return {
    ir: linearIR(),
    rationale: `No pattern matched for task '${args.task}'. Returning default linear IR.`,
  };
}

export function diamondIR(): PipelineIR {
  return {
    name: "diamond",
    stages: [
      {
        name: "A",
        type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { prompt: "produce a number x" },
      },
      {
        name: "B",
        type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "y", type: "string" }],
        config: { prompt: "double x and stringify" },
      },
      {
        name: "C",
        type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "z", type: "string" }],
        config: { prompt: "negate x and stringify" },
      },
      {
        name: "D",
        type: "agent",
        inputs: [
          { name: "b", type: "string" },
          { name: "c", type: "string" },
        ],
        outputs: [{ name: "final", type: "string" }],
        config: { prompt: "concatenate b and c" },
      },
    ],
    wires: [
      { from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } },
      { from: { stage: "A", port: "x" }, to: { stage: "C", port: "x" } },
      { from: { stage: "B", port: "y" }, to: { stage: "D", port: "b" } },
      { from: { stage: "C", port: "z" }, to: { stage: "D", port: "c" } },
    ],
  };
}

export function linearIR(): PipelineIR {
  return {
    name: "linear",
    stages: [
      {
        name: "greet",
        type: "agent",
        inputs: [],
        outputs: [{ name: "subject", type: "string" }],
        config: { prompt: "extract the subject" },
      },
      {
        name: "echoBack",
        type: "agent",
        inputs: [{ name: "subject", type: "string" }],
        outputs: [{ name: "message", type: "string" }],
        config: { prompt: "echo the subject in one sentence" },
      },
    ],
    wires: [
      { from: { stage: "greet", port: "subject" }, to: { stage: "echoBack", port: "subject" } },
    ],
  };
}
