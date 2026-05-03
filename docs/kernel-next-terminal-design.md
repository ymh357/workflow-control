# kernel-next Terminal Architecture Design

> Version 1.0 | 2026-04-19
> Status: **Design finalised; implementation pending**
> Authoring model: Opus 4.7 (1M context) — architect this session
> Reviewer: the product owner (primary user)
>
> **Rule**: this document is the single source of truth for all
> subsequent kernel-next implementation. Every architectural decision
> below was collected through a structured 5-round interview with the
> product owner. If a future decision would contradict this doc, the
> doc must be updated first (with dated reasoning) before code lands.

---

## 0. Reading map

- **§1** tells you what workflow-control is and is not
- **§2** defines the kernel's boundary and the userland it serves
- **§3** defines the three stage primitives that replace the legacy 7
- **§4** defines AgentMachine — the turn-level state machine inside
  every agent stage
- **§5** defines the IR and execution policy (two layers)
- **§6** defines wires, gates, and fanout — the routing primitives
- **§7** defines Typed Port and its type discipline
- **§8** defines the lineage + sidecar execution record model
- **§9** defines MCP surface structure (external vs internal)
- **§10** defines hot-update / migration semantics (B-series)
- **§11** defines acceptance — what it means for this design to be
  "done"
- **Appendix A** maps legacy kernel constructs to their terminal-state
  equivalents
- **Appendix B** lists what is explicitly out of scope and why

---

## 1. Scope & positioning

### 1.1 What workflow-control is

workflow-control is a **local, single-user AI workflow engine** that
runs as an **MCP server inside Claude Code's tool ecosystem**. The
author (who is also the primary user) invokes it through natural
language in Claude Code; the main Claude Code agent recognises that
a task is "long / multi-stage / gated" and dispatches it via the
`run_pipeline` MCP tool.

The product has exactly one shape in its terminal state:

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Code (terminal)                    │
│                                                              │
│  User: "use tech-research pipeline to study solana perp dex" │
│    │                                                         │
│    ▼                                                         │
│  Main Claude agent ──────────────────────┐                   │
│    │                                     │                   │
│    │ MCP: run_pipeline(                  │                   │
│    │   name='tech-research',             │                   │
│    │   task='solana perp dex',           │                   │
│    │   policy=<execution policy>)        │                   │
│    │                                     │                   │
│    │                                     ▼                   │
│    │        ┌────────────────────────────────────────┐       │
│    │        │  workflow-control MCP server           │       │
│    │        │  (independent local process)           │       │
│    │        │                                        │       │
│    │        │  - kernel-next core                    │       │
│    │        │  - XState task machine per run         │       │
│    │        │  - Agent stages use Claude SDK         │       │
│    │        │    (spawns independent sessions)       │       │
│    │        │  - Port lineage + sidecar records      │       │
│    │        │  - Gate queue (answerer decided at     │       │
│    │        │    runtime — main Claude / human)      │       │
│    │        └────────────────────────────────────────┘       │
│    │                    │                                    │
│    │    taskId, initial status                               │
│    ◄────────────────────┘                                    │
│    │                                                         │
│    │ Poll loop (get_task_status every N seconds)             │
│    │   - completed / failed → collect result                 │
│    │   - gated              → inspect question; either       │
│    │                           answer directly via MCP       │
│    │                           or relay to user              │
│    │                                                         │
│    ▼                                                         │
│  User: (reads final result through Claude)                   │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 What workflow-control is not

- **Not a multi-user platform.** No auth, no tenant isolation, no
  RBAC. A user runs their own server on their own laptop. If three
  developers use it, that means three independent installs.
- **Not a general-purpose orchestrator.** Its scope is AI agent
  workflows — specifically Claude-authored, Claude-executed, with
  gate-based human and main-agent review.
- **Not a hosted service.** No cloud deployment, no CI integration
  beyond local git.
- **Not a Claude Code competitor.** It is a *complement*: Claude Code
  handles short, interactive, single-session tasks; workflow-control
  handles the opposite.

### 1.3 The three non-negotiables

Locked in round 1 of the interview:

1. **Local single-user.** Never revisited. No design that requires
   "but if multiple users…" is valid.
2. **Zero historical compatibility debt.** The legacy kernel exists
   only as a control group. When kernel-next surpasses it, it is
   deleted outright — no migration of old tasks.
3. **"Architecture passed" is my (the architect's) judgement call with
   evidence.** Not a checkbox, not "tests green", not "one pipeline
   works". Evidence-backed argument that every decision is defensible.

---

## 2. Kernel boundary

### 2.1 What kernel owns

The **kernel** is the set of concerns that *must* be centralised to
preserve correctness invariants:

1. IR storage, validation, versioning (content hash)
2. Task lifecycle state machine (XState)
3. Agent execution state machine (AgentMachine — §4)
4. Port value flow and lineage (port_values, stage_attempts)
5. Gate queue (stage paused, waiting for answer)
6. Hot-update migration semantics
7. MCP surface registration (tool dispatch, authentication of
   internal vs external callers — §9)

### 2.2 What userland owns

Userland is everything delivered via the kernel but not *part* of the
kernel. Examples:

- **Pipeline IR authoring** (done by pipeline-generator, which is
  itself an AI-driven task running on workflow-control)
- **Prompt assembly logic** (fragment injection, invariants, output
  shape instructions). See §2.3.
- **Per-pipeline fragment library** (live in registry — §2.4)
- **Executor sidecar records** (each executor type chooses what to
  record beyond kernel's minimum)

The kernel exposes **interfaces** that userland implements. For
example, the "prompt assembly" interface is: kernel hands userland a
stage + context, userland returns an assembled string; kernel does
not inspect the output.

### 2.3 The prompt assembly interface

Legacy kernel has a **six-layer prompt architecture** (global
constraints / project rules / stage prompt / fragments / capability
discovery / output schema). In terminal design, this is **not
kernel's concern**.

Decision (Q2.3 → c): **kernel defines the interface, userland
implements the layers.**

```
kernel                                 userland
──────                                 ────────
execute_agent_stage(stage, context)
  │
  │ calls promptAssembler.assemble(
  │   stage, context, env, attemptId)
  │
  │                                    assembler looks up fragments,
  │                                    merges invariants, appends
  │                                    output schema, returns string
  │
  ◄─────────── assembled prompt ───────
  │
  │ passes prompt to SDK.query()
  ▼
```

**Consequence**: different generators / different eras / different
developers can swap in different prompt assemblers without kernel
changes. The kernel only enforces "one `string` comes back".

### 2.4 The registry (edge-case, not core)

Decision (Q2.4): registry is preserved but **peripheral**. It holds
reusable pipelines, fragments, skills for cross-session reuse — but
in single-user context with zero compatibility debt, the main value
is "I wrote this pipeline last month, I want to find it again".

It is **not** critical path. If it were deleted, kernel would still
work — the author would simply paste pipeline IRs into their Claude
Code conversation directly.

**Registry is explicitly deferred to post-terminal-architecture
phase.** Current work focuses on kernel itself.

### 2.5 Session model

Decision (Q2.5): **multi-session default; single-session kept as a
path if proven simpler.**

In terminal design:
- Each **agent stage** starts its own SDK session. Sessions are
  isolated; no conversation history across stages.
- Cross-stage information flow happens **only through typed ports**.
- The legacy kernel's single-session mode (with PreCompact hooks,
  tier1 re-injection, etc.) is **not ported** unless evidence shows
  multi-session materially underperforms.

**Rationale**: P1 / A experiments (both on multi-session) achieved
10/10 and 9/10 respectively. Single-session is a complexity multiplier
that has not been demonstrated to be worth the cost on this
architecture.

---

## 3. Stage primitives (the compressed set)

### 3.1 Rejection of the legacy seven

Legacy kernel has 7 stage types: agent, script, human_confirm,
condition, llm_decision, pipeline, foreach.

Decision (Q2.2 → d): **do not copy this inventory.** Redesign the
abstraction from scratch.

### 3.2 The terminal three

Terminal kernel-next has **three stage primitives**:

| Primitive | Purpose | Runs what |
|-----------|---------|-----------|
| `agent`   | LLM-driven work | Claude SDK session |
| `script`  | Deterministic work, no LLM | TypeScript function |
| `gate`    | Pause, wait for answer | No compute; parked on answer queue |

That's the full inventory. The legacy 7→3 collapse happens as:

- `agent` → kept. The core primitive.
- `script` → kept. Deterministic work is a different shape of
  computation (git commands, build gates, file I/O) and does not
  benefit from being wrapped in an LLM call. Keeping script avoids
  silly overhead like "start a Claude session just to run `git
  commit`".
- `human_confirm` + `llm_decision` → merged into `gate`. Both are
  "pause, pose question, route based on answer"; the only difference
  is who answers, which is a **runtime decision** (§3.3).
- `condition` → removed from stage primitives; becomes a **wire-level
  guard** (§6.2).
- `pipeline` → removed as a stage primitive; use agent stage that
  calls `run_pipeline` MCP recursively (§3.4).
- `foreach` → not a stage type; becomes a **stage config flag**
  `fanout` (§6.3).

### 3.3 Gate: answerer is a runtime concept, not an IR concept

Critical correction from the interview: **gate type is NOT declared
in IR**. The IR only declares "this is a gate, the question payload
is X, the allowed answers are Y". Who answers is decided at the
moment the gate activates.

Gate lifecycle:

```
  stage reaches gate
    │
    ▼
  gate record inserted into gate queue (§8.1):
    - gateId, taskId, stageName, attemptId
    - questionJson: { text, options? }
    - createdAt
    (answer + answeredAt populated when answer_gate is called)
    │
    ▼
  kernel exposes via get_task_status → 'gated'
    │
    ▼
  The main Claude Code poll-loops this.
  When it sees a gate:
    - Is the question machine-answerable?
       → main Claude decides (AI may answer directly via answer_gate MCP)
    - Is it something I shouldn't decide?
       → main Claude relays to the user; user answers via Claude
         Code (which calls answer_gate) OR via web UI / curl.
    │
    ▼
  answer_gate(gateId, answer) posted
    │
    ▼
  kernel routes based on answer (explicit routing declared in IR:
  "if answer == X, wire to stage Y")
```

**Consequences for IR**: the only gate attributes that appear in IR
are:
- The question content (text / options list)
- The routing table (which answer leads to which next stage)

Nothing in IR declares "this gate is for AI" vs "this gate is for
human".

### 3.4 Pipeline calls via recursion

A stage that runs a sub-pipeline is just an **agent stage** whose
prompt (identified by `promptRef`) instructs the agent to call
`run_pipeline` MCP with the appropriate inputs:

```typescript
const researchRound1: AgentStage = {
  name: 'research_round_1',
  type: 'agent',
  inputs:  [{ name: 'topic', type: 'string' }],
  outputs: [{ name: 'summary_of_findings', type: 'string' }],
  config: {
    promptRef: 'sub-pipeline-literature-search',
    // The referenced prompt tells the agent:
    //   "Call run_pipeline MCP with name='literature-search',
    //    task=<the topic>, await, then write_port summary_of_findings."
  },
};
```

This matches how main Claude Code calls workflow-control in the first
place. The recursion is unbounded in principle (sub-pipelines may
call sub-sub-pipelines); kernel does not track pipeline depth —
budget / time-limit enforcement at the policy layer (§5.2) handles
runaway recursion.

---

## 4. AgentMachine (turn-level XState)

### 4.1 Decision: Option B, validated by experiment

During the interview, four options for agent execution were
considered (A keep black box, B turn-level XState, C black box +
event boundaries, D sub-pipeline nesting). Option B was initially
feared to cost 5-8 weeks.

Before committing, an empirical probe
(`docs/kernel-next-phase2-b-feasibility.md`) ran two scenarios × two
runs × the real Claude Agent SDK, dumping every message verbatim.
Findings:

- SDK message stream is extremely regular (4/4 runs followed an
  identical template)
- Tool calls are strictly serial (one tool_use → one tool_result
  per turn; no parallel dispatch)
- Zero unmapped messages
- Revised effort: **~2 weeks**, not 5-8

**Decision confirmed: Option B.**

### 4.2 State machine

```
    ┌──────────┐   system/init         ┌─────────────────────┐
    │ starting │──────────────────────▶│ waiting_for_claude  │
    └──────────┘                       └──────┬──────────────┘
                                              │
        ┌─── assistant/thinking|text ─────────┤ (no transition)
        │    rate_limit_event                 │ (telemetry)
        │                                     │
        ├─ system/compact_boundary            │
        │          │                          │
        │          ▼                          │
        │    ┌────────────┐                   │
        │    │ compacting │                   │
        │    └────┬───────┘                   │
        │         │                           │
        │         └──► back to waiting_for_claude
        │                                     │
        │                   assistant/tool_use│
        │                                     │
        │                                     ▼
        │                          ┌──────────────────┐
        │                          │ dispatching_tool │
        │                          └──────┬───────────┘
        │                                 │
        │                  user/tool_result│
        │                                 │
        └─────────────────────────────────┘ (back to waiting_for_claude)

                                         │
                          result/success │  result/error_*
                                         ▼
                              ┌─────────────┐
                              │ done | error│
                              └─────────────┘
```

Six states. Ten events. Each SDK message maps to exactly one
transition or one no-op. The tenth event, `INTERRUPT`, is
kernel-originated and is handled as follows:

- **From `waiting_for_claude`**: next assistant turn becomes the
  "summary turn" — Claude gets one more opportunity to produce output
  before the machine finalises. The **final status reflects that
  turn's actual outcome**, not the fact that an INTERRUPT was
  received:
  - Summary turn completes with `RESULT_SUCCESS` → `{ status: 'done' }`
    (the port writes are legitimate; the fact that we were asked to
    stop does not invalidate them).
  - Summary turn produces `RESULT_ERROR` or the short timeout expires
    before completion → `{ status: 'interrupted' }` with
    `interruptedFrom: 'waiting_for_claude'` in the diagnostic so the
    caller can distinguish "stopped cleanly on request" from a
    spontaneous error.
  - AgentMachine context retains `interruptArmed: true` across the
    summary turn, so sidecar audit rows can always tell whether an
    INTERRUPT was the trigger even when final status is `'done'`.
- **From `dispatching_tool` / `compacting`**: the current SDK activity
  is allowed to complete (we don't abort mid-tool-call), then the
  INTERRUPT is processed on return to `waiting_for_claude`. Same
  final-status rules apply.
- **From `starting`**: machine transitions directly to `done` with
  result `{ status: 'interrupted' }` without executing any turn — no
  summary turn is possible because the SDK hasn't been engaged.

Full event set: `SDK_INIT`, `ASSISTANT_TEXT` (no-op), `TOOL_USE_REQUESTED`,
`TOOL_RESULT_RECEIVED`, `COMPACT_STARTED`, `COMPACT_ENDED`,
`RATE_LIMIT_SIGNAL` (no-op), `RESULT_SUCCESS`, `RESULT_ERROR`,
`INTERRUPT`.

### 4.3 Why this is the right granularity

- **Turn-level replay** becomes possible: snapshot → rewind to
  "before turn N" → re-execute with same inputs, different randomness
- **Precise graceful interrupt**: when kernel-level hot-update needs
  to stop an agent stage, it sends an `INTERRUPT` event on the
  `waiting_for_claude` state. The agent gets one more turn to write a
  summary; AgentMachine then transitions to `done`. Final status is
  `'done'` if the summary turn produced RESULT_SUCCESS, `'interrupted'`
  otherwise — see §4.2 for the full matrix. Either way the
  `interruptArmed` flag stays in sidecar audit so the caller can
  distinguish "ran to completion" from "ran to completion because we
  asked it to"
- **Debug via XState visualiser**: agent execution is inspectable
  with the same tools as the pipeline-level machine

### 4.4 SDK adapter

The adapter is a thin layer that translates `AsyncIterable<SDKMessage>`
into XState events. See `docs/kernel-next-phase2-b-feasibility.md` for
the exact mapping table. The adapter is the **most fragile** component
of AgentMachine: Claude Agent SDK version upgrades may introduce new
message types. Mitigation:

- Unknown message types → logged to sidecar, emit `UNKNOWN_MESSAGE`
  event (doesn't fault)
- SDK major version bumps trigger adapter re-review as part of
  dependency update

### 4.5 Nesting under TaskMachine

Pipeline-level TaskMachine treats each agent stage as an invoked
child actor. The child (AgentMachine) runs until it reaches its
`done` or `error` final state; the parent machine then advances.

```
TaskMachine (stage: agent_stage_N)
  │ state: executing
  │   invoke: AgentMachine (src: 'agentActor',
  │                         input: { stage, attemptId, inputs })
  │   onDone: → next stage (port writes already persisted by AgentMachine
  │                         via internal MCP write_port)
  │   onError: → handle retry / abort
  ▼
```

**Output contract**: AgentMachine does **not** return port values as
XState actor output. Ports are persisted via `write_port` MCP calls
during `dispatching_tool` transitions; the kernel's lineage store is
the source of truth. AgentMachine's final state output is minimal:
`{ status: 'done' | 'interrupted' | 'error', diagnostic? }`.

TaskMachine's `onDone` reads port_values for the just-completed
attempt from kernel storage, fires `PORT_WRITTEN` events for
downstream stages' ready-checks, and advances.

---

## 5. IR and execution policy (two layers)

### 5.1 Decision rationale

Q4.3 asked: do budget / retry / permission / fragments live in IR?
Answer: **no**. They live in a separate `ExecutionPolicy` object that
is supplied alongside IR at task creation time.

Rationale: same IR can be exercised in dev (small budgets, tolerant
retry) and production (larger budgets, strict) without branching the
IR itself. Separation of **structure** from **runtime discipline**.

### 5.2 Layer 1: IR (structure)

```typescript
interface PipelineIR {
  name: string;                            // stable identity
  description?: string;
  stages: StageIR[];
  wires: WireIR[];
}

// StageIR is a discriminated union keyed by `type`. The type
// determines which config shape applies — no separate `config.kind`
// discriminator.
type StageIR =
  | AgentStage
  | ScriptStage
  | GateStage;

interface StageCommon {
  name: string;
  inputs: PortIR[];
  outputs: PortIR[];
}

interface AgentStage extends StageCommon {
  type: 'agent';
  config: { promptRef: string };
  fanout?: FanoutSpec;                     // §6.3 — agent supports fanout
}

interface ScriptStage extends StageCommon {
  type: 'script';
  config: { moduleId: string };
  fanout?: FanoutSpec;                     // §6.3 — script supports fanout
}

interface GateStage extends StageCommon {
  type: 'gate';
  config: { question: GateQuestion; routing: GateRouting };
  // gates cannot fanout; validator rejects it.
}

interface GateQuestion {
  text: string;
  options?: string[];                      // optional pre-defined answers
}

interface GateRouting {
  // answer value → target stage name.
  // special key '_default' for answers not in `routes`.
  routes: Record<string, string>;
}

interface PortIR {
  name: string;
  type: string;                            // TypeScript type literal
  zod?: string;                            // optional runtime shape
}

interface WireIR {
  from: { stage: string; port: string };
  to:   { stage: string; port: string };
  guard?: string;                          // §6.2 expression
}

interface FanoutSpec {
  input: string;                           // input port name to iterate
}
```

### 5.3 Layer 2: ExecutionPolicy (runtime discipline)

```typescript
interface ExecutionPolicy {
  perStage: Record<string, StagePolicy>;   // per stage overrides
  default: StagePolicy;                    // fallback for stages not listed
}

interface StagePolicy {
  budget?: {
    maxCostUsd?: number;
    maxTurns?: number;
    timeoutSeconds?: number;
  };
  retry?: {
    maxAttempts?: number;                  // default 1
    onError?: 'fail_task' | 'gate';        // default fail_task
  };
  permission?: {
    allowedTools?: string[];               // restrict MCP tool surface
    disallowedTools?: string[];
  };
  // Prompt assembly configuration — userland-specific
  promptAssembly?: Record<string, unknown>;
}
```

Task creation signature:

```typescript
run_pipeline({
  name: 'tech-research',                     // resolves to IR version hash
  task: 'solana perp dex',                   // becomes entry-stage input
  policy?: ExecutionPolicy,                  // optional; merged with defaults
}): {
  taskId: string;
  pipelineVersionHash: string;
  status: 'running';                         // always running at creation
  createdAt: number;                         // unix ms
}
```

Caller then polls `get_task_status(taskId)` which returns:

```typescript
{
  taskId: string;
  status: 'running' | 'gated' | 'completed' | 'failed'
        | 'migrating' | 'blocked' | 'cancelled';
  currentStages: string[];                   // stages presently executing
  gates?: Array<{ gateId, stageName, question }>;  // when status='gated'
  result?: unknown;                          // when completed
  error?: { code, message };                 // when failed
}
```

### 5.4 Why this split matters

- The **same pipeline IR** can have multiple active `ExecutionPolicy`
  profiles (dev, prod, fast, careful).
- **Hot-update only ever changes IR**; policy changes are per-task
  at invocation time. This is a clean separation that reduces the
  surface of "what can migrate".
- Serialisation clarity: IR goes into content hash (version_hash);
  policy does not (each task snapshot captures its policy separately).

---

## 6. Wires, gates, and fanout

### 6.1 Wires are the DAG

Wires connect ports: `from.stage.from.port → to.stage.to.port`. Each
wire is a **typed 1-to-1 data flow edge**. The collection of wires
forms a DAG (enforced at validation time).

### 6.2 Wire guards (absorbing the former `condition` stage)

A wire may carry a `guard` — an expression evaluated at runtime
against the source port value. The downstream stage activates only
for wires whose guard is true.

```
wire: {
  from: { stage: 'analysis', port: 'result' },
  to:   { stage: 'deep_dive', port: 'input' },
  guard: 'value.complexity > 8'
}
```

This subsumes `condition` stages. Kernel-next has no condition
primitive.

**Guards do not short-circuit**: all source ports fire; the guard
decides whether the wire **delivers** to the downstream.

**Guard exhaustiveness is the AI author's responsibility.** When a
downstream stage has multiple inbound wires, the AI must ensure at
least one wire's guard evaluates to `true` on every reachable runtime
state. If at runtime all inbound wires' guards are `false`, the
kernel **fails the task immediately** with error code
`NO_ACTIVE_WIRE`, including the stage name, all inbound wires, and
the port values that made each guard false. This is a pipeline bug,
not a deadlock condition — the AI receives the diagnostic and may
propose a fix (add a fallback wire, adjust a guard, etc.).

Rationale: silently skipping a stage creates the illusion of success
while doing nothing; waiting for rescue hides the bug behind a
timeout. Failing fast surfaces the design error to the only entity
that can fix it (the pipeline author).

### 6.3 Fanout (absorbing the former `foreach` stage)

A stage config flag — not a separate type. Decision Q4.1(7) → β.

```
stage: {
  name: 'process_each_candidate',
  type: 'agent',
  fanout: { input: 'candidates' },
  inputs: [{ name: 'candidate', type: 'Candidate' }],
  outputs: [{ name: 'result', type: 'ProcessedCandidate' }],
  config: { kind: 'agent', promptRef: 'process_candidate' }
}

wire: {
  from: { stage: 'gather', port: 'candidates' },   // type: Candidate[]
  to:   { stage: 'process_each_candidate',
          port: 'candidate' }                      // type: Candidate
}
```

Kernel observes `fanout.input` on the stage, reads the source port
as an array, and instantiates **N virtual stage instances** — each
with its own `attemptId`, independent `port_values`, parallelisable.
The stage's output port is automatically reshaped from `Result` to
`Result[]` when read by downstream.

Concurrency / worktree isolation is kernel's responsibility.

**Why flag, not wire-level fan-out**: separating "what the stage
consumes" (single element) from "how many instances run" (array
length) reduces wire semantic complexity. The wire still carries the
array; the stage declares it wants per-element instantiation.

**Applies to both `agent` and `script` stages.** An agent stage with
`fanout` spawns N parallel AgentMachine instances, each with its own
SDK session. A script stage with `fanout` calls the underlying
TypeScript module N times, in a worker pool. `gate` stages cannot
have `fanout` — a gate is a single pause point, not a fan-out
construct; validator rejects `fanout` on `type: 'gate'`.

### 6.4 Fanout collect_to

By default, fanout outputs are collected into an array in the same
order as inputs (stable). The downstream stage sees `Result[]`.
Explicit alternatives (map, reduce) are userland's concern —
implement as a follow-up stage reading the array.

---

## 7. Typed Port discipline

### 7.1 Type system: TS type text + object field names

Decision (Q4.4): **TS type text**, no semantic type system.

```
port.type = "string"                      — ok
port.type = "{ url: string }"             — ok, url semantic via field name
port.type = "{ items: Array<Candidate> }" — ok, nested structured

port.type = "URL"                          — NOT ok (no semantic type dict)
port.type = "string & { __brand: 'URL' }"  — NOT ok (adds ceremony, no value)
port.type = "any"                          — NOT ok (banned)
```

**Convention**: prefer object types whose field names carry
semantics. A `url` goes in `{ url: string }`, not in `string`
directly. Claude writes IRs that respect this convention (validated
in Phase 2 A: 10/10 on clean IR authoring without being told).

### 7.2 Optional runtime shape (zod)

`port.zod` remains optional. Specify it when:
- Port is consumed by a script stage that would crash on unexpected
  shapes
- Port carries external data that must be validated

Do not require zod for every object port; this is an anti-pattern.

### 7.3 Wire type compatibility

Compatibility is checked by **codegen + tsc**: each wire becomes a
dummy assignment in generated TS; tsc verifies `from` type is
assignable to `to` type. This catches structural mismatches.

Fanout wires have a special compatibility rule: `from.type == T[]`
and `to.type == T` are compatible (codegen wraps the assignment).

---

## 8. Lineage + sidecar execution record

### 8.1 Two-layer model

Decision (Q2.6 → option 3): **kernel maintains lineage; executors
optionally maintain sidecar records.**

```
KERNEL-OWNED (mandatory, shared across all executors)
┌─────────────────────────────────────────────────┐
│  stage_attempts                                 │
│    attempt_id, task_id, version_hash,           │
│    stage_name, attempt_idx, started_at,         │
│    ended_at, status                             │
│  port_values                                    │
│    value_id, attempt_id, stage_name,            │
│    port_name, direction, value_json, written_at │
│  gate_queue                                     │
│    gate_id, task_id, stage_name, attempt_id,    │
│    question_json, created_at,                   │
│    answer, answered_at                          │
└─────────────────────────────────────────────────┘

EXECUTOR-OWNED (per-type sidecar tables)
┌─────────────────────────────────────────────────┐
│  claude_execution_details                       │
│    attempt_id (FK), prompt_blob,                │
│    tool_calls (JSONL), agent_stream (JSONL),    │
│    cost_usd, token_input, token_output,         │
│    model, session_id, scratch_pad_snapshot      │
│  script_execution_details                       │
│    attempt_id (FK), stdout, stderr,             │
│    exit_code, duration_ms                       │
└─────────────────────────────────────────────────┘
```

### 8.2 Why this split

- **Kernel is executor-agnostic**: adding a new executor type (future
  Gemini, Codex, local model) requires no kernel schema change.
- **Debugging is stratified**: lineage queries are fast and
  lightweight; deep debugging drops down to sidecar when needed.
- **Storage proportional to need**: tests and simple scripts don't
  need rich records; agent stages do.

### 8.3 Write discipline

- **Lineage is always written** synchronously at stage boundaries
  (attempt start, port write, attempt end). It is part of
  kernel-level correctness.
- **Sidecar is best-effort**: written incrementally during execution
  by the executor. A crashed executor may leave a sidecar row
  incomplete; queries must tolerate this.

---

## 9. MCP surface (internal vs external)

### 9.1 Two physically separate surfaces

Decision (Q2.7a → c): **separate the external and internal MCP
servers**.

```
┌────────────────────────────────────────────────────────┐
│  EXTERNAL MCP surface                                  │
│  Consumers: main Claude Code, pipeline-generator AI,   │
│             debug tools                                │
│                                                        │
│  Tools:                                                │
│   - submit_pipeline                                    │
│   - validate_pipeline                                  │
│   - propose_pipeline_change                            │
│   - list_proposals                                     │
│   - approve_proposal / reject_proposal                 │
│   - rollback_pipeline                                  │
│   - run_pipeline       ← main entry point              │
│   - get_task_status                                    │
│   - answer_gate                                        │
│   - cancel_task                                        │
│   - read_port                                          │
│   - query_lineage                                      │
│   - diff_runs                                          │
│                                                        │
│  Does NOT include: write_port                          │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│  INTERNAL MCP surface                                  │
│  Consumers: kernel's own executors                     │
│  Transport: in-process, NOT exposed over network       │
│                                                        │
│  Tools:                                                │
│   - write_port    ← only for executors, attempt-scoped │
│   - report_side_state  (sidecar writes)                │
└────────────────────────────────────────────────────────┘
```

### 9.2 Why physical separation

- **Correctness by design**: any AI with MCP access to the external
  surface cannot emit `write_port`, so cannot inject port values
  into running tasks.
- **Clear API contract**: the README of kernel-next can say "here is
  what you call us with", and all tools there are safe for AI
  authorship. The internal surface is an implementation detail.
- **Easier reasoning**: when debugging "who wrote this port?", the
  answer is always "the executor of the stage that declared it" —
  no back-doors.

### 9.3 REST bridge for web UI

Debug tools (diff / lineage / approve) also exposed via REST at
`/api/kernel/*`. Same underlying KernelService methods. REST is for
the optional web dashboard (§10); MCP is for AI consumers.

---

## 10. Hot-update / migration (B-series semantics)

### 10.1 Trigger: opt-in per task

Decision (Q5 → B6): **approve does NOT migrate running tasks by
default.** `propose_pipeline_change` takes an optional
`migrateRunningTasks: 'all' | 'none' | [taskId...]` argument; default
is `none`. `approve_proposal` consults this list and only migrates
the specified tasks.

### 10.2 Migration is serial per task

Decision (Q5): **a task can be migrated to at most one new version
at a time.** If a second approved proposal names the same task while
migration is in progress, it waits; if the wait exceeds a timeout,
it fails with `MIGRATION_IN_PROGRESS`.

### 10.3 Optimistic lock on propose

Decision (Q5 → B14): **propose requires `currentVersion` to match
the latest version of the pipeline.** If another proposal was
approved in between, the second propose fails with
`CONFLICT_REBASE_REQUIRED`. The AI (or human) must rebase on the
new latest version.

### 10.4 No auto-approve in kernel

Decision (Q5 → c): **kernel does not classify "safe range" patches
for auto-approve.** Main Claude Code looks at `list_proposals` output
and diff, decides whether to approve directly or relay to human.
Safe-range judgement becomes the main Claude's responsibility, not
kernel's.

### 10.5 In-flight migration semantics

When `migrateRunningTasks` includes a running task:

**Step 1 — determine the rerun boundary.**
Decision (Q5 → explicit): **the propose call carries
`rerunFrom: stageName | null`.** The AI inspects the patch and
declares which stage to rewind to. `null` means "apply to any future
stage only; do not rewind".

**Step 2 — graceful interrupt of currently executing stage.**
Decision (Q5 → B10): **graceful interrupt.** The kernel sends
AgentMachine an `INTERRUPT` event; AgentMachine allows one more turn
for the agent to write a summary into scratchpad / sidecar, then
transitions to `done`. The final status follows §4.2:
RESULT_SUCCESS → `'done'` (the summary turn produced a clean result;
port writes are legitimate and the stage is considered complete),
timeout / RESULT_ERROR → `'interrupted'`. In both cases
`interruptArmed` stays recorded so the migration audit can tell that
this stage was stopped on request. This typically costs 10-60 seconds.

Hard interrupt (no summary turn) is not exposed as an option in
terminal design. Emergency termination uses `cancel_task`, not
migration.

**Step 3 — parallel group fine-grained migration.**
Decision (Q5 → B13): **fine-grained.** If a patch only affects one
child of a parallel group, only that child is interrupted. Siblings
continue. Group-level aggregation waits until all siblings
(including the re-run child on the new version) complete.

For the concrete case of "5 children: 2 done, 2 running, 1 unstarted,
patch affects 1 running child":

- **Already-completed children**: their output port_values remain
  valid *if and only if* the patched child does not break their type
  contracts. Kernel re-runs `tsc` wire compatibility for the new
  version — if the completed children's outputs still flow correctly
  into downstream stages, nothing changes for them. If the patch
  broke their contracts, those children must also be re-run, which
  escalates the migration to a wider scope and requires the AI's
  `rerunFrom` to include them explicitly.
- **Running children (not the patched one)**: continue on the old
  version. They complete, their outputs are valid.
- **Unstarted children**: run on the **new version** if they are
  affected by the patch (kernel diffs the patched IR vs base and
  determines per-stage version binding); otherwise on the old version.
  In practice, most patches to a single child don't touch siblings'
  stage definitions, so unstarted siblings keep the old definition.
- **The patched child**: interrupted (graceful), then re-run on the
  new version.

Group aggregation waits for all children to complete — regardless of
which version they ran on.

**Step 4 — worktree reset.**
Decision (Q5 → B9): **git reset to the checkpoint of the last
unchanged stage.** The post-rewind diff (from the interrupted stages)
is written to the sidecar as "prior attempt on old version" — the
new-version stage may read it as context.

**Step 5 — execute new IR from `rerunFrom`.**
Kernel starts the new attempt on the new version hash. Lineage rows
reference the new version; old version's rows remain intact as
historical record.

### 10.6 Migration failure handling

Decision (Q5 → conservative): **if migration fails mid-way, roll
back to pre-migration state and mark task as `blocked`.** A human or
main Claude decides next step. `migrating → blocked` is an explicit
terminal state; it is not retried automatically.

### 10.7 Rollback is a reverse migration

Decision (Q5 → a): **rollback uses the same mechanism as migration.**
`rollback_pipeline(taskId, toVersion)` is essentially
`approve_proposal` targeting an older version. All rules above apply
(rerun boundary, graceful interrupt, worktree reset).

### 10.8 hot_update_events audit

All migrations — forward and rollback — append to
`hot_update_events`:

```
hot_update_events
  event_id, task_id,
  from_version, to_version,
  actor,                                   -- 'ai:main-claude' | 'human:<user>'
  trigger_propose_id,                      -- FK to pipeline_proposals
  rerun_from_stage,
  status,                                  -- 'success' | 'failed' | 'rolled_back'
  started_at, finished_at,
  diagnostic_json                          -- for failures
```

This table supports both debugging ("what changed when?") and
meta-analysis ("which pipelines get revised frequently — likely
design issues").

---

## 11. Acceptance

### 11.1 What "done" means

Per the product owner's directive (round 1): **completion is my
judgement, with explicit evidence.**

For **architecture design** (this document): done when it accepts
review by the product owner. That is this document's purpose.

For **architecture implementation** (subsequent phases): done when
all of the following are true:

| # | Criterion | Evidence |
|---|-----------|----------|
| A1 | Every stage primitive in §3.2 has a working executor | runnable end-to-end tests |
| A2 | AgentMachine (§4) compiled and behaving per §4.2: passes the happy-path template observed in the probe, plus type-defined edge cases (`compact_boundary`, `result/error_*` subtypes, INTERRUPT from every state) | dedicated test suite covering each transition |
| A3 | Wire guards (§6.2) and fanout (§6.3) working in isolation and composition | tests covering each primitive + at least one pipeline that uses all of them |
| A4 | Gate lifecycle (§3.3) fully closed: gate record, get_task_status report, answer_gate routing | integration test: pipeline pauses at gate, main-Claude-simulating test answers, pipeline continues |
| A5 | Lineage queries (§8) return correct data across parallel + fanout | scenario tests with known inputs/outputs |
| A6 | External MCP surface (§9.1) cannot invoke internal tools | negative test: write_port via external surface fails |
| A7 | One non-trivial real pipeline runs end-to-end on kernel-next | **tech-research** or equivalent (one of the three preserved builtins per roadmap §4) |
| A8 | Hot-update happy path (§10.5 step 1-5) with forward migration works | dedicated test; at least one run with graceful interrupt |
| A9 | No regressions in current test suite (3844 tests passing as of this session) | CI clean |

### 11.2 Non-negotiable principles (checklist)

These hold at every step:

- Kernel is executor-agnostic. Adding a new executor type cannot
  require kernel schema changes (§8).
- IR cannot encode policy (§5). If a feature seems to require
  budget-in-IR, it is wrong.
- All MCP surface claims (write_port internal, others external) are
  physical separations, not access-control layers (§9).
- Lineage is synchronous and mandatory; sidecar is async and
  best-effort (§8.3).
- Hot-update never silently migrates: opt-in only (§10.1).
- No mutable global state outside the kernel's DB.
- Zero legacy compatibility. Deletion, not migration.

### 11.3 Known deferred items

Not part of terminal design; acknowledged and parked:

- **Registry UI and cross-user sharing** — mentioned as edge-case in
  §2.4. Will revisit after terminal is stable.
- **Web dashboard feature set** — secondary to CLI / MCP per §1. May
  remain at current P2 simplicity.
- **Automated pipeline quality assurance** — "is this pipeline well
  formed beyond validation" is a userland / pipeline-generator
  concern, not kernel.
- **Multiple concurrent in-flight task migrations across different
  tasks** — kernel supports this (only per-task serial constraint
  applies), but we have not stress-tested across many tasks.

---

## Appendix A — Legacy to terminal mapping

| Legacy kernel construct | Terminal equivalent | Notes |
|-------------------------|---------------------|-------|
| `agent` stage | `agent` stage | Kept, now has AgentMachine |
| `script` stage | `script` stage | Kept |
| `human_confirm` stage | `gate` stage + runtime answerer | IR doesn't know answerer type |
| `llm_decision` stage | `gate` stage answered by an AI | Same mechanism as above |
| `condition` stage | wire guard (§6.2) | No longer a stage type |
| `pipeline` stage | `agent` stage calling `run_pipeline` MCP | Recursive architecture |
| `foreach` stage | `agent` or `script` stage with `fanout` flag | Kernel handles iteration |
| `parallel` group | native via wires fanning from source to multiple sinks | No special IR primitive |
| single-session mode | default multi-session; single available if shown needed | §2.5 |
| `outputFormat: json_schema` | MCP tool-call only (write_port) | P1 finding |
| `reads/writes` store strings | typed ports | §7 |
| Store as blackboard | port lineage | §8 |
| SSE as observability | lineage query + REST + optional SSE | §9 |
| `PreCompact` hook | AgentMachine's `compacting` state | §4 |
| `outputs` schema field | part of StageConfig (kind: 'agent') | §5 |
| Fragment system | userland-defined prompt assembly interface | §2.3 |
| YAML DSL | IR (JSON or typescript literal) | YAML is a user-facing format; IR is canonical. Converter deleted 2026-04-24. |
| Budget / max_turns on stage | `ExecutionPolicy` layer | §5 |
| Edge Runner | **removed** | Not in terminal. Deleted 2026-04-24 (Stage 4a). |
| Gemini / Codex engines | **removed from kernel** | Future `agent` subtypes possible, but not designed. Deleted 2026-04-24. |
| slack-cli-bridge | **removed** | Not in terminal |
| `retry.back_to` (QA feedback routing) | hot-update: a failed QA stage's AI proposes a patch that prepends a fix stage, then migrates with `rerunFrom=<the failed stage>` | §10 |
| Git `compensation` strategy | AgentMachine INTERRUPT + sidecar records prior diff; the replacement attempt reads the prior diff as context | §10.5 step 4 |

---

## Appendix B — Explicitly out of scope

These were considered and rejected:

- **Multi-user / multi-tenant** (Q1.1): "single-user local" is
  non-negotiable.
- **Cloud hosting** (Q1.1): same.
- **Dashboard as primary interface** (Q1.3): CLI / MCP / (optional)
  Web — dashboard is convenience, not core.
- **Semantic type system** (Q4.4): TS types + object field names
  carry enough semantics for Claude; semantic-type dictionary adds
  complexity without value.
- **Auto-approve safe-range patches in kernel** (Q5): kernel does
  not classify; main Claude Code decides.
- **Runtime generation of new stages** (Q4.2): achieved via
  hot-update migration; no dedicated `insert_stage_now` primitive.
- **Historical task migration** (§1.3): legacy kernel tasks are not
  ported. They will stop running when legacy kernel is deleted.
- **Backwards-compatible YAML schema evolution** (§1.3): no BC
  promises. IR is canonical; YAML is presentation.

---

## Appendix C — Open questions deferred to implementation

These are design nuances whose best answer needs empirical feedback
during build-out:

- **Fanout concurrency cap default**: ~~how many fanout instances run
  concurrently by default?~~ **Resolved 2026-04-24 (D5)**: default 3,
  ceiling 20, per-stage override via `FanoutSpec.concurrency`. See
  `runner-fanout.ts` worker-pool + `canonical.ts` for hash inclusion.
- **Gate timeout behaviour**: ~~what happens if a gate is never
  answered?~~ **Resolved 2026-04-24 (D6)**: opt-in via
  `GateStage.config.timeout_minutes`; periodic sweeper (60s) cancels
  the task with reason `gate_timeout: <stage> exceeded <N> minutes`.
  See `gate-timeout-sweeper.ts`.
- **Cross-stage store migration during hot-update**: when rerunFrom
  is early, some port_values may be rendered obsolete. Current answer
  is "leave them; new attempts write new rows". ~~This may need a
  cleanup primitive.~~ **Closed 2026-05-03**: re-evaluated against the
  shipped behaviour. Lineage queries always join `port_values` to a
  specific `attempt_id` (not just stage_name), so a superseded
  attempt's port rows are unreachable from the live query path —
  they don't pollute reads, only DB size. The existing
  `prune-kernel-records` CLI handles bulk deletion when DB size
  matters. No primitive added; concrete pressure (a real query that
  surfaces stale rows, or a sustained DB-bloat report) re-opens this.
- **AgentMachine's `compacting` state not yet observed**:
  ~~handled in schema, but first implementation must test a long-
  context run to verify~~ **Resolved 2026-04-24 (Phase 4.5 T1)**:
  `agent_execution_details.compact_events_json` column added; SDK
  adapter emits `COMPACT_STARTED` / `COMPACT_ENDED` (via the synthetic
  end-event on next non-compact message); real-executor maps them
  into `writer.appendCompactEvent` / `completeCompactEvent`. Each
  event records `{ trigger, preTokens, startedAt, endedAt }`. Live
  observation across multi-segment runs in dogfood-3 (handoff-
  dogfood-2026-05-02) confirmed compact_events accumulating during
  the longer fanout stages.

---

**End of terminal design.**

This document is the reference for all implementation to follow. Any
change to these decisions requires an amendment with dated
reasoning, published here, before implementation.
