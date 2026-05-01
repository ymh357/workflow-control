// IR -> pipeline.ts codegen.
//
// Produces a single TypeScript module that:
//   1. Declares each stage's Input / Output interfaces under a namespace.
//   2. Emits one `__wire__*` dummy assignment per wire, forcing tsc to check
//      `from.type` assignable to `to.type`. On mismatch tsc reports TS2322
//      with the assignment line number, which validator/types.ts parses back
//      into a structured WIRE_TYPE_MISMATCH diagnostic.
//
// See docs/kernel-next-design.md §5.2 + §5.3 for the rationale (why dummy
// assignments instead of `extends ? true : never`).

import { createHash } from "node:crypto";
import type { PipelineIR, StageIR, PortIR } from "../ir/schema.js";

// Bug 31 (c12+ review): PortIR.type is LLM-supplied free text that gets
// inlined into the emitted TS source verbatim (`${p.name}: ${p.type};`).
// The emitted source is then persisted in pipeline_versions.ts_source
// and shipped to tsc for diagnostics. Without validation, the LLM could
// craft a type that escapes its surrounding `interface { ... }` body
// and inject arbitrary top-level statements into the persisted module:
//   "string; }; export const x = <RCE>; namespace Stages { interface X { y"
// We bound this attack surface by:
//   1. Whitelisting the character class to TS type-expression syntax
//      (letters, digits, `_.,<>[](){}?|&:'\"!`, whitespace).
//   2. Rejecting newlines, carriage returns, and comment markers
//      ("//", "/*", "*/") so multiline injection / commented-out code is
//      impossible.
//   3. Rejecting `=` and backticks so variable-initializer / template
//      syntax can't be smuggled in.
//   4. Requiring balanced brackets for every bracket family — `{}`,
//      `[]`, `()`, `<>`. An imbalanced `}` would close the host
//      interface and let downstream tokens become top-level code.
const PORT_TYPE_ALLOWED_CHARS = /^[A-Za-z0-9_.,;<>\[\]{}()?|&:'"!\s]+$/;
const PORT_TYPE_FORBIDDEN_SUBSTRINGS = ["//", "/*", "*/", "\n", "\r", "=", "`"];

function assertBalanced(open: string, close: string, type: string): boolean {
  let depth = 0;
  for (const ch of type) {
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function assertSafePortType(
  context: { stage: string; portName: string; direction: "in" | "out" | "external" },
  type: string,
): void {
  if (typeof type !== "string" || type.length === 0) {
    throw new Error(
      `[emit-ts] Port type for ${context.stage}.${context.portName} ` +
      `(direction=${context.direction}) is not a non-empty string; ` +
      `cannot emit TS source.`,
    );
  }
  if (type.length > 4096) {
    throw new Error(
      `[emit-ts] Port type for ${context.stage}.${context.portName} ` +
      `is ${type.length} chars; refuse to inline (potential code-injection).`,
    );
  }
  for (const bad of PORT_TYPE_FORBIDDEN_SUBSTRINGS) {
    if (type.includes(bad)) {
      throw new Error(
        `[emit-ts] Port type for ${context.stage}.${context.portName} ` +
        `contains forbidden substring ${JSON.stringify(bad)}; refuse to ` +
        `inline (potential code-injection).`,
      );
    }
  }
  if (!PORT_TYPE_ALLOWED_CHARS.test(type)) {
    throw new Error(
      `[emit-ts] Port type for ${context.stage}.${context.portName} ` +
      `contains characters outside the allowed TS type-expression set; ` +
      `refuse to inline. Got: ${JSON.stringify(type)}`,
    );
  }
  for (const [open, close] of [["{", "}"], ["[", "]"], ["(", ")"], ["<", ">"]] as const) {
    if (!assertBalanced(open, close, type)) {
      throw new Error(
        `[emit-ts] Port type for ${context.stage}.${context.portName} ` +
        `has unbalanced ${open}${close} brackets; refuse to inline ` +
        `(potential code-injection). Got: ${JSON.stringify(type)}`,
      );
    }
  }
}

export interface WireMapEntry {
  line: number;                   // 1-based line number of the assignment
  fromStage: string;
  fromPort: string;
  toStage: string;
  toPort: string;
  fromType: string;
  toType: string;
}

export interface EmitResult {
  source: string;
  // Line -> wire map for diagnostic back-mapping. validator/types.ts uses
  // identifier name as primary key; line is kept for tsc error → wire lookup
  // when two wires happen to share a variable name collision (shouldn't
  // happen given our naming scheme, but cheap defense).
  wireByIdentifier: Map<string, WireMapEntry>;
  wireByLine: Map<number, WireMapEntry>;
}

// Wire identifier must be unambiguous: stage and port names may contain
// underscores, so the join-with-underscore form can collide (e.g. stage
// `a_b` port `c` vs stage `a` port `b_c` both encode to `a_b_c`). Append a
// short hash of the 4-tuple as disambiguator. The prefix keeps the name
// human-readable in tsc diagnostics; the hash guarantees uniqueness.
function wireIdentifier(fromStage: string, fromPort: string, toStage: string, toPort: string): string {
  const disambiguator = createHash("sha256")
    .update([fromStage, fromPort, toStage, toPort].join("\u0001"))
    .digest("hex")
    .slice(0, 8);
  return `__wire__${fromStage}_${fromPort}__TO__${toStage}_${toPort}__${disambiguator}`;
}

function emitPortBlock(
  stageName: string,
  ports: PortIR[],
  kind: "Inputs" | "Outputs",
): string[] {
  if (ports.length === 0) {
    return [`    export interface ${kind} {}`];
  }
  const lines: string[] = [`    export interface ${kind} {`];
  const direction: "in" | "out" = kind === "Inputs" ? "in" : "out";
  for (const p of ports) {
    assertSafePortType({ stage: stageName, portName: p.name, direction }, p.type);
    lines.push(`      ${p.name}: ${p.type};`);
  }
  lines.push(`    }`);
  return lines;
}

function emitStage(stage: StageIR): string[] {
  const lines: string[] = [];
  lines.push(`  export namespace ${stage.name} {`);
  lines.push(...emitPortBlock(stage.name, stage.inputs, "Inputs"));
  // Gate stages have an implicit kernel-emitted `__gate_feedback__` output
  // carrying the user's reject comment (or empty string on approve). The
  // structural validator (validator/structural.ts:283) already special-cases
  // this port as a builtin output. Codegen must mirror that — without the
  // declaration, any wire from `<gate>.__gate_feedback__` to an upstream
  // input fails tsc with TS2339, then surfaces as WIRE_TYPE_MISMATCH at
  // submit time. This is the canonical pattern for gate-reject-feedback
  // loops; do not require IR authors to declare it manually.
  const synthesizedOutputs =
    stage.type === "gate"
      ? [...stage.outputs, { name: "__gate_feedback__", type: "string" } as PortIR]
      : stage.outputs;
  lines.push(...emitPortBlock(stage.name, synthesizedOutputs, "Outputs"));
  lines.push(`  }`);
  return lines;
}

export function emitPipelineModule(ir: PipelineIR): EmitResult {
  const lines: string[] = [];
  lines.push(`// AUTOGENERATED by kernel-next/codegen/emit-ts. Do not edit.`);
  lines.push(`// Pipeline: ${ir.name}`);
  lines.push(``);
  lines.push(`export namespace Stages {`);
  for (const s of ir.stages) {
    lines.push(...emitStage(s));
  }
  lines.push(`}`);
  lines.push(``);

  // External inputs namespace (§externalInputs extension).
  // When the pipeline declares externalInputs, emit a parallel `__external__`
  // namespace whose Outputs block mirrors the declared external port shape.
  // External-source wires then reference `__external__.Outputs[port]` for
  // their type assertion — the type system treats the seed as a first-class
  // producer without needing a real stage.
  if (ir.externalInputs && ir.externalInputs.length > 0) {
    lines.push(`export namespace __external__ {`);
    lines.push(`  export interface Outputs {`);
    for (const p of ir.externalInputs) {
      assertSafePortType(
        { stage: "__external__", portName: p.name, direction: "external" },
        p.type,
      );
      lines.push(`    ${JSON.stringify(p.name)}: ${p.type};`);
    }
    lines.push(`  }`);
    lines.push(`}`);
    lines.push(``);
  }

  // Wire assertions. Each assignment forces tsc to verify that the source
  // output type is assignable to the target input type.
  // Declaration shape:
  //   export const __wire__A_x__TO__B_x: Stages.B.Inputs["x"] =
  //     null as unknown as Stages.A.Outputs["x"];
  // On type mismatch tsc reports TS2322 at this line.
  const wireByIdentifier = new Map<string, WireMapEntry>();
  const wireByLine = new Map<number, WireMapEntry>();

  for (const w of ir.wires) {
    // WireSource discriminated union (Task 1.2 / schema): stage vs external.
    //   stage:    Stages.<name>.Outputs[port]    (normal producer)
    //   external: __external__.Outputs[port]    (pipeline seed, no stage)
    // Narrow via a direct check on `w.from.source` (TS does not propagate
    // narrowing through an intermediate boolean).
    let fromStageId: string;
    let fromTypeLookup: string;
    const fromIsExternal = w.from.source === "external";
    if (w.from.source === "external") {
      fromStageId = "__external__";
      fromTypeLookup = `__external__.Outputs["${w.from.port}"]`;
    } else {
      // Legacy-compat: WireIR's optional `source` discriminant defeats
      // narrowing to the stage-member in this else-branch even though both
      // non-external members carry `stage`. Assert the stage-member shape.
      const fromStageName = (w.from as { stage: string }).stage;
      fromStageId = fromStageName;
      fromTypeLookup = `Stages.${fromStageName}.Outputs["${w.from.port}"]`;
    }
    const ident = wireIdentifier(fromStageId, w.from.port, w.to.stage, w.to.port);
    const toTypeLookup = `Stages.${w.to.stage}.Inputs["${w.to.port}"]`;

    // Design §7.3 — fanout type compatibility.
    //   from-fanout:   producer stage has `fanout`. Kernel auto-reshapes
    //                  each declared output T into T[] for downstream
    //                  consumption (§6.3 / §6.4). Wire source effective
    //                  type is Array<Outputs[port]>, declared is T.
    //   to-fanout:     consumer stage has `fanout` AND this wire targets
    //                  its fanout.input. Kernel iterates the source
    //                  array and feeds ONE element per virtual attempt,
    //                  so the declared input T is satisfied by T[][0].
    //   neither:       plain assignment, tsc checks declared types 1:1.
    //   both:          effects cancel — wire is T-to-T again.
    //
    // Without these wrap/unwrap transforms tsc would reject every fanout
    // pipeline with TS2322 (Reviewer concern C1 / plan §3 C1).
    //
    // External seed wires pass through as-is: they are scalar pipeline
    // inputs, never a fanned-out array. Forcing fromIsFanout=false here
    // prevents the codegen from wrapping an external seed in `[...]`.
    // Lookup producer stage for non-external wires. The cast is safe because
    // the WireIR type keeps legacy `{ source?: "stage", stage, port }` and
    // modern `{ source: "stage", stage, port }` as the same runtime shape;
    // the optional discriminant blocks TS's narrowing in the else-branch
    // even though both members carry `stage`.
    let fromStage: StageIR | undefined;
    if (w.from.source === "external") {
      fromStage = undefined;
    } else {
      const fromStageName = (w.from as { stage: string }).stage;
      fromStage = ir.stages.find((s) => s.name === fromStageName);
    }
    const toStage = ir.stages.find((s) => s.name === w.to.stage);
    const fromIsFanout =
      !fromIsExternal &&
      (fromStage?.type === "agent" || fromStage?.type === "script") &&
      fromStage?.fanout != null;
    const toIsFanout =
      (toStage?.type === "agent" || toStage?.type === "script") &&
      toStage?.fanout != null &&
      toStage.fanout.input === w.to.port;

    // Build the right-hand value expression. The left-hand type
    // annotation never changes (always the declared Inputs[port]) —
    // only the source coercion adapts to fanout semantics.
    //
    // External seed wires bypass fanout wrap/unwrap entirely: the seed is
    // a plain user-supplied value whose declared type already matches the
    // target input 1:1. Auto-wrapping/unwrapping here would synthesize a
    // false type mismatch or silently coerce a non-array seed.
    let rhsExpr: string;
    if (fromIsExternal) {
      rhsExpr = `null as unknown as ${fromTypeLookup}`;
    } else if (fromIsFanout && !toIsFanout) {
      // Producer aggregates T into T[]; downstream reads T[].
      rhsExpr = `[null as unknown as ${fromTypeLookup}]`;
    } else if (!fromIsFanout && toIsFanout) {
      // Downstream fans out the array; declared T input is one element.
      rhsExpr = `(null as unknown as ${fromTypeLookup})[0]!`;
    } else {
      // Plain or both-fanout (wrap + unwrap cancel).
      rhsExpr = `null as unknown as ${fromTypeLookup}`;
    }

    // Reserve the lines we're about to push and capture them for the map.
    // Keep the assignment on the next line after `export const`, matching
    // the primary signal line for tsc diagnostics on assignment.
    lines.push(`export const ${ident}: ${toTypeLookup} =`);
    const assignmentLine = lines.length + 1; // 1-based, line of the value expr
    lines.push(`  ${rhsExpr};`);

    // Resolve actual TS types from the port index for diagnostic payload.
    // External sources look up their declared type in `externalInputs`.
    const fromPort = fromIsExternal
      ? ir.externalInputs?.find((p) => p.name === w.from.port)
      : fromStage?.outputs.find((p) => p.name === w.from.port);
    const toPort = toStage?.inputs.find((p) => p.name === w.to.port);

    const entry: WireMapEntry = {
      line: assignmentLine,
      fromStage: fromStageId,
      fromPort: w.from.port,
      toStage: w.to.stage,
      toPort: w.to.port,
      fromType: fromPort?.type ?? "<unknown>",
      toType: toPort?.type ?? "<unknown>",
    };
    wireByIdentifier.set(ident, entry);
    wireByLine.set(assignmentLine, entry);
    // Also map the declaration line (where tsc may anchor the error for
    // assignment-to-type errors).
    wireByLine.set(assignmentLine - 1, entry);
  }

  lines.push(``);
  return { source: lines.join("\n"), wireByIdentifier, wireByLine };
}
