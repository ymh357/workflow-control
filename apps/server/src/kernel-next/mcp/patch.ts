// Apply an IRPatch to a base PipelineIR, producing a new IR. Pure function.
// The caller (propose_pipeline_change) is responsible for re-validating the
// result. See docs/kernel-next-terminal-design.md §10 semantics:
//
//   1. remove_stage cascades to delete wires touching that stage.
//   2. Ops applied in order to a deep-copy of the base IR; validation happens
//      once at the end, not between ops. (Intermediate dangling state is
//      allowed — e.g. add_stage now, add_wire in a later op.)
//   3. update_port_type may cascade to type mismatches reported at codegen +
//      tsc layer; this module doesn't anticipate them.
//   4. update_stage_config merges configPatch keys into stage.config. Since
//      StageIR is a discriminated union keyed by `type`, only keys that the
//      target stage's variant allows are retained in the shallow merge;
//      keys outside that set raise PatchApplyError. This is stricter than
//      the legacy flat-config merge and surfaces invalid patches early.

import type { PipelineIR, IRPatch, IRPatchOp, StageIR } from "../ir/schema.js";

// Permitted config keys per stage variant, kept in lockstep with
// ir/schema.ts. If schema.ts grows new variants or fields, this table
// must be updated.
//
// Coverage rationale (Finding 16, 2026-04-26):
// - agent: AgentStageSchema permits {promptRef, subAgents, mcpServers}.
//   All three are listed here so hot-update can adjust sub-agent lists
//   and MCP server declarations without a full pipeline resubmit.
// - gate: GateStageSchema permits {question, routing, timeout_minutes}.
//   timeout_minutes is opt-in deadline (P5.2/D6); listed for parity.
// - script: ScriptStageSchema is a discriminated union over `source`
//   ("registry" | "inline"). Cross-variant mutation (registry -> inline
//   or vice versa) requires more than a shallow merge — moduleId vs
//   moduleSource/sampleInputs are not co-existent. We expose only the
//   fields that are safely mergeable within a single variant: moduleId
//   for registry-source, retry for both. Variant switches must go via
//   submit_pipeline + new version. Hot-update is for in-place tweaks.
const ALLOWED_CONFIG_KEYS: Record<StageIR["type"], readonly string[]> = {
  agent:  ["promptRef", "subAgents", "mcpServers"],
  script: ["moduleId", "retry"],
  gate:   ["question", "routing", "timeout_minutes"],
};

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
        // Bridge: Task 1.2 introduced WireSource. External-source wires
        // never reference stage names by identity (source !== "stage") so
        // the cascade only applies to stage-source wires. Task 1.3+ will
        // replace the sentinel with an explicit source === "stage" check.
        ir.wires = ir.wires.filter(
          (w) =>
            (w.from.source === "external" ? "__external__" : w.from.stage) !== op.stageName &&
            w.to.stage !== op.stageName,
        );
        break;
      }
      case "add_wire": {
        const opFromStage = op.wire.from.source === "external" ? "__external__" : op.wire.from.stage;
        if (ir.wires.some(
          (w) =>
            (w.from.source === "external" ? "__external__" : w.from.stage) === opFromStage &&
            w.from.port === op.wire.from.port &&
            w.to.stage === op.wire.to.stage &&
            w.to.port === op.wire.to.port,
        )) {
          throw new PatchApplyError(
            `add_wire: wire ${opFromStage}.${op.wire.from.port} -> ${op.wire.to.stage}.${op.wire.to.port} already exists`,
            op,
          );
        }
        ir.wires.push(deepClone(op.wire));
        break;
      }
      case "remove_wire": {
        const opFromStage = op.wire.from.source === "external" ? "__external__" : op.wire.from.stage;
        const before = ir.wires.length;
        ir.wires = ir.wires.filter(
          (w) => !(
            (w.from.source === "external" ? "__external__" : w.from.stage) === opFromStage &&
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
        const allowed = ALLOWED_CONFIG_KEYS[stage.type];
        const unknownKeys = Object.keys(op.configPatch).filter(
          (k) => !allowed.includes(k),
        );
        if (unknownKeys.length > 0) {
          throw new PatchApplyError(
            `update_stage_config: stage '${op.stage}' is type '${stage.type}' and does not accept config keys [${unknownKeys.join(", ")}]; allowed keys: [${allowed.join(", ")}]`,
            op,
          );
        }
        // TypeScript can't narrow `stage.config` through the dynamic
        // `allowed` key list, so we re-assign through a typed cast. The
        // runtime guard above keeps the assignment type-safe in practice.
        stage.config = { ...stage.config, ...op.configPatch } as StageIR["config"];
        break;
      }
    }
  }

  return ir;
}
