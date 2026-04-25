// Single-session mode segment planner.
//
// Pure function: given a parsed PipelineIR, produces a list of "segments".
// Each segment is an ordered list of stage names that will share one SDK
// conversation when session_mode === "single". When session_mode is
// "multi", every stage is its own segment of size 1 (current behaviour).
//
// See docs/superpowers/specs/2026-04-25-single-session-mode-design.md §6.1
// for the segmentation rules.

import type { PipelineIR, StageIR, WireIR } from "../ir/schema.js";

/**
 * Plan segments for the given IR. The result preserves stage order:
 * `segments.flat()` is a topological enumeration of every stage in the IR.
 *
 * In multi mode every stage is its own segment.
 *
 * In single mode, a stage S joins the segment of its sole upstream agent
 * predecessor P iff:
 *   - S.type === "agent" && S.fanout === undefined
 *   - P.type === "agent" && P.fanout === undefined
 *   - S has exactly one upstream agent stage by stage-source wires
 *     (script/gate predecessors and external inputs do not count toward
 *      the agent-upstream tally)
 *   - P's segment has not yet been extended by another stage
 *     (at-most-one continuation per segment; first downstream wins)
 *
 * Otherwise S opens a new segment of size 1.
 */
export function planSegments(ir: PipelineIR): string[][] {
  if (ir.session_mode !== "single") {
    return ir.stages.map((s) => [s.name]);
  }

  const stageByName = new Map<string, StageIR>(ir.stages.map((s) => [s.name, s]));

  // For each stage, collect the distinct upstream non-fanout AGENT stage names
  // that are connected via stage-source wires. External-source wires and
  // script/gate upstream stages do NOT contribute to this count.
  const upstreamAgentsOf = new Map<string, string[]>();
  for (const s of ir.stages) upstreamAgentsOf.set(s.name, []);

  for (const w of ir.wires as WireIR[]) {
    // Reject external wires — they have source === "external" and no upstream stage.
    if (w.from.source === "external") continue;

    // stage-source wire: source is "stage" or undefined (legacy shape)
    const fromStageName = (w.from as { source?: "stage"; stage: string; port: string }).stage;
    if (!fromStageName) continue;

    const upstream = stageByName.get(fromStageName);
    if (!upstream) continue;

    // Only non-fanout agent stages qualify as upstream-agent contributors.
    if (upstream.type !== "agent") continue;
    if ("fanout" in upstream && upstream.fanout != null) continue;

    const list = upstreamAgentsOf.get(w.to.stage);
    if (!list) continue;

    if (!list.includes(fromStageName)) list.push(fromStageName);
  }

  // Walk stages in TOPOLOGICAL order, not ir.stages array order. The IR's
  // stages array reflects authorship order, which the runtime ignores —
  // execution order is determined by wires. Walking in array order would
  // mis-segment any pipeline whose IR happens to list a downstream stage
  // before its upstream (e.g. smoke-test lists `echoBack` before `greet`,
  // which by file order makes greet look like an orphan and breaks the
  // continuation merge). Build a Kahn-style topo order using ALL wires
  // (stage-source AND external) — externals contribute zero in-degree
  // (no source stage) so they don't affect ordering, and we want every
  // stage represented even if it has no agent upstream.
  const topoOrder = topologicalStageOrder(ir);

  // Map from stage name → index into `segments`.
  const segmentOf = new Map<string, number>();
  // Tracks stages that have already been consumed as a predecessor by one
  // downstream stage. Each stage can serve as a predecessor at most once —
  // the first eligible downstream wins; any further downstream must open a
  // new segment (at-most-one continuation rule).
  //
  // NOTE on spec wording: spec §6.1 says "P's segment has not yet been
  // closed by a downstream branching", which reads as "close the whole
  // segment after one extension". That reading breaks linear chains —
  // a→b→c would yield [[a,b],[c]] instead of [[a,b,c]] — because b
  // joining a's segment would close segment 0, blocking c. We instead
  // close the *predecessor* (the stage just consumed), preserving linear
  // chains while still rejecting diamond-style splits at the predecessor
  // (a→b, a→c → [[a,b],[c]]). See test "merges 4-stage linear chain"
  // for the regression fence on this choice.
  const predecessorConsumed = new Set<string>();
  const segments: string[][] = [];

  for (const stageName of topoOrder) {
    const stage = stageByName.get(stageName);
    if (!stage) continue;
    // Only non-fanout agent stages are eligible to continue or start a
    // merged segment.
    const isEligibleAgent =
      stage.type === "agent" &&
      !("fanout" in stage && stage.fanout != null);

    const ups = upstreamAgentsOf.get(stage.name) ?? [];
    // Exactly one upstream non-fanout agent stage required for continuation.
    const uniqueAgentUpstream = ups.length === 1 ? ups[0] : null;

    if (isEligibleAgent && uniqueAgentUpstream !== null) {
      const upSegIdx = segmentOf.get(uniqueAgentUpstream);
      if (upSegIdx !== undefined && !predecessorConsumed.has(uniqueAgentUpstream)) {
        // Extend the upstream's segment and mark that predecessor as consumed
        // so no further stage can also claim to continue from it.
        segments[upSegIdx].push(stage.name);
        segmentOf.set(stage.name, upSegIdx);
        predecessorConsumed.add(uniqueAgentUpstream);
        continue;
      }
    }

    // All other cases (script, gate, fanout agent, multi-input fan-in,
    // no eligible upstream) open a fresh single-stage segment.
    const newIdx = segments.length;
    segments.push([stage.name]);
    segmentOf.set(stage.name, newIdx);
  }

  return segments;
}

/**
 * Produce a topological ordering of stage names from the IR's wires.
 * Used by planSegments so the segment walk matches runtime execution
 * order rather than IR-file authorship order. Kahn's algorithm:
 * compute in-degree from stage-source wires (external wires don't
 * contribute), repeatedly emit zero-in-degree stages, decrement the
 * in-degree of their stage-source successors.
 *
 * On a cycle (which canonical IR validation should reject upstream),
 * the remaining stages are appended in IR-file order so the planner
 * still produces a result rather than throwing — defensive, matches
 * the "tolerate corrupt IR, don't crash" stance of segmentContinuationFor.
 */
function topologicalStageOrder(ir: PipelineIR): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const s of ir.stages) {
    inDegree.set(s.name, 0);
    adjacency.set(s.name, []);
  }
  for (const w of ir.wires as WireIR[]) {
    if (w.from.source === "external") continue;
    const fromStage = (w.from as { source?: "stage"; stage: string; port: string }).stage;
    if (!fromStage) continue;
    if (!inDegree.has(fromStage) || !inDegree.has(w.to.stage)) continue;
    if (fromStage === w.to.stage) continue;
    const succs = adjacency.get(fromStage)!;
    if (!succs.includes(w.to.stage)) {
      succs.push(w.to.stage);
      inDegree.set(w.to.stage, (inDegree.get(w.to.stage) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  // Seed in IR-file order so two equivalent topological orderings produce
  // a deterministic, author-friendly tie-breaker.
  for (const s of ir.stages) {
    if ((inDegree.get(s.name) ?? 0) === 0) queue.push(s.name);
  }
  const out: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    out.push(n);
    for (const next of adjacency.get(n) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  // Cycle / unreachable stages: append in IR-file order so every stage is
  // represented (planner contract: segments.flat() covers every stage).
  if (out.length < ir.stages.length) {
    const seen = new Set(out);
    for (const s of ir.stages) {
      if (!seen.has(s.name)) out.push(s.name);
    }
  }
  return out;
}
