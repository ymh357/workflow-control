// SDK adapter — translates Claude Agent SDK messages into AgentMachine
// events. One function per SDK message shape; callers dispatch the
// returned events in order.
//
// Why not a class or an object with state? The adapter needs to remember
// that it saw a COMPACT_STARTED so it can emit a synthetic COMPACT_ENDED
// on the next non-compact message. That's a tiny amount of state — one
// boolean. We wrap it in `createSdkAdapter()` which returns a translate()
// function closed over the boolean. The executor calls translate(msg) for
// every SDK message and actor.send()s each returned event.
//
// Unknown SDK message types return [] and are logged — they don't fault
// the machine (see design §4.4 mitigation).

import type { AgentEvent } from "./agent-machine.js";

/**
 * Subset of SDK message shape the adapter needs. Intentionally narrow:
 * we only read `type`, `subtype`, and the content blocks. Keeps the
 * adapter decoupled from SDK version churn.
 */
export type SdkMessageLike = {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<{
      type: string;
      id?: string;
      // SDK's real field for tool_result blocks (snake_case on the
      // wire per Anthropic Messages API spec). Some SDK paths expose
      // camelCase toolUseId instead — both kept optional so test
      // fixtures can construct either shape.
      tool_use_id?: string;
      toolUseId?: string;
      // Anthropic tool_result block error flag. When true, the content
      // describes a tool-invocation error (e.g. permission denial,
      // unknown tool). SDK also sometimes inlines <tool_use_error>...</tool_use_error>
      // into content without flipping this flag — adapter detects that
      // pattern and surfaces isError=true regardless.
      is_error?: boolean;
      name?: string;
      input?: unknown;
      content?: unknown;
    }>;
  };
  compact_metadata?: { trigger: "manual" | "auto"; pre_tokens: number };
  rate_limit_info?: { utilization?: number };
  total_cost_usd?: number;
  num_turns?: number;
  error_message?: string;
  result?: string;
  [k: string]: unknown;
};

export interface SdkAdapter {
  /**
   * Translate one SDK message into zero or more AgentEvents. The adapter
   * may emit a synthetic COMPACT_ENDED before the message's own event
   * when leaving a compact window.
   */
  translate(msg: SdkMessageLike): AgentEvent[];
  /**
   * Messages the adapter did not recognise, for observability. Adapter
   * versions churn as the SDK adds message types; surface these instead
   * of silently swallowing.
   */
  readonly unknownMessages: ReadonlyArray<{ type: string; subtype?: string }>;
}

export function createSdkAdapter(): SdkAdapter {
  let inCompact = false;
  const unknown: Array<{ type: string; subtype?: string }> = [];

  const adapter: SdkAdapter = {
    unknownMessages: unknown,
    translate(msg: SdkMessageLike): AgentEvent[] {
      const events: AgentEvent[] = [];

      // Leaving a compact window: emit synthetic COMPACT_ENDED before
      // translating the current message (unless the current message is
      // another compact_boundary, in which case we stay in compact).
      const isCompactBoundary =
        msg.type === "system" && msg.subtype === "compact_boundary";
      if (inCompact && !isCompactBoundary) {
        events.push({ type: "COMPACT_ENDED" });
        inCompact = false;
      }

      if (msg.type === "system") {
        if (msg.subtype === "init") {
          events.push({ type: "SDK_INIT" });
          return events;
        }
        if (msg.subtype === "compact_boundary") {
          const meta = msg.compact_metadata ?? { trigger: "auto" as const, pre_tokens: 0 };
          events.push({
            type: "COMPACT_STARTED",
            trigger: meta.trigger,
            pre_tokens: meta.pre_tokens,
          });
          inCompact = true;
          return events;
        }
        // status / task_notification / task_progress / task_started /
        // local_command_output / auth_status — telemetry, ignore.
        return events;
      }

      if (msg.type === "assistant") {
        const blocks = msg.message?.content ?? [];
        let sawToolUse = false;
        for (const b of blocks) {
          if (b.type === "tool_use") {
            sawToolUse = true;
            if (typeof b.id === "string" && typeof b.name === "string") {
              events.push({
                type: "TOOL_USE_REQUESTED",
                id: b.id,
                name: b.name,
                input: b.input,
              });
            }
          }
        }
        // Assistant messages with only text/thinking map to a single
        // ASSISTANT_TEXT (no-op in machine, pure telemetry).
        if (!sawToolUse) {
          events.push({ type: "ASSISTANT_TEXT" });
        }
        return events;
      }

      if (msg.type === "user") {
        const blocks = msg.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "tool_result") {
            // Real SDK uses tool_use_id (Anthropic Messages API spec).
            // Some SDK paths expose camelCase toolUseId. Older test
            // fixtures used `id`. Accept all three so we're robust to
            // both the spec and any internal SDK drift. The exact cause
            // of run #20's empty tool_calls_json.result was the adapter
            // only reading `id` — which the real SDK never emits.
            const id =
              typeof b.tool_use_id === "string"
                ? b.tool_use_id
                : typeof b.toolUseId === "string"
                  ? b.toolUseId
                  : typeof b.id === "string"
                    ? b.id
                    : undefined;
            if (id !== undefined) {
              // Two sources of truth for errors: the block's is_error
              // flag (spec form) and <tool_use_error> content pattern
              // (observed in run #22 when SDK did NOT set is_error but
              // still reported "No such tool"). Accept either — belt
              // and braces.
              const hasErrorFlag = b.is_error === true;
              const hasErrorTag =
                typeof b.content === "string" && b.content.includes("<tool_use_error>");
              const isError = hasErrorFlag || hasErrorTag;
              events.push({
                type: "TOOL_RESULT_RECEIVED",
                id,
                output: b.content,
                ...(isError ? { isError: true } : {}),
              });
            }
          }
        }
        return events;
      }

      if (msg.type === "rate_limit_event") {
        events.push({
          type: "RATE_LIMIT_SIGNAL",
          utilization: msg.rate_limit_info?.utilization,
        });
        return events;
      }

      if (msg.type === "result") {
        if (msg.subtype === "success") {
          events.push({
            type: "RESULT_SUCCESS",
            cost_usd: msg.total_cost_usd,
            num_turns: msg.num_turns,
          });
        } else {
          const subtype = msg.subtype ?? "unknown";
          const message =
            msg.error_message ??
            (typeof msg.result === "string" ? msg.result : `result subtype: ${subtype}`);
          events.push({ type: "RESULT_ERROR", subtype, message });
        }
        return events;
      }

      // stream_event (partial_assistant), hook_*, task_*, files_persisted,
      // tool_progress, tool_use_summary, auth_status, task_notification,
      // elicitation_complete, prompt_suggestion — all observability-only.
      // Log as unknown once per (type,subtype) without faulting.
      unknown.push({ type: msg.type, subtype: msg.subtype });
      return events;
    },
  };
  return adapter;
}
