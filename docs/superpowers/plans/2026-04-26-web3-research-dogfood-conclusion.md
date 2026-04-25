# Handoff: web3-research dogfood — final state

> **Date**: 2026-04-26 (session ended ~04:40)
> **Status**: Closed — round 4 succeeded, round 5 informed niche pause, all changes committed.
> **Predecessor**: `2026-04-26-web3-research-round-4-handoff.md` (handed off into this session)

---

## 1. What this session did

Picked up the `web3-research` dogfood at the round 4 invocation point and ran it through to completion, then continued into a round-5 experiment on `session_mode: "single"`, then concluded the dogfood by committing all changes.

Three rounds, three different outcomes:

- **Round 4**: invoked pipeline-generator with multi-session mode (default). 31.5 min, $3.56. Successfully produced web3-research pipeline `versionHash e6f281e9a8de0777058196efef281c8009b4ab80a5dcbcee1a03bf9a3c6c7b65`. All 12 prior dogfood findings stayed fixed; no new code-level findings emerged.
- **Round 5**: re-ran the same spec under `session_mode: "single"` to test the hypothesis "single saves tokens via cache reuse". Result: 42.2 min, $6.17. **+34% wall-clock, +73% cost** with identical output quality. Mode misapplication — single-session does not fit a structured-data-flow pipeline.
- **Round 5 aftermath**: brainstormed a niche definition for `session_mode: "single"`. Surfaced unresolved fundamental questions. Paused niche work, instructed pipeline-generator to never emit single, kept the runtime feature.

---

## 2. What is committed

Three commits on `main`:

```
5266b46 docs(spec): single-session niche — TODO research breadcrumb
cb073df feat(pipeline-generator): web3-research dogfood — IR/prompt updates + session_mode pause
f21c537 fix(kernel-next): 12-finding dogfood infrastructure fixes
```

All previously open changes from the prior session (handoff §8 punch-list of 15 modified + 4 new files) are now committed. Plus the round-5 experiment artifacts and niche research breadcrumb.

**Net diff**: 21 files changed, ~2,500 insertions, ~170 deletions across kernel runtime, pipeline-generator builtin IR/prompts, dogfood findings doc, handoff doc, niche spec, and the original task description spec.

---

## 3. Round 4 deliverable: the web3-research pipeline

Lives in `pipeline_versions` row `e6f281e9a8de0777058196efef281c8009b4ab80a5dcbcee1a03bf9a3c6c7b65` in `/tmp/workflow-control-data/kernel-next.db`. It is **NOT** materialized as a builtin under `apps/server/src/builtin-pipelines/`.

Shape (validated against round-4-handoff §7 acceptance criteria):
- 9 stages + 1 human gate (awaitApproval)
- session_mode: multi
- classifyTarget emits `entityType` + `atomSet` (no TS reserved words)
- atomAnalysis emits a single markdown port `analysisReport`
- adversarialFactCheck prompt explicitly forbids store-as-evidence + mandates ≥3 external URL fetches + applies §4.9 outlier smell tests
- shared `global-constraints` prompt fragment captures all §4 cross-cutting invariants

If you want to materialize this as a builtin in the future: dump it from `pipeline_versions.ir_json` and `pipeline_prompt_refs` joined with `prompt_contents`. Don't re-run round 5's misapplied single-session generation — that produced an incomplete artifact (only prompts written to disk, no IR file) which was deleted as part of this session's cleanup.

---

## 4. Round 5 cost numbers (recorded for future niche reference)

```
Stage         | round 4 (multi) | round 5 (single) | delta
analyzing     | 408s / $0.95    | 649s / $1.13     | +59% wall, +19% cost
genSkeleton   | 522s / $1.10    | 369s / $0.87     | -29% wall, -21% cost
genPrompts    | 468s / $0.77    | 758s / $2.99     | +62% wall, +288% cost
persisting    | 492s / $0.74    | 757s / $1.18     | +54% wall, +59% cost
TOTAL         | 1890s / $3.56   | 2533s / $6.17    | +34% wall, +73% cost
```

Round 5 cache_read tokens: 638K → 261K → 482K → 654K (analyzing → genSkeleton → genPrompts → persisting). Total 2,035K vs round 4's 823K. **2.5× cumulative input** because cross-segment resume let downstream stages inherit conversation history they didn't need.

Root cause analysis in `docs/superpowers/plans/2026-04-25-pipeline-generator-dogfood-findings.md` Finding 13 (committed in this session).

---

## 5. Single-session niche — what's known and what's unresolved

**Known facts** (after this session):

- Anthropic Agent SDK `resume: sessionId` re-sends full conversation transcript. Prompt cache reduces *cost* per token but does not reduce *count* of tokens transmitted. Source: official sessions docs, verified subagent query.
- Current kernel implementation has a **cross-segment resume leak**: `runner.ts:1707-1719` (`findUpstreamSessionByWires`) lets any downstream agent stage resume the nearest upstream agent's session via wire BFS, regardless of whether segment-planner placed them in the same segment. This was the largest single contributor to round 5's cost overrun.
- pipeline-generator's existing rule (`gen-skeleton.md` §`Choosing session_mode`) was correct but soft-enforced. Generator chose multi for web3-research correctly in round 4. Round 5's single-mode was a manual override I made for the experiment, against the generator's own rule.
- Current `INLINE_PORT_VALUE_CHAR_LIMIT = 1024` (real-executor-prompt-builder.ts:14): port values ≤1024 chars are inlined into continuation prompts, larger values get a fetch-on-demand summary line.

**Unresolved** (paused; see niche spec §10 for full context):

1. Is single-session a paradigm or a perf optimization? Both framings have logical holes. No empirical data to settle.
2. Is round 5's regression fundamental (SDK behavior) or implementable (cross-segment leak fixable)? Cannot answer without running a niche-internal A/B (e.g., `explore → propose`).
3. Is "quality strictly better" measurable without circular reasoning? Open.

**Three things must happen before resuming the niche spec**:

1. Fix `findUpstreamSessionByWires` cross-segment leak — gate cross-segment resume behind explicit IR opt-in
2. Implement at least one niche-positive pipeline (candidate: `pr-description-generator` is already an existing 2-stage single-session builtin and could serve as the A/B target if a multi-session variant is constructed for comparison)
3. Re-evaluate niche spec §1, §7, §9 with actual measurements

---

## 6. Builtin pipelines using single-session (preserved)

Two hand-written builtins still set `session_mode: "single"`:

```
apps/server/src/builtin-pipelines/smoke-test/pipeline.ir.json
  stages: echoBack → greet (test fixture)
apps/server/src/builtin-pipelines/pr-description-generator/pipeline.ir.json
  stages: fetchDiff → writePr (real workload, 2-stage refine chain)
```

These are NOT touched by this session's "pipeline-generator only emits multi" instruction — that instruction governs *generated* pipelines, not *hand-written* builtins. Both remain usable. pr-description-generator is the most plausible candidate for future niche-spec validation work.

---

## 7. Server state

- **Last reload**: ~04:34 (automatic via tsx watch when gen-skeleton.md was edited)
- **Database**: `/tmp/workflow-control-data/kernel-next.db` retains all task records from rounds 1-5 + the web3-research versionHash row
- **Test status**: 1789 passed / 4 skipped / 0 failed; tsc clean
- **Server log tail**: `/tmp/wfctl-server.log` (385K lines as of session end)

No background processes left running.

---

## 8. Things explicitly NOT done

These were considered and either deferred or rejected during this session:

- **Optimize single-session prompt-builder** (`real-executor-prompt-builder.ts`): considered four routes (segment-aware Inputs skipping, app-level summary ports, `resumeSessionAt` truncation, fanout sub-agents). All deferred until niche definition is unblocked.
- **Materialize web3-research as a builtin pipeline directory**: round 5 produced incomplete artifacts (prompts only, no IR file) which were deleted. If/when web3-research is needed as a builtin, regenerate cleanly or export from DB.
- **Run the web3-research pipeline on a real research target**: round-4-handoff §7.4 listed this as a stretch acceptance step. Skipped because the generator-side dogfood concluded successfully without it; running a real research task is its own workstream.
- **Add a §修订历史 entry to product-roadmap.md**: prior session's handoff §8 mentioned this; deferred because the dogfood touched no product-roadmap-tracked feature work (it was generator infrastructure).

---

## 9. If you're picking this up

The dogfood is closed. There is no immediate continuation needed. Possible follow-ups, in priority order:

1. **Fix cross-segment resume leak** (`runner.ts:1707-1719`). This is the single largest piece of technical debt blocking single-session research. Standalone work, can be done without re-opening the niche spec.
2. **Use the web3-research pipeline** to actually research a Web3 target (Arbitrum, EigenLayer, etc.). Pure consumption — no infrastructure work.
3. **Resume the niche spec** if you have ≥1 day to design the A/B experiment and run it. Requires #1 done first; otherwise data will be contaminated like round 5.
4. **Add roadmap §修订历史 entry** if you want the dogfood recorded at the product level (not just internal docs).

---

## 10. Quick references

- **Round 4 handoff**: `docs/superpowers/plans/2026-04-26-web3-research-round-4-handoff.md`
- **All 13 findings**: `docs/superpowers/plans/2026-04-25-pipeline-generator-dogfood-findings.md`
- **Niche spec (TODO)**: `docs/superpowers/specs/2026-04-26-single-session-niche.md`
- **Original task description**: `docs/superpowers/specs/2026-04-25-web3-research-task-description.md`
- **DB**: `/tmp/workflow-control-data/kernel-next.db`
- **Server log**: `/tmp/wfctl-server.log`
- **MCP endpoint**: `POST http://localhost:3001/api/mcp` (server still running unless reboot)
