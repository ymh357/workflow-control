# Workflow Control — Technical Whitepaper

> Version 2.0 · 2026-05-03 · kernel-next era
>
> Supersedes `architecture-whitepaper.md` / `architecture-whitepaper-zh.md`
> (archived 2026-04-24 — those describe the retired legacy engine).
>
> **Chinese version**: [`whitepaper-zh.md`](./whitepaper-zh.md).
> **Visuals (mermaid)**: [`whitepaper-visuals.md`](./whitepaper-visuals.md)
> · [`whitepaper-visuals-zh.md`](./whitepaper-visuals-zh.md)

---

## Abstract

Workflow Control is a local, single-user workflow engine for running
AI coding agents on tasks too large for one CLI session. It exists in
the gap between **Claude Code** (which is excellent for one-shot
coding turns but loses state when a task takes hours) and
**Temporal/Airflow** (which are excellent at orchestrating
deterministic services but were never designed for LLM agents that
need feedback loops, hot-update of in-flight prompts, and human
approval gates mid-task).

The product's two non-negotiable invariants:

1. **Reproducibility under interruption.** A task that ran for 75
   minutes across 20 stages must survive `pkill node`, `tsx watch`
   restarting on a file edit, the user closing their laptop, the
   server crashing — without losing the work that already finished.
2. **Hot-updateable in flight.** When the user notices their pipeline
   is wrong at stage 17 of 25, they must be able to fix the prompt or
   add a verification stage *without restarting the task* and without
   losing the 16 completed stages.

This document explains *what* the system does, *why* its design
choices look the way they do, and *how* the kernel actually
implements both invariants.

---

## Part 1 — What

### 1.1 The product, in one paragraph

The user describes a multi-step AI task in natural language. An
internal `pipeline-generator` (itself a workflow) emits a typed
**Pipeline IR** with stages, ports, wires, and gates. The user (or
an automated runner) starts a **Task** against that Pipeline IR. The
kernel drives the task through its stages — running Claude SDK
sessions for `agent` stages, in-process scripts for `script` stages,
fanout loops for `fanout` stages, human-blocking gates for `gate`
stages — recording every attempt, every port write, every cost dollar
to a SQLite database. A web dashboard shows progress live; a CLI/MCP
surface lets other Claude instances drive the same kernel.

If the kernel restarts mid-task, **boot resumability** picks the task
up from its last persisted state. If the user wants to change the
pipeline mid-task, **hot-update** lets a `pipeline-modifier` propose
a patch, the user approves it, the kernel migrates the running task
to the new IR, and only the affected stages re-run.

### 1.2 What it is *not*

The roadmap is explicit about non-goals (CLAUDE.md "What this project
is not"):

| Not | Why |
|---|---|
| A multi-tenant SaaS | One user per server process. No auth. No tenant isolation. |
| A team scheduling / approval platform | Human gates exist for the individual user, not for cross-team review. |
| A general-purpose orchestrator | The DSL, executor model, and audit log are AI-agent-specific. Don't run cron jobs through it. |
| A Claude Code wrapper | The workflow engine is the product. Claude Code is one of several execution surfaces. |
| Multi-engine | As of 2026-04-24 only Claude is supported. Gemini/Codex were retired. |

These non-goals are **load-bearing**: they let the design ignore
authentication, network partitioning, multi-version DB migrations
across user fleets, and most operational complexity that
general-purpose orchestrators cannot avoid.

### 1.3 Surfaces

The same kernel is reachable from three independent surfaces:

| Surface | Used for |
|---|---|
| **HTTP REST + SSE** at `:3001` | Web dashboard, dogfood scripts, curl |
| **MCP over HTTP** at `:3001/api/mcp` | External Claude Code sessions, Cursor, Codex CLI |
| **CLI** (`pnpm tsx src/cli/...`) | Registry install/publish, prune-records |

All three call into the same `KernelService` + same SQLite database.
There's no separate "API tier" — surfaces are thin adapters over the
service layer.

---

## Part 2 — Why

### 2.1 Why a kernel at all?

Three real problems pushed this product out of the "just use Claude
Code" sweet spot:

#### Problem 1: Long tasks lose state

A real investigation task — "research ESM/CommonJS interop in Node 22
TypeScript monorepos and write a 10,000-word report" — ran for 75
minutes across 20 stages including 3 fanout loops with 30+ Claude
sessions total. In a Claude Code REPL the user has to:

- Manually keep track of which sub-task is in progress
- Re-prompt with the right context if Claude's session compacts
- Lose everything if their laptop sleeps or `tsc watch` restarts

A kernel that **owns the state** rather than holding it in a chat
buffer makes the task survive restarts. Every stage's output is
persisted to `port_values` keyed by `attempt_id`; resume queries the
DB, not memory.

#### Problem 2: Pipelines are wrong on first try

When Claude generates a pipeline for a novel investigation topic, the
first version is rarely correct. The user notices at stage 17 that
the framing axis was off, or that a verification step is missing, or
that the synthesis prompt is too generic. In a stateless system the
fix means starting over — losing the 16 stages of expensive work.

A kernel that supports **structured hot-update** (propose a patch,
review the diff, migrate running tasks) lets the user fix forward.
The roadmap (B-series, §7) is dedicated to this: B9 worktree reset,
B10 graceful summary turn, B17 fanout element preservation, etc. The
hot-update path **is** the product, not a feature.

#### Problem 3: One Claude session is too small

Even with cache, a single SDK conversation has a context budget.
Multi-stage pipelines split work into segments small enough for the
SDK to handle while preserving cross-segment state through `port_values`
+ optional `single-session` mode (which lets adjacent stages share a
session via SDK `options.resume`).

### 2.2 Why these specific design choices?

| Decision | Alternative considered | Why this won |
|---|---|---|
| **IR is canonical, not YAML** | YAML stays canonical | YAML changes in whitespace/key-order shouldn't shift `version_hash`; canonical IR + `pipelineVersionHash({ir, prompts})` solves it. (terminal-design §2) |
| **AI writes the IR, never the human** | Hand-written DSL | An expert pipeline author is rare. Pipeline-generator is itself a workflow; users describe the task in NL and get a validated IR. (CLAUDE.md "Who writes the YAML") |
| **kernel-next + XState v5** | Bespoke event loop | XState's parallel-region semantics map 1-1 onto independent stages; INTERRUPT propagation, retry-rebuild, gate-rejection are all native state-machine operations rather than ad-hoc flags. |
| **Lineage-preserve, not delete-and-rewrite** | Reset rows on retry | An attempt that ran 25 seconds is real work. Across retries / hot-updates / rollbacks every prior `success` row stays intact (only `superseded` flag flips during migration, never on reject-rollback). Auditing 6 months later is possible. |
| **SQLite, not Postgres/SQS** | Server DB | Single-user. SQLite handles 2400 tests in 55s + every concurrent runtime path. WAL gives us durability on power loss. No ops cost. |
| **Claude only** | Multi-engine | Each engine had its own sub-bugs; cross-engine semantic divergence dwarfed the gain. Retired in Stage 4a. |

### 2.3 Why is reject-rollback not a delete?

Subtle but defining: when a user rejects a gate, the targeted
upstream stages re-run, but their old `stage_attempts` rows stay at
`status='success'`. New runs add `attempt_idx=2,3,...`. **Lineage is
the union, not a replacement.** This is the same invariant that
makes hot-update auditable — old version's work is *evidence*, not
garbage.

Only **migration** uses `status='superseded'` (B17), because
migration explicitly means "this attempt was on a now-defunct
pipeline version". Reject-rollback isn't migration; it's "the
content was wrong, but the attempt happened".

This was contested for several dogfood iterations and is documented
in `handoff-dogfood-bug16.md` § "Lineage preservation is the design
choice".

---

## Part 3 — How

### 3.1 Architecture topology

```
┌─────────────────────────────────────────────────────────────────┐
│                         Surfaces                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Web (Next.js)│  │ MCP HTTP     │  │ CLI (registry,       │   │
│  │  /kernel-next │  │ /api/mcp     │  │ prune-records)       │   │
│  └───────┬──────┘  └───────┬──────┘  └──────────┬───────────┘   │
│          │ REST + SSE       │ JSON-RPC 2.0      │ direct invoke  │
│          ▼                  ▼                   ▼                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   Hono HTTP server                        │   │
│  │  /api/kernel/*   /api/registry/*   /api/mcp              │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                             │                                    │
│                             ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │             KernelService (mcp/kernel.ts)                 │   │
│  │  submit / propose / approve / migrate / rollback / cancel │   │
│  │  answer_gate / provide_secrets / list*                    │   │
│  └──────────┬─────────────────────┬─────────────────────────┘   │
│             │                     │                              │
│             ▼                     ▼                              │
│  ┌────────────────────┐  ┌────────────────────────────────┐     │
│  │  SQLite DB         │  │  Runner                         │     │
│  │  pipeline_versions │  │  ┌──────────────────────────┐  │     │
│  │  stage_attempts    │  │  │ XState root machine      │  │     │
│  │  port_values       │  │  │  ┌─────────┐ ┌─────────┐ │  │     │
│  │  gate_queue        │  │  │  │ stage A │ │ stage B │ │  │     │
│  │  task_finals       │  │  │  │ region  │ │ region  │ │  │     │
│  │  hot_update_events │  │  │  └─────────┘ └─────────┘ │  │     │
│  │  task_worktrees    │  │  └──────┬───────────────────┘  │     │
│  │  task_env_values   │  │         │                       │     │
│  │  ...               │  │         ▼                       │     │
│  └────────────────────┘  │  ┌──────────────────────────┐  │     │
│                          │  │ StageExecutor            │  │     │
│                          │  │  ├ RealStageExecutor     │  │     │
│                          │  │  │  └ Claude SDK         │  │     │
│                          │  │  ├ ScriptStageExecutor   │  │     │
│                          │  │  └ orchestrateFanout     │  │     │
│                          │  └──────────────────────────┘  │     │
│                          └──────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 The IR — what a Pipeline really is

A `PipelineIR` is a JSON document validated by `ir/schema.ts`
(zod). The shape:

```jsonc
{
  "name": "my-investigation",
  "externalInputs": [
    { "name": "topic", "type": "string" }
  ],
  "stages": [
    {
      "name": "topicFraming",
      "type": "agent",                       // or "script" | "gate"
      "inputs":  [{ "name": "topic", "type": "string" }],
      "outputs": [{ "name": "axes", "type": "string[]" }],
      "config": { "promptRef": "topicFraming", "model": "claude-..." }
    },
    {
      "name": "framingGate",
      "type": "gate",
      "inputs":  [{ "name": "axes", "type": "string[]" }],
      "outputs": [],                         // gate's __gate_feedback__ is implicit
      "config": {
        "question": { "text": "Approve framing?", "options": [
          { "value": "approve" }, { "value": "reject" }
        ] },
        "routing":  { "routes": { "approve": "tutorialAuthoring",
                                  "reject":  "topicFraming" } }
      }
    }
    // ...
  ],
  "wires": [
    { "from": { "source": "external", "port": "topic" },
      "to":   { "stage": "topicFraming", "port": "topic" } },
    { "from": { "source": "stage", "stage": "topicFraming", "port": "axes" },
      "to":   { "stage": "framingGate", "port": "axes" } }
  ]
}
```

Three things to note:

1. **Wires, not implicit shared state.** Stages don't reach into a
   shared blackboard; every cross-stage data flow is a typed wire
   from a producer's output port to a consumer's input port.
   `wireDelivers` checks both source presence (`wireSettled`) and
   any conditional guard before considering a wire deliverable.
2. **Gate routes can be multi-target.** `reject: ["A", "B"]` means
   rejecting this gate rolls back stages A and B *together*, plus
   the gate itself, plus everything downstream of the gate-feedback
   wire. Validated by `validator/structural.ts` to ensure all
   targets are ancestors (rollback semantics).
3. **`version_hash` includes prompts.** Two pipelines that differ
   only in prompt content produce different versions. This is what
   lets `propose_pipeline_change(prompts: { foo: "new content" })`
   produce a meaningfully-new `proposedVersion` even when ops are
   empty.

### 3.3 IR → XState compilation

`compiler/ir-to-machine.ts:compileIRToMachine` takes the IR and
emits an XState `createMachine(...)` call. Each stage becomes a
**parallel region** with sub-states `idle | waiting | executing | done | error`. Wires
become guards on the `waiting → executing` transition: a stage
enters `executing` only when **all its inbound wires are settled
+ deliverable**.

```
                 ┌─────┐
                 │idle │  (only at machine startup)
                 └──┬──┘
                    │ always (entry guard)
                    ▼
              ┌──────────┐
              │ waiting  │
              └──┬───┬───┘
                 │   │  always: all inbound wireDelivers
                 │   │  AND (gate-routed → authorized)
                 │   ▼
                 │  ┌────────────┐
                 │  │ executing  │
                 │  └──┬─────────┘
                 │     │ PORT_WRITTEN: all outputs present
                 │     ▼
                 │  ┌──────┐
                 │  │ done │  (final)
                 │  └──────┘
                 │
                 │ STAGE_FAILED: stage matches
                 ▼
              ┌──────┐
              │error │  (final)
              └──────┘
```

The root machine has handlers for cross-cutting events:
- `PORT_WRITTEN { key, value }` → updates `context.portValues`,
  re-evaluates every region's guards.
- `GATE_ANSWERED { gateId, stageName, answer, targetStage }` →
  routes to the gate's region, transitions to `done`,
  conditionally adds `targetStage(s)` to `gateAuthorizedTargets`.
- `GATE_REJECTED` → intercepted by `dispatcher.send` (not the actor
  directly) so the runner can build a "rollback" verdict, prune
  affected stages from `persistentPortValues`, and rebuild the
  actor on the next attempt iteration.
- `INTERRUPT { stage? }` → forwarded to the stage's invoke child;
  if `stage` is undefined, broadcast to every executing region;
  fanout stages additionally abort via a parallel `fanoutInterruptController`
  (Bug 81 fix, dogfood-13).

### 3.4 The Runner loop

`runtime/runner.ts:runPipeline` is the outer driver:

```pseudo
loop {
  verdict = await runOneAttempt()
  switch verdict {
    case "natural":   break             // pipeline reached its sink stages
    case "retry":     prune ports for backToStage's downstream
                      bump retryCounts[stage]
                      continue           // rebuild actor
    case "rollback":  drop persistentPortValues for affectedStages
                      seed gate-feedback "" for each affected gate
                      record rejectFromGates[fromGate]
                      continue           // rebuild actor
    case "interrupted": break            // INTERRUPT delivered externally
  }
}
record task_finals
unregister from taskRegistry
delete task_env_values  (P3.6 contract)
```

The trick is `runOneAttempt` does NOT just `await actor.start()` — it
installs an inspector that watches every snapshot for retry / reject
verdicts, AND maintains a separate executor-promises array for
fanout stages that live outside the actor lifecycle. When any of
these three signals arrives, the verdict is built explicitly and the
outer loop performs the correct rebuild.

### 3.5 Hot-update — the migration story

A concrete trace of `propose → approve → migrate → rollback`:

1. **Propose.** `KernelService.propose({ currentVersion, patch, prompts, rerunFrom, autoApprove })`:
   - Validates the patch against `currentVersion`'s IR (`ir/patch.ts:applyPatch`).
   - Computes the proposed `version_hash` from canonical (IR + prompts).
   - Inserts row in `pipeline_proposals` with `status='pending'` (or
     `'approved'` if autoApprove + verdict=`safe`).
   - Returns `{ proposalId, proposedVersion, diff, impact, safeRange }`.
2. **Approve.** (auto-approved is in-line; manual is separate
   `approveProposal` call.)
3. **Migrate.** `migrateTask(taskId, proposalId)` →
   `executeMigration` in `hot-update/migration-orchestrator.ts`:
   - Acquires per-task lock (`MIGRATION_IN_PROGRESS` if held).
   - Sends `INTERRUPT` to live runner if **any non-gate stage is
     running** (Bug 80 fix, dogfood-10: skip when only gates are
     running, since gate.executing has no INTERRUPT handler).
   - Computes `supersedeSet = computeWireTransitiveReaders(ir, rerunFrom)` —
     every stage reachable via wires from the rerun point.
   - Snapshots pre-supersede status for reverse.
   - In one transaction: marks affected `stage_attempts` as
     `superseded` (preserving `kind='fanout_element' AND status='success'` —
     B17), closes any open `gate_queue` rows targeting superseded
     attempts.
   - Optionally `git reset --hard before_sha` in the task's
     worktree (B9 full).
   - Calls `startPipelineRun({ resumeFrom: rerunFrom })` to launch a
     new runner against the new version.
   - On any startRunner failure → reverse-supersede (restore status
     from snapshot) + audit `failed/RESUME_FAILED`.
4. **Rollback.** A user who regrets the migrate calls
   `rollbackHotUpdate({ taskId, toVersion })`:
   - Computes the inverse patch (forward patch's reversal).
   - Re-runs the migrate flow against `toVersion` as the new target.
   - Audited as a fresh `hot_update_events` row with `kind='rollback'`.

### 3.6 Resumability invariants

What restart looks like:

```
SIGTERM ───► graceful-shutdown.reconcileRunningAttempts:
              UPDATE stage_attempts SET status='superseded'
                WHERE status='running'
              UPDATE gate_queue ...
              writeTaskFinals(...) for each interrupted task
                with reason='interrupted'
            taskRegistry.interruptAll(deadline)
            await all runners terminate or timeout

(server shut down, restarts later)

server boot ─► bootResumability:
              for each task NOT in task_finals:
                resolve last live state from stage_attempts
                if any stage is in 'running' → it's an orphan;
                  classifyOrphan() decides whether to
                  re-launch (resume) or finalise (failed)
                if pipeline is mid-fanout → preserve fanout_element
                  successes (B17), kick off only the missing indices
              startPipelineRun({ resumeFrom: <recovered point> })
```

Three crucial invariants this preserves:

1. **No double-spend on Anthropic.** A stage that already wrote its
   port values does not re-run; the resumed runner finds it in
   `stage_attempts.status='success'` and short-circuits the region
   to `done`.
2. **Reject-rollback survives restart.** The `gate_feedback` port
   is persisted; on resume, the rebuilt machine sees the same
   feedback that prompted the upstream rerun. (Bug 16 — dogfood-5/6
   — fixed exactly this seam.)
3. **Fanout partial state survives.** 14 of 16 elements done, restart, only
   the 2 missing/superseded elements re-run. (B17 / handoff-dogfood-2026-05-02
   Bug 15 covers the migration variant.)

---

## Part 4 — The visible product

### 4.1 Web UI surface map

```
/                               ← Launch hub: all pipelines + run dialog
/kernel-next                    ← Task list
/kernel-next/[taskId]           ← Live task detail (SSE, gates, attempts, audit, DAG)
/kernel-next/pipelines          ← Pipeline browser
/kernel-next/pipelines/[name]   ← Pipeline IR viewer + version history
/kernel-next/proposals          ← Hot-update proposals (approve / reject / migrate)
/kernel-next/attempts/[id]      ← Per-attempt deep-dive (lineage, diff, sidecar)
/kernel-next/mcp-catalog        ← MCP server inventory (encrypted secrets)
/registry                       ← Cross-user package registry (browse + install)
```

### 4.2 The MCP surface

External Claude sessions reach the kernel through MCP tools. The
catalog (extracted via `tools/list` on `/api/mcp`):

```
  submit_pipeline(ir, prompts)            — register a new IR
  validate_pipeline(ir)                   — dry-run validation
  describe_pipeline({ taskId | versionHash }) — IR + prompts
  propose_pipeline_change({...})          — emit a proposal
  migrate_task(taskId, proposalId)        — hot-update
  run_pipeline({ name | versionHash, ... }) — start a task
  cancel_task(taskId, reason?)            — INTERRUPT + finalise
  get_task_status(taskId)                 — full state snapshot
  list_pipelines() / list_tasks()
  answer_gate(gateId, answer, comment?)   — answer a human gate
  provide_task_secrets(taskId, secrets, persistAs?) — unblock secret_pending
  read_port(taskId, stage, port)          — query lineage
  query_lineage(taskId, ...)              — audit / explain
  prune_records({ taskId | olderThan })   — DB cleanup
  ... + write_port (runner-internal)
```

Every tool returns a `{ ok: true, ... } | { ok: false, diagnostics: [...] }`
shape with structured codes — the same envelope used by the REST API.

### 4.3 Key DB tables (annotated)

| Table | What it stores |
|---|---|
| `pipeline_versions` | `(version_hash, pipeline_name, ir_json, ts_source, parent_hash, created_at)` — every IR ever submitted |
| `pipeline_prompt_refs` + `prompt_contents` | promptRef → content mapping, content-addressed |
| `stage_attempts` | One row per attempt: `(attempt_id, task_id, version_hash, stage_name, attempt_idx, status, kind, fanout_element_idx, started_at, ended_at)` |
| `port_values` | Lineage rows: `(value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)` |
| `gate_queue` | One row per gate-stage entry: `(gate_id, task_id, attempt_id, question_json, answer, answered_at)` |
| `task_finals` | Terminal state: `(task_id, version_hash, final_state, reason, detail, ended_at)` |
| `hot_update_events` | Audit: `(event_id, task_id, from_version, to_version, status, started_at, finished_at, diagnostic_json)` |
| `task_worktrees` | Worktree ownership: `(task_id, workdir, status, allocated_at)` |
| `task_env_values` | Plaintext env values; auto-deleted when task ends (P3.6) |
| `secret_gate_queue` | Per-task secret-pending state: `(secret_gate_id, task_id, stage_name, required_keys, resolved_at)` |
| `mcp_servers` + `mcp_secrets` | MCP catalog with encrypted-at-rest secrets |
| `migration_hints` | Advisory diff payload for hot-update successor attempts (B9-A) |
| `pipeline_proposals` | `(proposal_id, status, base_version, proposed_version, patch_json, ...)` |
| `agent_execution_details` | Per-agent-attempt token usage, cost, compact events, cache stats |
| `script_execution_details` | Per-script-attempt termination reason, error, runtime |
| `stage_checkpoints` | Pre-stage git SHA for B9 reset target |

Full schema: `apps/server/src/kernel-next/ir/sql.ts`.

---

## Part 5 — The visible test surface

The product is **defined by its tests** as much as by its code.
2,374 server tests + 66 web tests + 65 registry-service tests cover
the contracts the user actually depends on:

| Suite | What it pins |
|---|---|
| `runner.test.ts` | Stage-region transitions, retry, gate-routed authorization |
| `runner.reject-rollback.test.ts` | Single-target + multi-target rollback (Bug 28) |
| `runner.cross-region-cancel.test.ts` | STAGE_CANCELLED propagation |
| `runner-fanout.*.test.ts` | Concurrency, retry, timeout, secret-pending, INTERRUPT (Bug 81) |
| `migration-orchestrator.test.ts` | INTERRUPT timeout, idle-at-gate skip (Bug 80), reverse-supersede, B13 sibling preservation |
| `real-executor.test.ts` | Claude SDK adapter, abort, rate-limit, cancel, resume, MCP status |
| `validator/*.test.ts` | Type compat, store schema, structural rules |
| `compiler/ir-to-machine.test.ts` | IR → machine compile, multi-target rollback compile |
| `kernel.test.ts` (KernelService) | submit, propose, approve, migrate, rollback, cancel, answer, provide_secrets |
| `services/registry-service*.test.ts` | install, uninstall, update, publish, dependency closure |

Every commit that lands a fix lands a regression test. The dogfood
chain (handoffs `dogfood-2026-04-28/handoff-final.md` →
`handoff-dogfood-11-12-13.md`) walks every observable user path
end-to-end with real LLM calls.

---

## Part 6 — Honest limitations

1. **Local-only**. There is no auth, no remote multi-user, no audit
   chain across users. If you want a team workflow tool, this isn't it.
2. **Claude SDK dependency**. We're as good as Anthropic's SDK is
   stable. Outages, rate limits, breaking SDK changes are felt
   directly. We've shipped fixes for SDK status detection (Bug 11),
   compact event accounting (Phase 4.5 T1), and stderr noise filter,
   but a hostile SDK regression breaks this product.
3. **No prompt cache strategy yet**. Prompt caching works at the SDK
   layer (1.18-1.19 modifications observed 60-91% cache hit rates on
   real pipelines), but we don't *plan around* it — there's no
   "single-session decision gate" that uses cache stats to choose
   between segment shapes.
4. **Hand-written pipelines mostly broken**. The product assumes
   AI-written IRs (via pipeline-generator). A human writing the IR
   directly will fight the validator's strictness; the prompts that
   make pipeline-generator emit good IR are themselves much of the
   product's value.

---

## Part 7 — Pointers

- **Get started**: `docs/product-intro.md` (user-facing)
- **Authoritative design**: `docs/kernel-next-terminal-design.md`
- **Roadmap (live)**: `docs/product-roadmap.md`
- **Recent dogfood chain**: `docs/superpowers/dogfood-2026-04-28/handoff-*.md`
- **Code entry points**:
  - HTTP: `apps/server/src/index.ts`
  - Kernel: `apps/server/src/kernel-next/mcp/kernel.ts`
  - Runner: `apps/server/src/kernel-next/runtime/runner.ts`
  - Compiler: `apps/server/src/kernel-next/compiler/ir-to-machine.ts`
  - Hot-update: `apps/server/src/kernel-next/hot-update/migration-orchestrator.ts`
  - Web: `apps/web/src/app/`

---

**End of whitepaper v2.0.**

Updates to this document require a version bump in the header and
a paragraph under the relevant Part explaining what changed and why.
The legacy `architecture-whitepaper.md` and `architecture-whitepaper-zh.md`
are retained as historical artifacts — do NOT update them.
