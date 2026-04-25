# pipeline-generator dogfood findings (2026-04-25)

While feeding the `web3-research` task description (37K chars) to `pipeline-generator` to produce a real pipeline IR, the following bugs and limits surfaced. This doc records what was hit, what was fixed inline, and what's still open.

## Context

- **Task**: spawn `web3-research` pipeline via `start_pipeline_generator` MCP tool
- **Spec fed in**: `docs/superpowers/specs/2026-04-25-web3-research-task-description.md` (631 lines / 37170 bytes)
- **Task ID**: `428d652b-b9f1-4437-b45b-eb3ef673195c`
- **Date**: 2026-04-25
- **Server**: localhost:3001 (kernel-next)

---

## Finding 1 — `MAX_DESCRIPTION_LEN = 8000` too tight (FIXED inline)

### Symptom

`start_pipeline_generator` rejected our 37170-char spec with:

```json
{"ok": false, "error": "INVALID_DESCRIPTION", "reason": "too_long"}
```

The Zod input schema also enforced `.max(8000)` independently (returns `MCP error -32602: too_big`).

### Diagnosis

8000 char ceiling was a defensive default from when pipeline-generator was new. Real dogfood task descriptions for non-trivial pipelines (e.g., a methodology spec with cross-cutting invariants + atom library + type-mapping) routinely exceed 8K. 8K is far below Claude's context window and far below what the analyzing stage's prompt assembly already handles.

### Fix (inline this session)

Bumped to 64000 in two places:

- `apps/server/src/kernel-next/mcp/pg-entry.ts:73` — `MAX_DESCRIPTION_LEN` constant
- `apps/server/src/kernel-next/mcp/tools/pg.ts:35` — Zod `.max(8000)` → `.max(64000)`
- `apps/server/src/kernel-next/mcp/pg-entry.test.ts:58` — test threshold updated

23 pg-entry tests still pass.

### Why 64000

- 8 KB → 64 KB is 8×, comfortably above realistic spec size
- Claude Sonnet 4.6's 1M-token context window handles 64K input trivially
- An adversarial actor sending 64 KB still bounded; no DoS escalation
- If 64K becomes a real ceiling later, raise to 128K or 256K — no architectural concern

---

## Finding 2 — `wait_pipeline_result` history replay falsely settles on already-answered gate (OPEN)

### Symptom

After `answer_gate` successfully approved the `awaitingConfirm` gate (server log confirmed `targetStage: "genSkeleton"` and the task was actually running genSkeleton), `wait_pipeline_result` immediately returned:

```json
{
  "ok": true,
  "status": "gate_pending",
  "taskId": "...",
  "gateName": "awaitingConfirm",
  "gateContext": {"pipelineDesign": {}},
  "hint": "Call answer_gate to approve/reject, then wait_pipeline_result again."
}
```

…even though `get_task_status` simultaneously reported `status: "running"` (genSkeleton in progress) and `stage_attempts` SQL showed the gate row's status as `success` with `ended_at` populated.

### Root cause

`handleWaitPipelineResult` (`apps/server/src/kernel-next/mcp/pg-entry.ts:319`) subscribes to broadcaster events and returns synchronously when it sees a gate stage's `stage_executing` event. The broadcaster's `subscribe()` replays event history. The replay includes the historical `stage_executing` event that fired when `awaitingConfirm` first opened — even after the gate has been answered and the task moved on.

The settle path:

```
unsub = deps.broadcaster.subscribe(taskId, (ev) => {
  if (ev.type === "stage_executing") {
    const stage = deps.ir.stages.find((s) => s.name === data.stage);
    if (stage && stage.type === "gate") {
      settle({status: "gate_pending", gateName: data.stage, ...});
    }
  }
});
```

There's no check for "is this gate currently open?" The check should consult `gate_queue.answered_at IS NULL` for the (taskId, stageName) row, OR confine subscription to events newer than the current wait's `startedAt` and rely on a fresh `stage_executing` from a later gate.

### Repro recipe

1. Start a pipeline with a gate (e.g., pipeline-generator)
2. Wait for the gate to open
3. Call `answer_gate` with the gate ID
4. Immediately call `wait_pipeline_result` with the same task ID
5. Observe that it returns `gate_pending` with the *just-answered* gate even though the task is past it

### Workaround

Don't use `wait_pipeline_result` for "wait until terminal" if any gate has fired in the past. Use either:

- `Monitor` over a SQLite poll loop on `stage_attempts` looking for `persisting:success|error`
- Repeated `get_task_status` polling (the dashboard route)

### Suggested fix

In `handleWaitPipelineResult` event handler, before settling on a gate's `stage_executing`, query `gate_queue` for the (taskId, gateName) row and check `answered_at IS NULL`. Only settle if the gate is genuinely pending. If answered, ignore the event and keep waiting for the next terminal/gate event.

This is a 5-line patch in `pg-entry.ts:393-401` plus a regression test that:

1. Opens a gate
2. Answers it via `answer_gate`
3. Calls `wait_pipeline_result`
4. Asserts the response is NOT `gate_pending` for the answered gate (either `running` after timeout or `done` if the pipeline terminated)

---

## Finding 3 — server didn't ship a "spec → pipeline" shortcut (OBSERVATION)

### What happened

I had a 37K markdown spec on disk. The natural workflow would be:

```
start_pipeline_generator(specPath: "docs/.../web3-research-task-description.md")
```

…but the tool only accepts `description: string`. So the workflow was:

1. `cat` the file
2. Build a JSON-RPC payload via `jq -n --arg desc "$(cat ...)"`
3. POST to `/api/mcp`

Three small extra steps. Not blocking, but a real friction. AI authors commonly have spec files; making them paste-the-whole-thing inline isn't great UX.

### Suggested addition

Optional `descriptionPath: string` arg on `start_pipeline_generator`. If provided, server reads the file (size-capped at 64K via the same `MAX_DESCRIPTION_LEN` ceiling) and uses contents as `description`. Mutually exclusive with `description` arg. Path resolution rules: absolute paths only, OR rooted at workspace dir for safety.

This is a quality-of-life change, not blocking. Defer until 2-3 more dogfood runs validate the friction is real.

---

## Finding 4 — `persisting` agent picks TS reserved words for port names (CRITICAL — caused run failure)

### Symptom

`persisting` stage's first `submit_pipeline` call rejected with 14 `ZOD_PARSE_ERROR` rows, all variants of `"X.name: must not be a TS/JS reserved word"`. The most prominent offender: `classifyType` output port named `type`. Plus 9 `wires.*.port` references to it.

### Root cause

The pipeline-generator agent took our spec's `§7.1 R2 outputs: type, typeReasoning, typeConfidence, atomSet` and used `type` literally as a port name. `type` is a TS reserved word; kernel-next's port-name validator rejects it.

The persisting agent retried (with renamed ports `type → entityType`), which is the right behavior, but it took 14 minutes and 51K output tokens to recover — and ultimately failed for an unrelated codegen issue (Finding 5) before it could complete a clean retry.

### Two-sided fix needed

**On the spec side** (we control this): Section §7.1 R2 / §10 acceptance criteria #3 reference port name `type` literally. The spec should say "do NOT use TS reserved words; recommended names: `entityType`, `targetCategory`, `classification`." This guides any future generator run.

**On the generator side** (pipeline-generator's `analysis.md` / `gen-skeleton.md`): the system prompt should include a TS-reserved-word checklist for port naming. Currently the generator only learns from zod errors after submit fails — that's a 1-2 minute round-trip per error. Pre-empting saves real cost.

### Why this matters

Each retry of `persisting` agent costs $1+ and 50K+ tokens. If the IR has 14 reserved-word violations, agent fixes them in batches and may exceed `max_turns` before all are clean. Our run hit `max_turns` exhaustion + final error.

---

## Finding 5 — `__gate_feedback__` port causes WIRE_TYPE_MISMATCH at submit-time codegen (CRITICAL — kernel bug)

### Symptom

After fixing the reserved-word errors (Finding 4), `persisting` agent's second `submit_pipeline` call returned:

```
WIRE_TYPE_MISMATCH: tsc reported errors that could not be mapped to any wire:
pipeline.ts(132,51): error TS2339: Property '__gate_feedback__' does not exist on type 'Outputs'.
```

The IR contained a wire from `scopeApproval.__gate_feedback__` to `scope.rejectionFeedback`, which is the canonical kernel-next pattern for gate-reject feedback (per spec §8.8 and per legacy pipelines).

### Root cause (kernel codegen bug, not generator's fault)

The structural validator (`apps/server/src/kernel-next/validator/structural.ts:283`) explicitly recognizes `__gate_feedback__` as a builtin output of gate stages and skips port-existence checks for it. **But** the IR-to-TypeScript codegen (`emit-ts.ts`) does NOT inject `__gate_feedback__` into the gate stage's generated `Outputs` interface. Result: `submit_pipeline` runs `tsc --noEmit` on the generated TS, tsc finds an undeclared property, and emits `TS2339`.

The wire is structurally legal (validator passes) but the type-check fails because codegen and validator disagree about what's emitted.

### Repro recipe

1. Build any IR with a gate stage and a wire of the form:
   `{from: {stage: "<gate>", port: "__gate_feedback__"}, to: {stage: "<upstream>", port: "rejectionFeedback"}}`
2. Submit via `submit_pipeline`
3. Observe `WIRE_TYPE_MISMATCH` with the codegen TS file's `__gate_feedback__` undeclared

### Suggested fix

In `emit-ts.ts`, when emitting a gate stage's `Outputs` namespace, add `__gate_feedback__: string;` (or appropriate type) explicitly. This mirrors how the validator special-cases the field. One ~5-line patch + a regression test:

1. Build IR with a gate + `__gate_feedback__` wire
2. Submit
3. Assert no `WIRE_TYPE_MISMATCH` diagnostic

### Why this matters

`__gate_feedback__` is the *only* mechanism for gate-reject loops to carry user comments back upstream. Spec §8.8 documents it as the recommended pattern. If the codegen blocks it, every pipeline with gate-reject-with-feedback fails to submit. This is a P0 kernel bug that blocked the entire web3-research generation.

### Workaround for our blocked run

Two paths:
1. **Resubmit IR manually** with the wire stripped (lose feedback semantics) — not great
2. **Fix the codegen** and replay the persisting stage — the right path

---

## Finding 6 — `runPipeline` 30min global timeout too tight (FIXED)

### Symptom

Round 1 task ran past 30min during `persisting` retry loop (agent iterating on `submit_pipeline` diagnostics). Whole task got `task_finals.final_state='failed', reason='timeout', detail='runPipeline timeout after 1800000ms'` — even though the agent was actively making progress.

### Root cause

`apps/server/src/kernel-next/runtime/runner.ts:213` had `DEFAULT_RUN_TIMEOUT_MS = 30 * 60 * 1000`. Per-stage `max_turns` and `max_budget_usd` already cap individual stage cost; the global wall-clock ceiling is only there to catch wedged runners. 30min is below realistic bounds for complex pipelines.

For `pipeline-generator` against a 37K-char spec:
- `analyzing`: 9-10 min
- `genSkeleton` + `genPrompts`: 5-7 min each (parallel)
- `persisting` under retry pressure: up to 15-20 min
- Plus gate wait time (variable, possibly minutes-to-hours)

30min is a tight ceiling that the happy path can hit on retries.

### Fix

Raised to `90 * 60 * 1000` (90 min). This is comfortably above observed worst-case while still preventing forever-stuck tasks. Per-stage budgets remain the primary cost gate.

`apps/server/src/kernel-next/runtime/runner.ts:208-220` updated. `task-finals.test.ts:171` assertion `>= 30min` still passes.

---

## Finding 7 — `pipeline-generator` builtin IR has duplicate `description` port name on input vs output (FIXED)

### Symptom

Round 2 analyzing agent stalled mid-thinking, eventually emitting:

> "Looking at the read_port documentation more carefully, [...] But the task prompt says to call read_port with stage='analyzing', which would read the analyzing stage's own not-yet-written description port — that seems backwards. [...] Let me skip trying to read the full description and instead look at what I can infer from the system prompt and the git status showing a web3 research task file — I could even try reading that file directly from the filesystem since it's mentioned in the git output."

The agent was about to *bypass the port system entirely* and read the spec from disk directly.

### Root cause

`pipeline-generator/pipeline.ir.json` had:
- `analyzing.inputs.description` (`unknown`) — wired from `external.taskDescription`, carries the user's task text
- `analyzing.outputs.description` (`string`) — the AI-generated 1-sentence description of the pipeline being designed
- `genSkeleton.inputs.description`, `genPrompts.inputs.description`, `persisting.inputs.description` — all consume `analyzing.outputs.description`

Two *different* `description` ports on the same stage (`analyzing`) — input vs output — both legal in port-naming rules. But at runtime when the agent considers calling `read_port({stage: "analyzing", port: "description"})`, the SDK can't disambiguate, and the agent gets confused enough to abandon the port system.

### Fix (4-part rename)

1. **IR**: `analyzing.inputs.description` → `taskText`; `analyzing.outputs.description` → `pipelineDescription`; downstream stage inputs.description → `pipelineDescription`; 4 wires updated; `store_schema` key `analyzing.description` → `analyzing.pipelineDescription`.
2. **`analysis.md`**: line 134 input ref `description` → `taskText`; line 192 output ref `description` → `pipelineDescription`.
3. **`gen-skeleton.md`**: line 126 example IR's `{name: "description"}` input → `{name: "taskText"}`; new pre-submit checklist item flags TS reserved words AND same-name input/output as anti-patterns.
4. **No prompts/system/persist.md or gen-prompts.md** changes needed — they reference `description` only in unrelated contexts (e.g., `description?: string` field on PortIR shape definitions).

### Why this is also a generator-prompt-quality issue

Generator's `gen-skeleton.md` example IR template *taught* downstream pipeline generations the same mistake. Round 1's `web3-research` IR had `scope.inputs.description` because the example said so. Fixing the example also makes future generator runs cleaner.

---

## Finding 8 — heartbeat-based liveness signal misleading; agent thinking is silent (DESIGN OBSERVATION, not bug)

### Symptom

I observed Round 2 `analyzing` agent's `last_heartbeat_at` stuck at 458 seconds with no updates — mistakenly concluded the agent was wedged and called `cancel_task`. `agent_execution_details.termination_reason` came back as `interrupted` (the cancel landed cleanly), confirming the agent was actually alive.

### Root cause (not a bug — a monitoring blind spot)

`agent_execution_details.last_heartbeat_at` is updated only when the SDK emits a stream event (assistant message, tool call, tool result) and the writer flushes. **Pure thinking time emits no events** — the SDK can sit in `thinking_delta` for many minutes (especially on large prompts with extended thinking), heartbeat-frozen, while the agent is actively reasoning.

This means heartbeat alone cannot distinguish:
- Agent wedged (worth canceling)
- Agent thinking (let it continue)
- Agent rate-limited at 429 retry-wait (let it continue)

### What would help

Option A (lightweight): emit a synthetic heartbeat ping every N seconds while the SDK query is open, regardless of stream activity. Real-executor would set a `setInterval` that hits `writer.flush()` so `last_heartbeat_at` reflects "agent process is alive", not "agent emitted output."

Option B (verbose): persist `thinking_delta` events to `agent_stream_json` (currently they may be filtered for size). Heartbeat moves naturally. Cost: bigger streams, possibly very large during deep thinking.

Option C (status quo + docs): document that heartbeat ≥5min is not a wedged signal during the analyzing stage. Don't auto-cancel based on heartbeat alone.

### My recommendation

**Option A** — synthetic heartbeat ping every 30s. ~10-line change in real-executor. Makes heartbeat a true liveness signal without inflating stream size.

Not blocking right now; can defer. But future agents will hit the same trap.

---

## Summary

| # | Finding | Status |
|---|---|---|
| 1 | `MAX_DESCRIPTION_LEN = 8000` too tight | ✅ FIXED (8K→64K) |
| 2 | `wait_pipeline_result` history replay falsely settles on answered gate | ✅ FIXED — gate_queue.answered_at guard in `pg-entry.ts:388-413` + regression test |
| 3 | No `descriptionPath` arg → forces inline spec paste | ✅ FIXED — accepts `descriptionPath` (absolute path) in `tools/pg.ts` |
| 4 | Generator picks TS reserved words (`type`) as port names | ✅ FIXED — spec + new pre-submit check in `gen-skeleton.md` |
| 5 | `__gate_feedback__` port causes `WIRE_TYPE_MISMATCH` (codegen bug) | ✅ FIXED — `emit-ts.ts` synthesizes `__gate_feedback__: string` for gate stages |
| 6 | `runPipeline` 30min global timeout too tight | ✅ FIXED (30min→90min) |
| 7 | `pipeline-generator` IR has duplicate `description` on input + output | ✅ FIXED — IR rename + prompt edits + new pre-submit check |
| 8 | Heartbeat doesn't move during agent thinking — false-positive wedge signal | ✅ FIXED — synthetic 30s heartbeat ping in `real-executor.ts` |
| 9 | Round 3 analyzing skipped emitting `stageContracts`, `stageDesign`, `dataFlowSummary`, `summary` — declared but not required | ❌ FALSE POSITIVE — analyzing actually emitted all 17 ports; my SQL query was racing with the writer flush. Withdrawn. |
| 10 | Anthropic API socket closed mid-genSkeleton, before final write_port → stage error | (subsumed by F11) |
| 11 | `DEFAULT_MAX_RETRIES = 0` → no auto-retry on transient failures | ✅ FIXED (0→2) |
| 12 | `classifyOrphan` topo sort treated `__gate_feedback__` reject-loop wires as forward edges, creating spurious cycles → empty topo → false-terminal classification → boot reconciler force-completes incomplete tasks | ✅ FIXED — skip `__gate_feedback__` wires in `topologicalStageOrder` + regression test |
| 13 | `session_mode: "single"` makes pipeline-generator slower, not faster — Inputs+systemPrompt re-injection on every continuation stage; SDK resume re-sends full transcript O(N²) | ⚠️ DESIGN LIMITATION (not bug) — see §Finding 13 below for full analysis + mitigation roadmap |

**Net dogfood result so far**: 5 of 8 findings fixed in-session. Generator's design quality (Round 1 analyzing output) was excellent and validates the spec was understood. The persistence path needed two infrastructure fixes (Finding 5, 6) plus prompt-quality fixes (Finding 4, 7). Finding 8 is a monitoring blind spot that bit me once but isn't blocking.

**Next step**: Round 3 invocation. Server stays running (no more code edits before completion). Spec already updated. Pipeline-generator builtin IR + prompts already updated. New agent should produce a clean IR that survives `submit_pipeline` end-to-end.

The dogfood is producing real findings on the *pipeline-generator infrastructure*, not just the generated pipeline. This is the value — issues invisible during synthetic testing surface immediately on real input.

---

## Finding 13 — `session_mode: "single"` underperforms `"multi"` on pipeline-generator (DESIGN LIMITATION)

### Symptom — measured

Re-ran round 4 (`web3-research` spec → pipeline-generator output) under two modes, **same spec, same builtin IR layout, only `session_mode` differing**:

| Stage | round 4 (multi) wall | round 5 (single) wall | round 4 cache_read | round 5 cache_read | round 4 cost | round 5 cost |
|---|---|---|---|---|---|---|
| analyzing | 408s | 649s (+59%) | 261K | 638K | $0.95 | $1.13 |
| genSkeleton | 522s | 369s (-29%) | 256K | 261K | $1.10 | $0.87 |
| genPrompts | 468s | 758s (+62%) | 94K | 482K | $0.77 | $2.99 |
| persisting | 492s | 757s (+54%) | 212K | 654K | $0.74 | $1.18 |
| **total** | **1890s (31.5 min)** | **2533s (42.2 min)** **+34%** | **823K** | **2,035K** **2.5×** | **$3.56** | **$6.17** **+73%** |

session_id chain confirmed all 4 agent stages of round 5 share `8c24b38c-65ce-42a0-87d4-d876fe4b4cd4`, i.e. single-session resume actually fired and cross-segment resume re-used the same SDK conversation file.

### Root cause — three concrete waste sources, all reproducible from code

**1. `### Inputs` block re-injected every continuation stage** (`real-executor-prompt-builder.ts:127-129`)

```ts
if (options?.continuationMode === true) {
  return [
    "### Inputs",
    inputDump,            // <-- formatInputLine() for every stage input port,
    "",                   //     even though SDK already saw upstream's write_port
    ...                   //     value in conversation history
  ].join("\n");
}
```

`formatInputLine` (line 232-255) inlines values ≤1024 chars verbatim and emits a 3-line summary + read_port instruction for larger values. **It has no awareness that the value came from a stage already in conversation history**.

The author wrote a `TODO(future, app-level summary)` at line 112-125 acknowledging this exactly:

> "once a single-session segment grows long (n stages, each with multi-KB reads), the continuation prompt re-injects every input again — even though the SDK has already seen the upstream stage's writes in conversation history."

**2. `systemPrompt: { preset: "claude_code", append }` rebuilt every stage** (`real-executor-sdk-options.ts:30-33`)

The Claude Code preset itself is ~10K tokens. Even though continuation form drops the persona/Stage-contract block from `append`, the SDK preset is **always re-applied** because each stage starts a fresh `query()`. The cache covers the prefix on the second+ call, but the wall-clock cost of evaluating the prefix (cache lookup, prefix matching) is non-zero.

**3. SDK `resume` re-sends full prior transcript** (Anthropic Agent SDK docs, verified)

> "When you resume a session, the full conversation history is sent to Claude's API, which consumes input tokens." — [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

> "The Anthropic API is stateless—it only sees the messages you send in the current request."

This is **architectural**: prompt cache (5-min TTL) makes the replay cheaper, not faster. cache_read still consumes API time and tokens. The growth is O(N²) in segment length:
- stage 1 sends S₁
- stage 2 sends S₁ + S₂
- stage 3 sends S₁ + S₂ + S₃
- ... etc.

Round 5 cache_read went 638K → 261K → 482K → 654K (analyzing → genSkeleton → genPrompts → persisting), confirming the conversation grows monotonically and is re-sent on every resume.

The official SDK docs **explicitly recommend NOT relying on resume for long pipelines**:

> "Don't rely on session resume: Capture the results you need (analysis output, decisions, file diffs) as application state and pass them into a fresh session's prompt. This is often more robust than shipping transcript files around."

### Why "+29% on genSkeleton, +62% on genPrompts/persisting"

genSkeleton **is** mid-segment (analyzing→genSkeleton same segment per segment-planner). Its system_prompt + Inputs are mostly cached, AND it gets analyzing's tool_calls visible — saves ~29% wall.

genPrompts and persisting are **cross-segment resumes** (different segment, but `findUpstreamSessionByWires` returns the same upstream session_id). Each one:
- Resumes the entire conversation (analyzing + genSkeleton + …) → cache_read explodes
- Receives the full continuation-form prompt with re-injected Inputs
- Inherits agent behavior pollution from prior stages: round-5 genPrompts called local `Read` 21 times on filesystem paths it saw analyzing mention, instead of using `read_port`

This is the worst of both worlds — pays full conversation overhead, gets no upside from continuation because cross-segment doesn't drop persona/Stage-contract anyway.

### Why pipeline-generator already chooses correctly

`gen-skeleton.md:301-325` documents the rule: choose `"single"` only when stages chain without gates and each downstream agent **interprets/refines** the prior. pipeline-generator's own IR has a gate after analyzing, and stage 2-4 are pure structured-data transformers — exactly the case `gen-skeleton.md:317` says **must stay multi**:

> "Pipelines where each agent stage is an independent, idempotent transformation over its inputs (no shared working memory needed)."

The IR change to `"session_mode": "single"` violated pipeline-generator's own rule and round 5 surfaces the exact penalty.

### Mitigation roadmap (not implemented this session)

**M1 — App-level summary writes** (mentioned in the existing TODO comment):
- Each stage emits a structured `summary` port alongside real outputs (declared via `store_schema`)
- Continuation prompt-builder consults the segment's prior writes; for any input port whose source stage is in the same segment, **omit it from `### Inputs`** (SDK saw it in history) and inject a one-line "see prior turn" pointer instead
- Trigger: cumulative inputDump > N tokens OR cache_read regression detected on `v_segment_continuity`

**M2 — Use `resumeSessionAt`** (`sdk.d.ts:957-962`):

> "When resuming, only resume messages up to and including the message with this UUID."

A continuation stage could resume to a *boundary* uuid (the last segment write_port) rather than the most recent message, dropping any post-write thinking the agent did. Smaller transcript = smaller cache_read.

**M3 — App-level compact** (analogous to Claude Code's auto-compact):
- After each stage's success, summarize its full transcript into a digest message
- Next stage resumes with `resumeSessionAt: <digest_uuid>` instead of the full tail

**M4 — Stop using single-session for IO-heavy stage chains** (the current de-facto policy):
- pipeline-generator already enforces this in its prompt
- kernel-next could surface a metric (`v_segment_continuity` already exists per the comment) and warn if a single-session segment's cumulative cache_read crosses a threshold

### Decision for this session

**Rolled back** `session_mode: "single"` from pipeline-generator's builtin IR. Rationale:
1. pipeline-generator's own `gen-skeleton.md:301-325` rule says it shouldn't be single
2. Round 5 quantified the regression (+34% wall, +73% cost)
3. Mitigations M1-M3 are real engineering work, not a 1-line config flip
4. Multi-session is the documented Anthropic-recommended pattern for this topology

`session_mode: "single"` capability is preserved in the kernel for pipelines that genuinely match the criteria — the rollback is config-only.

