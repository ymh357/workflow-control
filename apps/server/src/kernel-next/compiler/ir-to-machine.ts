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

interface StageMeta {
  stageType: StageIR["type"];
  inbound: string[];  // "<stage>.<port>" inbound port keys
  outbound: string[]; // "<stage>.<port>" outbound port keys
}

function indexStages(ir: PipelineIR): Map<string, StageMeta> {
  const index = new Map<string, StageMeta>();

  // Start by declaring all stages with empty inbound/outbound.
  for (const s of ir.stages) {
    const outbound = s.outputs.map((p) => `${s.name}.${p.name}`);
    index.set(s.name, { stageType: s.type, inbound: [], outbound });
  }

  // Populate inbound via wires.
  for (const w of ir.wires) {
    const entry = index.get(w.to.stage);
    if (!entry) continue;
    entry.inbound.push(`${w.from.stage}.${w.from.port}`);
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
  const allInboundPresent = ({ context }: { context: MachineContext }) =>
    meta.inbound.every((k) => k in context.portValues);

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
          PORT_WRITTEN: [{ target: "executing", guard: allInboundPresent }],
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
        // Entry: if deps already met (entry stage or late entry), go directly.
        always: [{ target: "executing", guard: allInboundPresent }],
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
