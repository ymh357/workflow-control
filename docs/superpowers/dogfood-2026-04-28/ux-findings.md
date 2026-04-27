# Dogfood UX Findings — 2026-04-28

**Scope**: pipeline-generator awaitingConfirm gate first impression for a new user.

**Captured task**: `pipeline-generator-1777304967053-1378afca` — Hacker News Story Extractor (fetch-only, no secrets).

**Screenshots**:
- `01-gate-fullpage.png` — full scroll
- `02-gate-viewport.png` — first 720×640 viewport (no scroll)

## Observations from real DOM probe (chrome-devtools-mcp)

Gate panel structure (verified in-page via evaluate_script):

```
[Task header]
  task id, status, cost, events, MCP cmd button

[Seed Inputs (1)]
  taskDescription verbatim

[GATE PENDING — yellow bg]
  awaitingConfirm
  "Approve this result?"
  <details open=true> analyzing (17 outputs) </details>   ← problem
  [Recommended Tools (1)] section with NOT-EQUIPPED badge
  [Feedback (optional)] textarea
  [approve] [reject] buttons

[Pipeline DAG visualisation]
[Live output / Stages / Recent port writes]
```

## Issue 1 (Important) — `analyzing` details defaults to `open=true`

**Verified**: `document.querySelectorAll('details')[0].open === true`

**Effect**: The 17 output ports of analyzing render expanded as a full-width
table on first paint. The viewport screenshot (`02-gate-viewport.png`)
shows that approve/reject buttons are not visible in the first scroll —
the user has to scroll past 17 rows of structured JSON to reach the
decision. dataFlowSummary, recommendedMcps, stageContracts (which
contains a complete inline TypeScript module body) are all expanded
into the gate area.

**5-second decision test**: A new user opens the gate and is dropped
into a debugger-like view. The minimal-decision triple
(pipelineName / pipelineDescription / dataFlowSummary) is visible but
buried among lower-priority ports (pipelineId, externalInputs,
recommendedSkills, useCases, summary, targetRepoName).

**Fix direction**:
- Default `<details open={false}>` for the analyzing port table
- Show a 3-line "exec summary" inline — pipelineName + pipelineDescription
  + a stage count badge — and let the user expand details on demand.
- Keep RecommendedTools and Feedback sections at their current
  positions; both are correctly weighted.

## Issue 2 (Important) — stageContracts inline TypeScript code in port view

**Sample**: `stageContracts[1].moduleSource` for the formatOutput script
stage was a 200-character TypeScript block. Currently it ships verbatim
into the port row.

**Effect**: Non-developer users see a wall of code where they expect
a stage description. Developer users have IDEs to read code in.

**Fix direction**: At the gate, render `moduleSource` as a collapsed
`<details><summary>view source</summary>...</details>` instead of a
verbatim code block, OR replace inline source with a single line
"inline ScriptModule (N chars)" + a copy button. The full text is
still available via `read_port`.

## Issue 3 (Minor) — No "what should I look at" hint

**Effect**: User has to know which ports are decision-relevant. With
17 port rows, "approve" feels under-informed. Putting a 1-line preamble
above the details table — e.g., "Review the 3 highlighted fields
(pipelineDescription / dataFlowSummary / recommendedMcps), expand
details for everything else" — would lower friction.

Lower priority than 1+2.

## What's working

✅ RecommendedTools section is well-designed — entry name + NOT-EQUIPPED
   badge + "前往装备 ↗" link is exactly the right amount of context.

✅ Feedback (optional) textarea sits above approve/reject. User who
   wants to reject sees the input naturally.

✅ Per-port `full` details (the JSON full payload) is correctly
   collapsed by default. Only the table-level analyzing wrapper is
   open-by-default.

✅ Pipeline DAG visualisation lives BELOW the gate decision area —
   correctly relegated to "extra context" weight.

✅ Top header is concise: id + status + cost + events count fits one row.

## Decision

Issues 1 and 2 are real UX bugs but not blockers — the gate is usable,
just unnecessarily heavy on first paint. Document and continue with
the dogfood (approve gate → let generator finish → run the new
pipeline to verify Step 6-9 link).

Frontend fix can land as a separate, focused commit after dogfood.
