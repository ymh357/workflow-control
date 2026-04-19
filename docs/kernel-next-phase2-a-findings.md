# kernel-next Phase 2 A Findings

**Date**: 2026-04-19
**Scope**: Replace the mock pipeline generator with real Claude Haiku
4.5 via the MCP surface. Measure whether the agent can author a valid
PipelineIR end-to-end through `submit_pipeline`, and patch an existing
one through `propose_pipeline_change`. Diagnostic-feedback loop is in
scope (SDK multi-turn).
**Model**: `claude-haiku-4-5` (via local Claude CLI auth, ~/.claude)
**Budget**: `maxBudgetUsd=0.3` per generation run; total actual spend
across all experiments under $2.

## TL;DR

- **Diamond generation — 10/10 compliance on first sampling.** Claude
  produces a structurally correct diamond (A -> {B, C} -> D) pipeline
  IR that passes all kernel validation (structural + DAG + tsc). Mean
  2.9 turns, mean cost $0.07, mean 27s.
- **Patch (multi-op structural edit) — 9/10 compliance.** Claude
  applies 6-op patches (remove_stage×2, add_stage×2, add_wire×3) that
  correctly rebuild B and D with extra port + wire, passing validation.
  The one failure submitted exactly one `propose_pipeline_change` call
  that was rejected by the validator, and the model did not retry
  despite the diagnostic. Mean 3.1 turns, mean cost $0.12.
- **Diagnostic retry loop fired 0/20 times.** Claude's one-shot
  authoring is precise enough that the feedback loop had nothing to
  recover. This is good but leaves the retry path UNVALIDATED — we
  don't yet know how the loop behaves under sampling noise or with a
  deliberately hard task.
- **Tool-call authoring contract is robust.** Same lesson as P1: when
  the agent emits structured output via an MCP tool call (here
  `submit_pipeline` / `propose_pipeline_change`), the SDK-level
  `ir` argument shape is clean; no envelope-swallowing, no nested
  JSON. The `submit_pipeline` tool input schema (`ir: z.unknown()`)
  with Zod-based validation at the kernel gives Claude a pressure-free
  authoring surface.

## Experiment matrix

| Script | N | Model | Landed | Semantic-correct | Salvaged | Mean turns | Mean cost | Mean dur |
| ------ | - | ----- | ------ | ---------------- | -------- | ---------- | --------- | -------- |
| diamond-generate | 10 | Haiku 4.5 | 10/10 | 10/10 | 0 | 2.9 | $0.071 | 27.8 s |
| diamond-patch    | 10 | Haiku 4.5 | 9/10  | 9/10  | 0 | 3.1 | $0.116 | 45.2 s |

- "Landed" = new row appeared in `pipeline_versions` (generate) or new
  pending row in `pipeline_proposals` (patch).
- "Semantic-correct" = additional checks beyond kernel validation:
  diamond shape (1 entry, 2 middle, 1 join) for generate; B has extra
  output port + D has bExtra input + new wire present for patch.
- "Salvaged" = runs that landed only after a second `submit_pipeline`
  or `propose_pipeline_change` tool call (diagnostic feedback loop
  worked). Zero across both experiments.

## Finding #1 — Haiku can produce valid kernel-next IR one-shot

On the diamond task, 10/10 runs produced an IR that:

- Uses valid identifiers for all stage/port names.
- Declares correct TypeScript port types (`number`, `string`) without
  drifting into `any` / generics / unions.
- Gets the wire topology right (1 entry stage, 2 middle stages with
  2-way fan-out, 1 join stage with 2-way fan-in).
- Compiles through `tsc --noEmit` (the wire type-compat check).
- Preserves the prompt text from the task description nearly verbatim.

Two canonical hashes appeared across the 10 runs (7ca3a3d... × 6,
1538bafc... × 4) — the difference is at the canonical-JSON level
(probably port declaration order). Both hashes are equivalent diamond
IRs semantically.

Implication: **the MCP `submit_pipeline` tool with a Zod-based
validator and textual diagnostics is a sufficient authoring surface
for Haiku on this shape complexity.** No prompt engineering tricks
beyond listing the rules in the system prompt were needed.

## Finding #2 — Patch (structural remove-and-re-add) also works

The patch task is harder than generation: the agent must hold the base
IR in working memory, decide which stages to remove-and-re-add (since
the op set cannot grow existing stages' port lists), and sequence 6
ops correctly. 9/10 runs emitted a valid multi-op patch on the first
propose.

The operations Claude composed in a successful run:

```
remove_stage: B
remove_stage: D
add_stage: B (inputs: x:number; outputs: y:string, extra:string; ...)
add_stage: D (inputs: b:string, c:string, bExtra:string; outputs: final:string; ...)
add_wire: A.x -> B.x
add_wire: B.y -> D.b
add_wire: C.z -> D.c
add_wire: B.extra -> D.bExtra
```

The model correctly deduced the cascade: removing B automatically
drops A.x->B.x, B.y->D.b; removing D drops C.z->D.c. All four wires
need re-adding. Claude gets this right without being explicitly told
in the task (the system prompt does mention cascade in passing).

The **one failure** (run 5) submitted one `propose_pipeline_change`
that was rejected (no new proposal row appeared in DB), but the model
did not retry despite `maxTurns=20`. The `resultSubtype` was
`success`, meaning Claude ended its turn voluntarily rather than
running out of budget. We don't have the specific diagnostic (tool
response contents aren't captured in the harness — future work).

## Finding #3 — Diagnostic feedback loop fires 0 times in this session

Across 20 runs, zero got saved by retry. Either:
- Haiku's first-shot IR is essentially always valid for these two
  tasks (good news), OR
- The tasks aren't hard enough to exercise the loop.

Diamond and single-patch are both closer to "textbook" than the kind
of real pipeline (tech-research, 15-27 stages with fragment
references) that would stress the loop. **We don't yet know whether
Claude correctly reads a diagnostic and adjusts.** Leftover work.

## Finding #4 — Observation bugs in the harness

- **`submit_attempts=0` in run 2 of generate** (landed=true). The
  `countToolUses` helper scans `assistant.message.content[].type ===
  'tool_use'` but the SDK emits tool use information in more than one
  message type (partial assistant chunks, possibly compacted
  messages). The DB-based "did something land" check is the source
  of truth; the attempt counter is only accurate when non-zero.
- **Two different canonical hashes for equivalent diamonds**. Port
  order in `stage.outputs` propagates into the canonical JSON. Not a
  bug — it's literally content-hashing — but worth noting for
  downstream tools that might assume structurally equivalent IRs have
  equal hashes.

## Finding #5 — Actionable next-session work

From these findings, the concrete to-dos for a follow-up session:

1. **Capture tool-call responses in the harness.** Add an observer that
   records each `mcp__kernel_next__*` tool call's args and response
   text. Without this, we can't distinguish "model saw diagnostic and
   gave up" from "model never saw any diagnostic."
2. **Harder generation task**. A 10-stage pipeline with fragments,
   non-trivial types (`Array<{...}>`), and realistic prompts, to see
   if the loop ever actually fires.
3. **`submit_attempts` double-count**. Either fix the tool-use
   observer or drop the metric from the stress reports (DB is truth).
4. **Patch op set might want `add_port` / `remove_port` ops**. 9/10
   passed even without these, but the "remove+re-add stage" dance is
   wasteful tokens and error-prone; if heavy use of patches becomes a
   real workflow, a port-level op would be worth the schema
   expansion.

## What's solid

- The kernel-next IR schema + Zod validator + tsc wire-check is a
  strong-enough contract that Haiku respects it. This is the
  precondition for every downstream "AI self-modifies pipeline"
  workflow. It's been proven here.
- Tool-call authoring (kernel MCP `submit_pipeline`) is the right
  shape for AI-generated structured content. Same recommendation as
  P1 for write_port — the MCP wire format owns the envelope, the
  model owns the payload.
- Cost is trivial: $0.07 to generate, $0.12 to patch. Running 100
  generations / 100 patches to gather more data would cost <$20.

## Report artifacts

- `/tmp/kernel-next-gen-diamond-v1.json` — 10-run generate report
- `/tmp/kernel-next-gen-patch-v1.json` — 10-run patch report
- `/tmp/a-smoke.json`, `/tmp/a-patch-smoke.json` — 1-run smokes before
  each 10-run pass
