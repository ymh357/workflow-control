# kernel-next Phase 2 — Option B Feasibility Probe

**Date**: 2026-04-19
**Purpose**: Before committing 5-8 weeks to "agent-level XState"
(option B of the architecture terminal-state debate), validate that
the Claude Agent SDK message stream can be cleanly mapped to a finite
agent state machine.

**Method**: 2 synthetic stages × 2 runs each (4 streams total) dumped
verbatim to `/tmp/sdk-probe/*.jsonl`. Every SDK message, every content
block type preserved.

## TL;DR

**Option B is feasible**. The SDK stream observed in 4/4 runs
decomposes into a trivial 6-state machine with **zero unmapped
messages**. Tool calls are strictly serial (one tool_use → one
tool_result per turn). A minimal `AgentMachine` could be built in
days, not weeks.

The earlier "5-8 weeks" estimate was worst-case for "complete B".
The spec actually needed is much smaller. Revised estimate at the
end of this doc.

## Observed stream structure

All 4 runs followed the identical template:

```
[ 0] system/init                                      — bootstrap
[ 1] assistant/ [thinking]                            — ext. thinking
[ 2] assistant/ [tool_use: write_port]                — fires tool
[ 3] user/      [tool_result]                         — tool returns
[ …] (repeat tool_use + tool_result per output port)
[N-4] rate_limit_event                                — side-channel
[N-3] assistant/ [thinking]                           — post-tool
[N-2] assistant/ [text]                               — end-of-turn
[N-1] result/success                                  — session end
```

- **A-simple** (1 port): 8 messages, 2 turns
- **B-multi** (3 ports): 12 messages, 4 turns
- **Tool call cadence is serial**: 3 write_ports produced 3 full
  tool_use → tool_result round trips. The SDK does NOT batch multiple
  tool_use blocks into one assistant message in this session mode.
- **Thinking blocks**: always first block of an assistant message,
  followed by either tool_use (block index 1) or text. Never sole
  content.
- **rate_limit_event**: appears once per run, always between the last
  tool_result and the first post-tool assistant message. Informational
  only — no state change required.
- **compact_boundary**: NOT observed (runs too short). SDK types
  declare it as `type:'system' subtype:'compact_boundary'` with
  `compact_metadata: { trigger: 'manual' | 'auto', pre_tokens: number }`
  — shape is well-defined.

## Proposed AgentMachine (6 states)

```
initial
   │
   ▼
┌───────────┐  system/init              ┌────────────────────┐
│ starting  │─────────────────────────▶│ waiting_for_claude │
└───────────┘                           └──────┬─────────────┘
                                               │
         assistant/thinking|text  ◀───────────┤ (no state change)
         rate_limit_event        ◀───────────┤ (no state change,
                                  │          │  budget telemetry)
                                               │
                 assistant/tool_use            │ system/compact_boundary
                     │                         │
                     ▼                         ▼
           ┌──────────────────┐       ┌───────────────┐
           │ dispatching_tool │       │   compacting  │
           └──────────┬───────┘       └───────┬───────┘
                      │                       │
           user/tool_result             (next message ≠ compact_boundary)
                      │                       │
                      └───────────┬───────────┘
                                  ▼
                         waiting_for_claude
                                  │
                        result/success        result/error_*
                                  │                 │
                                  ▼                 ▼
                                done             error
```

**State → Entry semantics mapping** (what kernel records per state):

| State | Entry side-effect |
| ----- | ----------------- |
| starting | Open stage_attempt row, dispatch STAGE_STARTED |
| waiting_for_claude | Log turn boundary; budget check (guard) |
| dispatching_tool | Record tool call (name, input, invocation time) |
| compacting | Record compact_metadata (trigger, pre_tokens) |
| done | finishAttempt success; dispatch STAGE_SUCCEEDED |
| error | finishAttempt error; dispatch STAGE_FAILED (unless silent retry) |

**Events (driven by SDK → XState adapter)**:

| SDK message | Event to AgentMachine |
| ----------- | --------------------- |
| `system/init` | `SDK_INIT` |
| `assistant` w/ `tool_use` block | `TOOL_USE_REQUESTED { name, input, id }` |
| `assistant` w/ `text` or `thinking` only | `ASSISTANT_TEXT` (idempotent, logs only) |
| `user` w/ `tool_result` block | `TOOL_RESULT_RECEIVED { id, output }` |
| `system/compact_boundary` | `COMPACT_STARTED { trigger, pre_tokens }` |
| `system/status` (from SDKStatusMessage) | `STATUS_CHANGED { status }` |
| `rate_limit_event` | `RATE_LIMIT_SIGNAL { delta }` |
| `result/success` | `RESULT_SUCCESS { cost, turns, ... }` |
| `result/error_*` | `RESULT_ERROR { subtype, message }` |

## Unmapped / edge cases

### What IS covered by the observed runs
- Normal turn flow
- Multiple tool calls in one stage (serial cadence)
- End-of-turn assistant text after tool loop closes
- Rate limit signals as side-channel

### What is NOT in this probe's data (but addressable)
- **Compact boundary** — not triggered. Type-safe shape exists; we
  can add `compacting` state with confidence based on typings alone
  but will want one real triggered run before shipping.
- **Extended thinking as sole content** — doesn't appear. If it does
  in future runs, it's just `ASSISTANT_TEXT`-equivalent no-op.
- **tool_use block with multiple tool calls in one assistant message**
  — SDK typings allow it; not observed in serial write_port mode.
  Need to check what Haiku does when prompted with a parallel-capable
  task. **Not a blocker** — can treat multi-tool-use as "queue of
  pending dispatches" and chain `dispatching_tool → dispatching_tool`.
- **Hook/status messages** (`SDKHookStartedMessage` etc.) — declared
  in SDK types but not observed. Low priority; all are telemetry.
- **Partial assistant messages** (`SDKPartialAssistantMessage`) — SDK
  streams may emit these during long responses; not observed with
  non-streaming consumption. Need to verify.

## Revised effort estimate

The original "5-8 weeks" budget was based on fear of SDK-internal
complexity. Actual data shows the core mapping is **simple**:

| Work item | Estimate |
| --------- | -------- |
| AgentMachine state definition + transitions | 0.5 day |
| SDK adapter (message → event) | 1-1.5 days |
| Rewire write_port path through AgentMachine | 1-2 days |
| Nesting under stage machine (XState invoke) | 1-2 days |
| Port tests + snapshot adjustments | 1-2 days |
| One intentional compact-triggering run + model it | 0.5 day |
| **Subtotal (happy path)** | **5-7 days** |
| Buffer for edge cases (parallel tool_use, partial_assistant) | 2-3 days |
| Integration + adversarial tests | 2-3 days |
| **Total, realistic** | **~2 weeks** |

This is a **3-4× reduction** from the worst-case estimate.

## Recommendation

**Proceed with Option B**, but with two modifiers based on the data:

1. **Build incrementally**, not top-down. Start with the observed
   "happy path" (6-state machine, 4 events) and extend only when a
   real run surfaces an unmapped message. Do not pre-build for every
   SDK message type — most are never encountered.

2. **Do not model Claude-SDK internal latency**. E.g., the
   `dispatching_tool` state's time-in-state is observable via the
   tool_use / tool_result timestamps; we don't need to emit
   intra-state progress events.

## Artefacts

- `/tmp/sdk-probe/A-simple-run1.jsonl` · `A-simple-run2.jsonl`
- `/tmp/sdk-probe/B-multi-run1.jsonl` · `B-multi-run2.jsonl`
- `/tmp/sdk-probe/summary.json`
- Probe source: `apps/server/src/kernel-next/generator-real/sdk-probe.ts`
  (delete after this doc is accepted — not product code)
