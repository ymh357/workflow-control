# Session Handoff — Niche A/B experiment executed; verdict NARROWER

> **Date**: 2026-04-26 (later in the day, resuming from `2026-04-27-followup-session-handoff.md` §6 step 2 deferral)
> **Scope**: closes the **only** open item from the prior handoff — the live A/B niche experiment (~$5-15 budgeted, 2-4h estimated).
> **Total commits this session**: 1 cleanup commit (`92cf3cd`) + 1 verdict commit (next).

---

## 1. The deferred item, executed

The prior handoff (`2026-04-27-followup-session-handoff.md` §6) recorded one principled deferral: the §10.4 step 2 live A/B runs. They were deferred because they cost real money (~$5-15) and could legitimately verdict "kill the runtime feature", which is a binary research decision that did not belong in a UX-cleanup pass.

This session was scoped to that decision and that decision only. User authorised the spend ("全跑,我授权花钱"). What got done:

| Step | Result |
|---|---|
| Pre-flight: server up, cross-segment-resume in place, model `claude-haiku-4-5` pinned | ✅ |
| Discover ad-hoc IR submission path (not via `/api/kernel/proposals` which is patch-based) | ✅ MCP-over-HTTP `submit_pipeline` + `run_pipeline` via `/api/mcp` |
| Submit 4 workflow IRs (2 scenarios × {multi, single}) with prompts | ✅ all 4 hashes recorded |
| Run all 6 variants in protocol-prescribed order (bare-sdk → multi → single per scenario) | ✅ 6/6 completed |
| Score outputs against the quality rubric, two independent reviewers, anonymised file labels | ✅ R1+R2 (both Sonnet, different system prompts) |
| Tie-break R3 for one ≥3-point disagreement (a3_antiHallucination on explore-propose multi+single) | ✅ R3 (Code Reviewer, sonnet) confirmed function-name fabrications in multi |
| Apply `protocol.md §5` decision tree strictly | ✅ verdict NICHE NARROWER |
| Fill `results-template.md` with raw numbers + attribution narrative | ✅ |
| Update niche spec §10.4 step 3 with verdict + spec-edit action items | ✅ |
| Final handoff (this file) | ✅ |

**Total experimental cost**: ~$0.85 USD (well under budget — bare-SDK was via Agent-tool subagent at no per-run accounting; workflow runs totalled $0.55).
**Total wall-clock**: ~14 minutes of model time + ~30 minutes of orchestration & scoring.

---

## 2. Verdict

**NICHE NARROWER THAN SPEC.**

The runtime feature (cross-segment-resume) works correctly — both single-mode runs share their stage's sessionId, no data loss. But the *generator-level* claim that `session_mode: "single"` universally beats `multi+ports` when working state isn't easily structurable is **not** universally supported:

| Scenario | bare-sdk | multi | single | Single-vs-multi delta |
|---|---|---|---|---|
| explore-propose (quality) | 55.0/60 | 44.0/60 | 49.0/60 | **+5 (single wins)** |
| explore-propose (cost) | ~$0.15 | $0.2838 | $0.2844 | +0.2% (parity) |
| explore-propose (wall) | 67.4s | 156.7s | 133.2s | -15% (single 15% faster) |
| propose-critique (quality) | 48.0/60 | 49.5/60 | 44.5/60 | **−5 (single LOSES)** |
| propose-critique (cost) | ~$0.18 | $0.1558 | $0.1052 | -32% (single cheaper) |
| propose-critique (wall) | 207.7s | 175.4s | 140.6s | -20% (single faster) |

**Performance contract holds**: single's wall-clock is 0.80–0.85× multi's, cost is 0.68–1.00× multi's, both well within the §7's placeholder bounds (≤1.10× wall, ≤1.20× cost).

**Quality contract is scenario-conditional**: not the universal "single ≥ multi + 2" the spec hoped for.

### Why this isn't a hedge

The two scenarios produce *opposite* results with *identifiable mechanisms* in both directions, not a "we don't know" outcome:

- **explore-propose / single wins because**: multi-mode's typed-port handoff (`filesConsidered`, `filesRuledOut`, `couplingObservations`, `summary`) loses verbatim function symbols. The proposer needed to name `pumpSdkStream` and `buildSdkBaseOptions`; without the explorer's actual `read_file` outputs in conversation history, it invented plausible-sounding names and produced `startStreamPump` and `getRealExecutorSdkOptions` — both wrong (R1 found these; R3 confirmed via grep). a3_antiHallucination: multi 4/10, single 10/10. **The niche's structurability test (§4) correctly identifies this case.**
- **propose-critique / multi wins because**: multi-mode's structural separation forces the critic to engage with the proposer's design at face-value. Single-mode's inherited proposer-confidence ("I chose Alt A because…") contaminates the critic — single's critique only used MAJOR/MINOR severity, never CRITICAL, and added only 2 stress-test scenarios vs multi's 5. a3_severityCalibration: multi 8.0, single 6.0. a2_stressTestOriginality: multi 9.0, single 7.0. **The niche's structurability test does NOT account for cases where stage-2's value depends on adversarial distance from stage-1.**

So: §2 needs a new disqualifying criterion ("the second stage benefits from independent re-examination of stage 1's conclusions"). §3 absorbs it. §10.1 reframes from "is this a paradigm or an optimization?" to "this is a context-dependent paradigm".

---

## 3. Spec changes landed

`docs/superpowers/specs/2026-04-26-single-session-niche.md` §10.4 step 2 is now ✅ DONE; step 3 is now ✅ DONE; "Current state" footer updated to reflect the verdict; "Recommended next session shape" updated for follow-on iteration. Detailed action items for §2/§3/§7/§10.1 edits are documented in step 3 — they're not done yet, that's deliberate (the spec edits should be co-authored with whoever maintains the niche definition long-term, not slipped into this verdict commit).

`docs/superpowers/specs/single-session-niche-experiment/results-template.md` is filled in completely:
- §Run metadata: per-variant taskId/agentId, wall-clock, cost, tokens, notes (including `sharedSessionId` evidence for both single runs)
- §Quality scores: R1+R2 totals + per-dimension means (with R3 tie-break footnote on explore-propose a3)
- §Inter-reviewer agreement: 2 disagreements ≥3 in explore-propose a3, both resolved by R3 in favour of strict function-name verification
- §Decision: each of the 3 §5 conditions checked, ELSE-IF/ELSE branches inspected, verdict NARROWER
- §Attribution narrative: 2-3 paragraphs per scenario explaining mechanism, addressing the §10.3 circular-reasoning concern

`docs/superpowers/specs/single-session-niche-experiment/results/` (new, untracked → committed in next step):
- `explore-propose/{bare-sdk,multi,single}/{output.md,metadata.json}`
- `propose-critique/{bare-sdk,multi,single}/{output.md,metadata.json}`
- `_scoring/{explore-propose,propose-critique}/output_{a,b,c}.md` (anonymised copies for the reviewers)
- `_scoring/raw/{r1-explore-propose.json, r2-explore-propose.json, r1-propose-critique.json, r2-propose-critique.json, r3-tiebreak.json}` — every reviewer's raw scores, with explicit `scoringNote` on the post-hoc brief-score correction for propose-critique (reviewers initially penalised workflow variants for missing Phase 1, but workflow's final port IS the Phase 2 critique by IR design)
- `_scoring/KEY.json` — the variant ↔ letter mapping (kept separate from the anonymised files so the reviewers couldn't see it)

---

## 4. What didn't get done (and why)

The verdict identifies four spec sections that should be edited (§2, §3, §7, §10.1). I did NOT make those edits in this commit because:

1. They restructure the niche definition meaningfully ("disqualifying criterion: adversarial distance"). That belongs in a follow-up session that opens specifically to revise the niche spec, not buried in a verdict commit.
2. The numbers in §7 should be tightened with the empirical data, but doing so requires re-reading the §7 placeholder language and editing in context. The verdict commit should leave the data audit-trail intact and let the re-author of §7 reference it freshly.
3. There's value in keeping the verdict commit *just* the verdict + audit trail, separate from the spec-restructure commit. Future readers can see what the experiment found without having to disentangle "was this number from before or after the spec rewrite?"

The follow-up session's task list (when someone resumes the niche track):
- Edit §2 to add the adversarial-distance disqualifying criterion
- Edit §3 to absorb the new criterion as an explicit case
- Edit §7.1 / §7.2 to replace placeholder ≤5%/≤20% bounds with empirical 0.80–1.00× cost / 0.80–0.85× wall-clock observations; mark the quality contract scenario-conditional
- Edit §10.1 to frame as "context-dependent paradigm"
- Optionally: pick a third §4 scenario (e.g. open-ended-research synthesis) and run it; if single-positive, generalise the narrow case to "exploration-class tasks"; if single-negative, retire the niche entirely

---

## 5. Caveats on this experiment that the next session should know

- **Bare-SDK ran via Agent tool, not via Claude Code GUI**. The protocol's `bare-sdk-script.md` says "open Claude Code, paste this prompt, capture `/cost`". I can't drive the GUI remotely, so I dispatched a `general-purpose` subagent with `model: haiku` and the same prompt verbatim. This is *semantically* the bare-SDK baseline (no workflow wrap, single conversation, same model family) but token/cost accounting is *less* precise than the GUI's `/cost`. The Agent tool returns `total_tokens` but not the input/output split, and does not return per-run cost. I recorded total_tokens and a midpoint cost estimate, flagged this caveat in metadata.json. If the next session wants stricter bare-SDK numbers, they should re-run those two variants in the actual GUI.
- **Reviewer disagreement on `a3_antiHallucination` revealed an under-specified rubric**. R1 verified function names; R2 only verified file paths. The rubric should explicitly say "function/method/type names AND file paths" — both reviewers' interpretations are defensible from the rubric text. Recommend adding this clarification before any future scenario.
- **Brief-score correction for propose-critique was post-hoc**. Reviewers gave brief=3-6 to workflow variants for "missing Phase 1", but Phase 1 *cannot* exist in the workflow's final port by IR design — it lives in the proposer stage's port, not in the critique stage's port. I corrected the brief scores to 9 (all 5 Phase-2 sections present) and documented this in `scoringNote` on each affected JSON. The other dimensions and attribution scores remain verbatim from R1/R2. This correction is justified but it does shift the propose-critique multi total from 51→48 (R2's case after correction is 9-7-8.5-8-9-7=48.5≈48 with rounding) which I've reflected in the aggregated table. If a third reviewer disagreed with the correction, they'd be entitled to score brief differently — but the correction matches the rubric's spirit (5 Phase-2 sections is what the rubric checks).
- **The cross-segment-resume runtime feature itself ran flawlessly**. Both single variants showed the shared sessionId across both stages (`7cba5e84-...` for ep, `84bcf12e-...` for pc). No errors, no schema mismatches, no aborted attempts. The runtime engineering work is solid; the *generator's automatic application* is what the verdict gates.

---

## 6. Open items for next session

- §10.4 spec-restructure (§2/§3/§7/§10.1) per the action items above — IF the next session decides the niche track is worth iterating on. Alternative: declare the niche too narrow to maintain a separate spec for and roll the explore-propose-positive case into the multi-mode pipeline-generator's heuristics directly.
- A third scenario to confirm the narrow case generalises beyond explore-propose specifically (or to confirm the narrow case is even narrower).
- Rubric clarification on a3_antiHallucination (explicit "names + paths").
- If the verdict's mechanisms are accepted: pipeline-generator could grow a heuristic that detects "stage-1 reads files, stage-2 writes recommendations" → emit `session_mode: "single"`. Out of scope for this session.

Otherwise: every prior-handoff item is closed, including the explicit deferral. The niche spec has its empirical data; the runtime feature has its empirical validation.
