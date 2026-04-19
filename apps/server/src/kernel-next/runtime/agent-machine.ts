// AgentMachine — turn-level XState per design doc §4 and
// docs/kernel-next-phase2-b-feasibility.md.
//
// States (6):
//   starting              — before system/init lands
//   waiting_for_claude    — between SDK events; target of every non-terminal
//   dispatching_tool      — inside a tool_use round trip
//   compacting            — inside a compact_boundary window
//   done                  — final, success or interrupted
//   error                 — final, SDK returned a non-success result
//
// Events (10) — see feasibility table:
//   SDK_INIT               from system/init
//   ASSISTANT_TEXT         from assistant w/ text-or-thinking only (no-op)
//   TOOL_USE_REQUESTED     from assistant w/ tool_use block
//   TOOL_RESULT_RECEIVED   from user w/ tool_result block
//   COMPACT_STARTED        from system/compact_boundary
//   COMPACT_ENDED          synthetic — next non-compact message after
//                          COMPACT_STARTED. Adapter emits it so the state
//                          machine can leave `compacting` deterministically.
//   RATE_LIMIT_SIGNAL      from rate_limit_event (no-op, telemetry)
//   RESULT_SUCCESS         from result subtype=success
//   RESULT_ERROR           from any other result subtype
//   INTERRUPT              kernel-originated (§4.2 rules)
//
// This module is PURE: no DB writes, no SDK calls. Side effects
// (persisting tool calls, snapshotting compact metadata, writing ports)
// live in the executor that owns the adapter and the DB. The machine's
// sole job is to decide "what turn am I in" and to reach a final state.
//
// Output of the final state (via setup().output): a minimal record the
// executor reads off `actor.getSnapshot().output` after `actor.stop()`.

import { setup, assign } from "xstate";

export interface AgentContext {
  /**
   * Monotonically increasing count of observed SDK "turns" (assistant
   * messages that are NOT inside a pending tool loop). Used by the
   * executor / kernel for telemetry; machine itself doesn't branch on it.
   */
  turns: number;
  /**
   * The outstanding tool_use id currently being awaited. Set when entering
   * dispatching_tool, cleared on TOOL_RESULT_RECEIVED. When multiple tool_use
   * blocks land in a single assistant message (SDK typings allow it; not
   * observed in probe), we queue the rest here.
   */
  pendingToolUseIds: string[];
  /**
   * Latest compact_boundary metadata while in `compacting`. Surfaced to the
   * executor via entry action if it wants to persist it; cleared on exit.
   */
  compactMetadata: { trigger: "manual" | "auto"; pre_tokens: number } | null;
  /**
   * Final result, captured when a RESULT_* event fires. The output mapper
   * below reads this to produce the actor's final value.
   */
  result:
    | { kind: "success"; cost?: number; turns?: number }
    | { kind: "error"; subtype: string; message: string }
    | { kind: "interrupted"; from: "starting" | "waiting_for_claude" | "dispatching_tool" | "compacting" }
    | null;
  /**
   * True once an INTERRUPT has been accepted. While armed:
   *   - a later RESULT_SUCCESS is still honored (the summary turn landed)
   *   - a subsequent transition back to waiting_for_claude (after the
   *     agent used its summary turn — i.e. after we've left waiting once
   *     and returned) finalises as `interrupted` if no RESULT_* arrived.
   *   This models §4.2 "one more turn then done" without aborting the
   *   current in-flight tool call or compact.
   */
  interruptArmed: boolean;
  /**
   * Tracks whether the agent has consumed its summary-turn slot. Set true
   * when we leave waiting_for_claude (to dispatching_tool or compacting)
   * AFTER an INTERRUPT has been armed. On the next re-entry to waiting,
   * the `always` guard sees both flags and finalises.
   *
   * Without this flag, `interruptArmed` alone would cause an immediate
   * `always` fire on the same waiting entry where the INTERRUPT landed —
   * skipping the promised summary turn.
   */
  summaryTurnUsed: boolean;
}

export type AgentEvent =
  | { type: "SDK_INIT" }
  | { type: "ASSISTANT_TEXT" }
  | { type: "TOOL_USE_REQUESTED"; name: string; input: unknown; id: string }
  | { type: "TOOL_RESULT_RECEIVED"; id: string; output?: unknown }
  | { type: "COMPACT_STARTED"; trigger: "manual" | "auto"; pre_tokens: number }
  | { type: "COMPACT_ENDED" }
  | { type: "RATE_LIMIT_SIGNAL"; utilization?: number }
  | { type: "RESULT_SUCCESS"; cost_usd?: number; num_turns?: number }
  | { type: "RESULT_ERROR"; subtype: string; message: string }
  | { type: "INTERRUPT" };

export interface AgentMachineOutput {
  status: "done" | "interrupted" | "error";
  // Present on status='error'. Carries the SDK result subtype + message.
  diagnostic?: { subtype: string; message: string };
  // Present on status='interrupted'. Which state the INTERRUPT was processed from.
  interruptedFrom?: "starting" | "waiting_for_claude" | "dispatching_tool" | "compacting";
  turns: number;
}

/**
 * Build an AgentMachine. Kept as a factory so tests can start multiple
 * independent actors without worrying about shared state.
 */
export function createAgentMachine() {
  return setup({
    types: {} as {
      context: AgentContext;
      events: AgentEvent;
      output: AgentMachineOutput;
    },
    guards: {
      noPendingTools: ({ context }) => context.pendingToolUseIds.length === 0,
      hasPendingTools: ({ context }) => context.pendingToolUseIds.length > 0,
    },
    actions: {
      enqueueToolUse: assign({
        pendingToolUseIds: ({ context, event }) => {
          if (event.type !== "TOOL_USE_REQUESTED") return context.pendingToolUseIds;
          return [...context.pendingToolUseIds, event.id];
        },
      }),
      dequeueToolResult: assign({
        pendingToolUseIds: ({ context, event }) => {
          if (event.type !== "TOOL_RESULT_RECEIVED") return context.pendingToolUseIds;
          // Tolerate out-of-order (should not happen in serial mode, but SDK
          // typings don't guarantee order): remove first occurrence by id.
          const idx = context.pendingToolUseIds.indexOf(event.id);
          if (idx === -1) return context.pendingToolUseIds;
          const next = context.pendingToolUseIds.slice();
          next.splice(idx, 1);
          return next;
        },
      }),
      bumpTurns: assign({
        turns: ({ context }) => context.turns + 1,
      }),
      recordCompactStart: assign({
        compactMetadata: ({ event }) => {
          if (event.type !== "COMPACT_STARTED") return null;
          return { trigger: event.trigger, pre_tokens: event.pre_tokens };
        },
      }),
      clearCompact: assign({
        compactMetadata: () => null,
      }),
      armInterrupt: assign({
        interruptArmed: () => true,
      }),
      markSummaryTurnUsed: assign({
        summaryTurnUsed: ({ context }) => context.interruptArmed || context.summaryTurnUsed,
      }),
      recordSuccess: assign({
        result: ({ event }) => {
          if (event.type !== "RESULT_SUCCESS") return null;
          return { kind: "success" as const, cost: event.cost_usd, turns: event.num_turns };
        },
      }),
      recordError: assign({
        result: ({ event }) => {
          if (event.type !== "RESULT_ERROR") return null;
          return { kind: "error" as const, subtype: event.subtype, message: event.message };
        },
      }),
      recordInterruptedFromStarting: assign({
        result: () => ({ kind: "interrupted" as const, from: "starting" as const }),
      }),
      recordInterruptedFromWaiting: assign({
        result: () => ({ kind: "interrupted" as const, from: "waiting_for_claude" as const }),
      }),
    },
  }).createMachine({
    id: "agent",
    initial: "starting",
    context: {
      turns: 0,
      pendingToolUseIds: [],
      compactMetadata: null,
      result: null,
      interruptArmed: false,
      summaryTurnUsed: false,
    },
    output: ({ context }): AgentMachineOutput => {
      const r = context.result;
      if (!r) {
        // Reaching a final state without a result set is a programming error
        // in the machine definition — surface it explicitly instead of
        // silently shipping status='done'.
        return {
          status: "error",
          diagnostic: { subtype: "internal", message: "final state reached without result" },
          turns: context.turns,
        };
      }
      if (r.kind === "success") {
        return { status: "done", turns: context.turns };
      }
      if (r.kind === "interrupted") {
        return { status: "interrupted", interruptedFrom: r.from, turns: context.turns };
      }
      return {
        status: "error",
        diagnostic: { subtype: r.subtype, message: r.message },
        turns: context.turns,
      };
    },
    states: {
      starting: {
        on: {
          SDK_INIT: { target: "waiting_for_claude" },
          // §4.2: INTERRUPT from `starting` finalises immediately with
          // `interrupted`, no summary turn (no session exists yet).
          INTERRUPT: {
            target: "done",
            actions: ["recordInterruptedFromStarting"],
          },
          // Unexpected in this state (probe showed 4/4 runs start with
          // system/init) — treat as telemetry rather than fault.
          RATE_LIMIT_SIGNAL: {},
          ASSISTANT_TEXT: {},
        },
      },
      waiting_for_claude: {
        entry: ["bumpTurns"],
        always: [
          // If an INTERRUPT was armed AND the agent has since consumed its
          // summary-turn slot (left waiting and came back), finalise as
          // interrupted. The summary-turn slot is considered consumed when
          // we transitioned out of waiting at least once while armed.
          {
            target: "done",
            guard: ({ context }) => context.interruptArmed && context.summaryTurnUsed,
            actions: ["recordInterruptedFromWaiting"],
          },
        ],
        on: {
          ASSISTANT_TEXT: {}, // no-op, telemetry
          RATE_LIMIT_SIGNAL: {},
          TOOL_USE_REQUESTED: {
            target: "dispatching_tool",
            actions: ["enqueueToolUse", "markSummaryTurnUsed"],
          },
          COMPACT_STARTED: {
            target: "compacting",
            actions: ["recordCompactStart", "markSummaryTurnUsed"],
          },
          RESULT_SUCCESS: {
            target: "done",
            actions: ["recordSuccess"],
          },
          RESULT_ERROR: {
            target: "error",
            actions: ["recordError"],
          },
          // §4.2: arm and let the next transition through waiting handle it.
          // We *could* transition immediately, but the design says give the
          // agent one more turn. The `always` guard above catches the NEXT
          // re-entry to waiting_for_claude.
          INTERRUPT: {
            actions: ["armInterrupt"],
          },
        },
      },
      dispatching_tool: {
        on: {
          TOOL_USE_REQUESTED: {
            // Additional tool_use blocks in the same assistant message —
            // queue them; SDK may deliver multiple tool_use before any
            // tool_result. Stay in dispatching_tool.
            actions: ["enqueueToolUse"],
          },
          TOOL_RESULT_RECEIVED: [
            {
              target: "waiting_for_claude",
              guard: ({ context, event }) =>
                context.pendingToolUseIds.length === 1 &&
                context.pendingToolUseIds[0] === event.id,
              actions: ["dequeueToolResult"],
            },
            {
              // More tools still pending — stay put.
              actions: ["dequeueToolResult"],
            },
          ],
          ASSISTANT_TEXT: {}, // no-op (thinking block interleaved between tool calls)
          RATE_LIMIT_SIGNAL: {},
          // §4.2: do NOT abort mid-tool. The in-flight tool call itself
          // counts as the agent's summary-turn slot being consumed, so we
          // mark it now. The next bounce through waiting_for_claude's
          // `always` guard then finalises as interrupted.
          INTERRUPT: {
            actions: ["armInterrupt", "markSummaryTurnUsed"],
          },
          // Result messages in the middle of a tool loop are unusual but
          // possible (error during execution). Honor them.
          RESULT_SUCCESS: {
            target: "done",
            actions: ["recordSuccess"],
          },
          RESULT_ERROR: {
            target: "error",
            actions: ["recordError"],
          },
        },
      },
      compacting: {
        on: {
          COMPACT_ENDED: {
            target: "waiting_for_claude",
            actions: ["clearCompact"],
          },
          // §4.2: compacting also defers interrupt handling. The compact
          // itself counts as summary-turn consumption so the next re-entry
          // to waiting finalises.
          INTERRUPT: {
            actions: ["armInterrupt", "markSummaryTurnUsed"],
          },
          // A result landing during compact is rare but legal; clear the
          // compact metadata on the way out.
          RESULT_SUCCESS: {
            target: "done",
            actions: ["clearCompact", "recordSuccess"],
          },
          RESULT_ERROR: {
            target: "error",
            actions: ["clearCompact", "recordError"],
          },
          RATE_LIMIT_SIGNAL: {},
          ASSISTANT_TEXT: {},
        },
      },
      done: { type: "final" },
      error: { type: "final" },
    },
  });
}
