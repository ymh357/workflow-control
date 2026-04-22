// Structural validation of a PipelineIR.
//
// Enforces the constraints listed in docs/kernel-next-terminal-design.md:
//   - stages[].name unique
//   - ports unique per (stage, direction)
//   - every wire's source port exists AND is an output
//     (external-source wires instead target a declared external input)
//   - every wire's target port exists AND is an input
//   - each input port driven by at most one wire (also enforced at SQLite PK,
//     but we want a clean diagnostic before touching the DB)
//   - entry stage, if specified, exists
//   - (§3.2) gate stages must not declare fanout
//   - (§3.2) gate.config.routing targets must be declared stages
//   - (§6.3) a stage declaring fanout must name one of its own input ports
//   - (§4.15) no stage or external input may be named "__external__" (reserved
//     sentinel for kernel-next seed lineage)
//   - (§4.4) externalInputs[] names unique and distinct from stage names
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

  // --- Reserved stage name ---
  // The sentinel "__external__" is carved out of the stage-name space so
  // kernel-next's execution record layer can mint synthetic seed lineage
  // entries (ExecutionAttempt.stage = "__external__") without colliding
  // with a real stage. Any user-declared stage or external input using
  // this name would violate that invariant.
  const RESERVED = "__external__";
  for (const s of ir.stages) {
    if (s.name === RESERVED) {
      diagnostics.push({
        code: "RESERVED_STAGE_NAME",
        message: `Stage name '${s.name}' is reserved for kernel-next seed lineage.`,
        context: { stage: s.name },
      });
    }
  }

  // --- External inputs: reserved / duplicate / stage-collision ---
  const externalInputs = ir.externalInputs ?? [];
  const externalNames = new Set<string>();
  for (const p of externalInputs) {
    if (p.name === RESERVED) {
      diagnostics.push({
        code: "RESERVED_STAGE_NAME",
        message: `External input '${p.name}' uses the reserved sentinel name.`,
        context: { port: p.name },
      });
      // Skip further checks for a reserved-name port — subsequent
      // duplicate/collision diagnostics would just echo the same problem.
      continue;
    }
    if (externalNames.has(p.name)) {
      diagnostics.push({
        code: "DUPLICATE_EXTERNAL_INPUT_NAME",
        message: `External input '${p.name}' is declared more than once.`,
        context: { port: p.name },
      });
    }
    if (stageNames.has(p.name)) {
      diagnostics.push({
        code: "EXTERNAL_INPUT_COLLIDES_WITH_STAGE",
        message: `External input '${p.name}' collides with a stage of the same name.`,
        context: { port: p.name },
      });
    }
    externalNames.add(p.name);
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

  // --- Stage-type specific rules (gate / fanout) ---
  // Track gate target → list of gates that route to it, so we can reject
  // targets shared across gates (F6 / concern C3). A stage that is a
  // routing target for two different gates would be simultaneously
  // authorized by one gate's answer and skipped by the other's, and the
  // runtime has no defined resolution.
  const gateTargetOwners = new Map<string, string[]>();

  for (const s of ir.stages) {
    if (s.type === "gate") {
      // zod-level schema already forbids `fanout` on GateStage, but patch
      // application or hand-crafted IR may sneak one in; surface clearly.
      if ((s as { fanout?: unknown }).fanout !== undefined) {
        diagnostics.push({
          code: "GATE_FANOUT_FORBIDDEN",
          message: `Stage '${s.name}' is a gate and cannot declare fanout.`,
          context: { stage: s.name },
        });
      }
      const routes = s.config.routing.routes;
      for (const [answer, rawTarget] of Object.entries(routes)) {
        // rawTarget may be a single stage name or an array of stage names
        const targets: string[] = Array.isArray(rawTarget) ? rawTarget : [rawTarget];
        for (const target of targets) {
          if (!stageNames.has(target)) {
            diagnostics.push({
              code: "GATE_ROUTING_TARGET_MISSING",
              message:
                `Gate '${s.name}' routes answer '${answer}' to stage '${target}', ` +
                `but '${target}' is not declared in stages[].`,
              context: { stage: s.name, answer, target },
            });
          }
          // Record owner for the cross-gate conflict check below. A single
          // gate may legitimately route multiple answers to the same target
          // (e.g. yes → SUMMARY, confirm → SUMMARY); that's not a conflict,
          // so we de-dupe per-gate before adding.
          const owners = gateTargetOwners.get(target);
          if (!owners) {
            gateTargetOwners.set(target, [s.name]);
          } else if (!owners.includes(s.name)) {
            owners.push(s.name);
          }
        }
      }
    }

    // Fanout input must reference one of the stage's own input ports.
    const fanout = (s as { fanout?: { input: string } }).fanout;
    if (fanout !== undefined) {
      const stageInputs = new Set(s.inputs.map((p) => p.name));
      if (!stageInputs.has(fanout.input)) {
        diagnostics.push({
          code: "FANOUT_INPUT_MISSING",
          message:
            `Stage '${s.name}' declares fanout on input '${fanout.input}', ` +
            `but no such input port is declared.`,
          context: { stage: s.name, fanoutInput: fanout.input },
        });
      }
    }
  }

  // --- Gate target cross-gate conflict (F6 / concern C3) ---
  // Reject targets routed to by more than one gate. The runtime's
  // GATE_ANSWERED path places the picked target into
  // context.gateAuthorizedTargets and the non-picked siblings into
  // gateSkippedTargets. A target shared across two gates would land
  // on BOTH lists when each gate's answer arrives with a different
  // selection, producing undefined behaviour (ir-to-machine compiles
  // two mutually-exclusive transitions for the same region).
  for (const [target, owners] of gateTargetOwners) {
    if (owners.length > 1) {
      diagnostics.push({
        code: "GATE_TARGET_SHARED",
        message:
          `Stage '${target}' appears as a routing target for multiple gates ` +
          `(${owners.join(", ")}). A routing target must belong to exactly one gate.`,
        context: { target, gates: owners },
      });
    }
  }

  // --- Wire validity ---
  const drivenInputs = new Set<string>();
  for (const w of ir.wires) {
    // Source validity — discriminated on WireSource.source. External
    // sources are validated against ir.externalInputs[]; stage sources
    // against portIndex.
    if (w.from.source === "external") {
      if (!externalNames.has(w.from.port)) {
        diagnostics.push({
          code: "WIRE_EXTERNAL_SOURCE_PORT_MISSING",
          message: `Wire external source '${w.from.port}' is not declared in externalInputs[].`,
          context: { from: w.from },
        });
      }
    } else {
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

  // P6-8: reject pipelines where no data can ever flow anywhere. This
  // catches the pipeline-generator agent bug where the persist stage
  // strips every stage's inputs/outputs + wires before calling
  // submit_pipeline. Prior to this rule the empty-shell IR validated,
  // submit_pipeline stored it, runPipeline reached parallel.onDone
  // immediately (nothing to activate), and downstream callers saw a
  // 'completed' task that had done nothing.
  //
  // Criteria for EMPTY_DATAFLOW: zero wires AND zero externalInputs
  // AND every stage's inputs and outputs are both empty. A pipeline
  // that legitimately has no wires (eg. a single self-contained
  // stage) still declares inputs/outputs, so it won't trip here.
  //
  // Gate-only fixtures in unit tests (agent stages with no ports used
  // purely as routing targets) don't fail because they still carry at
  // least externals or wires; the rule only trips when EVERYTHING is
  // stripped, which is the real-world failure mode.
  const hasWires = ir.wires.length > 0;
  const hasExternals = (ir.externalInputs?.length ?? 0) > 0;
  const hasAnyPort = ir.stages.some((s) => s.inputs.length > 0 || s.outputs.length > 0);
  if (!hasWires && !hasExternals && !hasAnyPort) {
    diagnostics.push({
      code: "EMPTY_DATAFLOW",
      message: "Pipeline has no wires, no external inputs, and no stage declares any input or output port. Nothing can flow, nothing can execute. Did the submitter strip the schema before submitting?",
      context: { stageCount: ir.stages.length },
    });
  }

  return diagnostics.length === 0 ? { ok: true } : { ok: false, diagnostics };
}
