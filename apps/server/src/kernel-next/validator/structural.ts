// Structural validation of a PipelineIR.
//
// Enforces the constraints listed in docs/kernel-next-design.md §4.2:
//   - stages[].name unique
//   - ports unique per (stage, direction)
//   - every wire's source port exists AND is an output
//   - every wire's target port exists AND is an input
//   - each input port driven by at most one wire (also enforced at SQLite PK,
//     but we want a clean diagnostic before touching the DB)
//   - entry stage, if specified, exists
//
// Type compatibility between wire endpoints (TS-level) is M2's job (tsc).

import type { PipelineIR } from "../ir/schema.js";
import type { Diagnostic, ValidationResult } from "../ir/schema.js";

export function validateStructural(ir: PipelineIR): ValidationResult {
  const diagnostics: Diagnostic[] = [];

  // --- Stage name uniqueness ---
  const stageNames = new Set<string>();
  for (const s of ir.stages) {
    if (stageNames.has(s.name)) {
      diagnostics.push({
        code: "DUPLICATE_STAGE_NAME",
        message: `Stage name '${s.name}' appears more than once.`,
        context: { stage: s.name },
      });
    }
    stageNames.add(s.name);
  }

  // --- Entry stage exists ---
  if (ir.entry !== undefined && !stageNames.has(ir.entry)) {
    diagnostics.push({
      code: "ENTRY_STAGE_MISSING",
      message: `Entry stage '${ir.entry}' is not declared in stages[].`,
      context: { entry: ir.entry },
    });
  }

  // --- Port uniqueness per (stage, direction) ---
  // Also build a lookup index for wire validation.
  type PortKey = `${string}.${string}.${"in" | "out"}`;
  const portIndex = new Map<PortKey, { type: string }>();

  for (const s of ir.stages) {
    const seenIn = new Set<string>();
    for (const p of s.inputs) {
      if (seenIn.has(p.name)) {
        diagnostics.push({
          code: "DUPLICATE_PORT_NAME",
          message: `Stage '${s.name}' has duplicate input port '${p.name}'.`,
          context: { stage: s.name, port: p.name, direction: "in" },
        });
      }
      seenIn.add(p.name);
      portIndex.set(`${s.name}.${p.name}.in`, { type: p.type });
    }
    const seenOut = new Set<string>();
    for (const p of s.outputs) {
      if (seenOut.has(p.name)) {
        diagnostics.push({
          code: "DUPLICATE_PORT_NAME",
          message: `Stage '${s.name}' has duplicate output port '${p.name}'.`,
          context: { stage: s.name, port: p.name, direction: "out" },
        });
      }
      seenOut.add(p.name);
      portIndex.set(`${s.name}.${p.name}.out`, { type: p.type });
    }
  }

  // --- Wire validity ---
  const drivenInputs = new Set<string>();
  for (const w of ir.wires) {
    // Source must exist and be an output.
    const fromInKey: PortKey = `${w.from.stage}.${w.from.port}.in`;
    const fromOutKey: PortKey = `${w.from.stage}.${w.from.port}.out`;
    const fromExistsAsOut = portIndex.has(fromOutKey);
    const fromExistsAsIn  = portIndex.has(fromInKey);
    const fromStageExists = stageNames.has(w.from.stage);

    if (!fromExistsAsOut && !fromExistsAsIn) {
      diagnostics.push({
        code: "WIRE_SOURCE_PORT_MISSING",
        message: fromStageExists
          ? `Wire source '${w.from.stage}.${w.from.port}' does not exist on stage '${w.from.stage}'.`
          : `Wire source stage '${w.from.stage}' does not exist (port '${w.from.port}' unreachable).`,
        context: { from: w.from, stageExists: fromStageExists },
      });
    } else if (!fromExistsAsOut && fromExistsAsIn) {
      diagnostics.push({
        code: "WIRE_SOURCE_DIRECTION_WRONG",
        message: `Wire source '${w.from.stage}.${w.from.port}' is an input port; must be output.`,
        context: { from: w.from },
      });
    }

    // Target must exist and be an input.
    const toInKey: PortKey = `${w.to.stage}.${w.to.port}.in`;
    const toOutKey: PortKey = `${w.to.stage}.${w.to.port}.out`;
    const toExistsAsIn  = portIndex.has(toInKey);
    const toExistsAsOut = portIndex.has(toOutKey);
    const toStageExists = stageNames.has(w.to.stage);

    if (!toExistsAsIn && !toExistsAsOut) {
      diagnostics.push({
        code: "WIRE_TARGET_PORT_MISSING",
        message: toStageExists
          ? `Wire target '${w.to.stage}.${w.to.port}' does not exist on stage '${w.to.stage}'.`
          : `Wire target stage '${w.to.stage}' does not exist (port '${w.to.port}' unreachable).`,
        context: { to: w.to, stageExists: toStageExists },
      });
    } else if (!toExistsAsIn && toExistsAsOut) {
      diagnostics.push({
        code: "WIRE_TARGET_DIRECTION_WRONG",
        message: `Wire target '${w.to.stage}.${w.to.port}' is an output port; must be input.`,
        context: { to: w.to },
      });
    }

    // Each input at most one driver.
    const targetKey = `${w.to.stage}.${w.to.port}`;
    if (drivenInputs.has(targetKey)) {
      diagnostics.push({
        code: "WIRE_TARGET_ALREADY_DRIVEN",
        message: `Input port '${targetKey}' is driven by more than one wire.`,
        context: { to: w.to },
      });
    }
    drivenInputs.add(targetKey);
  }

  return diagnostics.length === 0 ? { ok: true } : { ok: false, diagnostics };
}
