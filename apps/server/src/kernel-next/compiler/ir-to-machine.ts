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

import { createMachine, assign } from "xstate";
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
}

export type MachineEvent =
  | { type: "START" }
  | { type: "PORT_WRITTEN"; key: string; value: unknown }
  | { type: "STAGE_FAILED"; stage: string; error: string }
  | { type: "GATE_ANSWERED"; gateId: string; stageName: string; answer: string; targetStage: string };

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

function indexStages(ir: PipelineIR): Map<string, StageMeta> {
  const index = new Map<string, StageMeta>();

  // First pass: compute the set of stages that appear as a target in any
  // gate's routing table. These stages are "gate-routed" — activation
  // requires GATE_ANSWERED authorization in addition to inbound delivery.
  const gateRoutedTargets = new Set<string>();
  for (const s of ir.stages) {
    if (s.type !== "gate") continue;
    for (const target of Object.values(s.config.routing.routes)) {
      gateRoutedTargets.add(target);
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
    entry.inbound.push({
      sourceKey: `${w.from.stage}.${w.from.port}`,
      from: { stage: w.from.stage, port: w.from.port },
      to: { stage: w.to.stage, port: w.to.port },
      guard: w.guard,
    });
  }

  return index;
}

export interface CompileOptions {
  taskId: string;
}

export interface CompiledMachine {
  machine: AnyStateMachine;
  stageMeta: Map<string, StageMeta>;
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
    gateRoutingMap.set(s.name, Object.values(s.config.routing.routes));
  }

  // Build parallel region children.
  const parallelChildren: Record<string, unknown> = {};
  for (const s of ir.stages) {
    const meta = stageMeta.get(s.name)!;
    parallelChildren[s.name] = buildStageRegion(s.name, meta, gateRoutingMap);
  }

  const machine = createMachine({
    id: `kn_${options.taskId}`,
    types: {} as { context: MachineContext; events: MachineEvent },
    context: {
      taskId: options.taskId,
      versionHash: "", // filled by runner before starting
      portValues: {},
      log: [],
      gateAuthorizedTargets: [],
      gateSkippedTargets: [],
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
      // Root-level GATE_ANSWERED: record the routed target on the context
      // so gate-routed stages can evaluate the authorization guard; AND
      // mark every OTHER routing-target of the answered gate as skipped,
      // so the unpicked branches transition to `done` without running.
      // Stage regions also observe GATE_ANSWERED (for routing/gate-resolve
      // transitions), unaffected by this root-level assign.
      GATE_ANSWERED: {
        actions: assign(({ context, event }) => {
          const authorized = context.gateAuthorizedTargets.includes(event.targetStage)
            ? context.gateAuthorizedTargets
            : [...context.gateAuthorizedTargets, event.targetStage];
          // The answered gate's stageName tells us which routing table
          // to consult; the picked target is event.targetStage. Only
          // skip siblings when the answer routed to a KNOWN sibling —
          // otherwise the answer was malformed and we leave every
          // branch untouched (symmetric with the waiting.GATE_ANSWERED
          // guard above).
          const siblings = gateRoutingMap.get(event.stageName) ?? [];
          const pickedIsKnown = siblings.includes(event.targetStage);
          const newSkips = pickedIsKnown
            ? siblings.filter(
                (t) =>
                  t !== event.targetStage &&
                  !context.gateSkippedTargets.includes(t),
              )
            : [];
          const skipped = newSkips.length === 0
            ? context.gateSkippedTargets
            : [...context.gateSkippedTargets, ...newSkips];
          return { gateAuthorizedTargets: authorized, gateSkippedTargets: skipped };
        }),
      },
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

  return { machine, stageMeta };
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

  const executingBody: Record<string, unknown> = {
    entry: assign({
      log: ({ context }) => [...context.log, `${stageName}:executing`],
    }),
    on: {
      STAGE_FAILED: [
        {
          target: "error",
          guard: ({ event }: { event: MachineEvent }) =>
            event.type === "STAGE_FAILED" && event.stage === stageName,
        },
      ],
    },
  };

  if (isGate) {
    // Gate stages have zero outputs; the default allOutboundPresent is
    // trivially true which would immediately `always` the gate through
    // to `done`. Suppress that transition and only resolve via the
    // GATE_ANSWERED event whose stageName matches this gate.
    (executingBody.on as Record<string, unknown>).GATE_ANSWERED = [
      { target: "done", guard: gateAnsweredIsMe },
    ];
    // Intentionally no `always` — gate blocks until answered.
  } else {
    (executingBody.on as Record<string, unknown>).PORT_WRITTEN = [
      { target: "done", guard: allOutboundPresent },
    ];
    // Synchronous-complete path for mock executors that write outputs
    // before the machine observes.
    executingBody.always = [{ target: "done", guard: allOutboundPresent }];
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
            { target: "error", guard: noDeliverableWire },
          ],
          STAGE_FAILED: [
            {
              target: "error",
              guard: ({ event }: { event: MachineEvent }) =>
                event.type === "STAGE_FAILED" && event.stage === stageName,
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
                // Only skip when the answered gate picked a KNOWN sibling
                // other than this stage. If the targetStage isn't a real
                // sibling (malformed answer that slipped past answerGate
                // validation), don't terminate any branch — leave the
                // pipeline state untouched so diagnostics surface via
                // other paths. This keeps the "unknown target is a
                // no-op" invariant.
                return (
                  siblings.includes(stageName) &&
                  siblings.includes(event.targetStage) &&
                  event.targetStage !== stageName
                );
              },
            },
            {
              target: "executing",
              guard: ({ context, event }: { context: MachineContext; event: MachineEvent }) => {
                if (event.type !== "GATE_ANSWERED") return false;
                if (event.targetStage !== stageName) return false;
                return meta.inbound.every((w) => wireDelivers(w, context.portValues));
              },
            },
            {
              target: "error",
              guard: ({ context, event }: { context: MachineContext; event: MachineEvent }) => {
                if (event.type !== "GATE_ANSWERED") return false;
                if (event.targetStage !== stageName) return false;
                if (meta.inbound.length === 0) return false;
                if (!meta.inbound.every((w) => wireSettled(w, context.portValues))) return false;
                return meta.inbound.some((w) => !wireDelivers(w, context.portValues));
              },
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
          {
            target: "done",
            guard: ({ context }: { context: MachineContext }) =>
              context.gateSkippedTargets.includes(stageName),
          },
          { target: "executing", guard: allInboundDelivered },
          { target: "error", guard: noDeliverableWire },
        ],
      },
      executing: executingBody,
      done: {
        type: "final",
        entry: assign({
          log: ({ context }) => [...context.log, `${stageName}:done`],
        }),
      },
      error: {
        type: "final",
        entry: assign({
          log: ({ context }) => [...context.log, `${stageName}:error`],
        }),
      },
    },
  } as const;
}
