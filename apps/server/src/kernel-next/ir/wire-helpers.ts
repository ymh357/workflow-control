// Wire source extraction helpers.
//
// kernel-next callers repeatedly inspect `wire.from` to decide whether
// the wire's source is a stage's output port or an external (top-level
// pipeline input) port. The discriminated union `WireSource` (see
// schema.ts) carries `source: "stage" | "external"`, but the schema's
// preprocess step defaults missing `source` to `"stage"` only at parse
// time — raw IR fixtures used in tests routinely omit the field. Three
// nearly-identical patterns appear across the codebase pre-Continuation-3:
//
//   if (w.from.source !== "stage") continue;             (~7 sites)
//   if (w.from.source === "external") continue;          (~14 sites)
//   const fromStage = w.from.source === "external"
//     ? "__external__"
//     : w.from.stage;                                    (~16 sites)
//
// Each variant has a subtle pitfall: the first form skips wires whose
// source is `undefined` (raw fixture) where the second form keeps them.
// Cross-region cancellation propagation ran into exactly this mismatch
// during continuation 3 (BFS missed wires whose source field was unset).
//
// These helpers centralise the convention. The runtime treats anything
// not explicitly tagged `"external"` as stage-sourced, matching the
// schema preprocess.

import type { WireIR } from "./schema.js";

/**
 * Returns the stage name a wire's source belongs to, or null when the
 * wire is sourced from an externalInputs port. Treats wires whose
 * `from.source` is unset (common in test fixtures) as stage-sourced —
 * matches WireIRSchema's preprocess default.
 */
export function wireFromStage(w: WireIR): string | null {
  if (w.from.source === "external") return null;
  // Defensive cast: when `from.source` is undefined the discriminated
  // union narrows to `never`, but raw test IR can take this path.
  // Reading `.stage` is safe because the runtime treats this branch
  // as stage-sourced regardless of the schema-narrowed type.
  return (w.from as { stage?: string }).stage ?? null;
}

/**
 * True when the wire is sourced from a stage (default) rather than an
 * external port. Equivalent to `wireFromStage(w) !== null` but avoids
 * a needless string allocation in hot loops.
 */
export function isStageSourcedWire(w: WireIR): boolean {
  return w.from.source !== "external";
}

/**
 * Returns the conventional source-key prefix used for port_values
 * lookup: stage-sourced wires use the source stage's name; external
 * wires use the literal sentinel `"__external__"`. The `<src>.<port>`
 * concatenation is left to the caller because some sites need only
 * the stage component.
 */
export function wireSourceKeyPrefix(w: WireIR): string {
  if (w.from.source === "external") return "__external__";
  return (w.from as { stage?: string }).stage ?? "__external__";
}
