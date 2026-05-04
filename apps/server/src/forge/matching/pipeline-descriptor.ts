// Build the "descriptor text" from a PipelineIR — what we embed for
// pipeline matching. Capture the contract: name, external inputs,
// stage names + their promptRefs (treated as identifiers, not prompt
// content), and store_schema port names. Promise: similar pipelines
// produce similar descriptor text.

import type { PipelineIR } from "../../kernel-next/ir/schema.js";

export interface PipelineDescriptor {
  name: string;
  text: string;
}

export function buildPipelineDescriptor(ir: PipelineIR): PipelineDescriptor {
  const parts: string[] = [];
  parts.push(`pipeline ${ir.name}`);

  const externals = ir.externalInputs ?? [];
  if (externals.length > 0) {
    parts.push("inputs " + externals.map((p) => `${p.name}:${p.type}`).join(" "));
  }

  for (const stage of ir.stages) {
    let line = `stage ${stage.name} ${stage.type}`;
    if (stage.type === "agent") {
      const ref = stage.config.promptRef;
      if (ref) line += ` ${ref.replace(/[/_-]/g, " ")}`;
    }
    if (stage.inputs && stage.inputs.length > 0) {
      line += " in " + stage.inputs.map((p) => p.name).join(" ");
    }
    if (stage.outputs && stage.outputs.length > 0) {
      line += " out " + stage.outputs.map((p) => p.name).join(" ");
    }
    parts.push(line);
  }

  return { name: ir.name, text: parts.join("\n") };
}
