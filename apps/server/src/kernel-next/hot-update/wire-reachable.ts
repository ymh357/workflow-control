// Wire-causal BFS — Stage 5B design §2.3.
// Unlike topoDownstream (which traverses topological order), this only
// follows wire edges. Used for B13: parallel siblings with no wire
// dependency on rerunFrom are NOT superseded.

import type { PipelineIR } from "../ir/schema.js";

export function computeWireTransitiveReaders(
  ir: PipelineIR,
  startStage: string,
): Set<string> {
  const stageNames = new Set(ir.stages.map((s) => s.name));
  if (!stageNames.has(startStage)) {
    return new Set<string>();
  }

  const visited = new Set<string>([startStage]);
  const queue: string[] = [startStage];

  while (queue.length > 0) {
    const cur = queue.shift() as string;
    for (const w of ir.wires) {
      if (w.from.source === "external") continue;
      const fromStage = (w.from as { stage: string }).stage;
      if (fromStage !== cur) continue;
      const toStage = w.to.stage;
      if (!visited.has(toStage)) {
        visited.add(toStage);
        queue.push(toStage);
      }
    }
  }

  return visited;
}
