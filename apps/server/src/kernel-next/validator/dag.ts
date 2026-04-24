// DAG validation + topological sort for pipeline wires.
//
// A valid IR's wires must form a DAG (no cycles). In kernel-next the execution
// order is derived from this topology: a stage becomes ready only after all
// stages whose outputs drive its inputs have finished.
//
// Callers should run validateStructural() first — this module assumes wire
// endpoints are well-formed.

import type { PipelineIR } from "../ir/schema.js";
import type { Diagnostic, ValidationResult } from "../ir/schema.js";

export interface DagInfo {
  // Topological order (Kahn). Stages with in-degree 0 come first.
  topoOrder: string[];
  // For each stage: upstream stages whose outputs drive any of its inputs.
  upstream: Map<string, Set<string>>;
  // For each stage: downstream stages that consume any of its outputs.
  downstream: Map<string, Set<string>>;
}

export function buildDag(ir: PipelineIR): DagInfo | { cycle: string[] } {
  const upstream = new Map<string, Set<string>>();
  const downstream = new Map<string, Set<string>>();
  for (const s of ir.stages) {
    upstream.set(s.name, new Set());
    downstream.set(s.name, new Set());
  }

  for (const w of ir.wires) {
    // External wires originate outside the DAG — they seed ports but
    // create no upstream dependency for scheduling purposes.
    if (w.from.source === "external") continue;
    if (w.from.stage === w.to.stage) continue; // self-wire is a cycle, caught below
    // A (gate feedback): wires carrying `__gate_feedback__` are the one
    // sanctioned back-edge in the otherwise-strict DAG. The source gate
    // stage is structurally downstream of the target (which is being
    // regenerated after a reject), but the wire exists solely to ferry
    // the rejection comment on the *next* pass. Including it in topo
    // sort produces a spurious cycle for any pipeline with a reject
    // loop. Runtime uses initial portValues (empty string) on the
    // first pass and PORT_WRITTEN on subsequent gate answers, so no
    // scheduling dependency is required.
    if (w.from.port === "__gate_feedback__") continue;
    upstream.get(w.to.stage)!.add(w.from.stage);
    downstream.get(w.from.stage)!.add(w.to.stage);
  }

  // Kahn's algorithm with cycle detection.
  const inDegree = new Map<string, number>();
  for (const [s, ups] of upstream) inDegree.set(s, ups.size);

  const queue: string[] = [];
  for (const [s, deg] of inDegree) if (deg === 0) queue.push(s);
  queue.sort(); // deterministic order

  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    topoOrder.push(n);
    const downs = [...downstream.get(n)!].sort();
    for (const m of downs) {
      const d = inDegree.get(m)! - 1;
      inDegree.set(m, d);
      if (d === 0) queue.push(m);
    }
  }

  if (topoOrder.length !== ir.stages.length) {
    // Cycle exists. Build one example cycle for the diagnostic.
    const remaining = new Set(ir.stages.map((s) => s.name).filter((n) => !topoOrder.includes(n)));
    const cycle = extractCycle(remaining, downstream);
    return { cycle };
  }

  // Include self-wires as cycles (caught as length-1 cycles).
  for (const w of ir.wires) {
    if (w.from.source === "external") continue;
    if (w.from.stage === w.to.stage) {
      return { cycle: [w.from.stage] };
    }
  }

  return { topoOrder, upstream, downstream };
}

function extractCycle(remaining: Set<string>, downstream: Map<string, Set<string>>): string[] {
  // DFS to find any cycle within the `remaining` set.
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();

  const start = [...remaining].sort()[0]!;
  return dfs(start) ?? [start];

  function dfs(node: string): string[] | null {
    if (onStack.has(node)) {
      const i = stack.indexOf(node);
      return stack.slice(i).concat(node);
    }
    if (visited.has(node)) return null;
    visited.add(node);
    onStack.add(node);
    stack.push(node);
    const downs = [...(downstream.get(node) ?? new Set())].sort();
    for (const m of downs) {
      if (!remaining.has(m)) continue;
      const found = dfs(m);
      if (found) return found;
    }
    stack.pop();
    onStack.delete(node);
    return null;
  }
}

export function validateDag(ir: PipelineIR): ValidationResult {
  const result = buildDag(ir);
  if ("cycle" in result) {
    const diagnostics: Diagnostic[] = [{
      code: "DAG_HAS_CYCLE",
      message: `Pipeline has a cycle: ${result.cycle.join(" -> ")}${
        result.cycle.length > 1 ? " -> " + result.cycle[0]! : " -> " + result.cycle[0]!
      }`,
      context: { cycle: result.cycle },
    }];
    return { ok: false, diagnostics };
  }
  return { ok: true };
}
