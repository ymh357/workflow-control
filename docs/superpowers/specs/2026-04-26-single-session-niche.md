# Single-Session Niche Definition

> Date: 2026-04-26 (last updated 2026-04-27)
> Status: **§10.4 step 1 DONE → niche feasibility now actually testable.** Sections §10.4 steps 2-3 (run a true niche-internal A/B experiment and re-evaluate the spec with empirical data) remain open. pipeline-generator continues to NOT emit `session_mode: "single"` until that experiment lands. The runtime feature itself remains; only the generator's use of it is gated off.
> Trigger: 2026-04-26 round 5 dogfood proved the current single-session mode is misapplied to structured-data-flow pipelines (+34% wall, +73% cost vs multi). Brainstorming a niche definition revealed that the boundary between "single is genuinely better" and "single is misapplied" is not yet operationally definable.
> 2026-04-27 update (A6 of `2026-04-27-followup-session-handoff.md`): the cross-segment-resume pivot called for in §10.4 step 1 has landed (commits `f2429fe..44fc37b`). Multi-session pipelines are now byte-identical regardless of whether single-session segments exist, eliminating the round-5 cost-data contamination. §10.4 is updated to record this. Steps 2-3 are now executable as a focused experimental session — see §10.4.

---

## 0. Why this document exists

Three standards `session_mode: "single"` must satisfy to justify its existence:

1. **Must not be worse than running the same work as a single un-wrapped agent in Claude Code.** If wrapping an agent loop in workflow-control's single-session mode is slower / costlier / less ergonomic than just running it as one SDK session, the feature is dead weight.
2. **Side effects must be minimal.** Choosing single for one segment must not affect any stage outside that segment. Multi-session pipelines must be unaffected by the existence of single-session as a feature.
3. **Must be strictly better than multi-session in its target scenario.** If multi can match single's quality and cost on a given pipeline, single is design noise. There must be a non-empty set of pipelines where single is the *only* correct answer.

The 2026-04-26 round 5 measurements (web3-research generation under `session_mode: "single"`) violated all three: +34% wall-clock, +73% cost vs multi-session, with the same output quality. Root cause: misapplied to a structured-data-flow pipeline.

This document defines the niche where single-session is the only correct answer, so future generator decisions and runtime behavior can be anchored to a precise contract.

---

## 1. The reason for being

> **Single-session lets a workflow-controlled agent loop carry working state across stage boundaries — getting workflow's structural benefits without paying multi-session's working-state-loss penalty.**

A bare SDK conversation already preserves working state for free. Workflow control adds value over a bare conversation by providing:

- **Human gates** with structured approval/reject paths that survive process restarts
- **Per-stage retry granularity** — re-run any stage without redoing the whole conversation
- **Hot-update** — change the pipeline mid-run, propagate diffs as advisory hints to the live attempt
- **Observability** — every stage attempt persisted with prompt/tool-calls/cost/duration, queryable via dashboard
- **Mid-run data injection** — `task_env_values`, `seed_values`, gate replies feed into the running pipeline through structured channels
- **Resume after crash** — orphan reconciler reattaches running stages on server restart

Multi-session pipelines get all of the above for free, but pay a price: structured typed ports are the only way data flows between stages. Working state that resists structuring (mid-formed judgments, tool exploration history, ruled-out hypotheses) is **lost** at every stage boundary. Downstream re-derives or re-explores.

Single-session's reason for being is to **eliminate that loss for the cases where it matters**, while keeping every workflow benefit listed above. The minute either side of this contract breaks — workflow benefits don't accrue, OR the working state could have been cheaply structured anyway — single-session has no reason to exist.

"Working state" specifically means: agent thinking blocks, tool call history, partial judgments not yet finalized, exploration paths attempted, hypotheses ruled out. NOT structured outputs — those are typed ports' job.

The **cannot be cheaply structured** clause is the crux. If working state can be packed into a handful of small ports without significant loss, multi-session + those ports is strictly better (lower cost, no leak risk, more debuggable). Single-session is justified only when packing is infeasible or lossy. §4 defines the test.

---

## 2. Hard criteria for choosing single

ALL must hold. Failure of ANY single criterion → use multi.

| # | Criterion | Test |
|---|---|---|
| (a) | Implicit working state exists between adjacent stages, AND it cannot be expressed as ≤5 small typed ports (each ≤ `INLINE_PORT_VALUE_CHAR_LIMIT`) covering ≥90% of what downstream needs | Try to list the ports. If list is empty, criterion fails (no state) → multi. If list is small enough, criterion fails (state IS structurable) → multi+ports. If list explodes / each entry is open-ended → single |
| (b) | Downstream prompt naturally contains a phrase like "based on what you tried / explored / considered / ruled out above" | Write the downstream prompt without seeing upstream conversation. If it sounds incomplete or forces upstream to over-specify, criterion holds |
| (c) | **Every** adjacent pair `(stage_i, stage_{i+1})` within the proposed segment independently satisfies (a) AND (b) | Per-pair test, not per-segment. A 3-stage chain qualifies for single iff pair (1,2) AND pair (2,3) both pass. Chains where only some pairs pass MUST be split: only the qualifying pairs become single segments, the rest stay multi |
| (d) | No gate / script / fanout inside the segment | Already enforced by segment-planner. Listed for completeness |

**On segment length**: there is **no hard upper bound on N**. Length is an emergent result of (c): if every adjacent pair passes (a)+(b), the segment is as long as the chain. In practice almost all real refine chains are 2 or 3 stages; chains of 4+ that genuinely satisfy per-pair (a)+(b) are rare but legitimate. If you see N≥4 emerging, treat it as a strong signal to re-examine each pair's (a)(b) verdict for honesty — but do not reject solely on length.

The 1KB threshold in (a) is bound to `INLINE_PORT_VALUE_CHAR_LIMIT` (defined in `real-executor-prompt-builder.ts:14`). If that constant changes, this criterion auto-updates: the question is always "can downstream's needs fit in ports that prompt-builder will inline efficiently?"

---

## 3. Disqualifying scenarios (always multi)

These are reverse-derivable from §2 but listed for fast lookup during pipeline review:

- **Structured data flow.** Each stage consumes typed ports from upstream and emits typed ports for downstream. Examples: classification → analysis → report; collect → analyze → synthesize. The web3-research pipeline is the canonical example: 9 stages, every input/output is structured, no implicit state. Round 5 misapplied single here and paid +73% cost.
- **Single long-running agent task wanting stage isolation.** If the work is genuinely one agent loop and stages are added only for retry granularity / observability, use a single multi-session stage. Adding artificial stages and marking them single is overengineering.
- **Cost-optimization motivation.** "Reusing prompt cache will save tokens" is **not** a valid reason to choose single. Cache savings on a structured-data-flow pipeline are dwarfed by conversation re-replay overhead. See round 5 evidence (Finding 13).
- **Pipelines with gates, scripts, or fanouts inside the proposed segment.** segment-planner rejects this; listed because authors sometimes try to "work around" by reordering stages.
- **Debugging scenarios.** Wanting to see upstream thinking during development is NOT a reason to mark a pipeline as single. Use the dashboard's `agent_execution_details.agent_stream_json` to inspect any stage's thinking after the fact. Pipeline mode should reflect production semantics, not debug ergonomics.

---

## 4. The implicit-state structurability test

A binary check, designed to be answerable by both LLMs (during generation) and humans (during review). The test:

> **Pretend you must hand off from upstream stage to downstream stage WITHOUT shared conversation. Write down the smallest set of typed ports the upstream must emit for downstream to do its job at ≥90% quality. Count the ports and check each port's expected JSON-stringified size.**

Decision matrix (port size threshold = `INLINE_PORT_VALUE_CHAR_LIMIT`, currently 1024):

| Port list result | Verdict |
|---|---|
| 0 ports — downstream doesn't actually need anything from upstream | NEITHER mode applies — these stages are independent, not a chain |
| 1–5 small ports (each ≤ `INLINE_PORT_VALUE_CHAR_LIMIT`) covering ≥90% of downstream's needs | **Multi** with these ports. Single would waste resources |
| 6+ ports needed OR any single port is unavoidably large (>`INLINE_PORT_VALUE_CHAR_LIMIT`, e.g. agent's exploration log, free-form judgments, raw tool history) OR ports cannot be enumerated ahead of time (downstream's needs depend on what upstream happened to find) | **Single** is justified |

The middle case is the win condition for multi. The crux of the niche is when this reduction fails — typically because the working state is open-ended ("which files felt off") or runtime-dependent ("downstream needs to know what upstream tried, which depends on what upstream found").

### Worked examples

**Example A (multi — clean structured handoff)**: `classifyTarget → produceReport`
- Upstream → downstream needs: `entityType: string`, `typeReasoning: string`, `typeConfidence: string`, `atomSet: string[]`
- 4 small ports, full quality. **Multi.**

**Example B (single — open-ended working state)**: `exploreCodebase → proposeRefactor`
- Upstream → downstream needs: which files were read, what patterns were noticed, which directories were skipped and why, partial intuitions about coupling, files that "felt off" without crisp evidence
- Cannot be cheaply structured: the "intuitions" and "felt off" judgments are exactly the working state. **Single.**

**Example C (multi — looks like refine, isn't)**: `draftSummary → editSummary`
- Looks like refine. But upstream → downstream needs: `draft: string` (the markdown), `tone: "formal" | "casual"`, `targetLength: number`
- 3 small ports. Editor doesn't need the writer's thinking — it works on the draft. **Multi.**

**Example D (single — runtime-dependent context)**: `factCheck → resolveContradictions`
- Upstream produces a list of conflicts but also unstated context: which sources were checked vs skipped, which claims were borderline, what fetch attempts failed transiently
- Resolver needs to know whether a "missing source" was a hard failure or an authoritative absence. **Single.**

**Example E (BORDERLINE — should resolve to multi)**: `analyzeData → writeFindings`
- Tempting to say single because "writeFindings needs to know what analyzeData noticed".
- But the structuring test: `findings: object[]` (each with `finding`, `evidence`, `confidence`), `summary: string`, `dataNotes: string[]` (caveats / unusual values noticed)
- 3 ports, two small two medium. Quality at 90%+ achievable. The "what analyzeData noticed" is structurable as `findings + dataNotes`. **Multi.**
- If you find yourself wanting single here, you've under-specified the upstream's outputs. Add more structured ports first.

**Example F (BORDERLINE — should resolve to single)**: `proposeAPIDesign → critiqueAPIDesign`
- Tempting to say multi because "critique just reads the proposal".
- But: a serious critique needs to know which alternatives the proposer **considered and rejected**, not just the chosen design. Listing rejected alternatives in a port is possible but lossy — the rejection reasoning is often "I tried this and it felt off when I traced through these 4 use cases", which is exactly working state.
- 5+ ports needed if you try to capture this; rejection-reasoning ports inevitably exceed 1KB. **Single justified.**

---

## 5. On segment length (no hard cap, soft heuristic)

There is no hard upper bound on N. Length emerges from §2(c) — every adjacent pair must independently satisfy (a)+(b). A 5-stage chain that genuinely passes per-pair is legitimate; a 2-stage chain that fails per-pair is not.

**Heuristic check** (informational, not gating): segments of length ≥4 in real pipelines are rare. Refine chains in human work tend to bottom out at 2–3 steps (draft→polish, explore→propose→commit, hypothesize→test→adjust). When generator output proposes N≥4, treat as a strong signal to re-examine each pair's (a)(b) verdict for honesty — but do not auto-reject.

**No prior assumed retry cost penalty.** Earlier drafts of this spec argued long single segments are bad because retries replay the segment. This is no worse than the bare-SDK baseline (a Claude Code conversation also restarts from scratch on retry). The §1 contract — "must not be worse than bare SDK" — already constrains this; no separate length cap is needed.

---

## 6. Segment boundary hardness — the design pivot from cross-segment-by-default

A single-session segment must be a **closed unit**. Its existence must not change the behavior of any stage outside it.

**The current implementation does not satisfy this** — and on closer inspection, the original 2026-04-25-single-session-mode-design spec §3 deliberately chose the opposite: `runner.ts:1707-1719` (`findUpstreamSessionByWires`) lets any downstream agent stage resume the nearest upstream agent's session via wire BFS, regardless of segment placement. This was framed as "cross-segment resume" in §3 of the original spec, not as a leak.

**This niche spec disagrees with that original design choice.** The decision to flip cross-segment resume from default-on to opt-in is documented as its own design pivot in `docs/superpowers/specs/2026-04-26-cross-segment-resume-pivot.md` (written same date as this niche spec). That pivot supersedes the original §3.

The reason for the pivot, in one paragraph: when a stage marked `multi` can still inherit a single segment's conversation history just because wires reach back to that segment, "multi" stops meaning what it says. Round 5's 73% cost overrun was the visible symptom — `genPrompts` and `persisting` were structurally multi but ran with full single-segment conversation because of the wire-walk default. Fixing `multi` to mean "fresh session" requires defaulting cross-segment resume off and introducing an opt-in IR field.

**Required hardness invariants** (post-pivot):

1. **Resume only within the planned segment.** Two stages share a session iff `segment-planner` placed them in the same segment.
2. **Cross-segment resume is opt-in.** Express via the IR field `cross_segment_resume_from: <stageName>` on the receiving stage's `config`. Default behavior across any cross-segment edge: fresh session, typed-port-only data flow.
3. **Multi-session pipelines must be byte-identical in behavior whether or not the kernel even compiled the single-session code paths.** Pure feature flag: enabling single for some segments must not perturb anything outside those segments.

**Implementation status (2026-04-27 update)**: the pivot has landed. The original `findUpstreamSessionByWires` wire-walk default has been removed; cross-segment resume now requires the IR opt-in field `config.cross_segment_resume_from: <stageName>` on the receiving agent stage, and the structural validator enforces (i) the target stage exists, (ii) the target is an agent stage, (iii) the target is wire-upstream via BFS, (iv) the target lives in a different segment, and (v) the pipeline is multi-mode. The field participates in canonical form / version_hash with hash stability when absent (the canonical JSON omits the key entirely). Multi-mode pipelines that do not set the field are byte-identical in runtime behavior to a build that lacks the single-session code paths entirely — satisfying §6 invariants 1-3. See commits `f2429fe..44fc37b` (11 commits) for the implementation; tests in `apps/server/src/kernel-next/validator/structural.test.ts` and `apps/server/src/kernel-next/runtime/runner.single-session.test.ts` exercise both happy and rejection paths.

---

## 7. Performance and quality contract within the niche

When all criteria in §2 hold and §6 invariants are honored, single-session must satisfy three independent contracts:

### 7.1 Performance vs bare-SDK baseline

The reference baseline is "the same agent loop run as one continuous SDK conversation, with no workflow-control wrapping at all". Bounds:

| Metric | Bound | Rationale |
|---|---|---|
| Wall-clock | ≤ baseline + 5s × N (N = stage count) | Per-stage overhead covers SDK subprocess startup, segment-planner DB query, attempt row insert. Multi already runs at this overhead; single must not be worse |
| Cost | ≤ baseline × 1.05 | Prompt cache hits should make resume nearly free. >5% means a fixable inefficiency in the kernel's resume path, not a fundamental cost |

Anything beyond these bounds means one of:
- The pipeline misapplied single (criteria §2 not actually met) → fix the generator's choice
- The runtime has a leak or inefficiency → fix the kernel
- The niche is mis-defined → revise this document

### 7.2 Performance vs multi-session equivalent

| Metric | Bound | How measured |
|---|---|---|
| Wall-clock | ≤ multi-equivalent (single must not be slower than multi running the same logical work) | A/B run of two pipeline variants on identical inputs |
| Cost | ≤ multi-equivalent × 1.20 | Single can spend marginally more on retained conversation cost, but only when it pays off in quality (see 7.3). >20% premium without a quality win = niche misapplied |

### 7.3 Quality contract — single must produce a STRICTLY better outcome

This is the make-or-break test. If 7.3 fails, single has no reason to exist.

**Definition of "better"**: on the same input, the single-session pipeline's terminal output must score higher on a niche-specific quality rubric than the multi-session-with-equivalent-ports pipeline. The rubric depends on the niche scenario:

| Niche scenario class | Quality rubric |
|---|---|
| Refine chains (draft→polish style) | Reviewer (human or LLM) prefers single's output, AND the preference is attributable to working state preservation (e.g., "the polish addressed nuances visible in the draft's thinking that wouldn't be in a small ports digest") |
| Explore→propose chains | Single's proposal references upstream's exploration paths; multi's proposal duplicates exploration work, OR misses paths that upstream had ruled out |
| Critique chains | Single's critique catches issues a port-only handoff would miss (specifically: issues that depend on rejected-alternatives reasoning) |

If two evaluators independently cannot articulate why single's output is better — single isn't justified for this scenario, regardless of how it performs on 7.1 and 7.2.

---

## 8. What this niche definition does NOT do

- It does NOT prescribe an implementation. The §6 hardness invariants and §7 performance bounds are the contract; how the kernel achieves them is a separate design.
- It does NOT optimize multi-session. Multi-session is the default and is already correct for the vast majority of pipelines. This niche document is purely about defending single-session's right to exist.
- It does NOT introduce new IR concepts (working memory, summary ports, trace ports, etc.). Those were earlier proposals; this niche operates within the existing typed-port + session_mode model.
- It does NOT relax the rule that `session_mode` defaults to multi. Single is opt-in, requires evidence per the structurability test (§4).
- It does NOT introduce automatic compaction. Any kernel-driven compact mid-session would make single-session non-deterministic (compact summaries are LLM-generated, vary per run) and break §6's hardness invariants. If conversation length becomes a concern within an N≥4 segment, the answer is "split into smaller segments via §2(c) re-evaluation", not "let the kernel auto-compact".

---

## 9. Acceptance for this definition

The niche definition is accepted when **all** of the following pass:

### 9.1 Test corpus construction

Construct a labeled corpus of 10 candidate pipelines (text descriptions, no implementation needed):

- **5 niche-positive** examples — pipelines where single-session is the correct choice. Seed with: `exploreCodebase → proposeRefactor`; `factCheck → resolveContradictions`; `proposeAPIDesign → critiqueAPIDesign`; one new example involving 3 stages where pair-wise (a)+(b) all hold; one new example mimicking a real-world refine task the user has actually wanted.
- **5 niche-negative** examples — pipelines where single is wrong. Seed with: web3-research (the round-5 anti-example); `classifyTarget → produceReport`; `draftSummary → editSummary` (looks like refine, isn't); `analyzeData → writeFindings` (borderline-multi from §4 example E); a single-long-task case that wants stage isolation only.

This corpus is checked into the repo at `docs/superpowers/specs/2026-04-26-single-session-niche-corpus.md` as a companion file.

### 9.2 Verdict concordance

On the 10-pipeline corpus:
- An LLM applying §2's criteria produces a verdict (single / multi)
- A human reviewer (the spec author) independently produces a verdict
- Concordance ≥ 9/10 (90%+). Disagreements must be explicitly resolved either by spec clarification or corpus re-labeling.

### 9.3 Misapplication coverage

For every misapplication mode currently known (round 5 web3-research, "I want to share state for debugging", "I want to save tokens"), §3 must explicitly call out the scenario. Verified by spec author check.

### 9.4 Implementation feasibility for §6

A short feasibility note (≤2 paragraphs) confirming that the §6 hardness invariants — particularly cross-segment-resume opt-in — can be implemented in `runner.ts` with bounded effort and without breaking existing multi-session test cases. This note becomes the seed for the implementation plan.

### 9.5 Performance contract is testable

The §7 contracts must be measurable by a concrete experimental protocol:
- Same input run as: (a) bare SDK loop, (b) workflow multi-session, (c) workflow single-session
- Wall-clock, cost, output captured for all three
- Quality scored by the §7.3 rubric

If we cannot describe this experiment without ambiguity, §7's contracts are aspirational and §9 fails.

---

This document supersedes any earlier interpretation of `session_mode: "single"` semantics. Where this document conflicts with `gen-skeleton.md:301-325`, this document is authoritative; `gen-skeleton.md` is to be updated downstream as part of the implementation plan derived from this spec.

---

## 10. Why this spec is paused (open questions for future resumption)

The brainstorming session that produced this spec surfaced three unresolved questions that block acceptance per §9. Recording them here so a future resumption can pick up with full context:

### 10.1 Is single-session a paradigm or a performance optimization?

I tried two framings:
- **Independent paradigm**: single is "continuation-style" (one agent at multiple checkpoints) vs multi's "function-style" (independent stages communicating via typed ports). Sounds elegant; runs into the problem that any working state CAN theoretically be serialized into a typed port — so "function-style" is a superset, not a peer.
- **Performance optimization**: single is multi with conversation-history reuse. Honest but reduces single's reason-to-exist to "save tokens / preserve nuance lost in port serialization". Then the question becomes: in what scenarios does this trade-off win?

The user's four points (gathered during brainstorming) suggest a hybrid:
1. Quality: downstream sees full upstream working state → better-targeted answers
2. Cost (cumulative across the whole pipeline, not per-stage): no re-transmission of working state through ports
3. Capability assumption: single is paired with 1M-context models so long conversation isn't a constraint
4. Baseline: better than bare SDK (workflow benefits) and better than multi (in niche scenarios)

These four are operational claims that need empirical verification on a real niche-internal pipeline. Until that experiment runs, §1's "reason for being" remains under-justified.

### 10.2 Is round 5's cost regression fundamental or implementation-fixable?

Round 5 measured single-session at 1.73× the cost of multi-session on the same input. Two possible interpretations:

- **Fundamental**: SDK resume's full-transcript replay makes single-session structurally more expensive, and prompt cache helps but doesn't eliminate the gap. If true, the user's claim (2) ("不用重复信息减少成本对整体来说") is wrong on current SDK semantics, and single's only justification reduces to (1) quality.
- **Implementation-fixable**: most of the regression came from cross-segment leak (genPrompts and persisting were not in the segment but inherited the conversation via `findUpstreamSessionByWires`). If we fix the leak, single's cost on a properly-scoped 2-3 stage segment may be ≤ multi.

This cannot be answered without an experiment on a real niche-internal task (e.g., explore→propose). The web3-research data is contaminated by mode misapplication.

### 10.3 Is "quality strictly better" measurable without circular reasoning?

§7.3 quality contract reduces to "reviewer prefers single's output and the preference is attributable to working state preservation". The "attributable to" clause is what a fair experiment would require, but it's also what the niche definition needs to establish in the first place. We risk circular validation: we say "single wins on quality because reviewer prefers it" and "reviewer prefers it because single preserves working state" without independent grounds.

A possible escape: pick tasks where the upstream's working state contains specific pieces of information (e.g., "files that were considered then ruled out") that any human reviewer can independently verify the downstream output references or fails to reference. This makes "attribution" objective, but requires careful task design.

### 10.4 What unblocks resumption

Three things must happen in order before this spec can be accepted:

1. ✅ **Implement the cross-segment-resume pivot** (commits `f2429fe..44fc37b`, 2026-04-27). Done. Cross-segment resume is now opt-in via the IR field `config.cross_segment_resume_from`. Multi-mode pipelines without the field are byte-identical to a kernel without single-session — eliminating the round-5 cross-segment leak that contaminated all earlier cost measurements. See `docs/superpowers/specs/2026-04-26-cross-segment-resume-pivot.md` (the pivot spec) and `2026-04-27-session-handoff.md` §1 for the implementation summary.

2. ⏳ **Run a true niche-internal A/B experiment** (NEXT). All offline preparation is done — every IR, every prompt, every protocol step, the scoring rubric, and the results template are checked into `docs/superpowers/specs/single-session-niche-experiment/`. The remaining work is the live runs themselves (~$5-15, ~2-4 hours wall-clock) plus scoring. Re-read the README in that directory before resuming. Candidate scenarios from §4 (intentionally pre-vetted as niche-positive):
   - **Explore→propose chain**: a 2-stage pipeline that explores a small codebase (read N files, accumulate intuitions about coupling / smell) and then proposes a refactor. The "what files felt off" working state is the §4 test's open-ended-state requirement.
   - **Critique chain**: a 2-stage pipeline that proposes a small API design and then critiques it, where the critique stage benefits from knowing which alternatives the proposer considered and rejected (§4 example F).

   The experiment must produce three runs on identical input:
   - (a) **Bare-SDK baseline**: one continuous Claude Code conversation, no workflow wrapping
   - (b) **Workflow multi-session**: same logical work split across the same 2 stages, but `session_mode: "multi"`, with the smallest set of typed ports the §4 structurability test would land on
   - (c) **Workflow single-session**: same 2 stages, `session_mode: "single"`, no extra ports beyond what the work strictly requires

   For each run: capture wall-clock, total cost (USD), input/output tokens, and the terminal artifact (proposal markdown / critique markdown). Score quality via the §7.3 rubric using two independent reviewers (LLM + human, or two LLMs with different system prompts) — record agreement rate, not just average score. The experiment must be designed to make the "attribution" clause of §7.3 verifiable: pre-commit to specific working-state items (e.g., a list of files the explorer considered then ruled out) and check whether the downstream output references them. Without this pre-commitment, the quality contract reduces to circular reasoning per §10.3.

   Estimated cost: ~$5-15 across the 3 runs × 2 scenarios = 6 runs total. Estimated wall-clock: 2-4 hours of focused work to author the pipelines + run + score + write findings. This is a focused research session, not a bug-fix session — it should be scoped explicitly with the outcome (vindicate or kill the niche) called out before starting.

3. ⏳ **Resume this spec with empirical data** (BLOCKED on step 2). Re-evaluate §1 (paradigm vs optimization), §7 (performance contract numbers), §9 (acceptance criteria) against actual measurements rather than reasoning. The current §7 numbers (≤5% baseline overhead, ≤20% multi premium) are placeholders; step 2 either confirms them, tightens them, or rejects them.

**Current state (2026-04-27)**: step 1 is closed; steps 2-3 remain. pipeline-generator continues to NOT emit `session_mode: "single"` (the gate stays in place — the runtime feature is implemented but the generator's automatic use of it is suppressed pending §9 acceptance via step 3). The runtime feature stays compiled in so manual experiments (step 2) can be authored against it without a code-rebuild round-trip.

**Why the gating decision is still right**: the original gating was "we don't know when single helps". Step 1 removed the *contamination* that prevented us from measuring. It did not produce evidence that single helps anywhere — that requires step 2. So the generator gate stays.

**Recommended next session shape** (when someone resumes):
- Open as "Single-session niche experiment session". Scope: complete §10.4 step 2 + write findings + decide whether to proceed to step 3 or abandon the niche.
- First action: re-read `docs/superpowers/specs/single-session-niche-experiment/README.md` — that file points at the protocol, the rubric, the results template, and every IR + prompt needed to run the experiment.
- Pre-flight: confirm kernel-next server is up + cross-segment-resume pivot is in place (it is).
- Run all 6 variants (2 scenarios × 3 modes) per the protocol; bare-SDK runs are manual, the workflow runs use the new web launcher (B-track, 2026-04-27).
- Score with two independent reviewers per output, double-blind.
- Apply the decision matrix in `protocol.md §5` strictly.
- The experiment can fail honestly: if the multi+ports run scores as good or better on quality at lower cost, that is a *valid* outcome and means the niche has no real members — at which point the runtime feature should be retired alongside the spec.
