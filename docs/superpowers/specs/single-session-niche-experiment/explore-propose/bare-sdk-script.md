# Bare-SDK baseline — explore-propose

Run this in a fresh Claude Code conversation (no workflow wrapping). The
goal is the §1 baseline: "the same agent loop run as one continuous SDK
conversation". Capture wall-clock from your watch (or `time` if running
via CLI) and cost from the `/cost` summary at session end.

## Setup
1. Open Claude Code in a fresh session against the same model the workflow runs use (default `claude-haiku-4-5` per real-executor.ts).
2. Set `cwd` to the same `repoPath` you'll feed the workflow runs.
3. Note the start time.

## The conversation

Paste this verbatim as the first user message:

> I'm going to ask you to do two things in sequence: first explore a
> codebase, then propose a refactor. The goal of the refactor is:
> **`<refactorGoal>`**.
>
> Phase 1: Explore the codebase. List the relevant directories, open
> 5-15 files that seem load-bearing for the refactor, and form opinions
> about coupling, naming patterns, and where the change would land.
> Note files you peeked at and ruled out, and why. Form partial
> intuitions about coupling/smell/tension between modules. When you
> feel you have enough to write a good proposal, summarize your read
> in 100-200 words.
>
> Phase 2: Produce a refactor proposal in markdown with sections:
> 1. Summary (3-5 bullets)
> 2. Files touched
> 3. Files explicitly NOT touched (with reason)
> 4. Risk and rollback
> 5. Open questions for review
>
> The proposal must reference at least one specific concern from your
> exploration. Generic refactor advice is a failure.

After the model finishes phase 2, type `/cost` (or note the cost
manually) and stop.

## What to capture

| Metric | Source |
|---|---|
| Wall-clock | Stopwatch / `time` |
| Cost (USD) | `/cost` summary |
| Input tokens | `/cost` summary |
| Output tokens | `/cost` summary |
| Final markdown | Last assistant message — paste into `results/<scenario>/<run-id>.md` |

## Notes
- Do NOT use a system prompt that mimics the workflow's `system_prompt_append`. The bare-SDK baseline should reflect what a competent operator would do without workflow control — that's a system prompt of "claude_code" preset and nothing else.
- If the model hits maxTurns or the budget cap mid-conversation, that IS the result — record it. Workflow runs have the same caps; the comparison is fair only if all three variants share them.
