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
        config: {
          promptRef:
            "Pick a single integer between 1 and 100 inclusive. The value of port 'x' is that integer (as a plain number, not a string, not wrapped in any object).",
        },
      },
      {
        name: "B",
        type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "y", type: "string" }],
        config: {
          promptRef:
            "Input port 'x' is a number. The value of port 'y' is the plain string formed by concatenating the literal prefix \"B saw \" with x. Example: if x=42, then y is the 7-character string: B saw 42. Do NOT include any braces, quotes, or JSON wrapping inside the string value itself.",
        },
      },
      {
        name: "C",
        type: "agent",
        inputs: [{ name: "x", type: "number" }],
        outputs: [{ name: "z", type: "string" }],
        config: {
          promptRef:
            "Input port 'x' is a number. The value of port 'z' is the plain string formed by concatenating the literal prefix \"C saw \" with x. Example: if x=42, then z is the 7-character string: C saw 42. Do NOT include any braces, quotes, or JSON wrapping inside the string value itself.",
        },
      },
      {
        name: "D",
        type: "agent",
        inputs: [
          { name: "b", type: "string" },
          { name: "c", type: "string" },
        ],
        outputs: [{ name: "final", type: "string" }],
        config: {
          promptRef:
            "Inputs are two strings b and c. The value of port 'final' is the plain string formed by concatenating exactly: the literal \"b:\", then b, then the literal \" | c:\", then c. Example: if b=\"B saw 42\" and c=\"C saw 42\", then final is the 25-character string: b:B saw 42 | c:C saw 42. Do NOT include any braces, quotes, or JSON wrapping inside the string value itself.",
        },
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
        config: { promptRef: "extract the subject" },
      },
      {
        name: "echoBack",
        type: "agent",
        inputs: [{ name: "subject", type: "string" }],
        outputs: [{ name: "message", type: "string" }],
        config: { promptRef: "echo the subject in one sentence" },
      },
    ],
    wires: [
      { from: { stage: "greet", port: "subject" }, to: { stage: "echoBack", port: "subject" } },
    ],
  };
}
