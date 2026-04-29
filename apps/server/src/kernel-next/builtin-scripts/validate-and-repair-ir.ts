// validate_and_repair_ir — deterministic post-processor for IRs produced
// by the LLM-driven `genSkeleton` stage. Continuation 9.5 (2026-04-29).
//
// Background: 6 consecutive 17-stage dogfood runs failed at submit_pipeline
// because the LLM made small but-fatal mechanical errors writing the IR:
// dup wires, hallucinated aggregate port names, port name mismatches,
// missing externalInputs entries, fanout outputs split into too many
// element ports. Each error is deterministically detectable from the IR
// alone, and each is mechanically repairable. This script does that
// repair so the LLM only has to be right about content (which stages,
// what they read/write, what the prompts say) — not about IR bookkeeping.
//
// The script runs as a builtin between genSkeleton and genPrompts in
// pipeline-generator's IR; genPrompts then sees a structurally-valid IR
// and produces prompts consistent with it. Without this script, the same
// 5 mechanical error classes would re-emerge on every regen.
//
// Five repair functions, applied in order:
//   1. dedupeWires           — removes literally-identical duplicates
//   2. repairPortNameMismatch — fuzzy-match wire targets to declared inputs
//   3. repairFanoutShape     — joint Repair 4+5: source-side fanout-output
//                              shape determined by target-input type
//   4. backfillExternalInputs — infer missing externalInputs[] entries
//                              from `from.source === "external"` wires
//
// Each repair function is a pure function on PipelineIR + returns the
// repaired IR plus a list of human-readable repair descriptions for the
// dashboard. A composing wrapper threads them together.
//
// Throws (does NOT silently mangle) when:
//   - fuzzy match has multiple candidates (ambiguity)
//   - fanout source has no matching output and the target type can't
//     guide repair (true semantic error, not mechanical)

import type { ScriptModule } from "../runtime/script-module-resolver.js";
import type { PipelineIR, PortIR, WireIR } from "../ir/schema.js";

// ---------- Public entry point ----------

export interface RepairOutcome {
  ir: PipelineIR;
  repairs: string[];
}

export function validateAndRepairIR(input: PipelineIR): RepairOutcome {
  const repairs: string[] = [];
  let r: PipelineIR = input;

  // 1. Wire dedup — cheapest, removes duplicates that would mask other
  // diagnostics ("same wire twice + a wrong-target wire" looks like one
  // error per pair, but is really two separate problems).
  {
    const before = r.wires.length;
    const dedupd = dedupeWires(r.wires);
    if (dedupd.length !== before) {
      repairs.push(
        `dedupeWires: removed ${before - dedupd.length} duplicate wire(s)`,
      );
    }
    r = { ...r, wires: dedupd };
  }

  // 2. Wire target port name fuzzy match.
  {
    const out = repairPortNameMismatch(r);
    r = out.ir;
    repairs.push(...out.repairs);
  }

  // 3. Backfill missing target input ports (when fuzzy match found no
  // candidate but the wire is structurally fine). Common case: LLM
  // wrote a wire to `<stage>.<correctName>` but never added that port
  // to `<stage>.inputs[]`. We synthesize the input port using the type
  // inferred from the wire's source.
  {
    const out = backfillMissingTargetInputs(r);
    r = out.ir;
    repairs.push(...out.repairs);
  }

  // 4. Joint fanout-shape repair (covers original Repair 4 + Repair 5
  // for the source-side of fanout wires).
  {
    const out = repairFanoutShape(r);
    r = out.ir;
    repairs.push(...out.repairs);
  }

  // 5. Backfill externalInputs[] from external wires that reference
  // undeclared port names.
  {
    const out = backfillExternalInputs(r);
    r = out.ir;
    repairs.push(...out.repairs);
  }

  return { ir: r, repairs };
}

// ---------- Repair 1: dedup wires ----------

function wireKey(w: WireIR): string {
  return JSON.stringify({ from: w.from, to: w.to, guard: w.guard ?? null });
}

function dedupeWires(wires: WireIR[]): WireIR[] {
  const seen = new Set<string>();
  const result: WireIR[] = [];
  for (const w of wires) {
    const k = wireKey(w);
    if (seen.has(k)) continue;
    seen.add(k);
    result.push(w);
  }
  return result;
}

// ---------- Repair 2: wire target port fuzzy match ----------
//
// LLM writes `topicFraming.rejectionFeedback` but stage's inputs[] only has
// `framingRejectionFeedback`. Suffix-match (or substring-equality) lets us
// rewrite the wire's target port to the declared one.
//
// Strict: when fuzzy match finds >1 candidate, throw. The caller (LLM
// rerun) is the only thing that can disambiguate intent.

function repairPortNameMismatch(ir: PipelineIR): RepairOutcome {
  const stageByName = new Map(ir.stages.map((s) => [s.name, s] as const));
  const repairs: string[] = [];
  const newWires: WireIR[] = [];

  for (const w of ir.wires) {
    const targetStage = stageByName.get(w.to.stage);
    if (!targetStage) {
      // Unknown target stage — let downstream validator emit the real
      // diagnostic. We don't try to fuzzy-match across stages.
      newWires.push(w);
      continue;
    }
    const declaredInputNames = targetStage.inputs.map((p) => p.name);
    if (declaredInputNames.includes(w.to.port)) {
      newWires.push(w);
      continue;
    }
    // Find candidates: input ports whose names are similar enough.
    // We use a relaxed match (case-insensitive substring or suffix) — the
    // common LLM mistake forms are "rejectionFeedback" vs
    // "framingRejectionFeedback" (suffix) and "tutorials" vs
    // "tutorialMarkdowns" (substring).
    const lower = w.to.port.toLowerCase();
    const candidates = declaredInputNames.filter((n) => {
      const nl = n.toLowerCase();
      return nl === lower
        || nl.endsWith(lower)
        || lower.endsWith(nl)
        || nl.includes(lower)
        || lower.includes(nl);
    });

    if (candidates.length === 0) {
      // No fuzzy match — this isn't a port-name typo, it's a missing
      // input port. Either fanout-shape repair or external-input
      // backfill will handle it later, OR it's a genuine bug.
      newWires.push(w);
      continue;
    }
    if (candidates.length > 1) {
      throw new Error(
        `validate_and_repair_ir: ambiguous wire target port. ` +
          `Wire '${formatWireSource(w)}' -> '${w.to.stage}.${w.to.port}' has ` +
          `multiple fuzzy-match candidates on stage '${w.to.stage}': ` +
          `[${candidates.join(", ")}]. The LLM-emitted IR is structurally ` +
          `ambiguous; cannot auto-repair without changing semantics. ` +
          `Re-run genSkeleton with the dispatch ambiguity in mind.`,
      );
    }
    const chosen = candidates[0]!;
    repairs.push(
      `repairPortNameMismatch: rewrote wire target ` +
        `'${w.to.stage}.${w.to.port}' -> '${w.to.stage}.${chosen}'`,
    );
    newWires.push({ ...w, to: { ...w.to, port: chosen } });
  }
  return { ir: { ...ir, wires: newWires }, repairs };
}

function formatWireSource(w: WireIR): string {
  if (w.from.source === "external") return `external.${w.from.port}`;
  return `${w.from.stage}.${w.from.port}`;
}

// ---------- Repair 3: backfill missing target input ports ----------
//
// LLM error pattern: wire targets `<stage>.<correctName>` (a port name
// the STRICT skeleton table requires the stage to declare) but the
// stage's `inputs[]` doesn't have it because the LLM forgot to write
// the input port. Repair 2 (fuzzy match) only helps when there's a
// declared port to fuzzy-match to; when the input is fully missing,
// fuzzy match returns no candidate and the wire passes through to
// trigger WIRE_TARGET_PORT_MISSING.
//
// Strategy: for any wire whose target port is undeclared on the target
// stage, infer the port type from the wire's source (the source's
// output port type) and add the missing input port to the target
// stage's inputs[]. This covers gen6's `topicFraming.framingRejectionFeedback`
// and `prereqExtraction.prereqRejectionFeedback` both being missing
// because the LLM only declared one of the two reject-feedback ports.
//
// Only applied when fuzzy match (Repair 2) found no candidate — at this
// point in the pipeline order, any remaining wire targeting a
// non-existent port is genuinely missing. The synthesized port has the
// type inferred from the wire's source output port (or the conventional
// `string` for `__gate_feedback__` since gates emit string).

function backfillMissingTargetInputs(ir: PipelineIR): RepairOutcome {
  const repairs: string[] = [];
  const stageByName = new Map(ir.stages.map((s) => [s.name, s] as const));
  let stages = ir.stages;
  const stageMutations = new Map<string, PortIR[]>();

  for (const w of ir.wires) {
    const targetStage = stageByName.get(w.to.stage);
    if (!targetStage) continue;
    const declaredInputs = targetStage.inputs.map((p) => p.name);
    if (declaredInputs.includes(w.to.port)) continue;
    if ((stageMutations.get(w.to.stage) ?? []).some((p) => p.name === w.to.port)) continue;

    // Infer type from wire source.
    let inferredType = "string";
    if (w.from.source === "external") {
      // External port type already inferred elsewhere; use string fallback.
      inferredType = "string";
    } else {
      const srcStage = stageByName.get(w.from.stage);
      // gate stages have an implicit __gate_feedback__ port emitting `string`.
      if (w.from.port === "__gate_feedback__") {
        inferredType = "string";
      } else if (srcStage) {
        const srcPort = srcStage.outputs.find((p) => p.name === w.from.port);
        if (srcPort) inferredType = srcPort.type;
      }
    }

    const newPort: PortIR = {
      name: w.to.port,
      type: inferredType,
      description:
        `Auto-backfilled by validate_and_repair_ir from wire source ` +
        `${formatWireSource(w)} (LLM forgot to declare this input port).`,
    };
    const existing = stageMutations.get(w.to.stage) ?? [];
    existing.push(newPort);
    stageMutations.set(w.to.stage, existing);
    repairs.push(
      `backfillMissingTargetInputs: added '${w.to.stage}.inputs[${newPort.name}: ${newPort.type}]' ` +
        `(wired from ${formatWireSource(w)})`,
    );
  }

  if (stageMutations.size === 0) {
    return { ir, repairs };
  }

  stages = stages.map((s) => {
    const additions = stageMutations.get(s.name);
    if (!additions || additions.length === 0) return s;
    return { ...s, inputs: [...s.inputs, ...additions] };
  });
  return { ir: { ...ir, stages }, repairs };
}

// ---------- Repair 4: joint fanout-shape (source-side wire repair) ----------
//
// Two LLM error patterns that are dual to each other:
//
//   A) Hallucinated aggregate port: LLM writes
//        wire from `tutorialAuthoring.tutorials` -> `reportJudge.tutorialMarkdowns`
//      but `tutorialAuthoring.outputs` doesn't have a `tutorials` port — it
//      has `slug` + `markdown` (element-level). The target type
//      `string[]` says the consumer wants the array form of ONE field.
//      Repair: rewrite the wire to use the declared element-level port
//      whose name matches the target's logical field.
//
//   B) Over-fanned outputs: LLM declares `evidenceGather.outputs` as 5
//      separate ports (hypothesisId, verdict, positiveEvidence, ...) and
//      then wires ALL FIVE to the same target input port
//      `sourceClassify.evidence`. The target's type `Array<{...}>` says
//      it wants ONE object. Repair: synthesize a single object port on
//      the fanout stage that bundles the 5 fields and replace the 5 wires
//      with 1.
//
// The decision between (A)-style and (B)-style repair is driven by the
// *target input port's TS type*: `Array<{...}>` (object array) → (B);
// scalar/primitive array (`string[]`, `number[]`, etc.) → (A).
//
// We process per (fromStage, toStage, toPort) group because (B) only
// applies when multiple wires target the same input.

function repairFanoutShape(ir: PipelineIR): RepairOutcome {
  const repairs: string[] = [];
  let stages = ir.stages;
  let wires = ir.wires;
  const stageByName = new Map(stages.map((s) => [s.name, s] as const));

  // ------- Pattern (A): hallucinated source port (single-wire case) -------
  //
  // For wires whose source.stage is a fanout stage and source.port doesn't
  // exist in that stage's outputs[], try to repair by rewriting to a
  // matching declared output.
  const newWiresA: WireIR[] = [];
  for (const w of wires) {
    if (w.from.source !== "stage") {
      newWiresA.push(w);
      continue;
    }
    const srcStage = stageByName.get(w.from.stage);
    if (!srcStage) {
      newWiresA.push(w);
      continue;
    }
    if (srcStage.outputs.some((p) => p.name === w.from.port)) {
      newWiresA.push(w);
      continue; // source port exists, fine
    }
    // source.port doesn't exist on srcStage. Can we repair?
    const isFanout = isFanoutStage(srcStage);
    if (!isFanout) {
      // Not a fanout stage — likely a real typo. Try fuzzy match against
      // outputs[]; if no good match, leave wire as-is (downstream
      // validator will emit WIRE_SOURCE_PORT_MISSING and the caller has
      // to regen).
      const outNames = srcStage.outputs.map((p) => p.name);
      const lower = w.from.port.toLowerCase();
      const fuzzy = outNames.filter((n) => {
        const nl = n.toLowerCase();
        return nl === lower
          || nl.endsWith(lower)
          || lower.endsWith(nl)
          || nl.includes(lower)
          || lower.includes(nl);
      });
      if (fuzzy.length === 1) {
        const chosen = fuzzy[0]!;
        repairs.push(
          `repairFanoutShape (non-fanout source): rewrote wire source ` +
            `'${w.from.stage}.${w.from.port}' -> '${w.from.stage}.${chosen}'`,
        );
        newWiresA.push({ ...w, from: { ...w.from, port: chosen } });
        continue;
      }
      // Either no candidate or ambiguous — pass through and let the
      // validator complain with a clean message.
      newWiresA.push(w);
      continue;
    }

    // Fanout source with a non-existent port — repair by inferring shape
    // from the target input type.
    const targetStage = stageByName.get(w.to.stage);
    const targetPort = targetStage?.inputs.find((p) => p.name === w.to.port);
    const targetType = (targetPort?.type ?? "").trim();

    if (isObjectArrayType(targetType)) {
      // Target wants Array<{...}>. The fanout's element output should be
      // a single object port. If srcStage already has a single object
      // output port, use it. Otherwise we need pattern-(B)-style synthesis,
      // which is handled below — defer this wire by passing through and
      // let pattern (B) merge it (it will, because there's only one wire
      // in this group from this fanout's existing single object output...
      // unless srcStage has multiple object outputs, which would be the
      // ambiguous case).
      const objectOutputs = srcStage.outputs.filter((p) =>
        /^\{/.test(p.type.trim()),
      );
      if (objectOutputs.length === 1) {
        repairs.push(
          `repairFanoutShape: rewrote fanout wire source ` +
            `'${w.from.stage}.${w.from.port}' -> ` +
            `'${w.from.stage}.${objectOutputs[0]!.name}' ` +
            `(single object output port matches target Array<{...}>)`,
        );
        newWiresA.push({
          ...w,
          from: { ...w.from, port: objectOutputs[0]!.name },
        });
        continue;
      }
      if (objectOutputs.length === 0) {
        // No single object port — pass through; pattern (B) below may
        // synthesize one if there's a parallel multi-wire group. If not,
        // the original WIRE_SOURCE_PORT_MISSING surfaces.
        newWiresA.push(w);
        continue;
      }
      throw new Error(
        `validate_and_repair_ir: fanout stage '${srcStage.name}' has ` +
          `multiple object-shaped output ports [${objectOutputs.map((p) => p.name).join(", ")}], ` +
          `cannot determine which one to use for wire to ` +
          `'${w.to.stage}.${w.to.port}' (Array<{...}>). Re-run genSkeleton ` +
          `with explicit output port selection.`,
      );
    }

    if (isScalarArrayType(targetType)) {
      // Target wants `string[]` / `number[]` / etc. — single field, array
      // form. Find the element-level output port whose name correlates
      // with the target input port name.
      const elementOutput = pickElementOutputForScalarArrayTarget(
        srcStage.outputs,
        w.to.port,
      );
      if (elementOutput) {
        repairs.push(
          `repairFanoutShape: rewrote fanout wire source ` +
            `'${w.from.stage}.${w.from.port}' -> ` +
            `'${w.from.stage}.${elementOutput.name}' ` +
            `(target input '${w.to.port}' is ${targetType})`,
        );
        newWiresA.push({
          ...w,
          from: { ...w.from, port: elementOutput.name },
        });
        continue;
      }
      // No clear element match — pass through and surface validator error.
      newWiresA.push(w);
      continue;
    }

    // Target type doesn't tell us shape (no Array<...>). Conservative:
    // pass through and let the validator complain. We avoid silent
    // mangling.
    newWiresA.push(w);
  }
  wires = newWiresA;

  // ------- Pattern (B): over-fanned outputs (multi-wire case) -------
  //
  // Detect: multiple wires share the SAME (from.stage, to.stage, to.port)
  // triple, where from.stage is a fanout stage. The target wants ONE
  // value (object), but the LLM wired N element-level outputs into it.
  // Repair: synthesize a single object port on the fanout stage that
  // bundles the fields, and replace the N wires with 1.
  const groups = new Map<string, WireIR[]>();
  for (const w of wires) {
    if (w.from.source !== "stage") continue;
    const srcStage = stageByName.get(w.from.stage);
    if (!srcStage || !isFanoutStage(srcStage)) continue;
    const k = `${w.from.stage}|${w.to.stage}|${w.to.port}`;
    const list = groups.get(k);
    if (list) list.push(w);
    else groups.set(k, [w]);
  }

  const wiresToRemove = new Set<string>();
  const wiresToAdd: WireIR[] = [];
  let stagesNew = stages;

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    const firstFrom = group[0]!.from;
    if (firstFrom.source !== "stage") continue; // groups only built for stage sources, but TS narrowing
    const fromStage = firstFrom.stage;
    const srcStage = stageByName.get(fromStage)!;
    const targetStage = stageByName.get(group[0]!.to.stage);
    const targetPort = targetStage?.inputs.find(
      (p) => p.name === group[0]!.to.port,
    );
    const targetType = (targetPort?.type ?? "").trim();

    // Only apply this repair when the target genuinely wants Array<{...}>.
    // If target is multiple scalar arrays (which never happens for the
    // same input port), we'd not be in this branch.
    if (!isObjectArrayType(targetType)) {
      // Target is e.g. a primitive — multiple wires into one input is
      // truly malformed. Throw rather than mangle.
      throw new Error(
        `validate_and_repair_ir: ${group.length} wires from fanout stage ` +
          `'${fromStage}' converge on '${group[0]!.to.stage}.${group[0]!.to.port}' ` +
          `but target type '${targetType}' is not Array<{...}>. ` +
          `This pattern is only repairable when the target expects an object-array; ` +
          `re-run genSkeleton.`,
      );
    }

    // Synthesize a single object output port on srcStage that bundles
    // the fields the LLM wired.
    const fields: PortIR[] = [];
    const groupSourcePortNames = new Set<string>();
    for (const w of group) {
      const op = srcStage.outputs.find((p) => p.name === w.from.port);
      if (op && !groupSourcePortNames.has(op.name)) {
        fields.push(op);
        groupSourcePortNames.add(op.name);
      }
    }
    if (fields.length < 2) {
      // Less than 2 actual distinct fields after dedup — this wasn't
      // really an over-fan, just the same wire repeated (which dedup
      // already handles). Skip.
      continue;
    }

    const synthName = group[0]!.to.port; // the target input port name
    if (srcStage.outputs.some((p) => p.name === synthName)) {
      // Already exists — we don't want to clobber. Use a fallback name.
      // This case is very unlikely in practice.
      continue;
    }
    const synthType = `{ ${fields.map((f) => `${f.name}: ${f.type}`).join("; ")} }`;
    const synthPort: PortIR = {
      name: synthName,
      type: synthType,
      description:
        `Auto-synthesised by validate_and_repair_ir: aggregate of ` +
        `[${fields.map((f) => f.name).join(", ")}] for downstream ` +
        `${group[0]!.to.stage}.${group[0]!.to.port} (Array<{...}>).`,
    };

    stagesNew = stagesNew.map((s) =>
      s.name !== fromStage ? s : { ...s, outputs: [...s.outputs, synthPort] },
    );

    for (const w of group) wiresToRemove.add(wireKey(w));
    wiresToAdd.push({
      from: { source: "stage", stage: fromStage, port: synthName },
      to: group[0]!.to,
    });

    repairs.push(
      `repairFanoutShape: synthesised object output port ` +
        `'${fromStage}.${synthName}' from ${fields.length} fields ` +
        `[${fields.map((f) => f.name).join(", ")}] and replaced ${group.length} ` +
        `wires with 1 (target ${group[0]!.to.stage}.${group[0]!.to.port} is ${targetType})`,
    );
  }

  if (wiresToRemove.size > 0 || wiresToAdd.length > 0) {
    const filtered = wires.filter((w) => !wiresToRemove.has(wireKey(w)));
    wires = [...filtered, ...wiresToAdd];
    stages = stagesNew;
  }

  return { ir: { ...ir, stages, wires }, repairs };
}

// Heuristic: TS type literal is an object-array form like `Array<{...}>`,
// `{...}[]`, or `Array<Record<...>>`. Whitespace-tolerant.
function isObjectArrayType(t: string): boolean {
  if (!t) return false;
  const compact = t.replace(/\s+/g, "");
  if (/^Array<\{/.test(compact)) return true;
  if (/^Array<Record</.test(compact)) return true;
  if (/^\{.*\}\[\]$/.test(compact)) return true;
  return false;
}

// Heuristic: TS type literal is a scalar array — string[], number[],
// boolean[], Array<string>, Array<number>, etc.
function isScalarArrayType(t: string): boolean {
  if (!t) return false;
  const compact = t.replace(/\s+/g, "");
  if (/^(string|number|boolean)\[\]$/.test(compact)) return true;
  if (/^Array<(string|number|boolean)>$/.test(compact)) return true;
  return false;
}

function isFanoutStage(s: { name: string } & Record<string, unknown>): boolean {
  return (
    typeof s === "object" &&
    s !== null &&
    "fanout" in s &&
    s.fanout !== undefined &&
    s.fanout !== null
  );
}

// Given a fanout stage's outputs[] and a target input port name (which
// should correlate with one of those outputs in plural form), pick the
// element-level output port the wire should source from.
function pickElementOutputForScalarArrayTarget(
  outputs: PortIR[],
  targetPortName: string,
): PortIR | undefined {
  const lower = targetPortName.toLowerCase();
  // Exact substring match first: target `tutorialMarkdowns` matches
  // output `markdown`.
  for (const op of outputs) {
    if (lower.includes(op.name.toLowerCase())) return op;
  }
  // Reverse substring: target `slugs` matches output `slug`.
  for (const op of outputs) {
    if (op.name.toLowerCase().includes(lower)) return op;
  }
  return undefined;
}

// ---------- Repair 4: backfill externalInputs[] ----------
//
// LLM-emitted IR sometimes has wires whose `from.source === "external"`
// reference a port name that's not declared in `externalInputs[]`. This
// is a checklist failure: the LLM wrote `externalInputs.taskText` in
// stageContracts.reads but emitted `externalInputs: []`. We backfill the
// missing entries by inferring port type from the wire's downstream
// (target stage's input port type).

function backfillExternalInputs(ir: PipelineIR): RepairOutcome {
  const repairs: string[] = [];
  const stageByName = new Map(ir.stages.map((s) => [s.name, s] as const));
  const declared = new Set((ir.externalInputs ?? []).map((p) => p.name));

  const additions: PortIR[] = [];
  for (const w of ir.wires) {
    if (w.from.source !== "external") continue;
    if (declared.has(w.from.port)) continue;
    if (additions.some((p) => p.name === w.from.port)) continue;
    const targetStage = stageByName.get(w.to.stage);
    const targetPort = targetStage?.inputs.find((p) => p.name === w.to.port);
    const inferredType = targetPort?.type ?? "string";
    additions.push({
      name: w.from.port,
      type: inferredType,
      description:
        `Auto-backfilled by validate_and_repair_ir from downstream ` +
        `${w.to.stage}.${w.to.port}.`,
    });
    declared.add(w.from.port);
  }

  if (additions.length === 0) {
    return { ir, repairs };
  }
  for (const p of additions) {
    repairs.push(
      `backfillExternalInputs: added externalInput '${p.name}: ${p.type}'`,
    );
  }
  return {
    ir: { ...ir, externalInputs: [...(ir.externalInputs ?? []), ...additions] },
    repairs,
  };
}

// ---------- ScriptModule export ----------
//
// Inputs (from the upstream genSkeleton stage in the pipeline-generator
// IR — runs BEFORE genPrompts so prompts are generated against the
// repaired IR):
//   ir:        PipelineIR
//   subIrs:    PipelineIR[]
//
// Outputs:
//   ir:        PipelineIR — repaired
//   subIrs:    PipelineIR[] — each repaired independently
//   repairs:   string[] — human-readable list of repairs performed
//                         (across main + sub IRs)
//
// We do NOT re-validate against the full Zod schema here — that's the
// downstream KernelService.submit's job. Our contract: if the LLM made
// one of the 5 known mechanical errors, fix it. If it made a different
// error, pass through and let submit_pipeline emit the real diagnostic
// (which the next regen run can react to).

export const validate_and_repair_ir: ScriptModule = {
  async run(inputs) {
    const irRaw = inputs.ir;
    if (irRaw === undefined || irRaw === null || typeof irRaw !== "object") {
      throw new Error(
        `validate_and_repair_ir: input 'ir' is required and must be an object (got ${typeof irRaw})`,
      );
    }

    const irOut = validateAndRepairIR(irRaw as PipelineIR);
    const allRepairs = [...irOut.repairs];

    // sub-IRs (if any) get the same treatment — independently repaired.
    const subIrsIn = inputs.subIrs;
    const subIrsArr: unknown[] = Array.isArray(subIrsIn) ? subIrsIn : [];
    const repairedSubIrs: PipelineIR[] = [];
    for (let i = 0; i < subIrsArr.length; i++) {
      const sub = subIrsArr[i];
      if (sub === null || typeof sub !== "object") {
        throw new Error(
          `validate_and_repair_ir: subIrs[${i}] must be an object (got ${typeof sub})`,
        );
      }
      const subOut = validateAndRepairIR(sub as PipelineIR);
      repairedSubIrs.push(subOut.ir);
      for (const r of subOut.repairs) {
        allRepairs.push(`subIrs[${i}]: ${r}`);
      }
    }

    return {
      ir: irOut.ir,
      subIrs: repairedSubIrs,
      repairs: allRepairs,
    };
  },
};
