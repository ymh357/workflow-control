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
//   - (2026-04-26) cross_segment_resume_from: target must exist, be
//     wire-upstream, and in a different segment; requires session_mode=single
//
// Type compatibility between wire endpoints (TS-level) is M2's job (tsc).

import type { PipelineIR } from "../ir/schema.js";
import type { Diagnostic, ValidationResult } from "../ir/schema.js";
import { wireFromStage } from "../ir/wire-helpers.js";
import { planSegments } from "../runtime/segment-planner.js";

export interface StructuralValidationOptions {
  /**
   * D'-1: the set of script module IDs the runtime will be able to
   * resolve. When provided, any ScriptStage whose config.moduleId is
   * absent from this set fails validation with
   * SCRIPT_MODULE_NOT_REGISTERED. Omit to skip the check (e.g. for
   * validate_pipeline dry runs, or D'-3+ inline-source scripts that
   * carry their implementation in config.moduleSource rather than
   * resolving a name).
   */
  allowedScriptModuleIds?: ReadonlySet<string>;
}

export function validateStructural(
  ir: PipelineIR,
  options: StructuralValidationOptions = {},
): ValidationResult {
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
  // Track stage type so the wire-validation phase can recognise the
  // kernel-emitted `__gate_feedback__` output on gate stages without
  // requiring every pipeline author to declare it.
  const stageTypeByName = new Map<string, "agent" | "script" | "gate">();
  for (const s of ir.stages) {
    stageTypeByName.set(s.name, s.type);
  }

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
      } else {
        // B4.F22: fanout input port must also have an inbound wire,
        // otherwise the runtime waits forever for an array that no
        // upstream ever produces. The port name being declared is
        // necessary but not sufficient — the wire is what actually
        // delivers the value.
        const hasInbound = ir.wires.some(
          (w) => w.to.stage === s.name && w.to.port === fanout.input,
        );
        if (!hasInbound) {
          diagnostics.push({
            code: "FANOUT_INPUT_NOT_WIRED",
            message:
              `Stage '${s.name}' declares fanout on input port '${fanout.input}', ` +
              `but no wire delivers a value to that port. The fanout would block forever.`,
            context: { stage: s.name, fanoutInput: fanout.input },
          });
        }
      }
    }

    // D'-1: registry-backed script stages must reference a registered
    // moduleId. D'-3 adds inline-source script stages (config.source ===
    // "inline") whose implementation travels in the IR itself; those
    // skip the registry check here and are validated by
    // submit-inline-script-contract (Layer 1 + 2 + 3) on the submit path.
    if (
      s.type === "script"
      && s.config.source === "registry"
      && options.allowedScriptModuleIds !== undefined
    ) {
      const moduleId = s.config.moduleId;
      if (!options.allowedScriptModuleIds.has(moduleId)) {
        diagnostics.push({
          code: "SCRIPT_MODULE_NOT_REGISTERED",
          message:
            `Script stage '${s.name}' references moduleId '${moduleId}', ` +
            `which is not registered in the kernel's builtin script registry. ` +
            `Registered modules: ${[...options.allowedScriptModuleIds].sort().join(", ") || "(none)"}.`,
          context: {
            stage: s.name,
            moduleId,
            registered: [...options.allowedScriptModuleIds].sort(),
          },
        });
      }
    }
  }

  // --- Gate target cross-gate conflict (F6 / concern C3, RELAXED 2026-04-29) ---
  //
  // Original rule (F6 / concern C3) forbade a stage from being a routing
  // target of more than one gate, fearing race conditions on
  // gateAuthorizedTargets / gateSkippedTargets. Investigation during the
  // 12-stage investigation-pipeline skeleton design (see
  // docs/superpowers/dogfood-2026-04-28/handoff.md continuation 7)
  // showed:
  //
  //   1. Gates fire sequentially, never concurrently — there is no
  //      runtime race.
  //   2. gateAuthorizedTargets uses dedup (line 392 of ir-to-machine.ts),
  //      so adding the same target twice from two different gates is a
  //      no-op the second time.
  //   3. gateSkippedTargets is written but never used as a guard — only
  //      gateAuthorizedTargets gates a stage's executing transition.
  //      "Stale" skipped entries from a prior gate are harmless.
  //   4. reject-rollback's affectedStages filter (runner.ts line 725)
  //      cleans both lists by stage-name, so cross-gate state collapses
  //      cleanly on rollback.
  //
  // The legitimate use case is a long pipeline with multiple
  // LLM-judge / human-review gates where each gate's reject loops back
  // to its own immediate upstream, AND the upstream of one gate is the
  // same stage as the approve forward of another gate. In the 12-stage
  // skeleton:
  //   - prereqExtraction is framingGate.approve AND prereqGate.reject
  //   - tutorialAuthoring is prereqGate.approve AND tutorialReviewGate.reject
  //   - hypothesize is tutorialReviewGate.approve AND
  //     findingsSynthesisGate.reject AND humanReviewGate.reject
  //
  // Forcing single-owner would require collapsing all gates into one
  // monolithic review gate, throwing away the per-layer feedback loop.
  // This rule is therefore lifted. The sharing pattern is now
  // first-class supported. (B4.F20: gateTargetOwners map removed —
  // dead code with no read sites, only kept by `void` to suppress
  // an unused-variable warning. If a future diagnostic needs the
  // owners-by-target view, rebuild it locally rather than carrying
  // it across the gap.)

  // --- Bug 28: multi-target rollback coherence ---
  //
  // A gate routing answer may declare multiple targets (`reject: [a, b]`).
  // The compiler treats the answer as rollback when ALL targets are
  // transitive ancestors of the gate (reverse-BFS via stage-sourced wires,
  // excluding `__gate_feedback__` back-edges so we mirror the compiler's
  // ancestor view). Mixed-semantics answers — some targets ancestors,
  // some not — collapse silently to "forward route" in the compiler,
  // which means a true reject answer to a partial-ancestor list would
  // never trigger rollback. Surface this clearly so the LLM regenerates
  // a coherent IR.
  {
    const downstreamAdj = new Map<string, Set<string>>();
    for (const w of ir.wires) {
      const fromStage = wireFromStage(w);
      if (fromStage === null) continue;
      if (w.from.port === "__gate_feedback__") continue;
      const set = downstreamAdj.get(fromStage);
      if (set) set.add(w.to.stage);
      else downstreamAdj.set(fromStage, new Set([w.to.stage]));
    }
    const bfsReaches = (start: string, target: string): boolean => {
      if (start === target) return true;
      const visited = new Set<string>([start]);
      const queue: string[] = [start];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const nexts = downstreamAdj.get(cur);
        if (!nexts) continue;
        for (const n of nexts) {
          if (n === target) return true;
          if (visited.has(n)) continue;
          visited.add(n);
          queue.push(n);
        }
      }
      return false;
    };
    for (const s of ir.stages) {
      if (s.type !== "gate") continue;
      for (const [answer, rawTarget] of Object.entries(s.config.routing.routes)) {
        if (!Array.isArray(rawTarget)) continue;
        if (rawTarget.length < 2) continue;
        const ancestor: boolean[] = rawTarget.map((t) => bfsReaches(t, s.name));
        const allAncestors = ancestor.every((b) => b);
        const noneAncestors = ancestor.every((b) => !b);
        if (!allAncestors && !noneAncestors) {
          diagnostics.push({
            code: "GATE_ROLLBACK_MIXED_TARGETS",
            message:
              `Gate '${s.name}' routes answer '${answer}' to multiple targets ` +
              `[${rawTarget.join(", ")}], some of which are upstream ancestors of ` +
              `the gate (rollback semantics) and others are not (forward semantics). ` +
              `Multi-target answers must be either all-rollback or all-forward.`,
            context: {
              stage: s.name,
              answer,
              targets: rawTarget,
              ancestorMask: ancestor,
            },
          });
        }
      }
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

      // A (gate feedback): `__gate_feedback__` is a builtin output on
      // every gate stage. Authors don't declare it — the runner writes
      // it when answer_gate is called. Treat any wire reading it from
      // a gate stage as if the port were declared.
      const isGateFeedbackSource =
        w.from.port === "__gate_feedback__" &&
        stageTypeByName.get(w.from.stage) === "gate";

      if (isGateFeedbackSource) {
        // Recognised — fall through to target validation without
        // emitting WIRE_SOURCE_* diagnostics.
      } else if (!fromExistsAsOut && !fromExistsAsIn) {
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

  // --- cross_segment_resume_from (2026-04-26 pivot) ---
  // Iterate agent stages with the field set. Validate against three rules:
  //   1. target stage exists
  //   2. target stage is wire-upstream (BFS through wires)
  //   3. target stage is in a different segment per planSegments()
  // Plus: the pipeline must be session_mode === "single" for the field
  // to have any meaning at all.
  const stagesWithCrossSegField: Array<{ stageName: string; target: string }> = [];
  for (const st of ir.stages) {
    if (st.type !== "agent") continue;
    const t = st.config.cross_segment_resume_from;
    if (typeof t === "string") stagesWithCrossSegField.push({ stageName: st.name, target: t });
  }
  if (stagesWithCrossSegField.length > 0) {
    if (ir.session_mode !== "single") {
      for (const { stageName } of stagesWithCrossSegField) {
        diagnostics.push({
          code: "CROSS_SEGMENT_RESUME_FROM_REQUIRES_SINGLE",
          message: `Stage '${stageName}' declares cross_segment_resume_from but pipeline session_mode is not 'single'; the field has no effect outside single-session pipelines.`,
          context: { stage: stageName },
        });
      }
    } else {
      // Build wire-upstream adjacency: for each stage, which stages feed into it directly?
      const wireUpstream = new Map<string, string[]>();
      for (const st of ir.stages) wireUpstream.set(st.name, []);
      for (const w of ir.wires) {
        const fromStage = wireFromStage(w);
        if (fromStage === null) continue;
        const list = wireUpstream.get(w.to.stage);
        if (!list) continue;
        if (!list.includes(fromStage)) list.push(fromStage);
      }

      const segments = planSegments(ir);
      const segmentOf = new Map<string, number>();
      segments.forEach((seg, idx) => seg.forEach((stageName) => segmentOf.set(stageName, idx)));

      for (const { stageName, target } of stagesWithCrossSegField) {
        // Rule 1: target exists
        if (!stageNames.has(target)) {
          diagnostics.push({
            code: "CROSS_SEGMENT_TARGET_NOT_FOUND",
            message: `Stage '${stageName}'.cross_segment_resume_from = '${target}' references a stage that is not declared in stages[].`,
            context: { stage: stageName, target },
          });
          continue;
        }
        // Rule 1.5: target must be an agent stage. Resume only makes
        // sense for agent-typed stages (which own SDK sessions); script
        // and gate stages have no session_id, and the runtime would
        // silently fall back to "no resume" for non-agent targets.
        // Catching it here turns a silent runtime mis-fire into an
        // authoring-time diagnostic.
        const targetType = stageTypeByName.get(target);
        if (targetType !== "agent") {
          diagnostics.push({
            code: "CROSS_SEGMENT_TARGET_NOT_AGENT",
            message: `Stage '${stageName}'.cross_segment_resume_from = '${target}' references a '${targetType}' stage; only agent stages own resumable SDK sessions.`,
            context: { stage: stageName, target, targetType: targetType ?? "unknown" },
          });
          continue;
        }
        // Rule 2: target is wire-upstream (BFS from stageName's direct predecessors)
        const reachable = new Set<string>();
        const queue = [...(wireUpstream.get(stageName) ?? [])];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          if (reachable.has(cur)) continue;
          reachable.add(cur);
          for (const up of wireUpstream.get(cur) ?? []) queue.push(up);
        }
        if (!reachable.has(target)) {
          diagnostics.push({
            code: "CROSS_SEGMENT_TARGET_NOT_REACHABLE",
            message: `Stage '${stageName}'.cross_segment_resume_from = '${target}' is not wire-reachable upstream from '${stageName}'.`,
            context: { stage: stageName, target },
          });
          continue;
        }
        // Rule 3: target is in a different segment
        if (segmentOf.get(stageName) === segmentOf.get(target)) {
          diagnostics.push({
            code: "CROSS_SEGMENT_TARGET_SAME_SEGMENT",
            message: `Stage '${stageName}'.cross_segment_resume_from = '${target}' is in the same segment; cross-segment resume is not applicable. (Within-segment continuation is automatic.)`,
            context: { stage: stageName, target },
          });
        }
      }
    }
  }

  // --- mcpServers.envKeys ⊆ ${VAR} references in command/args/env (Bug G, 2026-04-30) ---
  //
  // The kernel has two layers that look at MCP env requirements and they
  // were inconsistent:
  //   1. Pre-flight (collectMissingEnvKeys, start-pipeline-run.ts) — reads
  //      mcpServer.envKeys[] declaratively and warns the caller upfront.
  //   2. Runtime (expandMcpServers, mcp-servers-expander.ts) — only
  //      enumerates ${VAR} placeholders in command/args/env values; envKeys
  //      that are not referenced anywhere are silently ignored.
  //
  // The breakage: an IR that lists envKeys but forgets the matching
  // env: { KEY: "${KEY}" } passes pre-flight (warns the user "missing
  // KEY"), passes submit, then at runtime the expander finds nothing to
  // expand → ok=true → the secret-gate path is skipped entirely → the
  // child MCP process spawns without the key and fails its own
  // handshake. The user sees an opaque attempt-error and cannot recover
  // via provide_task_secrets because no secret_gate_queue row was ever
  // written.
  //
  // Fix: every envKey must appear as a ${KEY} reference in at least one
  // of command, args[*], env[*]. This guarantees expandMcpServers will
  // see the variable and route through the secret-gate path when it is
  // missing.
  const VAR_RE_FOR_ENVKEY = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  function collectVarRefs(s: string): Set<string> {
    const out = new Set<string>();
    const re = new RegExp(VAR_RE_FOR_ENVKEY.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) out.add(m[1]);
    return out;
  }
  for (const stage of ir.stages) {
    if (stage.type !== "agent") continue;
    const servers = stage.config.mcpServers ?? [];
    for (const srv of servers) {
      const declaredKeys = srv.envKeys ?? [];
      if (declaredKeys.length === 0) continue;
      const refs = new Set<string>();
      for (const v of collectVarRefs(srv.command)) refs.add(v);
      for (const a of srv.args ?? []) for (const v of collectVarRefs(a)) refs.add(v);
      if (srv.env) {
        for (const value of Object.values(srv.env)) {
          for (const v of collectVarRefs(value)) refs.add(v);
        }
      }
      for (const key of declaredKeys) {
        if (!refs.has(key)) {
          diagnostics.push({
            code: "ENVKEY_NOT_REFERENCED",
            message:
              `Stage '${stage.name}' mcpServer '${srv.name}' declares envKey '${key}' ` +
              `but no \${${key}} reference appears in command/args/env. ` +
              `Add env: { "${key}": "\${${key}}" } so runtime expansion can route ` +
              `through the secret-gate when the value is missing. Without this, the ` +
              `pre-flight check warns about '${key}' but the runtime silently spawns ` +
              `the MCP child without the value, producing an opaque handshake failure ` +
              `that provide_task_secrets cannot recover.`,
            context: { stage: stage.name, server: srv.name, envKey: key },
          });
        }
      }
    }
  }

  return diagnostics.length === 0 ? { ok: true } : { ok: false, diagnostics };
}
