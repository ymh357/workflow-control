// Transitive closure of all stages reachable from `start` via
// stage-to-stage wires. External-sourced wires are skipped since
// they have no producing stage. Cycle-safe (uses a visited set).

import type { WireIR } from "../ir/schema.js";

export function topoDownstream(wires: WireIR[], start: string): string[] {
  const visited = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const w of wires) {
      if (w.from.source !== "stage") continue;
      if (w.from.stage !== current) continue;
      const next = w.to.stage;
      if (visited.has(next) || next === start) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  return Array.from(visited);
}
