# Bare-SDK baseline — propose-critique

Run this in a fresh Claude Code conversation. Same protocol as
`../explore-propose/bare-sdk-script.md`; this scenario's content
differs.

## Setup
Same as the other scenario. Different input: `apiBrief` (text from
`protocol.md §2`).

## The conversation

Paste this verbatim:

> I'm going to ask you to design an API and then critique your own
> design. Here is the brief:
>
> **`<apiBrief>`**
>
> Phase 1 (proposer):
> - Sketch at least 3 distinct alternative designs.
> - For each, mentally trace through every use case implied by the brief; record what works / what doesn't / what each alternative does worse than its rivals.
> - Pick a chosen design based on the trace, NOT on first instinct.
> - Note open concerns about the chosen design.
> - Output: a markdown document with the chosen design (endpoints / types / examples / state model), the alternatives section (with rejection reasons), the trace section, and the open-concerns list.
>
> Phase 2 (critic): now switch hats. As a senior reviewer, find every issue with the chosen design that could bite the team in production, and do so by genuinely engaging with the rejected alternatives — re-examine each rejection and stress-test the chosen design against use cases not in the original brief.
> - Output sections in this order: Verdict (SHIP/REVISE/RESTART) · Issues (numbered with severity) · Re-examined alternatives · Stress test · Recommendations.

After phase 2 finishes, run `/cost` and stop.

## What to capture
Same metrics as the other bare-sdk script.

## Notes
- The "switch hats" instruction is intentional. The bare-SDK comparison is to "one continuous conversation that does both jobs" — splitting the conversation into two SDK sessions defeats the purpose of the baseline.
- If the model resists self-critique or skims it ("looks good!"), that's a real failure mode of the bare-SDK approach and worth recording — workflow's stage isolation may help here.
