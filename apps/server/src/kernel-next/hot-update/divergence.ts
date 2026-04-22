// findEarliestDivergence — Stage 5B design §2.2 step 4.
//
// Returns the topologically-earliest stage name that differs between
// baseIR and proposedIR. Used by rollback.ts to synthesize a proposal
// with rerunFrom = divergenceStage. Returns null when IRs are equivalent.

import type { PipelineIR } from "../ir/schema.js";
import { computePipelineDiff } from "./diff.js";

export function findEarliestDivergence(
  baseIR: PipelineIR,
  proposedIR: PipelineIR,
): string | null {
  const diff = computePipelineDiff(baseIR, proposedIR);

  const changedNames = new Set<string>([
    ...diff.stages.added.map((s) => s.name),
    ...diff.stages.removed.map((r) => r.name),
    ...diff.stages.modified.map((m) => m.stageName),
  ]);

  if (changedNames.size === 0) return null;

  // Build a topological order using wires + stages[] order as fallback.
  // Stages considered: union of baseIR + proposedIR stages.
  const allStageNames = new Set<string>([
    ...baseIR.stages.map((s) => s.name),
    ...proposedIR.stages.map((s) => s.name),
  ]);

  const combinedWires = [...baseIR.wires, ...proposedIR.wires];

  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const name of allStageNames) {
    inDegree.set(name, 0);
    adjacency.set(name, []);
  }
  for (const w of combinedWires) {
    if (w.from.source === "external") continue;
    const fromStage = (w.from as { stage: string }).stage;
    if (!allStageNames.has(fromStage) || !allStageNames.has(w.to.stage)) continue;
    adjacency.get(fromStage)!.push(w.to.stage);
    inDegree.set(w.to.stage, (inDegree.get(w.to.stage) ?? 0) + 1);
  }

  const tieBreakOrder: string[] = [];
  const seen = new Set<string>();
  for (const s of proposedIR.stages) {
    if (!seen.has(s.name)) { seen.add(s.name); tieBreakOrder.push(s.name); }
  }
  for (const s of baseIR.stages) {
    if (!seen.has(s.name)) { seen.add(s.name); tieBreakOrder.push(s.name); }
  }

  const topoOrder: string[] = [];
  const queue = tieBreakOrder.filter((n) => (inDegree.get(n) ?? 0) === 0);
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    topoOrder.push(cur);
    for (const next of adjacency.get(cur) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) {
        const idx = tieBreakOrder.indexOf(next);
        let insertAt = queue.length;
        for (let i = 0; i < queue.length; i++) {
          if (tieBreakOrder.indexOf(queue[i]!) > idx) { insertAt = i; break; }
        }
        queue.splice(insertAt, 0, next);
      }
    }
  }

  for (const name of topoOrder) {
    if (changedNames.has(name)) return name;
  }

  return Array.from(changedNames)[0] ?? null;
}
