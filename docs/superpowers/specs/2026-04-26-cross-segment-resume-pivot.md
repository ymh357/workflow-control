# Cross-Segment Resume — Design Pivot

> Date: 2026-04-26
> Status: Decision recorded; implementation deferred to a separate session
> Supersedes: `2026-04-25-single-session-mode-design.md` §3 (cross-segment-resume-by-default)
> Refines: `2026-04-26-single-session-niche.md` §6 (renames "leak fix" to "design correction")

---

## 1. The decision

`session_mode: "single"` segments must not silently extend their conversation into stages outside the planned segment. Cross-segment SDK session resume becomes **opt-in** via an explicit IR field. The current default — `findUpstreamSessionByWires` walking the wire graph and resuming any agent ancestor's session — is removed.

This is a behavior change to a documented design, not a bug fix. The 2026-04-25 single-session-mode-design spec §3 explicitly chose the current behavior; this pivot reverses that choice.

---

## 2. Why the original choice was wrong

Three independent reasons converge.

### 2.1 Self-inconsistency in the original spec

`2026-04-25-single-session-mode-design.md` §4.3 declares:

> "Segment is the unit of cancellation, retry, and resume."

But §3 + §6.3 then make cross-segment resume the default — every downstream stage that can BFS-walk wires to an upstream agent automatically inherits that agent's `session_id`. The two clauses contradict: if segment is the unit, the segment's effects should be bounded by the segment; if segment is not the unit (and effects propagate), then segment is not the unit.

We pick the first clause. Segment is the unit; effects stop at the boundary.

### 2.2 Loss of mode orthogonality

Under the original design, a stage marked `multi` (because its IR places it outside any single-mode segment) can still inherit an upstream segment's session. This means:

- Choosing `multi` for a stage no longer guarantees it starts from a clean SDK conversation
- Adding a `single` segment upstream silently changes the runtime behavior of every wire-reachable downstream stage, even those the author marked `multi`
- Reasoning about "what does this stage see" requires reasoning about the entire pipeline's segment plan + wire graph, not just the stage itself

This violates the principle that a stage's mode should be a property of the stage, not an emergent consequence of upstream choices. After this pivot, `multi` means what it says: fresh session, typed-port-only data flow.

### 2.3 Round 5 quantified the cost

Round 5 dogfood (web3-research generation under `session_mode: "single"`) measured a +34% wall-clock and +73% cost overrun versus multi. Cumulative `cache_read_input_tokens` grew 261K → 261K → 482K → 654K across the four agent stages. The conversation accumulated monotonically because cross-segment resume connected every stage to the segment's session, not just the in-segment stages.

If cross-segment resume were truly the design intent, this 73% cost would be the *price of single-mode pipelines*, full stop. But the IR's `genPrompts` and `persisting` stages have no implicit working-state dependency on `analyzing`/`genSkeleton` — they consume typed ports cleanly. The right answer is "those stages should run as multi". The original design prevented this by making cross-segment resume automatic; this pivot allows it.

---

## 3. The new contract

### 3.1 Within-segment resume — unchanged

Stages co-located in the same segment by `segment-planner` continue to share an SDK session, with the segment's first stage starting a fresh query and subsequent stages receiving `options.resume = <prior in-segment stage's session_id>`. This is what makes single-mode "single": the segment is one conversation.

### 3.2 Cross-segment resume — opt-in only

A stage in segment B does **not** automatically resume any session from segment A, even if B's wires reach back to A's agents. Cross-segment session sharing must be expressed by an explicit IR field. Strawman:

```ts
// On a stage:
{
  name: "downstreamStage",
  type: "agent",
  config: {
    promptRef: "...",
    cross_segment_resume_from: "upstreamStage",  // optional, must name a wire ancestor
  },
  ...
}
```

Validation rules for the new field:
- The named stage must exist in the same pipeline
- The named stage must be wire-reachable upstream (BFS reachable from this stage's wires)
- The named stage's segment must be a different segment from this stage's
- (Open question) Whether the named stage must be the segment's last stage or any in-segment agent — leaning toward "any agent in the upstream segment", but defer until first concrete use case

### 3.3 Multi-mode pipelines — strictly unaffected

A pipeline with `session_mode: "multi"` (the default) MUST behave byte-identically whether or not the kernel even compiles single-mode code paths. This is the orthogonality property §2.2 demands. Operationally:

- `runner.ts` segmentContinuationFor returns `undefined` for any pipeline with `session_mode: "multi"` — no resume, no in-segment magic, no cross-segment magic
- `real-executor.ts` does not pass `options.resume` for multi-mode stages unless M-R5 (per-stage resume after error / orphan recovery) explicitly sets `resumeSessionId`

Existing multi-mode pipelines (web3-research, smoke-test's multi variant if any, all not-yet-built future pipelines) are unaffected by this pivot.

### 3.4 Existing single-mode pipelines

Two builtin pipelines currently use `session_mode: "single"`:

- `smoke-test`: 2 agent stages (echoBack → greet). Single segment. No cross-segment resume in play. Unaffected.
- `pr-description-generator`: 2 agent stages (fetchDiff → writePr). Single segment. No cross-segment resume in play. Unaffected.

Pipelines that the (deferred-into-an-uncertain-future) niche work eventually produces will start with no cross-segment resume. If a real use case for cross-segment resume emerges, it can opt in via §3.2's mechanism.

---

## 4. Why this isn't a "small fix"

It touches:

- **IR schema** (`ir/schema.ts`): add optional `cross_segment_resume_from: string` to `AgentStageSchema`'s `config`
- **Canonical hashing** (`ir/canonical.ts`): include the new field
- **Runtime** (`runtime/runner.ts`): remove the unconditional Phase 2 fallback in `segmentContinuationFor`; replace with a check for the new IR field
- **Validator** (`validator/structural.ts`): enforce the rules in §3.2 — referenced stage must exist, must be wire-reachable, must be in a different segment
- **Tests**: `runner.single-session.test.ts:207` ("diamond fan-out a→b, a→c: both b and c resume a's session_id") and similar tests encode the *current* behavior — they must be rewritten to assert the new behavior. Some tests may need to declare the new IR field to keep prior intent
- **Docs**: `2026-04-25-single-session-mode-design.md` §3 must be updated or marked superseded; `niche.md` §6 must be re-worded from "leak fix" to "design pivot"
- **Hot-update / patch table** (`mcp/patch.ts`): if `cross_segment_resume_from` becomes mutable post-submit, the patch table needs the key listed (relates to F16's general gap)

This is roughly 1-2 focused days. It is not appropriate to do in the same session that wrote the niche spec, because the relationship between the niche spec and this pivot — niche §6 was originally written as "leak fix" but is actually "design pivot" — needs a clean re-edit pass that's better done after the implementation lands and reality has tested the contract.

---

## 5. What this session does and does not do

**Does**:

- Records this decision so the next session has full context
- Renames Finding 13's "leak fix" framing in `niche.md` to acknowledge the design-pivot nature (deferred to that document; this spec is the authoritative location for the rationale)
- Provides the implementation blueprint in §3 + §4 above

**Does not**:

- Touch code. `runner.ts:1707-1719` remains unchanged in this session. The cross-segment-by-default behavior persists until the pivot is implemented as its own focused work item.
- Touch IR schema. The new optional field is described but not added.
- Update existing tests. They keep passing against current behavior.
- Update the original 2026-04-25 design spec. It will be marked superseded when this pivot's implementation lands and the new behavior is verified.

This split ensures the *decision* is captured immediately while the *implementation* gets the focused attention it deserves on its next session.

---

## 6. Implementation acceptance criteria (for the next session)

When this pivot is implemented:

1. New IR field `AgentStage.config.cross_segment_resume_from?: string` added to schema, canonical, validator
2. `runner.ts` `segmentContinuationFor`'s Phase 2 path removed; replaced with a check that consults the new field
3. `runner.single-session.test.ts:207` and any sibling tests asserting cross-segment-by-default behavior are rewritten to either assert the new default (no resume) or declare the IR field and assert opt-in resume
4. Add at least 2 new tests:
   - Multi-mode pipeline with diamond topology: no resume anywhere, byte-identical to current multi-mode runner output
   - Single-mode pipeline with explicit `cross_segment_resume_from`: resume happens; without the field on the same IR, no resume
5. `niche.md` §6 re-worded; original `single-session-mode-design.md` §3 marked superseded with link to this spec
6. Full test suite (1792+ tests) passes; tsc clean
7. The web3-research pipeline (versionHash `e6f281e9...`) re-runnable as a baseline regression — multi-mode behavior must be byte-identical to current

---

## 7. Why this matters beyond this session

`session_mode: "single"` is a small feature. Most users will never use it directly. But the principle this pivot enforces — *a stage's mode is its own property, independent of upstream choices* — is foundational. Without it, mixing modes in real pipelines becomes a guessing game about implicit propagation, and `multi` stops meaning anything. Fixing this now, while the pipeline ecosystem is small enough that no production pipelines depend on the current cross-segment-by-default behavior, is much cheaper than fixing it later when behavior changes break workflows already in production.

The pivot also unblocks niche-spec resumption: §10 of `niche.md` listed "fix cross-segment leak" as the first prerequisite for re-opening the niche definition. With this decision recorded and implementation queued, that prerequisite is now an actionable work item rather than a vague worry.
