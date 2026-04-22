// A3 store_schema validator.
//
// The pipeline-level store_schema field is an AI-facing data dictionary:
// it names semantic slots ("artifactPath", "decisionLog", ...) and pins
// each one to a concrete (stage, port) output that carries its value.
// Callers — dashboards, debug tools, propose_pipeline_fix — can read the
// dictionary instead of inferring semantics from stage shape.
//
// Drift rules (docs/product-roadmap.md §6.3):
//   - STORE_SCHEMA_STAGE_MISSING — produced_by.stage is not in ir.stages
//   - STORE_SCHEMA_PORT_MISSING  — stage exists but has no output port with
//                                   produced_by.port (note: only output
//                                   ports are eligible; input ports never
//                                   count as producers)
//   - STORE_SCHEMA_TYPE_MISMATCH — entry.type.trim() != port.type.trim()
//
// Types are compared as trimmed strings, consistent with the rest of the
// IR — deep TS-equivalence is deferred to the M2 tsc phase.

import type { PipelineIR, Diagnostic, ValidationResult } from "../ir/schema.js";

export function validateStoreSchema(ir: PipelineIR): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const schema = ir.store_schema;
  if (!schema) return { ok: true };

  const stageByName = new Map<string, PipelineIR["stages"][number]>();
  for (const s of ir.stages) stageByName.set(s.name, s);

  for (const [key, entry] of Object.entries(schema)) {
    const { stage: stageName, port: portName } = entry.produced_by;
    const stage = stageByName.get(stageName);
    if (!stage) {
      diagnostics.push({
        code: "STORE_SCHEMA_STAGE_MISSING",
        message: `store_schema['${key}'] references stage '${stageName}' which is not declared in stages[].`,
        context: { key, stage: stageName, port: portName },
      });
      continue;
    }

    const outputPort = stage.outputs.find((p) => p.name === portName);
    if (!outputPort) {
      diagnostics.push({
        code: "STORE_SCHEMA_PORT_MISSING",
        message: `store_schema['${key}'] references output port '${portName}' on stage '${stageName}', but that stage has no such output port.`,
        context: { key, stage: stageName, port: portName },
      });
      continue;
    }

    if (entry.type.trim() !== outputPort.type.trim()) {
      diagnostics.push({
        code: "STORE_SCHEMA_TYPE_MISMATCH",
        message: `store_schema['${key}'] declares type '${entry.type}' but the referenced port '${stageName}.${portName}' is typed '${outputPort.type}'.`,
        context: {
          key,
          stage: stageName,
          port: portName,
          declaredType: entry.type,
          portType: outputPort.type,
        },
      });
    }
  }

  if (diagnostics.length === 0) return { ok: true };
  return { ok: false, diagnostics };
}
