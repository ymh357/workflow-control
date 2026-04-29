// IR -> XState machine definition.
//
// Semantics (proven by M0 spike in kernel-next/m0/parallel-wait.test.ts;
// extended in A1.2b for gate stages per terminal-design §3.3):
//   - The machine is a top-level state with `running` being a parallel region,
//     one sub-region per stage.
//   - Each stage region has substates: waiting -> executing -> done.
//   - waiting:
//       * `always` guard: if all inbound ports already present in
//         context.portValues, advance to executing. This handles entry
//         stages (in-degree 0) and late entries after their deps are set.
//       * `on: PORT_WRITTEN`: re-evaluate the same guard when any port is
//         written.
//       * `on: GATE_ANSWERED`: if event.targetStage === this stage name,
//         advance to executing even when not all inbound ports are present.
//         This is how gate routing activates a target stage out-of-band.
//   - executing (non-gate stages):
//       * entry action: logs + runner invokes the executor.
//       * transitions to `done` when all declared output ports are present.
//   - executing (gate stages):
//       * the runner creates a gate_queue row on entry and does NOT invoke
//         any executor — the stage stays in `executing` until answer_gate
//         fires a GATE_ANSWERED event naming this gate's stage. Gate
//         stages have zero output ports, so the default allOutboundPresent
//         guard is trivially true; we suppress the `always` transition to
//         prevent immediate self-complete.
//   - done: final.
//
// The machine is pure: it contains no side effects, no DB writes, no subprocess
// invocation. runtime/runner.ts owns all side effects.

import { createMachine, assign, sendTo, raise } from "xstate";
import type { AnyStateMachine } from "xstate";
import type { PipelineIR, StageIR } from "../ir/schema.js";
import { buildDag } from "../validator/dag.js";
import { evaluateGuard } from "../runtime/guard-evaluator.js";

export interface MachineContext {
  taskId: string;
  versionHash: string;
  // "stage.port" -> JSON-serializable value. For spike, we keep values in
  // memory on ctx; in real runtime they're also written to SQLite via
  // port-runtime so lineage is queryable.
  portValues: Record<string, unknown>;
  // Ordered audit log of state entries. Used for tests to assert execution
  // ordering without a custom observer.
  log: string[];
  // A3.2 — stage names that have been authorized by a gate routing answer.
  // A stage that is referenced as a routing target by any gate stage only
  // activates once this set contains its name AND its inbound wires have
  // delivered. Non-gate-targeted stages ignore this set.
  gateAuthorizedTargets: string[];
  // A3.2/A7 — stage names that a gate answer decided NOT to take. These
  // stages transition directly to `done` (vacuously skipped) so the
  // parallel region's onDone can fire without the unpicked branches
  // blocking forever. Populated by the root-level GATE_ANSWERED action:
  // for the answered gate, every routing target that is not the picked
  // branch gets added here.
  gateSkippedTargets: string[];
  // Debt #3 retire — control-plane mirror of each stage region's final
  // outcome. Populated atomically with the region's final.entry. Read by
  // runner.ts when the machine reaches a top-level final state to detect
  // `error` regions that parallel.onDone collapsed into the same snapshot
  // tick (previously scraped via regex over `log[]`). The `log` string
  // array is preserved as a test-facing ordering contract (see
  // wire-guards.test.ts, demo/diamond.ts); this field is the typed,
  // runner-only signal.
  //
  // `reason` is populated on `error` outcomes to distinguish the 3 entry
  // paths (§6.2 stage_error differentiation):
  //   - "no_active_wire" — every inbound wire settled but at least one
  //     dropped (guard false) so the stage cannot activate. Runner
  //     attaches the structured failedWires[] payload.
  //   - "executor_failed" — agent/script executor returned status=error
  //     or rejected; runner reads the concrete message from stageErrors.
  //   - "upstream_cancelled" — a transitive upstream stage entered its
  //     `error` final, so this stage's inbound wires can never deliver.
  //     Raised by runner-side propagation (see runner.ts subscribe loop)
  //     dispatching STAGE_CANCELLED to every transitive downstream of
  //     the failing stage. Lets the parallel region's onDone fire (a
  //     waiting region would otherwise hang forever).
  // `outcome === "done"` always has reason === undefined.
  finalizedStages: {
    name: string;
    outcome: "done" | "error";
    reason?: "no_active_wire" | "executor_failed" | "upstream_cancelled";
    // Continuation-3 Issue #2 — concrete error message captured at the
    // moment the region transitioned to its `error` final. For
    // `executor_failed` it is the executor's status.error string
    // (mock-executor handler throw / real-executor SDK error / script
    // module throw). For `no_active_wire` and `upstream_cancelled` it
    // stays undefined; the runner derives a structured message from
    // stageMeta / upstream identity at output time. Centralising the
    // message here removes the parallel runner-side stageErrors[]
    // array that used to mirror finalizedStages and required
    // out-of-band sync via dispatched / publishedStageFinal /
    // cancelledByPropagation guards.
    message?: string;
  }[];
  // Slice C (Task C1): per-stage retry counter. Keyed by the failing
  // stage name (the ScriptStage whose executor errored). Read by the
  // STAGE_FAILED retry guard; incremented by runner's root-level
  // RETRY_TO_STAGE handler (Task C5). Distinct from port-runtime's
  // stage_attempts.attempt_idx — that's a monotonic audit counter.
  retryCounts: Record<string, number>;
}

export type MachineEvent =
  | { type: "START" }
  | { type: "PORT_WRITTEN"; key: string; value: unknown }
  | { type: "STAGE_FAILED"; stage: string; error: string }
  // Cross-region cancellation. Raised by the runner (subscribe loop in
  // runner.ts) when a stage enters its `error` final, addressed at every
  // transitive downstream stage. The downstream region's waiting/executing
  // STAGE_CANCELLED handler fires when event.stage equals its own name,
  // moving the region to its `error` final with reason="upstream_cancelled"
  // so the parallel onDone can resolve. Without this event, a region
  // waiting on inbound wires from a failed upstream stays in `waiting`
  // forever and the run hangs until wall-clock budget.
  | { type: "STAGE_CANCELLED"; stage: string; upstreamStage: string }
  | { type: "GATE_ANSWERED"; gateId: string; stageName: string; answer: string; targetStage: string | string[] }
  // A2.3.3 — external interrupt for a specific running stage. Carried on
  // the root TaskMachine event bus; individual agent stage regions match
  // on `event.stage === <my stage>` and forward the event to their
  // invoked child via sendTo. The child (fromCallback in A2.3.3 — see
  // runner.ts executeStageLogic) converts it into an AbortSignal trigger
  // so the real executor can deliver INTERRUPT to the nested AgentMachine
  // per design doc §4.2. stage-specific routing is owner-decided (A2.3
  // plan §6.1).
  | { type: "INTERRUPT"; stage: string }
  // Slice C (Task C1): script stage executor failed with retry-in-budget.
  // Raised by the per-stage STAGE_FAILED transition; handled by runner's
  // root-level subscriber (C5) which clears downstream portValues, bumps
  // retryCounts, and sends RESET_STAGE back to the backToStage region.
  | {
      type: "RETRY_TO_STAGE";
      failedStageName: string;
      backToStage: string;
      reason: "executor_failed";
      retryIdx: number; // 0-based pre-increment value
      maxRetries: number;
      errorMessage: string;
    }
  // Intercepted by the runner before reaching the XState actor. Triggers
  // prune of affectedStages' persistent state and a rebuild of the actor
  // so the rejected gate re-enters executing for a fresh answer.
  | {
      type: "GATE_REJECTED";
      gateId: string;
      stageName: string;
      answer: string;
      targetStage: string;
      affectedStages: string[];
    };

export interface InboundWireMeta {
  // "<from.stage>.<from.port>" — the source port whose value activates the wire.
  sourceKey: string;
  // Original wire endpoints, used for guard evaluation error context + the
  // NO_ACTIVE_WIRE diagnostic payload.
  from: { stage: string; port: string };
  to: { stage: string; port: string };
  // Optional runtime guard expression (§6.2). When set, the wire delivers
  // only if evaluateGuard(expr, source port value) returns true.
  guard?: string;
}

export interface StageMeta {
  stageType: StageIR["type"];
  // A3.1: inbound is now per-wire (not per source port key), because a
  // single source port may feed multiple downstream ports and each carries
  // its own guard. `allInboundWiresSettled` means every wire's source has
  // been written; `anyInboundWireDelivered` means at least one wire's
  // source has been written AND its guard (if any) evaluated true.
  inbound: InboundWireMeta[];
  outbound: string[]; // "<stage>.<port>" outbound port keys
  // A3.2 — whether this stage appears in any gate's routing table as a
  // target. Gate-routed stages additionally require GATE_ANSWERED to
  // authorize them before they can activate (see guard composition in
  // buildStageRegion). This prevents a routing target from executing
  // purely on upstream wire delivery while the gate is still pending.
  gateRouted: boolean;
}

/**
 * For every gate stage, return the set of stages that can reach the
 * gate via inbound wires (transitive closure), excluding the special
 * `__gate_feedback__` back-edge that the DAG validator already
 * ignores. Used by indexStages to distinguish rollback targets (gate
 * ancestors — must activate on the forward pass) from forward
 * gate-routed targets (non-ancestors — wait for GATE_ANSWERED).
 *
 * Implementation: reverse BFS from each gate over `inbound` wires.
 * The IR is small enough that O(stages × wires) per gate is fine.
 */
function computeGateAncestors(ir: PipelineIR): Map<string, Set<string>> {
  // Build adjacency: stage → upstream stages (one hop), filtered to
  // exclude __gate_feedback__ back-edges (the DAG validator's same
  // exclusion rule, mirrored here so the BFS sees a strict DAG).
  const upstreamOf = new Map<string, Set<string>>();
  for (const s of ir.stages) upstreamOf.set(s.name, new Set());
  for (const w of ir.wires) {
    if (w.from.source !== "stage") continue;
    if (w.from.port === "__gate_feedback__") continue;
    upstreamOf.get(w.to.stage)?.add(w.from.stage);
  }

  const ancestorsByGate = new Map<string, Set<string>>();
  for (const s of ir.stages) {
    if (s.type !== "gate") continue;
    const seen = new Set<string>();
    const frontier = [...(upstreamOf.get(s.name) ?? new Set())];
    while (frontier.length > 0) {
      const cur = frontier.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const up of upstreamOf.get(cur) ?? new Set()) {
        if (!seen.has(up)) frontier.push(up);
      }
    }
    ancestorsByGate.set(s.name, seen);
  }
  return ancestorsByGate;
}

function indexStages(ir: PipelineIR): Map<string, StageMeta> {
  const index = new Map<string, StageMeta>();

  // First pass: compute the set of stages that appear as a target in
  // any gate's routing table. These stages are "gate-routed":
  // activation requires GATE_ANSWERED authorization in addition to
  // inbound delivery — UNLESS the target is a transitive ancestor of
  // the gate in the IR DAG (excluding `__gate_feedback__` back-edges).
  // Such ancestors are rollback targets: they must activate on their
  // own inbound wires on the first forward pass; a later `reject`
  // answer sends the pipeline back through them via runner-side reset
  // logic, not via gate-authorization.
  //
  // Earlier this exclusion only checked direct (one-hop) upstreams of
  // the gate. Multi-hop rollback chains — e.g. claim_collection →
  // claim_verify → claim_review_gate where `reject` routes back to
  // claim_collection — were misclassified as forward gate-routed,
  // making claim_collection wait for an authorization that the runner
  // never issues on the first pass. The pipeline would then orphan
  // after the seed phase: the only entry stage couldn't activate.
  //
  // Original symptom (before): `analyzing` feeds `awaitingConfirm` AND
  // is the gate's reject target — the one-hop check handled it because
  // the wire chain is short. This generalisation preserves that case
  // while also handling pipelines whose reject chain has intermediate
  // stages.
  const gateAncestors = computeGateAncestors(ir);
  const gateRoutedTargets = new Set<string>();
  for (const s of ir.stages) {
    if (s.type !== "gate") continue;
    const ancestors = gateAncestors.get(s.name) ?? new Set();
    for (const target of Object.values(s.config.routing.routes)) {
      const list = Array.isArray(target) ? target : [target];
      for (const t of list) {
        if (ancestors.has(t)) continue;  // rollback target, not a forward gate
        gateRoutedTargets.add(t);
      }
    }
  }

  // Start by declaring all stages with empty inbound/outbound.
  for (const s of ir.stages) {
    const outbound = s.outputs.map((p) => `${s.name}.${p.name}`);
    index.set(s.name, {
      stageType: s.type,
      inbound: [],
      outbound,
      gateRouted: gateRoutedTargets.has(s.name),
    });
  }

  // Populate inbound via wires. Preserve guard per wire.
  for (const w of ir.wires) {
    const entry = index.get(w.to.stage);
    if (!entry) continue;
    // Bridge: Task 1.2 introduced WireSource. Task 1.3+ will wire external
    // sources into the inbound set via a dedicated external stage record.
    const fromStage = w.from.source === "external" ? "__external__" : w.from.stage;
    entry.inbound.push({
      sourceKey: `${fromStage}.${w.from.port}`,
      from: { stage: fromStage, port: w.from.port },
      to: { stage: w.to.stage, port: w.to.port },
      guard: w.guard,
    });
  }

  return index;
}

export interface CompileOptions {
  taskId: string;
  // 2026-04-20 — external-input seeding. When provided, the compiler
  // inlines the values into the machine's initial context.portValues
  // under keys `__external__.<name>`. The runner MUST also persist the
  // same values via writePort against a kind="external" attempt row
  // (see runner.ts seed phase) so lineage and SSE observe them.
  seedValues?: Record<string, unknown>;
  // Slice C (Task C5) — when the runner rebuilds the actor for a
  // RETRY_TO_STAGE the freshly-compiled machine must start from a
  // pre-populated context (upstream port values preserved, retryCounts
  // carried forward, gate authorizations intact). Any field left
  // undefined falls back to the default for that field (the seedValues
  // path for portValues, `[]` / `{}` for the rest). First-run callers
  // pass nothing here and preserve existing behavior.
  initialContext?: {
    portValues?: Record<string, unknown>;
    retryCounts?: Record<string, number>;
    gateAuthorizedTargets?: string[];
    gateSkippedTargets?: string[];
    log?: string[];
    finalizedStages?: MachineContext["finalizedStages"];
  };
}

// Build the initial context.portValues map for a compiled machine.
// XState's createActor cannot mutate initial context after construction,
// so any externalInputs seeded by the caller must be inlined here. We
// iterate ir.externalInputs (declaration order) rather than Object.keys
// on seedValues so the resulting map is deterministic regardless of the
// caller's object key order — this matters for the port_values row
// persistence order in Task 1.8.
function buildInitialPortValues(
  ir: PipelineIR,
  seedValues: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // A (gate feedback): pre-populate every gate's `__gate_feedback__`
  // builtin output with the empty string so downstream wires reading
  // it can resolve on the pipeline's first pass (before any gate has
  // fired). The gate's own answerGate call later overwrites this slot
  // via PORT_WRITTEN; on reject-rollback runner's prune preserves the
  // populated value so the rerun upstream reads the user's correction
  // (see runner.ts rollback filter).
  for (const stage of ir.stages) {
    if (stage.type === "gate") {
      out[`${stage.name}.__gate_feedback__`] = "";
    }
  }
  if (ir.externalInputs && ir.externalInputs.length > 0) {
    const seeds = seedValues ?? {};
    for (const port of ir.externalInputs) {
      if (port.name in seeds) {
        out[`__external__.${port.name}`] = seeds[port.name];
      } else if (port.optional === true) {
        // Bug 7 (2026-04-28 dogfood): optional input the caller omitted
        // gets null in initial portValues so downstream wires resolve
        // (matches runner.ts's seed-phase write of null).
        out[`__external__.${port.name}`] = null;
      }
    }
  }
  return out;
}

export interface RejectRollback {
  answer: string;
  targetStage: string;
  affectedStages: string[];
}

/**
 * P6-10: compute the gateAuthorizedTargets + gateSkippedTargets
 * context update for a GATE_ANSWERED event. Factored out of the root
 * handler so the gate region's own transition can run it too — XState
 * v5 consumes the event at the descendant (gate) transition and does
 * NOT then fire the root-level on.GATE_ANSWERED handler. Without the
 * gate region also running this assign, gateAuthorizedTargets stays
 * empty, the picked downstream stage's allInboundDelivered guard keeps
 * returning false, and the pipeline hangs waiting for an authorization
 * that can never be written under later PORT_WRITTEN events.
 *
 * Closure over gateRoutingMap (the sibling-set lookup) so the factory
 * produces a ready-to-use assign updater given only (context, event).
 */
function applyGateAnsweredContextAssign(
  gateRoutingMap: Map<string, string[]>,
): (args: { context: MachineContext; event: MachineEvent }) => Partial<MachineContext> {
  return ({ context, event }) => {
    if (event.type !== "GATE_ANSWERED") return {};
    const pickedTargets = Array.isArray(event.targetStage)
      ? event.targetStage
      : [event.targetStage];

    // Add every picked target that isn't already authorized.
    let authorized = context.gateAuthorizedTargets;
    for (const t of pickedTargets) {
      if (!authorized.includes(t)) {
        authorized = [...authorized, t];
      }
    }

    // Compute which siblings are SKIPPED for this answered gate.
    const siblings = gateRoutingMap.get(event.stageName) ?? [];
    const pickedSet = new Set(pickedTargets);
    const pickedIsKnown = pickedTargets.every((t) => siblings.includes(t));
    const newSkips = pickedIsKnown
      ? siblings.filter(
          (t) => !pickedSet.has(t) && !context.gateSkippedTargets.includes(t),
        )
      : [];
    const skipped = newSkips.length === 0
      ? context.gateSkippedTargets
      : [...context.gateSkippedTargets, ...newSkips];
    return { gateAuthorizedTargets: authorized, gateSkippedTargets: skipped };
  };
}

export interface CompiledMachine {
  machine: AnyStateMachine;
  stageMeta: Map<string, StageMeta>;
  rejectRollbackMap: Map<string, RejectRollback>;
}

export function compileIRToMachine(ir: PipelineIR, options: CompileOptions): CompiledMachine {
  // Validate DAG before compiling; otherwise machine construction may loop.
  const dag = buildDag(ir);
  if ("cycle" in dag) {
    throw new Error(`Cannot compile IR with a cycle: ${dag.cycle.join(" -> ")}`);
  }

  const stageMeta = indexStages(ir);

  // Map of gate stage name → list of all routing-target stage names.
  // Used at runtime by the root-level GATE_ANSWERED handler: the
  // picked target goes into gateAuthorizedTargets; the unpicked ones
  // into gateSkippedTargets so their regions terminate cleanly.
  const gateRoutingMap = new Map<string, string[]>();
  for (const s of ir.stages) {
    if (s.type !== "gate") continue;
    // Flatten: each route target may be a string or string[] (multi-target)
    const targets: string[] = [];
    for (const t of Object.values(s.config.routing.routes)) {
      if (Array.isArray(t)) {
        targets.push(...t);
      } else {
        targets.push(t);
      }
    }
    gateRoutingMap.set(s.name, targets);
  }

  // Downstream adjacency: stageName -> set of immediate downstream stages.
  // Used to compute BFS-downstream for rejectRollbackMap entries below.
  //
  // 0G dogfood (2026-04-29): exclude `__gate_feedback__` back-edges from
  // the adjacency, mirroring the same exclusion in computeGateAncestors.
  // Without this, BFS-downstream reaches via gate-feedback wires that
  // already point UPSTREAM (gate.__gate_feedback__ →
  // <upstreamAgent>.rejectionFeedback). Concretely, with the
  // 12-stage investigation skeleton:
  //   findingsAuthoring → humanReviewGate (forward) →
  //   humanReviewGate.__gate_feedback__ → hypothesize (BACK-EDGE) →
  //   hypothesize.hypotheses → findingsSynthesisGate
  // The BFS would conclude that `findingsAuthoring` is an ancestor of
  // `findingsSynthesisGate`, which makes findingsSynthesisGate.approve
  // (target=findingsAuthoring) look like a rollback answer. The
  // answerGate isReject classifier then misroutes legitimate approve
  // answers as rejects, and the runner rolls the pipeline back.
  // Excluding `__gate_feedback__` sources keeps the DAG strictly
  // forward and the rollback detection accurate.
  const downstreamAdj = new Map<string, Set<string>>();
  for (const w of ir.wires) {
    if (w.from.source !== "stage") continue;
    if (w.from.port === "__gate_feedback__") continue;
    const src = w.from.stage;
    const dst = w.to.stage;
    if (!downstreamAdj.has(src)) downstreamAdj.set(src, new Set());
    downstreamAdj.get(src)!.add(dst);
  }

  function bfsDownstream(start: string): string[] {
    const visited = new Set<string>([start]);
    const queue: string[] = [start];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const nexts = downstreamAdj.get(cur);
      if (!nexts) continue;
      for (const n of nexts) {
        if (visited.has(n)) continue;
        visited.add(n);
        queue.push(n);
      }
    }
    return Array.from(visited);
  }

  // For each gate stage, check whether any routing answer's target is a
  // transitive ancestor of the gate (i.e. BFS-downstream(target) reaches
  // the gate). If so, that answer triggers rollback: record the answer,
  // target stage, and the full set of affected stages (BFS-downstream of
  // target, which includes target itself and the gate). Only the first
  // matching rollback answer per gate is recorded; pipelines with multiple
  // rollback answers are not supported in this milestone.
  const rejectRollbackMap = new Map<string, RejectRollback>();
  for (const s of ir.stages) {
    if (s.type !== "gate") continue;
    for (const [answer, target] of Object.entries(s.config.routing.routes)) {
      if (typeof target !== "string") continue;
      // Transitive rollback check: if BFS-downstream(target) reaches the gate,
      // target is an ancestor and answer triggers rollback.
      const downstream = new Set(bfsDownstream(target));
      if (!downstream.has(s.name)) continue;
      rejectRollbackMap.set(s.name, {
        answer,
        targetStage: target,
        affectedStages: Array.from(downstream), // includes target and gate
      });
      break; // one rollback answer per gate
    }
  }

  // Build parallel region children.
  const parallelChildren: Record<string, unknown> = {};
  for (const s of ir.stages) {
    const meta = stageMeta.get(s.name)!;
    // Slice C (Task C1): only ScriptStage carries a retry spec. Extract
    // it here so buildStageRegion can emit a retry-aware STAGE_FAILED
    // transition without having to re-discriminate the stage union.
    const retrySpec = s.type === "script" ? s.config.retry : undefined;
    parallelChildren[s.name] = buildStageRegion(s.name, meta, gateRoutingMap, retrySpec);
  }

  const machine = createMachine({
    id: `kn_${options.taskId}`,
    types: {} as { context: MachineContext; events: MachineEvent },
    context: {
      taskId: options.taskId,
      versionHash: "", // filled by runner before starting
      // Task C5 — initialContext.portValues wins when provided (retry
      // rebuild path); otherwise derive from seedValues as before.
      portValues:
        options.initialContext?.portValues
        ?? buildInitialPortValues(ir, options.seedValues),
      log: options.initialContext?.log ?? [],
      gateAuthorizedTargets: options.initialContext?.gateAuthorizedTargets ?? [],
      gateSkippedTargets: options.initialContext?.gateSkippedTargets ?? [],
      finalizedStages: options.initialContext?.finalizedStages ?? [],
      retryCounts: options.initialContext?.retryCounts ?? {},
    },
    initial: "idle",
    on: {
      // Root-level handler: every PORT_WRITTEN mutates context.portValues so
      // stage guards can re-evaluate. Sub-region `on: PORT_WRITTEN` handles
      // the actual transition decision.
      PORT_WRITTEN: {
        actions: assign({
          portValues: ({ context, event }) => ({
            ...context.portValues,
            [event.key]: event.value,
          }),
        }),
      },
      // NOTE: we intentionally do NOT declare a root-level
      // `on.GATE_ANSWERED` handler. XState v5 fires the gate region's
      // own transition first (gateAnsweredIsMe matches on its own
      // answer event), which consumes the event — so any root handler
      // would be dead code. The authoritative
      // gateAuthorizedTargets / gateSkippedTargets assign runs on the
      // gate region's transition action; see buildStageRegion /
      // applyGateAnsweredContextAssign. Leaving a "safety net" root
      // handler here was misleading and has been removed (P6-10
      // post-audit). If a future event source bypasses the gate
      // region, a new test should exercise that path and a fresh
      // handler can be added with a precise reason.
    },
    states: {
      idle: { on: { START: "running" } },
      running: {
        type: "parallel",
        states: parallelChildren as never,
        onDone: { target: "completed" },
      },
      completed: { type: "final" },
      failed: { type: "final" },
    },
  });

  return { machine, stageMeta, rejectRollbackMap };
}

// Per-stage region: waiting -> executing -> done.
//
// gateSiblingsByGate maps gate.stageName -> list of its routing target
// stage names. Used by the GATE_ANSWERED `on:` transition of
// gate-routed stages to detect "this gate was answered and we are a
// non-picked sibling → transition to `done` without running." Without
// reading this closure, the region would have to wait for the
// root-level assign to update context.gateSkippedTargets and for a
// downstream event to re-evaluate the always guard — which never
// happens if the picked branch is the last thing to run.
function buildStageRegion(
  stageName: string,
  meta: StageMeta,
  gateSiblingsByGate: Map<string, string[]>,
  // Slice C (Task C1): present only for ScriptStage with config.retry.
  // When set, the executing.STAGE_FAILED transition becomes a two-entry
  // array: a guarded retry path (target `waiting`, raises
  // RETRY_TO_STAGE) and the existing error-final fallback. When
  // undefined, behavior is unchanged.
  retrySpec: { maxRetries: number; backToStage: string } | undefined,
) {
  // A wire is "settled" when its source port has been written.
  const wireSettled = (
    wire: InboundWireMeta,
    portValues: Record<string, unknown>,
  ): boolean => wire.sourceKey in portValues;

  // A wire "delivers" when it is settled AND its guard (if any) evaluates
  // true. Wires without a guard deliver as soon as they settle.
  const wireDelivers = (
    wire: InboundWireMeta,
    portValues: Record<string, unknown>,
  ): boolean => {
    if (!wireSettled(wire, portValues)) return false;
    if (!wire.guard) return true;
    const value = portValues[wire.sourceKey];
    return evaluateGuard(wire.guard, value, {
      wireFrom: wire.from,
      wireTo: wire.to,
    });
  };

  // Stage activates when every wire (slot) has delivered. Equivalent to
  // legacy `allInboundPresent` when no guards are attached; with guards,
  // an unguarded wire still requires its source to be written, and a
  // guarded wire additionally requires the guard to pass. Validator
  // guarantees each inbound port has at most one wire (WIRE_TARGET_
  // ALREADY_DRIVEN), so "one slot per wire" maps 1:1 to the design's
  // "one wire per inbound port".
  //
  // A3.2 — gate-routed stages additionally require the stage's name to
  // appear in context.gateAuthorizedTargets. A gate routing target never
  // executes on upstream-wire delivery alone; it waits for GATE_ANSWERED
  // to authorise it. Non-gate-routed stages skip this extra check.
  const allInboundDelivered = ({ context }: { context: MachineContext }) => {
    if (meta.gateRouted && !context.gateAuthorizedTargets.includes(stageName)) {
      return false;
    }
    return meta.inbound.every((w) => wireDelivers(w, context.portValues));
  };

  // Dead stage: every source has fired, but at least one wire has been
  // dropped by a false guard. That wire can never deliver — the stage
  // cannot activate. §6.2 specifies this is a pipeline authoring bug
  // (NO_ACTIVE_WIRE). We detect it compile-free at runtime and surface
  // it as STAGE_FAILED via a transient `always` branch from `waiting`.
  //
  // A3.2 — gate-routed stages suppress this diagnostic until they have
  // been authorised. A routing target that is not the selected branch
  // (e.g. the "no" branch when the answer was "yes") is expected to
  // remain waiting without its wires ever firing; that is not a bug.
  // Only once the stage is authorised do we consider dropped wires a
  // real dead-end.
  const noDeliverableWire = ({ context }: { context: MachineContext }) => {
    if (meta.inbound.length === 0) return false;
    if (meta.gateRouted && !context.gateAuthorizedTargets.includes(stageName)) {
      return false;
    }
    if (!meta.inbound.every((w) => wireSettled(w, context.portValues))) return false;
    return meta.inbound.some((w) => !wireDelivers(w, context.portValues));
  };

  const allOutboundPresent = ({ context }: { context: MachineContext }) =>
    meta.outbound.length === 0
      ? true // stages with no declared outputs are considered done once executor signals completion
      : meta.outbound.every((k) => k in context.portValues);

  const isGate = meta.stageType === "gate";

  // Guard for a gate stage leaving `executing` on its own GATE_ANSWERED
  // event (not to be confused with gate-routed *targets*, which use the
  // context.gateAuthorizedTargets list composed with allInboundDelivered).
  const gateAnsweredIsMe = ({ event }: { event: MachineEvent }) =>
    event.type === "GATE_ANSWERED" && event.stageName === stageName;

  // Executor-failure transition(s). The error-final path is the
  // historic default: record the finalized stage with
  // reason="executor_failed" and enter the region's `error` final.
  //
  // Slice C (Task C1) — when the stage is a ScriptStage with a retry
  // spec, we prepend a guarded retry entry: if
  // retryCounts[stageName] < maxRetries, target `waiting` and raise
  // RETRY_TO_STAGE. The root-level handler in runner (Task C5) owns the
  // side effects (bump counter, clear downstream ports, RESET_STAGE).
  const errorFinalTransition = {
    target: "error",
    guard: ({ event }: { event: MachineEvent }) =>
      event.type === "STAGE_FAILED" && event.stage === stageName,
    actions: assign({
      log: ({ context }: { context: MachineContext }) => [
        ...context.log,
        `${stageName}:error`,
      ],
      finalizedStages: ({
        context,
        event,
      }: {
        context: MachineContext;
        event: MachineEvent;
      }) => [
        ...context.finalizedStages,
        {
          name: stageName,
          outcome: "error" as const,
          reason: "executor_failed" as const,
          // Continuation-3 Issue #2 — capture executor's error string in
          // context so the runner derives stageErrors at the end without
          // a parallel push-array.
          message: event.type === "STAGE_FAILED" ? event.error : undefined,
        },
      ],
    }),
  };

  const stageFailedTransitions = retrySpec
    ? [
        {
          // Reset mechanism (no explicit RESET_STAGE event):
          //   The retry transition targets `waiting` and raises RETRY_TO_STAGE.
          //   Runner (Task C5) handles the raised event by (a) incrementing
          //   retryCounts[stageName], (b) clearing portValues for the
          //   backToStage AND its transitive downstream. After runner's
          //   portValues clear, the `waiting.always` guards for the target and
          //   downstream stages re-evaluate; allInboundDelivered becomes false
          //   because the source ports are now missing, so they stay in
          //   `waiting` until the upstream's re-execution re-populates them.
          //   Gate authorization (gateAuthorizedTargets) is NOT cleared on
          //   retry; a stage that a human already approved does not need a
          //   second approval when its script downstream fails.
          //
          // Retry path: stage-name match AND retries still in budget.
          // Target `waiting` so the region re-enters its entry guards;
          // Task C5's root-level handler will also bump retryCounts and
          // clear downstream portValues so the waiting.always re-evaluation
          // doesn't immediately promote the stage back to executing on
          // stale inbound values.
          target: "waiting",
          guard: ({
            context,
            event,
          }: {
            context: MachineContext;
            event: MachineEvent;
          }) => {
            if (event.type !== "STAGE_FAILED" || event.stage !== stageName) {
              return false;
            }
            const count = context.retryCounts[stageName] ?? 0;
            return count < retrySpec.maxRetries;
          },
          actions: raise(
            ({
              context,
              event,
            }: {
              context: MachineContext;
              event: MachineEvent;
            }) => {
              // Guard above narrows event to STAGE_FAILED, but the
              // factory signature sees the full union — re-narrow here.
              if (event.type !== "STAGE_FAILED") {
                throw new Error("unreachable: retry raise on non-STAGE_FAILED");
              }
              return {
                type: "RETRY_TO_STAGE" as const,
                failedStageName: stageName,
                backToStage: retrySpec.backToStage,
                reason: "executor_failed" as const,
                retryIdx: context.retryCounts[stageName] ?? 0,
                maxRetries: retrySpec.maxRetries,
                errorMessage: event.error,
              };
            },
          ),
        },
        // Fallback: retries exhausted (guard above failed) — the
        // existing error-final path runs with the same name+reason
        // payload as the no-retry case.
        errorFinalTransition,
      ]
    : [errorFinalTransition];

  // Cross-region cancellation transition for the `executing` state.
  // Same shape as the waiting-state STAGE_CANCELLED handler: a stage
  // already running can still be cancelled if a parallel-sibling
  // upstream entered its `error` final after this region's invoke
  // started. The runner forwards INTERRUPT separately so the in-flight
  // executor aborts; the cancellation transition handles the region's
  // state-machine side (transition to `error` final so parallel onDone
  // can resolve). Both must coexist — INTERRUPT addresses the executor
  // child, STAGE_CANCELLED addresses the region itself.
  const executingStageCancelledTransition = {
    target: "error",
    guard: ({ event }: { event: MachineEvent }) =>
      event.type === "STAGE_CANCELLED" && event.stage === stageName,
    actions: assign({
      log: ({ context }: { context: MachineContext }) => [
        ...context.log,
        `${stageName}:cancelled`,
      ],
      finalizedStages: ({ context }: { context: MachineContext }) => [
        ...context.finalizedStages,
        {
          name: stageName,
          outcome: "error" as const,
          reason: "upstream_cancelled" as const,
        },
      ],
    }),
  };

  const executingBody: Record<string, unknown> = {
    entry: assign({
      log: ({ context }) => [...context.log, `${stageName}:executing`],
    }),
    on: {
      STAGE_FAILED: stageFailedTransitions,
      STAGE_CANCELLED: [executingStageCancelledTransition],
    },
  };

  if (isGate) {
    // Gate stages have zero outputs; the default allOutboundPresent is
    // trivially true which would immediately `always` the gate through
    // to `done`. Suppress that transition and only resolve via the
    // GATE_ANSWERED event whose stageName matches this gate.
    //
    // P6-10: the transition action MUST also run the
    // gateAuthorizedTargets / gateSkippedTargets assign. Root-level
    // on.GATE_ANSWERED doesn't fire once this region consumes the
    // event (XState v5 semantics), so any downstream stage waiting
    // for authorization would never see it written. Running the assign
    // here is safe because gateAnsweredIsMe means the event IS for
    // this gate; a different gate's answer doesn't match this guard
    // and this region doesn't fire / consume the event.
    (executingBody.on as Record<string, unknown>).GATE_ANSWERED = [
      {
        target: "done",
        guard: gateAnsweredIsMe,
        actions: assign(applyGateAnsweredContextAssign(gateSiblingsByGate)),
      },
    ];
    // Intentionally no `always` — gate blocks until answered.
  } else {
    (executingBody.on as Record<string, unknown>).PORT_WRITTEN = [
      { target: "done", guard: allOutboundPresent },
    ];
    // Synchronous-complete path for mock executors that write outputs
    // before the machine observes.
    executingBody.always = [{ target: "done", guard: allOutboundPresent }];

    // A2.3.2 — non-gate stages (agent / script / fanout-less agent) now
    // invoke a stage executor as a proper XState child. The executor is
    // provided at runtime via `machine.provide({ actors: { execute_stage: ... } })`
    // and reads `input.stageName` to dispatch to the right handler.
    //
    // Semantics:
    //   - The executor's Promise resolves AFTER writePort has dispatched
    //     PORT_WRITTEN events; by that point the `always` guard above
    //     (allOutboundPresent) has already transitioned this region to
    //     `done`. onDone therefore usually never fires — it's a safety
    //     net for executors that finish without writing all declared
    //     outputs (schema non-compliance) so the region still progresses.
    //   - onError raises STAGE_FAILED so the error final path runs, same
    //     as the legacy `runner.ts` executor-rejected branch.
    //   - Fanout stages still bypass this invoke and run through the
    //     runner's specialised orchestrateFanoutStage (fanout is an orchestration concern — see comment there). They enter
    //     `executing` without an invoke because runner handles them
    //     before this code path gets a chance — see runner.ts.
    //
    // Invoke src `execute_stage` is a string key resolved by the runner's
    // machine.provide() call. Using one src name for every stage keeps
    // the compiler agnostic of stage-specific executor dispatch; the
    // stageName is passed via `input` so the runtime logic picks the
    // right handler.
    //
    // `id: <stageName>_exec` makes the child addressable via sendTo() for
    // A2.3.3 INTERRUPT forwarding. Without a deterministic id, XState
    // auto-generates one per actor instance which the compiler can't
    // reference ahead of time.
    executingBody.invoke = {
      id: `${stageName}_exec`,
      src: "execute_stage",
      input: ({ context }: { context: MachineContext }) => ({
        stageName,
        taskId: context.taskId,
        versionHash: context.versionHash,
        portValues: context.portValues,
      }),
      onError: {
        actions: ({ event }: { event: { error: unknown } }) => {
          // A2.3.2 note: onError payload shape differs from MachineEvent;
          // the compiler cannot dispatch a typed STAGE_FAILED from here
          // (XState action signature limitation). The runner observes
          // this via the executor's promise result path — if executor
          // returns status='error', the runner sends STAGE_FAILED. If
          // the promise itself rejects (uncaught throw), the runner
          // catches it the same way as pre-A2.3.2 via the subscribe()
          // drainErrors path. So this onError is effectively a no-op
          // observation point; kept here for XState completeness so
          // invoke errors don't become uncaught promise rejections.
          void event;
        },
      },
    };

    // A2.3.3 — forward INTERRUPT to the invoked child. Two accepted shapes:
    //   1. { type: 'INTERRUPT', stage: <stageName> } — targeted. Used when
    //      a parallel region wants to stop just one sibling without
    //      affecting others (owner decision §6.1).
    //   2. { type: 'INTERRUPT' } — broadcast. Every currently-executing
    //      stage region picks it up and forwards to its invoke child.
    //      This is the shape migration-orchestrator sends: it wants to
    //      halt whatever stage the task happens to be running, without
    //      first querying which stage that is. Parallel sibling stops
    //      are acceptable here because the migration rerun sequence
    //      will re-invoke every wire-reachable region regardless.
    // The invoke child is a fromCallback (A2.3.3; see runner.ts) and
    // translates INTERRUPT into an AbortSignal trigger for the executor
    // → AgentMachine §4.2 path.
    (executingBody.on as Record<string, unknown>).INTERRUPT = [
      {
        guard: ({ event }: { event: MachineEvent }) =>
          event.type === "INTERRUPT" && event.stage === stageName,
        actions: sendTo(
          `${stageName}_exec`,
          { type: "INTERRUPT" as const },
        ),
      },
      {
        guard: ({ event }: { event: MachineEvent }) =>
          event.type === "INTERRUPT" && event.stage === undefined,
        actions: sendTo(
          `${stageName}_exec`,
          { type: "INTERRUPT" as const },
        ),
      },
    ];
  }

  return {
    initial: "waiting",
    states: {
      waiting: {
        on: {
          PORT_WRITTEN: [
            { target: "executing", guard: allInboundDelivered },
            // NO_ACTIVE_WIRE: every source has fired but at least one wire
            // was dropped by a false guard. Emit via `error` final; the
            // runner interprets the `error` substate + meta.inbound to
            // produce the structured diagnostic.
            {
              target: "error",
              guard: noDeliverableWire,
              actions: assign({
                log: ({ context }) => [...context.log, `${stageName}:error`],
                finalizedStages: ({ context }) => [
                  ...context.finalizedStages,
                  {
                    name: stageName,
                    outcome: "error" as const,
                    reason: "no_active_wire" as const,
                  },
                ],
              }),
            },
          ],
          STAGE_FAILED: [
            {
              target: "error",
              guard: ({ event }: { event: MachineEvent }) =>
                event.type === "STAGE_FAILED" && event.stage === stageName,
              // Rare path: STAGE_FAILED arrives while the stage is still
              // waiting (e.g. fanout orchestrator fails before the region
              // entered executing). Origin is the executor layer, so
              // reason = executor_failed.
              actions: assign({
                log: ({ context }) => [...context.log, `${stageName}:error`],
                finalizedStages: ({ context, event }) => [
                  ...context.finalizedStages,
                  {
                    name: stageName,
                    outcome: "error" as const,
                    reason: "executor_failed" as const,
                    message: event.type === "STAGE_FAILED" ? event.error : undefined,
                  },
                ],
              }),
            },
          ],
          // Cross-region cancellation. The runner dispatches STAGE_CANCELLED
          // for each transitive downstream of a stage that just entered its
          // `error` final. We match on stage === self so each region only
          // reacts to its own cancellation, even though the same event is
          // observable by every parallel sibling.
          STAGE_CANCELLED: [
            {
              target: "error",
              guard: ({ event }: { event: MachineEvent }) =>
                event.type === "STAGE_CANCELLED" && event.stage === stageName,
              actions: assign({
                log: ({ context }) => [...context.log, `${stageName}:cancelled`],
                finalizedStages: ({ context }) => [
                  ...context.finalizedStages,
                  {
                    name: stageName,
                    outcome: "error" as const,
                    reason: "upstream_cancelled" as const,
                  },
                ],
              }),
            },
          ],
          // A3.2 — GATE_ANSWERED composes with inbound delivery. XState
          // evaluates transition guards BEFORE running root-level
          // actions on the same event, so sub-region guards cannot
          // rely on context.gateAuthorizedTargets / gateSkippedTargets
          // being up to date yet. We match on event fields directly.
          //
          // Priority:
          //   1. This stage is a NON-picked routing target of the
          //      answered gate → transition straight to `done`. This
          //      closes the region cleanly so the parallel region's
          //      onDone can fire even though the unpicked branch never
          //      runs. Without this, unpicked branches would stay
          //      `waiting` forever and the pipeline would hang.
          //   2. This stage IS the picked target → transition to
          //      executing iff inbound wires have delivered (gate
          //      authorization is an addition to, not a replacement
          //      for, wire delivery).
          //   3. This stage IS the picked target but inbound has a
          //      dropped wire → NO_ACTIVE_WIRE error.
          GATE_ANSWERED: [
            {
              target: "done",
              guard: ({ event }: { event: MachineEvent }) => {
                if (event.type !== "GATE_ANSWERED") return false;
                const siblings = gateSiblingsByGate.get(event.stageName) ?? [];
                // Normalize targetStage to an array for uniform membership checks.
                const picked = Array.isArray(event.targetStage)
                  ? event.targetStage
                  : [event.targetStage];
                // Only skip when the answered gate picked KNOWN siblings and
                // this stage is NOT among them. If the targetStage(s) aren't
                // real siblings (malformed answer that slipped past answerGate
                // validation), don't terminate any branch — leave the
                // pipeline state untouched so diagnostics surface via
                // other paths. This keeps the "unknown target is a no-op" invariant.
                const pickedIsKnown = picked.every((t) => siblings.includes(t));
                return (
                  pickedIsKnown &&
                  siblings.includes(stageName) &&
                  !picked.includes(stageName)
                );
              },
              // Record this stage in gateSkippedTargets so retry rebuild
              // can preserve the skip decision. XState v5 consumes the
              // event at this descendant transition and does NOT fire
              // the root-level `on: GATE_ANSWERED` handler — so we must
              // update context here.
              actions: assign({
                gateSkippedTargets: ({ context }) =>
                  context.gateSkippedTargets.includes(stageName)
                    ? context.gateSkippedTargets
                    : [...context.gateSkippedTargets, stageName],
              }),
            },
            {
              target: "executing",
              guard: ({ context, event }: { context: MachineContext; event: MachineEvent }) => {
                if (event.type !== "GATE_ANSWERED") return false;
                // Check whether this stage is among the picked targets.
                const isTarget = Array.isArray(event.targetStage)
                  ? event.targetStage.includes(stageName)
                  : event.targetStage === stageName;
                if (!isTarget) return false;
                return meta.inbound.every((w) => wireDelivers(w, context.portValues));
              },
              // Record this stage in gateAuthorizedTargets so retry rebuild
              // can re-synthesize GATE_ANSWERED for it. XState v5 consumes
              // the event at this descendant transition and does NOT fire
              // the root-level `on: GATE_ANSWERED` handler — so we must
              // update context here.
              actions: assign({
                gateAuthorizedTargets: ({ context }) =>
                  context.gateAuthorizedTargets.includes(stageName)
                    ? context.gateAuthorizedTargets
                    : [...context.gateAuthorizedTargets, stageName],
              }),
            },
            {
              target: "error",
              guard: ({ context, event }: { context: MachineContext; event: MachineEvent }) => {
                if (event.type !== "GATE_ANSWERED") return false;
                const isTarget = Array.isArray(event.targetStage)
                  ? event.targetStage.includes(stageName)
                  : event.targetStage === stageName;
                if (!isTarget) return false;
                if (meta.inbound.length === 0) return false;
                if (!meta.inbound.every((w) => wireSettled(w, context.portValues))) return false;
                return meta.inbound.some((w) => !wireDelivers(w, context.portValues));
              },
              // Gate authorised this stage but its inbound has at least
              // one dropped wire — same underlying cause as the plain
              // PORT_WRITTEN NO_ACTIVE_WIRE branch. Also record the gate
              // authorisation here — XState v5 consumes GATE_ANSWERED at
              // this descendant transition and does not fire the
              // root-level handler.
              actions: assign({
                log: ({ context }) => [...context.log, `${stageName}:error`],
                finalizedStages: ({ context }) => [
                  ...context.finalizedStages,
                  {
                    name: stageName,
                    outcome: "error" as const,
                    reason: "no_active_wire" as const,
                  },
                ],
                gateAuthorizedTargets: ({ context }) =>
                  context.gateAuthorizedTargets.includes(stageName)
                    ? context.gateAuthorizedTargets
                    : [...context.gateAuthorizedTargets, stageName],
              }),
            },
          ],
        },
        // Entry: if deps already met (entry stage or late entry), go
        // directly. Also catches the "already dead on entry" edge case
        // where portValues arrive before the region even starts.
        //
        // Priority ordering:
        //   1. gateSkipped — we already know this branch is not taken;
        //      terminate directly so the parallel region can converge.
        //   2. executing — normal activation.
        //   3. error — NO_ACTIVE_WIRE dead-end (suppressed for
        //      gate-routed stages until they're authorised).
        always: [
          // Rebuild short-circuit: if this stage already appears in
          // context.finalizedStages (populated by runner's initialContext.
          // finalizedStages on retry rebuild), jump directly to the
          // corresponding terminal state without re-running anything.
          // Ensures rebuilt actors don't re-invoke agents / re-create
          // gate_queue rows / re-run scripts for stages that completed
          // in a prior attempt. No actions here — the terminal-state
          // entry / original transition already recorded the outcome.
          {
            target: "done",
            guard: ({ context }: { context: MachineContext }) =>
              context.finalizedStages.some(
                (f) => f.name === stageName && f.outcome === "done",
              ),
          },
          {
            target: "error",
            guard: ({ context }: { context: MachineContext }) =>
              context.finalizedStages.some(
                (f) => f.name === stageName && f.outcome === "error",
              ),
          },
          {
            target: "done",
            guard: ({ context }: { context: MachineContext }) =>
              context.gateSkippedTargets.includes(stageName),
          },
          { target: "executing", guard: allInboundDelivered },
          {
            target: "error",
            guard: noDeliverableWire,
            // waiting.always NO_ACTIVE_WIRE — symmetric to PORT_WRITTEN
            // branch above; covers the "already dead on entry" race
            // where portValues arrive before the region starts.
            actions: assign({
              log: ({ context }) => [...context.log, `${stageName}:error`],
              finalizedStages: ({ context }) => [
                ...context.finalizedStages,
                {
                  name: stageName,
                  outcome: "error" as const,
                  reason: "no_active_wire" as const,
                },
              ],
            }),
          },
        ],
      },
      executing: executingBody,
      done: {
        type: "final",
        // Idempotent: the rebuild short-circuit in waiting.always can
        // target "done" when this stage's outcome was already recorded
        // by a prior attempt. Skip the push in that case to avoid a
        // duplicate finalizedStages entry / duplicate log line.
        entry: assign({
          log: ({ context }: { context: MachineContext }) =>
            context.finalizedStages.some((f) => f.name === stageName)
              ? context.log
              : [...context.log, `${stageName}:done`],
          finalizedStages: ({ context }: { context: MachineContext }) =>
            context.finalizedStages.some((f) => f.name === stageName)
              ? context.finalizedStages
              : [
                  ...context.finalizedStages,
                  { name: stageName, outcome: "done" as const },
                ],
        }),
      },
      error: {
        // `entry` removed — finalizedStages + log are assigned on each of
        // the transitions that enter this state so `reason` can carry
        // the originating path (no_active_wire vs executor_failed).
        type: "final",
      },
    },
  } as const;
}
