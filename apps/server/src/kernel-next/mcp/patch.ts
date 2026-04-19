// Apply an IRPatch to a base PipelineIR, producing a new IR. Pure function.
// The caller (propose_pipeline_change) is responsible for re-validating the
// result. See docs/kernel-next-design.md §7 semantics:
//
//   1. remove_stage cascades to delete wires touching that stage.
//   2. Ops applied in order to a deep-copy of the base IR; validation happens
//      once at the end, not between ops. (Intermediate dangling state is
//      allowed — e.g. add_stage now, add_wire in a later op.)
//   3. update_port_type may cascade to type mismatches reported at codegen +
//      tsc layer; this module doesn't anticipate them.

import type { PipelineIR, IRPatch, IRPatchOp } from "../ir/schema.js";

export class PatchApplyError extends Error {
  constructor(message: string, public readonly op: IRPatchOp) {
    super(message);
    this.name = "PatchApplyError";
  }
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export function applyPatch(base: PipelineIR, patch: IRPatch): PipelineIR {
  const ir = deepClone(base);

  for (const op of patch.ops) {
    switch (op.op) {
      case "add_stage": {
        if (ir.stages.some((s) => s.name === op.stage.name)) {
          throw new PatchApplyError(
            `add_stage: '${op.stage.name}' already exists`, op,
          );
        }
        ir.stages.push(deepClone(op.stage));
        break;
      }
      case "remove_stage": {
        const before = ir.stages.length;
        ir.stages = ir.stages.filter((s) => s.name !== op.stageName);
        if (ir.stages.length === before) {
          throw new PatchApplyError(
            `remove_stage: '${op.stageName}' not found`, op,
          );
        }
        // Cascade: remove any wire touching this stage.
        ir.wires = ir.wires.filter(
          (w) => w.from.stage !== op.stageName && w.to.stage !== op.stageName,
        );
        break;
      }
      case "add_wire": {
        if (ir.wires.some(
          (w) =>
            w.from.stage === op.wire.from.stage &&
            w.from.port === op.wire.from.port &&
            w.to.stage === op.wire.to.stage &&
            w.to.port === op.wire.to.port,
        )) {
          throw new PatchApplyError(
            `add_wire: wire ${op.wire.from.stage}.${op.wire.from.port} -> ${op.wire.to.stage}.${op.wire.to.port} already exists`,
            op,
          );
        }
        ir.wires.push(deepClone(op.wire));
        break;
      }
      case "remove_wire": {
        const before = ir.wires.length;
        ir.wires = ir.wires.filter(
          (w) => !(
            w.from.stage === op.wire.from.stage &&
            w.from.port === op.wire.from.port &&
            w.to.stage === op.wire.to.stage &&
            w.to.port === op.wire.to.port
          ),
        );
        if (ir.wires.length === before) {
          throw new PatchApplyError(
            `remove_wire: not found`, op,
          );
        }
        break;
      }
      case "update_port_type": {
        const stage = ir.stages.find((s) => s.name === op.stage);
        if (!stage) {
          throw new PatchApplyError(
            `update_port_type: stage '${op.stage}' not found`, op,
          );
        }
        const ports = op.direction === "in" ? stage.inputs : stage.outputs;
        const port = ports.find((p) => p.name === op.port);
        if (!port) {
          throw new PatchApplyError(
            `update_port_type: port '${op.port}' (${op.direction}) not found on stage '${op.stage}'`,
            op,
          );
        }
        port.type = op.newType;
        break;
      }
      case "update_stage_config": {
        const stage = ir.stages.find((s) => s.name === op.stage);
        if (!stage) {
          throw new PatchApplyError(
            `update_stage_config: stage '${op.stage}' not found`, op,
          );
        }
        stage.config = { ...stage.config, ...op.configPatch };
        break;
      }
    }
  }

  return ir;
}
