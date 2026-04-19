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
}

export type MachineEvent =
  | { type: "START" }
  | { type: "PORT_WRITTEN"; key: string; value: unknown }
  | { type: "STAGE_FAILED"; stage: string; error: string }
  | { type: "GATE_ANSWERED"; gateId: string; stageName: string; answer: string; targetStage: string };

interface InboundWireMeta {
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

interface StageMeta {
  stageType: StageIR["type"];
  // A3.1: inbound is now per-wire (not per source port key), because a
  // single source port may feed multiple downstream ports and each carries
  // its own guard. `allInboundWiresSettled` means every wire's source has
  // been written; `anyInboundWireDelivered` means at least one wire's
  // source has been written AND its guard (if any) evaluated true.
  inbound: InboundWireMeta[];
  outbound: string[]; // "<stage>.<port>" outbound port keys
}

function indexStages(ir: PipelineIR): Map<string, StageMeta> {
  const index = new Map<string, StageMeta>();

  // Start by declaring all stages with empty inbound/outbound.
  for (const s of ir.stages) {
    const outbound = s.outputs.map((p) => `${s.name}.${p.name}`);
    index.set(s.name, { stageType: s.type, inbound: [], outbound });
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

  // Build parallel region children.
  const parallelChildren: Record<string, unknown> = {};
  for (const s of ir.stages) {
    const meta = stageMeta.get(s.name)!;
    parallelChildren[s.name] = buildStageRegion(s.name, meta);
  }

  const machine = createMachine({
    id: `kn_${options.taskId}`,
    types: {} as { context: MachineContext; events: MachineEvent },
    context: {
      taskId: options.taskId,
      versionHash: "", // filled by runner before starting
      portValues: {},
      log: [],
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
function buildStageRegion(stageName: string, meta: StageMeta) {
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
  const allInboundDelivered = ({ context }: { context: MachineContext }) =>
    meta.inbound.every((w) => wireDelivers(w, context.portValues));

  // Dead stage: every source has fired, but at least one wire has been
  // dropped by a false guard. That wire can never deliver — the stage
  // cannot activate. §6.2 specifies this is a pipeline authoring bug
  // (NO_ACTIVE_WIRE). We detect it compile-free at runtime and surface
  // it as STAGE_FAILED via a transient `always` branch from `waiting`.
  const noDeliverableWire = ({ context }: { context: MachineContext }) => {
    if (meta.inbound.length === 0) return false;
    if (!meta.inbound.every((w) => wireSettled(w, context.portValues))) return false;
    return meta.inbound.some((w) => !wireDelivers(w, context.portValues));
  };

  const allOutboundPresent = ({ context }: { context: MachineContext }) =>
    meta.outbound.length === 0
      ? true // stages with no declared outputs are considered done once executor signals completion
      : meta.outbound.every((k) => k in context.portValues);

  const isGate = meta.stageType === "gate";

  // Guard matching a GATE_ANSWERED whose targetStage names this stage. Used
  // in every stage's `waiting` substate so gate routing can activate
  // downstream stages even when they don't have all inbound wires ready.
  const gateAnsweredTargetsMe = ({ event }: { event: MachineEvent }) =>
    event.type === "GATE_ANSWERED" && event.targetStage === stageName;

  // Guard for a gate stage leaving `executing` on its own GATE_ANSWERED
  // event. Distinguished from the `waiting` activation guard above — here
  // we match on stageName (the answered gate) rather than targetStage.
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
          // Gate routing: any stage may be activated by a GATE_ANSWERED
          // whose targetStage names it, regardless of inbound-wire state.
          GATE_ANSWERED: [
            { target: "executing", guard: gateAnsweredTargetsMe },
          ],
        },
        // Entry: if deps already met (entry stage or late entry), go
        // directly. Also catches the "already dead on entry" edge case
        // where portValues arrive before the region even starts (rare,
        // but possible with hot-update).
        always: [
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
