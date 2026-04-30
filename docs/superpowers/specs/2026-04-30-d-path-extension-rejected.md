# D-path Extension to Automation/Lookup — REJECTED

**Status**: rejected on design feasibility grounds (2026-04-30)
**Continuation**: c12 D3
**Roadmap reference**: `docs/superpowers/dogfood-2026-04-28/handoff.md` §c11+
Roadmap "方向 3: D path 扩展到非 investigation pipelines"

---

## What was proposed

Extend the c9.6 D-path pattern (LLM emits content fields, code
hardcodes IR template) from investigation pipelines to two more types:

- **automation** typical shape: `prereqs → fetch → transform → validate → persist`
- **lookup** typical shape: `frame → query → format`

with two new builtin scripts (`assemble_automation_ir`,
`assemble_lookup_ir`) and analyzing-prompt routing on a new top-level
`pipelineType` field.

## Why D-path works for investigation

Investigation pipelines have a **fixed domain-knowledge structure**:

- 4 stable sub-types (lookup / diagnostic / selection / landscape)
- canonical Layer-0/1/2/3 flow (framing → foundations → investigation
  → quality judgment)
- a known set of structured fields the LLM fills (audience, axes,
  concepts, hypotheses, evidence shape, findings, tutorials)
- 7 gates whose semantics are fixed across every investigation

The 17-stage (now 20-stage post-D1) skeleton is a faithful
abstraction of "do an investigation" because investigations are a
genuine type with shared structure.

## Why D-path does NOT work for automation

Automation pipelines lack equivalent structure:

- "fetch / transform / persist" is a phrase, not a type. Each stage's
  inputs / outputs / promptRef / port shapes depend entirely on the
  specific automation:
    - "every Monday email me a digest of my GitHub stars" needs a
      cron-trigger external input, GitHub-API fetch shape, summary
      transform, SMTP persist
    - "transcribe my audio inbox and file the transcripts in
      Obsidian" needs filesystem-watcher input, audio-file fetch,
      Whisper-style transform, Obsidian-vault persist
    - "monitor X-rate breakage and slack me on regression" needs
      timed-poll input, HTTP fetch, comparison transform, Slack persist
- the cross-task overlap is shallow: two automations sharing the same
  abstract shape have almost zero portable structure (different
  externalInputs, different mcpServers, different stageContracts).

Hardcoding the 5-stage template gives the LLM almost no structural
relief — it must still fill nearly every field per task. The
"verbatim-copy from catalog" lever that prevented mechanical errors
in investigation IRs (envKeys, command, args) does still help, but it
is already covered by the existing gen-skeleton prompt.

The genuine mechanical errors that hit pre-D-path investigation IRs
(wire type mismatches, dedup failures, port shape drift across
fanouts, reject-target topology errors) **were structural complexity
that automation pipelines lack**. A 5-stage no-fanout pipeline has so
few wires that the LLM does not bounce off them.

## Why D-path is even less useful for lookup

The "lookup" type as described ("查询 X 的当前状态" — return one
fact) is structurally simpler than automation. Existing investigation
sub-type `lookup` already handles single-concept explainers via the
20-stage skeleton, which is more than enough. A standalone 3-stage
"lookup" pipeline would just be a degenerate special case of an
investigation lookup.

If the user wants ultra-light "one-shot question" behavior, the right
lever is to add a fast-path to the existing investigation skeleton
(skip prereqGate / tutorialAuthoring fanout when concepts list is
empty), not to build a parallel pipeline type.

## The real lever, if/when LLM generates automation IRs

Improvements that matter when pipeline-generator produces an
automation pipeline:

1. **Stronger structural-constraint prompts** — explicit anti-patterns
   in `gen-skeleton.md` for automation shapes (e.g. "if fetch is HTTP,
   the response port must be `string` not `object`"; "validate must
   come before persist; never the other way").
2. **Validator-level checks for automation shape** — analogous to
   c11's `ENVKEY_NOT_REFERENCED`, encode shape rules that catch
   common automation footguns at submit time.
3. **A test-fixture corpus of "good" automation IRs** that the prompt
   references as examples.

These can be added incrementally as real automation use cases land,
without committing to a hardcoded template.

## Decision

**Do not build `assemble_automation_ir` or `assemble_lookup_ir`.**

When real automation use cases drive demand, the right response is
prompt + validator improvements (§The real lever above), not a
hardcoded template the LLM has to bend to each new task.

**Re-open the question if**: a user actually generates ≥3 automation
pipelines through pipeline-generator and the same shape recurs.
That recurrence is the empirical signal that hardcoding pays back.
Until then the cost is speculative.

## What this commit captures

This document, written and committed as the design output of c12 D3.
No code changes accompany it. The c11+ roadmap entry for D3 is now
considered closed in the form "rejected with rationale".
