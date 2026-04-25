# Single-Session Mode Design

**Status:** draft (awaiting review)
**Date:** 2026-04-25
**Author:** AI brainstorming with @ymh357
**Roadmap link:** §4 line 105 ("Single-session 模式 — TODO / 决策 open")

---

## 1. Goal

Enable kernel-next pipelines to run as a **single, continuous SDK
conversation** across multiple agent stages — at per-pipeline opt-in —
without breaking the existing multi-session execution path.

Both modes coexist:

- `multi` (default, current behaviour): every agent stage spawns its own
  SDK query; no conversation memory across stages; cost / latency /
  context savings come solely from prompt-cache hits.
- `single` (new): consecutive agent stages share one SDK conversation;
  each stage is one user turn in that conversation; the SDK's working
  memory carries across stages.

Single-session unlocks four user-facing wins (Q1 from brainstorm):

1. **Cost.** Stage 2's prompt does not re-send stage 1's full context —
   the SDK already has it in its conversation. Beats prompt-cache hits
   in raw token count (the cached read still counts as input tokens at
   ~10% rate; in single-session, those tokens never leave the client at
   all because they are not in the next prompt).
2. **Latency.** No per-stage SDK init overhead (`init` system message,
   tool advertisement, system prompt re-emission).
3. **Experience.** Chat-style refinement pipelines (e.g. "explore →
   propose → refine") become natural — the agent literally remembers
   what it did three stages ago, not via re-injected port values.
4. **Architectural completeness.** Multi-stage = independent
   transactions; single-session = one transaction with internal
   checkpoints. Both are legitimate, and the engine should support
   both rather than forcing one shape.

## 2. Non-goals

- **Stage-level granularity** (Q2-(ii)): "stages 1+2 share session,
  stage 3 forks fresh." Recorded as future direction; not in scope.
- **Auto-derive session boundaries from reads/writes topology**
  (Q2-(iii)): violates the "reads/writes is the only legitimate cross
  stage data flow" invariant if the runtime starts implicitly grouping
  stages. Recorded as future direction; not in scope.
- **Backporting to multi-session as a behaviour switch.** Multi remains
  the default and the regression baseline; single-session is purely
  additive.

## 3. Architectural decision: Hybrid I + II

Two pure shapes were considered:

- **Shape I — single SDK query for the entire pipeline.** One
  long-running SDK process; stage edges are pipeline-internal events;
  SDK never sees stage boundaries. Theoretically maximises sharing
  but breaks every existing mechanism that assumes stage = SDK
  query (interrupt model, maxTurns budget, attempt records, M-R5
  resume).
- **Shape II — per-stage SDK query with `options.resume`.** Each
  stage spawns a fresh query passing the prior stage's `session_id`.
  Looks like single-session from the user's perspective; underneath
  is N queries with shared history. Reuses M-R5 mechanism; minimal
  surgery.

**Decision: Hybrid.** Identify "agent-only continuous segments" — runs
of consecutive agent stages with no gate/script/fanout in between.
Within a segment, run **Shape I**: one SDK query covering all stages
in the segment. At a segment boundary (gate / script / fanout / pipeline
end), terminate the SDK query, persist the final `session_id` from
that segment, and the next segment opens a new query with `options.resume`
pointing at it.

This is not a compromise. It is the only correct shape:

1. **Gates inherently break the SDK process.** A gate waits for human
   input that may take hours. The SDK query cannot stay open for hours
   awaiting one user-message turn — it has to be torn down, the gate
   answer collected, then the next agent stage resumes. So the segment
   boundary at gates is forced, not chosen.
2. **Script stages do not participate in the conversation.** A script
   reads/writes ports deterministically; it has no role inside the
   SDK's "what the assistant has been told" history. Putting it inside
   one SDK query would either pollute the history with irrelevant
   tool calls or require contortions to hide it. Cleaner: scripts
   live outside the conversation.
3. **Fanout produces parallel branches.** Each fanout element should
   not see other elements' working state — that is the whole point of
   per-element isolation. Sharing one SDK conversation across fanout
   elements would either serialise them or cross-contaminate them.
   Cleaner: each fanout element starts its own segment.
4. **Within a segment, Shape I is correct.** No external constraint
   forces a query break between two consecutive agent stages — so
   not having one is the natural choice.

## 4. The four hard rules of `single` mode

### 4.1 Continuation prompt (Q3 = B)

The first agent stage in a segment receives a normal full prompt
(rendered with all reads, instructions, persona, etc.). Subsequent
stages in the same segment receive a **continuation prompt** that
keeps every block whose content changes per stage and drops every
block that is identical (or near-identical) across the segment:

**Kept** (per-stage content):
- `### Inputs` (rendered reads — mandatory per §4.2)
- `### Task` (this stage's instruction)
- emptyInputsWarning + migrationNote (when applicable)
- `### Output protocol` (this stage's output ports differ; SDK must
  know which ports to call `write_port` for on this turn)
- Identity block (this attempt's `taskId`/`attemptId`)
- Required tool calls (per-stage `write_port` examples)
- CRITICAL RULES (apply every turn)

**Dropped** (segment-invariant content):
- The "You are running stage X in a kernel-next pipeline" preamble
- The `### Stage contract` overview (input/output port listings —
  the SDK has them in the segment's prior turn(s))

Pipeline-generator (the AI YAML author) is responsible for emitting
this-stage `prompt` template content suited to continuation usage —
short instructions like "Now produce X based on the prior output"
rather than persona blocks. See §6.4. Template rendering itself
does NOT change — same ref system, same DSL, same prompt-content
addressing. Only the *content* the AI is expected to write changes.

### 4.2 reads/writes invariant preserved (Q4 = α)

Single-session does NOT relax the rule that "reads/writes is the only
legitimate cross-stage data flow." Concretely:

- A stage's `reads` are still rendered into its prompt as a `<reads>`
  section, even though the SDK already saw the prior stage's outputs.
  Reason: execution-record correctness. The DB row for stage 2 must
  show *what stage 2 actually saw*. If `reads` were skipped on the
  assumption "SDK remembers it," then a third party (replay tool,
  audit log reader, the human at QBR review) cannot reconstruct what
  stage 2 was actually told.
- A stage's `writes` are still mediated by port-runtime — the SDK
  emits `write_port` MCP tool calls, the runtime captures them, the
  next stage's `reads` come from port-runtime, not from "let the SDK
  remember." This is non-negotiable.
- Wire topology (`PipelineIR.wires`) still drives stage dispatch
  order. Single-session does not implicitly link stages; the wires
  do.

The cost: the same content is in both the SDK's conversation history
*and* in the next stage's prompt prefix. This is acceptable per the
"correctness > cost" decision. Prompt-cache reads cover the duplication
on the SDK side.

### 4.3 Segment is the unit of cancellation, retry, and resume

- **Cancellation.** An external `INTERRUPT` aborts the current SDK
  query — same mechanism as today. When abort triggers in the middle
  of a segment, all in-flight stages in that segment record
  `interrupted`. The next run resumes by starting a *new* segment
  whose first agent stage gets `options.resume = <last segment session id>`.
- **Retry.** Stage retry (script-driven `RetrySpec.backToStage`) puts
  the runtime back at a stage. If `backToStage` lands inside a
  segment, the segment's SDK query is torn down (cannot rewind a live
  conversation cleanly) and a fresh query begins from `backToStage`,
  with `options.resume` pointing at the segment's prior `session_id`
  if one was persisted; otherwise from scratch.
- **Crash recovery.** Same as today: orphan-reconciler reads
  `agent_execution_details.session_id` for the last in-progress
  attempt and passes it back via `runner` opts as `resumeSessionId`
  + `resumeFrom`. In single mode, that one session_id covers the
  whole segment up to the crash — the resumed stage may not be the
  segment's first stage.

### 4.4 Costs / token budgets

Per-stage cost accounting stays per-stage. The SDK emits one `result`
message per *user turn* (= per stage in single mode), with its own
`usage`/`modelUsage` fields. `RealStageExecutor` already reads them
and writes per-attempt rows into `agent_execution_details`. No change.

`maxTurns` semantics extended: in single mode, the configured
`maxTurns` value is applied as a *segment budget*, not a per-stage
budget. Each stage's effective allowance is the remaining segment
budget after subtracting prior stages' actual `num_turns`. The
existing `clampMaxTurns` / `parseNumTurnsFromStream` helpers are
generalised to "sum over the segment," not "sum over the stage's
own prior attempts." See §6.3.

`maxBudgetUsd` likewise becomes a segment-level cap.

## 5. IR schema changes

### 5.1 Top-level `session_mode`

```ts
// schema.ts: PipelineIRSchema
session_mode: z.enum(["multi", "single"]).default("multi"),
```

Effect on `version_hash`: included in canonical-JSON ordering; same
pipeline going from multi → single is a new version. Correct: it's
a behavioural change.

### 5.2 No stage-level field

Stage-level overrides are explicitly excluded (Q2 non-goal). A stage
in a `single` pipeline does NOT get to opt out individually. If a
pipeline has a stage that should fork its own session, the pipeline
author either:

- chooses `session_mode: "multi"` for the whole pipeline, OR
- inserts a script/gate as a forced segment boundary.

This keeps the model simple.

### 5.3 No `entry`-level coupling

`PipelineIR.entry` is unaffected. Single-session does not change
entry-stage selection; it changes how the entry-segment runs.

## 6. Runtime changes

The runtime work breaks into four areas. Each is small and
independently shippable.

### 6.1 Segment planner (new module)

New module: `apps/server/src/kernel-next/runtime/segment-planner.ts`

Pure function: given an `IR` and the current `wires` topology,
emit a static list of "segments" — each segment is an ordered list
of stage names. A stage `S` joins an existing segment iff **all** of:

- `S.type === "agent"` and `S.fanout === undefined`
- `S` has exactly **one** upstream agent stage `P` (per `wires`),
  with `P.type === "agent"` and `P.fanout === undefined`
- `P` has not already been used as the predecessor of another
  downstream stage (at-most-one continuation **per predecessor**;
  first eligible downstream wins). This phrasing matters: it is
  not "the segment is closed after one extension" — that reading
  would block linear chains a→b→c→d. Closing per-predecessor
  preserves linear chains while still forcing diamond splits
  (a→b, a→c) to start a new segment for the second branch.
- No `script` or `gate` stage sits between `P` and `S`

Otherwise `S` opens a new segment of which it is the first stage.

A `script` or `gate` stage is always a segment of size 1
(degenerate; runs in shape-II-style, but with `resumeSessionId`
inherited from the prior segment's last `session_id` if any).

Multi-input agent stages (e.g. a stage with two upstream agent
predecessors that fan-in) always start a new segment — no implicit
choice between "which predecessor's session do we resume." This is
a deliberate restriction, not a limitation: pipeline-generator should
emit a script stage to merge multi-input fan-in if continuation is
desired.

Hand-computed once at pipeline-load time, cached on the
`PipelineIR` (or in a sibling lookup keyed by `version_hash`).
Runner consults this map to decide, for each `executeStage` call,
"which segment am I in, and am I its first stage or a continuation?"

**Important:** segment planner runs only when `session_mode === "single"`.
For `multi`, every stage is its own segment of size 1 — equivalent to
today's behaviour.

### 6.2 RealStageExecutor: continuation mode

`ExecuteStageArgs` gains:

```ts
// When set, this stage has an upstream agent stage with a persisted
// session_id; the executor MUST resume that session, and SHOULD pick
// prompt form according to isContinuationStage.
segmentContinuation?: {
  resumeSessionId: string;
  priorNumTurns: number;     // segment-wide sum so far
  priorAttempts: string[];   // attempt_ids in segment order, for
                             // execution-record cross-reference
  isContinuationStage: boolean;  // see below
};
```

`isContinuationStage` separates *whether to resume* (always when an
upstream agent has a persisted session) from *which prompt form to
render*:

- `true`: this is a non-first stage in the same agent-only segment.
  The SDK is in the same query that emitted the segment-first
  stage's full prompt, so the prompt builder uses **continuation
  form** (drops the persona + Stage-contract overview — see §4.1).
- `false`: this is a segment-first stage that is resuming a prior
  segment's session_id (cross-segment resume after a gate / script /
  fanout boundary, or after a retry). The SDK is starting a fresh
  query with `options.resume`, but it is logically a new segment
  from the pipeline's perspective. The prompt builder uses
  **full form** (§8.4 adversarial example).

This is *additive* to the existing `resumeSessionId` / `priorNumTurns`
fields — those remain for crash-recovery resume. The two paths share
the underlying SDK `options.resume` plumbing but differ in:

- `clampMaxTurns` consults the segment-wide turn count, not just
  this stage's own prior attempts.
- The prompt builder receives `continuationMode = isContinuationStage`,
  not `continuationMode = (segmentContinuation !== undefined)`.

### 6.3 Runner: segment lifecycle

`runner.ts` currently calls `executeStage` per stage with
`resumeFieldsForStage` (M-R5 crash resume only). Extended:

1. Before dispatching each stage, look up its segment via the planner.
2. Compute `isContinuationStage = idx > 0` within the segment.
3. Resolve resume session in two phases:
   - **In-segment**: walk preceding stages of this segment (idx <
     current). Sum `num_turns` over all that ran. Pick the most
     recent persisted `session_id` among them as the resume target.
     Capture `priorAttempts` in segment order.
   - **Cross-segment fallback**: if no in-segment stage has a
     persisted session yet (typical for segment-first stages, idx
     0), BFS upstream by wires from this stage. The first agent
     ancestor with a persisted `session_id` is the resume target.
     This implements §3 "next segment opens a new query with
     options.resume pointing at the prior segment's session_id".
4. If a session was resolved, pass
   `segmentContinuation = { resumeSessionId, priorNumTurns,
   priorAttempts, isContinuationStage }`. Otherwise pass `undefined`
   (this stage is the first agent stage in the pipeline, or upstream
   is purely script/external/agents-without-sessions).
5. M-R5's crash-recovery resume continues to work unchanged for
   segment-first stages with no upstream agent ancestor; for
   continuation stages and cross-segment-resume stages, the segment
   lookup subsumes it.

No XState machine changes. Segment is a runner-side concept; the
machine still sees per-stage `executing → done` transitions.

### 6.4 Pipeline-generator updates (Q6 = C)

Prompt updates to `pipeline-generator` (the IR-authoring AI):

1. Recognise the four cases for `session_mode = "single"`:
   - Multi-stage refinement (explore → propose → refine)
   - Sequential reasoning where stage N+1 *interprets* stage N's
     output, not just consumes it
   - Long-context investigations where re-injecting context per stage
     would burn measurable token budget
   - Anything explicitly tagged "chat-style" by the user
2. Recognise the cases for `session_mode = "multi"`:
   - Independent transformations (each stage is a pure function over
     its inputs)
   - Pipelines with frequent gates/scripts (segments would all be
     size 1 anyway, single mode adds no value)
   - One-shot pipelines (size 1 everywhere)
3. When `session_mode = "single"` is chosen, emit continuation-style
   prompts (§4.1) for non-first stages in each agent-only segment.
4. Default to `multi` if uncertain. Adding `single` requires explicit
   reasoning in the pipeline-generator's plan output (so the human
   reviewer can sanity-check).

These are prompt-level changes, not code changes. They live in
pipeline-generator's `pipeline.ir.json` system-prompt section.

## 7. Migration of the five builtins (Q7 = B)

Per-builtin assessment (verified by reading each `pipeline.ir.json`
on 2026-04-25, not by assumption):

| Builtin | Stages | Decision | Rationale |
|---|---|---|---|
| `smoke-test` | greet → echoBack (2 agent) | **`single`** (min canary) | Two-stage linear agent segment, ideal smallest end-to-end test of the segment plumbing |
| `pr-description-generator` | fetchDiff → writePr (2 agent) | **`single`** (prod canary) | Two-stage linear agent segment with real workload — `fetchDiff` produces a diff, `writePr` interprets it. Textbook single-session case |
| `pipeline-generator` | analyzing → gate → genPrompts → genSkeleton → persisting | `multi` (no change) | Self-modification risk: this is the YAML-author pipeline; its own session model should be stable while we iterate on the feature it ships. Revisit after canary |
| `tech-research-collector` | collectTargetSources (1 agent) | `multi` (no change) | Single agent stage; mode irrelevant |
| `tech-research-writer` | writeDeliverable (1 agent) | `multi` (no change) | Single agent stage; mode irrelevant |

Migration of `smoke-test`:

1. Add `session_mode: "single"` to its `pipeline.ir.json`.
2. Inspect `echoBack` stage's prompt (`prompts/system/echo-back.md`
   or whatever the ref points to). Verify it's already short and
   continuation-shaped, OR rewrite to drop any redundancy with
   `greet`'s prompt. Keep the reads-section header (§4.2).
3. Re-run the smoke regression test; verify both attempts share
   `session_id` in `agent_execution_details`; verify segment lookup
   detected the segment.

Migration of `pr-description-generator`:

1. Add `session_mode: "single"` to its `pipeline.ir.json`.
2. Rewrite `writePr` prompt to continuation form: drop any
   "you are a PR description writer" persona block (covered by
   `fetchDiff`'s context which now lives in conversation history),
   keep the reads section (§4.2) and the "now produce the PR
   description for <reads.diff>" instruction.
3. Run on a real PR; verify segment session_id continuity; verify
   `cache_read_input_tokens` non-zero on stage 2 (cache hit on
   resumed conversation).

These two migrations are themselves verification of the design — if
neither visibly cuts tokens or improves perceived continuity, the
design is wrong.

## 8. Testing strategy

### 8.1 Pure-function tests (no SDK)

- `segment-planner.test.ts`: feed crafted IRs; verify segment list
  matches expectation. Cases: all-agent linear, agent → script →
  agent (two segments), agent → gate → agent (two segments), agent
  with fanout (each element its own segment), `session_mode: "multi"`
  always returns size-1 segments.
- `clamp-segment-turns.test.ts`: verify the segment-wide turn-budget
  math.

### 8.2 Runner integration tests with mock executor

- New file: `runner.single-session.test.ts`
- Uses `MockStageExecutor` configured to record what arguments it
  received per stage. Assert: continuation flag set on stages 2+,
  `resumeSessionId` plumbed correctly, segment boundaries respected.

### 8.3 Real executor smoke test

- Extend `smoke-test.linear-two-stage.test.ts` (or add a sibling).
  Run a 2-stage agent pipeline in `single` mode, verify:
  - Both attempts share `session_id` (same value in
    `agent_execution_details`)
  - Stage 2's prompt does NOT contain stage 1's full persona
  - `cache_read_input_tokens` on stage 2 is non-zero (SDK is reading
    from the resumed conversation cache)

### 8.4 Adversarial tests

- Crash mid-segment: kill the runner during stage 2 of a 3-stage
  segment. Restart. Verify orphan-reconciler picks up
  `session_id` from stage 2's partial attempt; new attempt resumes
  from there; segment integrity preserved.
- Gate mid-pipeline: 3-stage pipeline with gate between stages 2 and
  3. Verify two segments: [stage1, stage2] and [stage3]. Stage 3's
  prompt is full (it's a segment-first stage), even though
  semantically it's "after the user answered the gate."
- Retry across segment boundary: `RetrySpec.backToStage` points to
  stage 2 from a script at stage 4. Verify segment 1's session is
  reused on retry of stage 2 (it's the same segment-first stage as
  before).

## 9. Observability

No new tables. The existing `agent_execution_details.session_id`
field, when read across the rows of one segment, *is* the segment
trace. New SQL view (optional, not blocking the design):

```sql
CREATE VIEW v_segment_continuity AS
SELECT
  task_id,
  session_id,
  COUNT(*) AS stages_in_segment,
  GROUP_CONCAT(stage_name, '→') AS stage_path,
  SUM(token_input)               AS segment_input_tokens,
  SUM(cache_read_input_tokens)   AS segment_cache_reads,
  SUM(cache_creation_input_tokens) AS segment_cache_creates
FROM agent_execution_details aed
JOIN stage_attempts sa USING (attempt_id)
WHERE session_id IS NOT NULL
GROUP BY task_id, session_id
HAVING stages_in_segment > 1;
```

Used for: verifying single-session is actually winning vs multi (run
the same workload twice, compare segment input tokens).

## 10. Rollout plan

1. **Code lands behind `session_mode` flag.** All existing pipelines
   default to `multi`; nothing changes for them.
2. **`tech-research-writer` migrated** to `single` as the canary.
3. **One week of dogfood.** Real tasks run through the canary;
   v_segment_continuity inspected; token deltas measured.
4. **Pipeline-generator updated.** New pipelines start emitting
   `single` where appropriate.
5. **Roadmap §4 line 105 closed**: decision = "shipped, in canary."
   Re-evaluate scope for stage-level / topology-derived modes (the
   non-goals from §2).

## 11. Open issues / parking lot

- **Cross-segment `cache_creation_input_tokens` accounting.** When
  segment 2 starts with `options.resume`, the SDK rebuilds the
  conversation context server-side. That hits the prompt cache (5m
  TTL) if and only if segment 1 finished within the TTL window of
  segment 2's start. This may or may not be a practical concern; we'll
  measure during canary, not pre-optimise.
- **Sub-agent invocations inside a single-session stage.** The Claude
  Agent SDK's sub-agent feature spawns a child SDK query with its own
  session. Single-session at the *pipeline* level has no opinion on
  *sub-agent* sessions — they remain whatever the SDK does with them.
  Not in scope.
- **`pipeline-generator` self-hosting.** When pipeline-generator is
  asked to generate a pipeline that uses single-session mode, it
  emits IR using its own multi-session pipeline. No paradox; the
  generator and the generated are independent processes.
