# Sub-Pipeline Path — REJECTED

**Status**: rejected on premature-optimization grounds (2026-04-30)
**Continuation**: c12 D2
**Roadmap reference**: `docs/superpowers/dogfood-2026-04-28/handoff.md` §c11+
Roadmap "方向 2: sub-pipeline 路径"

---

## What was proposed

Let `analyzing` decide when a topic is "too complex for one pipeline"
and emit `subIrs: PipelineIR[]`. The kernel then runs each sub-IR as
its own task, the parent pipeline waits, then `aggregateSubFindings`
merges before `reportAssembly`. Wiring needs:

- analyzing-stage complexity judgment
- `assemble_investigation_ir` extending to emit subIrs alongside the main IR
- main pipeline gets a new `subInvestigationFanout` stage that calls
  `run_pipeline` MCP tool per child
- runtime change: parent task waits on N child tasks
- web UI: tree-shaped task display
- aggregateSubFindings stage
- failure semantics: child fails → parent fails how?

Estimated cost: 2-3 weeks. Touches runtime (cross-task wait), web UI,
analyzing prompt, IR template, and adds a new fanout-of-pipelines mode.

## Why the symptom does not justify the cure

The roadmap's stated motivation: "hypothesis 数 >12 时 evidence quality
摊薄" and "100k+ 超长报告".

**Empirical observation (2026-04-30)**: the largest investigation
report produced through pipeline-generator on this dev machine is
~1155 words (`stage_reportAssembly.md` from
pipeline-generator-1777532818425). The 100k-token threshold is
~75,000 words. We are 65× under the regime where context-window
saturation matters. The "complex topic doesn't fit" failure mode has
not actually been observed.

**Hypothesis-count dilution** is real but has a cheap fix: add an
explicit cap (8-12 hypotheses; 14 max for `landscape`) to the
`hypothesize` prompt. Prompt change. One line. No runtime work.

## Where the runtime cost lands

A cross-task wait primitive is non-trivial:

- Parent task's pipeline sleeps until N child tasks finalize. Today
  the runner has no "wait for external task" primitive — every
  current `secret_pending` style pause is a single-task internal
  state machine.
- Failure cascade: if child 2/5 fails, does the parent run with 4
  partial results or fail entirely? Either policy is committable but
  both are non-trivial.
- Resumability: if the kernel restarts mid-run with parent waiting,
  the resume path must re-establish the wait without re-running
  finished children. This interacts with `pipeline_versions`,
  `task_finals`, `migration_hints`.
- Hot-update: if a child's pipeline version is hot-updated mid-run,
  what does the parent see? The current model assumes one task = one
  version_hash; sub-pipelines violate that.
- Web UI: parent + N children in a tree adds a non-trivial view.

These are all addressable, but they are **infrastructure for a use
case that has not occurred**. CLAUDE.md explicitly cautions against
this: "Don't add features, refactor, or introduce abstractions
beyond what the task requires."

## What actually helps right now

**Cap hypothesis count in the prompt.** Single-line change. Captures
80% of the "evidence dilution" complaint at near-zero cost. Implemented
in a separate commit accompanying this spec.

If reports legitimately grow past ~10k words and context becomes a
real ceiling (not before), revisit:

1. **Section streaming**: `reportAssembly` writes the report
   incrementally per finding rather than holding the whole bundle in
   one prompt. Stays within one task.
2. **Findings-bundle truncation**: cap the per-finding markdown a
   reportAssembly sees (full bundle still in port_values for the
   reviewer).
3. **Sub-pipeline as a last resort**, after (1) and (2) prove
   insufficient.

## Decision

**Do not build the sub-pipeline path.**

The "complexity threshold" the roadmap names is far above current
usage. The cheap fix (hypothesis cap) covers the immediate symptom.
Cross-task wait is correct infrastructure to think about *if and when*
real workloads exceed single-pipeline context, but committing 2-3
weeks of runtime + UI work to it speculatively is the exact pattern
CLAUDE.md tells us to avoid.

**Re-open if**: a real investigation report needs >10k words and
intra-task context optimizations (above) prove insufficient.

## What this commit captures

This document, written and committed as the design output of c12 D2.
A separate commit adds the hypothesis-count cap to gen-prompts.md.
The c11+ roadmap entry for D2 is now closed in the form "rejected
with cheaper alternative".
