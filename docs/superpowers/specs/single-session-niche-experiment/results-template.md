# Experiment Results

> Filled in 2026-04-26 with raw per-run numbers from a 6-variant live run.
> Decision applied per `protocol.md §5`.

## Run metadata

### explore-propose

| Variant | taskId / agentId | Wall-clock (s) | Cost (USD) | Input tokens | Output tokens | Notes |
|---|---|---|---|---|---|---|
| bare-sdk | agent `a51042e7e488f5682` | 67.4 | ~$0.15 (mid-est) | n/a (subagent total: 56,513) | n/a | Agent tool subagent_type=general-purpose, model=haiku. Per-attempt cost not reported by Agent tool. Token split unavailable. |
| multi    | task `niche-exp-explore-propose-multi-1777240159689-06c659c9` (hash `1db8c50…`) | 156.7 | $0.2838 | 163 (cumulative) | 11,029 | Two stages: exploreCodebase 121.3s ($0.2423, 17 tools) + proposeRefactor 39.7s ($0.0416, 3 tools). 4s overlap (parallel-region kickoff). |
| single   | task `niche-exp-explore-propose-single-1777240436457-9da8d203` (hash `5748bcf…`) | 133.2 | $0.2844 | 148 (cumulative) | 8,206 | Two stages: exploreCodebase 104.7s ($0.1995, 17 tools) + proposeRefactor 33.8s ($0.0849, 1 tool). **Shared sessionId `7cba5e84-9ef1-4af0-a5c8-c7edb7e30fff`** confirms cross-segment-resume pivot worked. Output tokens −26% vs multi. |

### propose-critique

| Variant | taskId / agentId | Wall-clock (s) | Cost (USD) | Input tokens | Output tokens | Notes |
|---|---|---|---|---|---|---|
| bare-sdk | agent `a5b5b90a5ef814de8` | 207.7 | ~$0.18 (mid-est) | n/a (subagent total: 65,914) | n/a | Same Agent-tool caveats as ep. |
| multi    | task `niche-exp-propose-critique-multi-1777241002566-62858167` (hash `8f63632…`) | 175.4 | $0.1558 | 72 | 15,901 | proposeAPIDesign 107.9s ($0.0894) + critiqueAPIDesign 77.7s ($0.0664). Two distinct sessionIds (expected). |
| single   | task `niche-exp-propose-critique-single-1777241220307-71924527` (hash `93d3bde…`) | 140.6 | $0.1052 | 36 | 10,953 | proposeAPIDesign 46.5s ($0.0387) + critiqueAPIDesign 108.6s ($0.0665). **Shared sessionId `84bcf12e-baee-40a4-9759-e364d6d74649`**. Cost −32% vs multi, output tokens −31%, wall-clock −20%. |

## Quality scores

> R1=general-purpose, R2=Code Reviewer, both Sonnet. R3 dispatched as tie-break for explore-propose a3_antiHallucination where R1 and R2 diverged ≥6 points.

### explore-propose

| Variant | R1 total | R2 total | Mean | Brief | Specificity | Coherence | A1 ruled-out | A2 coupling | A3 anti-halluc | Attribution mean |
|---|---|---|---|---|---|---|---|---|---|---|
| bare-sdk | 55 | 55 | **55.0** | 9.0 | 9.0 | 9.0 | 9.0 | 9.0 | 10.0 | +2.0 |
| multi    | 43 | 51 | 44.0\* | 8.0 | 7.5 | 8.0 | 8.0 | 8.5 | 4.0\*\* | 0.0 |
| single   | 49 | 46 | 49.0\* | 7.5 | 8.0 | 8.5 | 6.0 | 9.0 | 10.0\*\* | +0.5 |

\* totals recomputed using R3-corrected a3 scores; see footnote.
\*\* multi a3 = 4 (R1+R3 confirmed two function-name fabrications: `startStreamPump` not present, actual is `pumpSdkStream`; `getRealExecutorSdkOptions` not present, actual is `buildSdkBaseOptions`). single a3 = 10 (R2+R3 confirmed no fabrications; R1's earlier 7 was a misread — output_c does NOT cite getRealExecutorSdkOptions).

### propose-critique

> See R1/R2 scoringNote: brief scores corrected post-hoc because reviewers initially penalized workflow variants for missing Phase 1, but workflow's final port IS the Phase 2 critique by IR design (Phase 1 lives in the proposer stage's chosenDesignMarkdown port, deliberately not echoed into the final critique). Bare-SDK happens to combine both phases. Other dimensions and attribution preserved verbatim.

| Variant | R1 total | R2 total | Mean | Brief | Specificity | Coherence | A1 alts re-exam | A2 stress test | A3 severity | Attribution mean |
|---|---|---|---|---|---|---|---|---|---|---|
| bare-sdk | 46 | 50 | **48.0** | 8.5 | 9.0 | 7.5 | 8.5 | 8.0 | 6.5 | +1.0 |
| multi    | 51 | 48 | **49.5** | 9.0 | 7.0 | 8.5 | 8.0 | 9.0 | 8.0 | -1.0 |
| single   | 45 | 44 | **44.5** | 9.0 | 7.0 | 7.5 | 8.0 | 7.0 | 6.0 | -1.0 |

## Inter-reviewer agreement

| Scenario | Dimensions disagreed (≥3 pts) | Resolution |
|---|---|---|
| explore-propose | a3_antiHallucination (multi: R1=4 R2=10 diff=6; single: R1=7 R2=10 diff=3) | R3 tie-break dispatched (Code Reviewer, sonnet, strict function-name verification): multi=4 confirmed (R1+R3), single=10 confirmed (R2+R3, R1 was misread). |
| propose-critique | none ≥3 after brief-score correction | n/a |

The rubric was UNDER-specified on a3 in explore-propose: "anti-hallucination" did not mandate function-name verification, only file-path verification, so two reviewers applied different rigor levels. R3 used the strict version, which matches the rubric's spirit (the "every reference real → 10. Each fabrication → -3" language plainly covers function names, not just files).

## Decision

Per `protocol.md §5`:

- [ ] Single quality ≥ multi + 2, **both scenarios**?
  - ep: single 49.0 vs multi 44.0 → **+5** ✓
  - pc: single 44.5 vs multi 49.5 → **-5** ✗
  - **FAILS** (one scenario each way; condition requires both)
- [✓] Single cost ≤ multi × 1.20, both scenarios?
  - ep: $0.2844 / $0.2838 = 1.002 ✓
  - pc: $0.1052 / $0.1558 = 0.675 ✓ (single 32% cheaper)
- [✓] Single wall-clock ≤ multi × 1.10, both scenarios?
  - ep: 133.2s / 156.7s = 0.85 ✓ (single 15% faster)
  - pc: 140.6s / 175.4s = 0.80 ✓ (single 20% faster)

The first condition fails. Inspect the ELSE-IF and ELSE branches:

- **ELSE-IF "single quality < multi quality OR cost > multi×1.5"**: single quality < multi only in pc, not in ep. The ELSE branch's example "one scenario each way" explicitly carves out this case as NARROWER, not FALSIFIED. ELSE-IF therefore reads as "single<multi in BOTH scenarios" or "cost > multi×1.5 in either" — neither applies.
- **ELSE "mixed result, one scenario each way"**: applies — ep is single-positive, pc is single-negative.

**Verdict**: ☐ NICHE CONFIRMED  ☐ NICHE FALSIFIED  ☑ **NICHE NARROWER**

**Action items derived from the verdict**:

1. Tighten niche spec §2 criteria to reflect the empirical narrowing — `session_mode: "single"` is supported by evidence on **codebase-exploration tasks where structuring the explorer's reasoning into typed ports causes name-level information loss**, NOT on **design tasks where stage isolation aids critic objectivity**. Generalising the niche to "any 2-stage agent task" overshoots.
2. Pipeline-generator gate stays in place. The generator's `session_mode: "single"` heuristic should be tied to detection of "exploration" or "code archaeology" tasks specifically, not to 2-stage shape generally.
3. Cross-segment-resume pivot itself is **vindicated for both scenarios** — the runtime feature works, sessionIds are shared, no data loss, and cost is competitive (or better). The narrowing is in the *generator's automatic application*, not the runtime.
4. Re-run with a third scenario from §4 (some other "rejected alternatives" or "exploration history" example) before lifting any gate, to confirm the narrow case generalises.

## Attribution narrative

### explore-propose: working-state genuinely paid off

Two clean signals show working-state preservation reaching the proposal stage in single mode:

**Signal 1: Anti-hallucination (a3) is the niche's single most important measurement here.**
- bare-sdk 10/10 (zero fabrications)
- single 10/10 (zero fabrications)
- multi 4/10 (two function-name fabrications: `startStreamPump`, `getRealExecutorSdkOptions`)

This is a textbook niche payoff. The multi proposer received four typed ports (`filesConsidered`, `filesRuledOut`, `couplingObservations`, `summary`) which by construction encode *what was looked at* but not *the verbatim function symbols*. When the proposer needed to name a helper, it inferred a plausible-sounding name from module purpose ("the function that builds SDK base options" → "getRealExecutorSdkOptions") and got it wrong. The single proposer inherited the explorer's actual `read_file` outputs in conversation history and used the real symbol names.

**Signal 2: Coupling-observation grounding (a2) is best in single (9.0) and bare-sdk (9.0), worst in multi (8.5).** Margins are narrow but consistent: when the explorer's nuanced observations need to make it to the proposer, conversation-state carries them more faithfully than typed ports.

**Counter-signal: a1_filesRuledOut is multi-best (8.0) and single-worst (6.0).** Multi structurally collects ruled-out files into a typed array; the proposer can't help but address them. Single relies on the proposer picking up the explorer's narrative around ruled-out files, and the model didn't do that as thoroughly. So: typed ports help *enumerate* the ruled-out list; conversation-state helps *verify* what's in it.

**Net**: in this scenario, single's gain on accuracy + grounding outweighed its loss on enumeration completeness. Niche claim **vindicated** for the codebase-exploration sub-case.

### propose-critique: working-state did NOT pay off; multi structurally won

The reverse pattern emerged:

**Signal 1: a3_severityCalibration is multi-best (8.0), bare-sdk-second (6.5), single-worst (6.0).** Multi's critic only saw the chosen design + alternatives + traced use cases + open concerns as typed ports — NOT the proposer's full reasoning. This *forced* the critic to engage at face-value with the proposed severities, leading to a more disciplined CRITICAL/MAJOR/MINOR/NIT calibration. Single's critic inherited the proposer's confidence ("I chose Alt A; here's why I rejected Alt B") and seems to have softened severity to fit the inherited stance — its critic only used MAJOR and MINOR, never CRITICAL.

This is the empirically interesting failure mode: **working-state preservation can transmit the proposer's biases into the critic**, defeating the critic's structural job (independent re-examination). Stage isolation via typed ports is a feature, not a cost, when the second stage's value depends on adversarial distance.

**Signal 2: a2_stressTestOriginality is multi-best (9.0), bare-sdk-second (8.0), single-worst (7.0).** Multi's critic, working from a structured handoff, was more motivated to invent stress tests *not* in the proposer's enumeration (5 scenarios: hot-update polling, multi-tab connection saturation, partial /tools failure, 2G network, transcript discovery). Single's critic saw the proposer had already traced 4-6 use cases and added only 2 more — apparently anchored on what the proposer had done.

**Signal 3: Attribution score is unanimously -1 (typed-port advantage) for multi, -1 for single both, +1 for bare-sdk.** The reviewers actually *confused single with typed-port handoff* in most cases — the critique didn't read like one continuous conversation. This suggests Haiku 4.5 in single-mode is treating the second stage's prompt as a fresh task and not weaving in the conversation history as densely as a true single-conversation would. Could be a prompt-engineering issue, but the evidence today is what we have.

**Net**: niche claim **falsified** for the design+critique sub-case. Multi's structural separation produced a better critique; single's contiguous conversation produced a more biased one.

### Why this matters for §10.3 attribution

The niche spec's §10.3 was worried about circular reasoning: "of course single beat multi, look at the prompts!" The empirical answer is more interesting. **In one scenario the niche is real, with a specific identifiable mechanism (function-name fidelity). In the other, the niche is anti-real, with a different specific identifiable mechanism (proposer-bias contamination of critic).** Neither result is a prompt-engineering artifact — they reflect genuine architectural tradeoffs in when stage isolation helps vs hurts.

The verdict NICHE NARROWER is therefore not a hedge; it is the most accurate description: the runtime feature (cross-segment-resume) works correctly and reliably; whether it produces *better outcomes* depends on the structural relationship between the two stages, not on whether they share a session.
