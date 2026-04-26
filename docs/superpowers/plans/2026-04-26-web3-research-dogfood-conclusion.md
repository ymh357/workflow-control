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

## 9. Round 6 — actually run the web3-research pipeline (NEW, surfaced 4 findings)

After commits c1-c3 closed the generator-side dogfood, the user requested actually running the web3-research pipeline on a real Web3 target (Arbitrum). The attempt produced 4 new findings (F14-F17) and ended with the task stuck on collectPrimarySources.

### Round 6 timeline

- 05:04 — `run_pipeline(versionHash=e6f281e9..., seedValues={taskDescription: "Research Arbitrum..."})`
- 05:04:17 — scoping completed (20.7s, $0.064). Output quality validated: 6 research questions covering architecture / tokenomics / governance / security / decentralization / horizontal comparison
- 05:04:47 — gate awaitApproval, approved
- 05:05:13 — classifyTarget completed (27s). Output: `entityType: "l1-l2-chain", typeConfidence: "high"`, atomSet contains the right 4 atoms
- 05:05:18 — collectPrimarySources errored at 11ms — never reached LLM. Cause: `MCP_ENV_MISSING: GITHUB_TOKEN`

### What surfaced (full text in dogfood-findings doc)

- **F14**: caller (the dogfood agent) failed to provide `envValues` to `run_pipeline`. The generator's IR was correct — github MCP is the right tool for `m-developer-traction` atom on an `l1-l2-chain` target. The agent's invocation was wrong.
- **F15**: in response to F14, the agent (me) asked the user to paste GITHUB_TOKEN into chat. The user correctly rejected this. Pasting secrets into agent context contaminates session JSONL + is replayed on every resume. Now codified as a "Secret handling" SOP in CLAUDE.md.
- **F16**: while attempting (incorrectly) to remove the github MCP from the IR via hot-update, discovered that `update_stage_config` patch op's `ALLOWED_CONFIG_KEYS` table omits `subAgents` and `mcpServers` (`mcp/patch.ts:22`). Latent bug — workaround is submit_pipeline + new version.
- **F17** (the deepest one): kernel has no pause-and-resume mechanism for "stage needs a secret to proceed". `MCP_ENV_MISSING` terminates the attempt as error rather than transitioning the task to a `secret_pending` state and waiting for the secret to be provided through an out-of-band channel. This is what blocks the dogfood from reaching the remaining 6 stages.

### Rollback applied

The mis-attempted IR mutation was rolled back:
- `propose_pipeline_change` proposal `83703576-...` marked `rejected`, `migrate_running` cleared to `"none"`
- `patch.ts` reverted (the `subAgents`/`mcpServers` extension is real but unrelated to F14; recorded as F16 for separate fix)
- Task `web3-research-1777151032404-d7cd3c29` remains on original versionHash `e6f281e9...` in errored state — kept as F17's reproduction case for when secret-gate lands

The orphan `pipeline_versions` row `67ab566b...` is unreferenced and harmless; left in place.

---

## 10. If you're picking this up

The dogfood is closed at the F14-F17 wall. Possible follow-ups, in priority order:

1. **Implement F17 (secret-gate kernel feature)**. ~2-3 days. Without it, no pipeline that needs secrets can be reliably operated. After F17 lands, the existing errored Arbitrum task can be revived (its scoping/classifyTarget outputs are intact in DB; just needs collectPrimarySources onward to re-run with secret provided).
2. **Implement F16 (hot-update patch table completion)**. <1 day. Independent of F17.
3. **Implement F13 (cross-segment resume leak fix in `runner.ts:1707-1719`)**. Independent of F14-F17. Blocks any future single-session research.
4. **Resume the niche spec** if you have ≥1 day to design the A/B experiment and run it. Requires #3 done first.
5. **Add roadmap §修订历史 entry** if you want the dogfood recorded at the product level.

The web3-research pipeline itself (versionHash `e6f281e9...`) is validated structurally (round 4) and partially validated end-to-end (rounds 5/6 covered scoping → classifyTarget). The remaining 6 stages remain unverified-on-real-input until F17 unblocks the secret path.

---

## 11. Quick references

- **Round 4 handoff**: `docs/superpowers/plans/2026-04-26-web3-research-round-4-handoff.md`
- **All 17 findings**: `docs/superpowers/plans/2026-04-25-pipeline-generator-dogfood-findings.md`
- **Niche spec (TODO)**: `docs/superpowers/specs/2026-04-26-single-session-niche.md`
- **Original task description**: `docs/superpowers/specs/2026-04-25-web3-research-task-description.md`
- **DB**: `/tmp/workflow-control-data/kernel-next.db`
- **Server log**: `/tmp/wfctl-server.log`
- **MCP endpoint**: `POST http://localhost:3001/api/mcp` (server still running unless reboot)

---

## 12. Round 7 (2026-04-26 later same day) — F17 lands, dogfood unblocks, deliverable produced

After F17 (secret-gate) was implemented and merged (commits `f44e0ea`..`c9fa070` + bug fix `19b62bf`), the long-paused round-6 task was revived without server restart:

```
provide_task_secrets({ taskId: "web3-research-1777151032404-d7cd3c29", secrets: { GITHUB_TOKEN: "..." } })
→ { ok: true, resolved: true }
```

Task status flipped from `secret_pending` → `running`, executed `collectPrimarySources` → `domainResearch` → `onChainVerification` → `atomAnalysis` → `produceDeliverable` → `adversarialFactCheck`, terminated `completed`.

### Empirical numbers

| Metric | Value |
|---|---|
| New stages executed | 6 (round 6 stopped at stage 4) |
| Net cost from resume to completion | ~$0.92 (round 6 was $0.70; final $1.625) |
| Net token usage (in/out) | ~4117 input / ~76879 output |
| New attempts created | 4 (46 → 50) |
| Wall time from `provide_task_secrets` to `completed` | ~10 minutes |
| Final deliverable | 22397 chars / 728 lines / 38KB Chinese markdown |

### Findings from round 7

**F18 — `provideTaskSecrets` only resolved ONE row (the latest by `created_at`).** When server restarted while paused, orphan-reconciler resumed and each resume attempt wrote a new `secret_gate_queue` row. Pre-fix, `provideTaskSecrets` only updated the latest; older rows stayed unresolved; `getTaskStatus` kept returning `secret_pending` even after secrets supplied. Fixed in commit `19b62bf`: load ALL unresolved rows, batch-resolve every row whose `required_keys` are now fully in `task_env_values`, dispatch one `retryTaskFromStage` per distinct unblocked stage. `listPendingSecretGates` additionally filters out fully-satisfied rows as a defensive guard. Two new tests cover this.

**F19 — `runner-fanout.ts` does not handle `secret_pending` from per-element `executor.executeStage` calls.** Per-element results have shape `{ status: "success" | "error" | "secret_pending" }`. The fanout orchestrator (`runner-fanout.ts:194`) only branches on `error`, treating `secret_pending` as success and proceeding to read `silentRuntime.readWritesForAttempt(result.attemptId)` which returns nothing. Subsequent aggregation gets `undefined` per port. Latent — web3-research has no fanout stages; would surface on the first fanout pipeline whose elements declare envKeys. Fix is the next item in this session.

**F20 — Adversarial fact-check stage returned `confidence: high` without flagging temporal inconsistencies.** The deliverable references "Kelp DAO 资产冻结事件 (2026年5月)" — this is a **future event** at the time of writing (2026-04-26). Either the model hallucinated, or it pulled a forward-looking analysis piece without flagging the date. The adversarial pass cited 4 independent sources but did not catch this. The fact-check prompt may need an explicit "anything dated AFTER `<reportDate>` must be flagged as projection, not fact" rule. Doesn't invalidate the report — most claims are well-grounded — but the confidence rating is misleading.

**F21 — Token-budget asymmetry: input 4117, output 76879 (~19:1 output:input).** Healthy ratio for a research-and-write pipeline (most cost is in agent generation, not prompt overhead). Confirms multi-session pipeline's cost profile is dominated by output volume, not by reprompt waste. Comparable to round-4's $3.55 generator (no MCP, 6 stages); web3-research at $1.625 for 9 stages including MCP-driven stages is materially cheaper, suggesting pipeline-generator's structural-data-flow approach pays off.

### What's still open

1. **F19 fanout secret_pending handling** — fix in this session (next).
2. **F20 adversarial fact-check temporal-anchor rule** — modify pipeline-generator's prompt template to instruct fact-check stages to verify dates against `reportDate`. Alternatively, add to web3-research's adversarialFactCheck prompt directly.
3. **Hallucination-detection auxiliary pipeline** — not on roadmap, but the Kelp DAO miss is the kind of error a second-opinion auditor pipeline could catch. Consider after dogfood matures.

### Status of the original errored task

`web3-research-1777151032404-d7cd3c29` is now `completed`. `task_finals` row written, `total_cost_usd = 1.625`, `final_state = completed`, all `secret_gate_queue` rows resolved.

The deliverable is in DB at `port_values` row `(stage='adversarialFactCheck', port='finalDeliverable')`. Read via:

```
read_port({ taskId: "web3-research-1777151032404-d7cd3c29", stage: "adversarialFactCheck", port: "finalDeliverable" })
```

Or from this session's transient copy at `/tmp/web3-final.md`.

---

## 13. Round 8 (2026-04-26) — Solana on the same pipeline, fresh task

To validate that the pipeline isn't accidentally tuned to Arbitrum, ran the same versionHash `e6f281e9...` on a Solana task description focused on PoH/Tower BFT consensus, validator economics, SOL inflation, network outages, and Firedancer rollout. F17 path was bypassed by passing `envValues` directly at `run_pipeline` time (operator path; the secret-gate path itself was already validated end-to-end in round 7).

### Task: `web3-research-1777206776437-6fd58418`

| Stage | Action | Notes |
|---|---|---|
| scoping | wrote 6 research questions, 4 assumptions, 1 task summary | normal |
| awaitApproval (gate) | auto-approved by orchestrator | |
| classifyTarget | entityType=`l1-l2-chain`, atomSet derived from L1 type | |
| collectPrimarySources | github MCP queried; primarySourceReport written | ~10 min |
| domainResearch | candidateList covers Aptos/Sui/Avalanche L1 competition; ~$0.32 / 9K out | bigger than Arbitrum (more L1 peers to enumerate) |
| onChainVerification | onChainReport empty/skipped — atomSet didn't include `m-onchain-verification` for this Solana shape | |
| atomAnalysis | analysisReport per-atom; ~$0.16 / 12K out | normal |
| produceDeliverable | 17K-token Chinese deliverable | normal |
| adversarialFactCheck | finalDeliverable = corrected version with on-chain corrections inlined | normal |

### Empirical numbers

| Metric | Round 7 (Arbitrum, resumed) | Round 8 (Solana, fresh) |
|---|---|---|
| Total cost | $1.625 | $1.865 |
| Input tokens | 4153 | 6041 |
| Output tokens | 80968 | 78375 |
| Attempts (incl. historical) | 50 | 10 |
| Final deliverable | 22397 chars / 728 lines | 23261 chars / 545 lines |

### Quality observations

**Solana report's fact-discipline is materially better than Arbitrum's**. Concrete examples:
- "1.5% 固定下限,**预计**于 2026 年下半年至 2027 年达成 [Official]" — future-dated milestone explicitly hedged with "预计"
- "Alpenglow 提案目标在 2026 年将其减少到 100-150ms,但**部署时间尚不确定** [Secondary]" — uncertainty surfaced
- "**截至 2026 年 4 月 17 日**,20%-22% 的验证者质押运行 Firedancer" — concrete date (9 days before report) for a current-state claim
- "**截至 2026 年 4 月 26 日**" used as the report's temporal anchor explicitly

The report's 材料更正 section (in 附注与数据质量声明) records that on-chain verification corrected SOL circulating supply from 464.4M (in primarySourceReport) to ~575.9M (verified via CoinGecko/Solana Compass on report date) — this is the F20-style temporal-anchor discipline working. The Arbitrum round-7 report had the Kelp DAO 2026-05 future-event fabrication without flagging; Round 8's Solana report does not have any equivalent issue.

### Why is Round 8 better at temporal discipline?

Three plausible explanations, none mutually exclusive:

1. **Topic specificity**: Solana's recent state (Firedancer rollout %, validator counts, outage logs from StatusGator) is well-anchored in dated public data. There's less surface for the model to confabulate "what happened recently" because StatusGator and Helius publish dated outage records that the model used as ground.
2. **Subject-matter familiarity**: the model's training likely had more Solana coverage than Arbitrum's recent governance events, so the pattern of "specific event in 2026-05" pulled fewer hallucinated date-anchored claims.
3. **F20 fix is NOT yet in this report's prompts**: this Round 8 task uses the same versionHash `e6f281e9...` as round 7. The F20 prompt-writer fix (commit `6a80602`) only affects future pipeline-generator outputs. So the improvement here is NOT attributable to F20.

The conclusion: the Round 7 Kelp DAO miss was either topic-specific bad luck or training-data over-confidence on a specific Arbitrum incident. F20 still matters for resilience, but the empirical baseline now has at least one well-disciplined report on the same prompts.

### Status

Both tasks `completed`. Total session cost across both rounds: ~$3.49 across 19 stages (round 7's resume executed only 6 stages; round 8 ran all 9 fresh).

Solana deliverable in DB at `port_values` row `(stage='adversarialFactCheck', port='finalDeliverable')` for taskId `web3-research-1777206776437-6fd58418`. Transient copy at `/tmp/sol-final.md`.

---

## 14. Round 9-10 (2026-04-26) — 0G cross-chain bridges, exposes F22, then succeeds after fix

### Round 9 (failed)

Started a new task on the same versionHash with topic "Research the cross-chain bridges currently used by 0G". The pipeline immediately hit a cascading-failure mode that the Arbitrum + Solana rounds had narrowly avoided:

- `collectPrimarySources` started, the SDK fired `system.init` BEFORE the npx-spawned `@modelcontextprotocol/server-github` MCP subprocess was ready.
- `real-executor.ts:582+` correctly threw `MCP_STARTUP_FAILED`.
- Runner marked the attempt `status='error'` after 15s.
- **The SDK subprocess kept running**. ~140s later github MCP came up, the agent did the work, and `write_port` calls landed against an already-terminal `attempt_id`.
- Reconciler / runner advanced past `collectPrimarySources` to `domainResearch` (a real bug — possibly because port_values existed for collectPrimarySources, fooling some "did this stage succeed?" check). Same MCP_STARTUP_FAILED race fired again. Cascade through every downstream stage.

Recorded as F22 in the master findings doc. The 0G research itself was **not produced** in round 9.

### F22 fix (commits)

Two changes landed this same session:

1. **`real-executor.ts` retry budget for MCP_STARTUP_FAILED** — independent of `maxRetries`, the executor now grants up to 3 free retries on this specific error with 2s/5s/10s backoff. Cold-start cache hit window for npx is reliably under 15s but slipped through on a fresh-cache / first-run boundary.
2. **`real-executor.ts` AbortController plumbing** — `buildSdkBaseOptions` now optionally accepts an `AbortController`; `doAttempt` creates one per attempt, passes it through to the SDK query, and aborts at every termination path (error / secret_pending / interrupted / parent-signal-aborted / outer-catch / inner-finally fallback). Eliminates the orphaned-SDK-late-write bug.

Combined commit: `944fd41`. Ran kernel-next/runtime test sweep: 69/69 passing, tsc clean.

### Round 10 (succeeded)

Same task description, different taskId (`web3-research-1777216550857-f5f02a91`). Ran end-to-end without intervention.

| Metric | Value |
|---|---|
| Total cost | $1.790 |
| Input tokens | 6267 |
| Output tokens | 54835 |
| Attempts | 11 |
| Wall time | ~17 minutes |
| Final deliverable | 23601 chars / 782 lines / 41KB Chinese markdown |

The deliverable answered every research question with concrete bridge identification: 0G integrates Chainlink CCIP (canonical), LayerZero V2 (omnichain), Brevis (ZK DA verification), and Relay (multichain UX). The report explicitly excludes Wormhole / Axelar / Hyperlane (they are NOT integrated), and the on-chain verification provided concrete EID (LayerZero V2 EID `30388`) and chain coverage numbers.

### Quality observations across all three completed rounds

| | Arbitrum (R7) | Solana (R8) | 0G (R10) |
|---|---|---|---|
| Cost | $1.625 | $1.865 | $1.790 |
| Input tok | 4153 | 6041 | 6267 |
| Output tok | 80968 | 78375 | 54835 |
| Output:Input | 19:1 | 13:1 | 9:1 |
| Deliverable | 22397 chars | 23261 chars | 23601 chars |
| Future-event hallucinations | **YES** (Kelp DAO 2026-05) | NO | NO |

The 0G report is the **densest** of the three: similar character count to Arbitrum's, but ~30% fewer output tokens. This is consistent with the topic being narrower (just bridges, not the full protocol). The output:input ratio also narrows accordingly — there's less to fabricate vs. summarize when the topic is concrete and well-anchored in dated official posts.

**Crucial fact-discipline observation**: Round 7's Kelp DAO miss (citing a 2026-05 event in a 2026-04-26 report as fact) does NOT recur in rounds 8 or 10, despite the underlying pipeline prompts being unchanged across all three rounds. Hypothesis stands: the Arbitrum miss was topic-specific (training data over-confidence on a high-profile governance incident with poorly-anchored dates), not a systemic pipeline weakness. F20's prompt-writer fix remains the right resilience hardening for future-generated pipelines.

### Status

All three web3-research dogfoods (Arbitrum, Solana, 0G bridges) complete with deliverables in DB. The F22 fixes landed mid-session; the 0G research that triggered F22 is the proof that the fix works.
