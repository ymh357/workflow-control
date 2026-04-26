# Single-Session Niche A/B Experiment

> Date created: 2026-04-27 (followup-handoff §6 step 2)
> Status: ready to run; awaiting an explicit decision to spend ~$5-15 of API budget on the live runs.
> Parent spec: `../2026-04-26-single-session-niche.md` (§10.4 step 2)

This directory contains everything needed to run the niche feasibility A/B
experiment offline. The intent is that whoever picks this up next can do
the entire experiment by following a single command sequence in §3 — no
spec re-reading, no IR re-authoring.

The experiment scores `session_mode: "single"` against:
- (a) bare-SDK conversation (the §1 contract baseline)
- (b) workflow `session_mode: "multi"` with carefully-chosen typed ports
- (c) workflow `session_mode: "single"`

…on two scenarios chosen for being §4-positive (working state genuinely
hard to structure):

| Scenario | Stages | Working-state reason |
|---|---|---|
| **explore-propose** | `exploreCodebase` → `proposeRefactor` | "files considered then ruled out", coupling intuitions, partial smell judgments |
| **propose-critique** | `proposeAPIDesign` → `critiqueAPIDesign` | "alternatives considered and rejected", traced-through-use-cases reasoning |

## 1. Files in this directory

```
README.md                                     ← this file
protocol.md                                   ← step-by-step run + scoring procedure
quality-rubric.md                             ← §7.3 attribution-test rubric, instantiated
results-template.md                           ← table to fill in during runs
explore-propose/multi.pipeline.ir.json        ← variant (b)
explore-propose/single.pipeline.ir.json       ← variant (c)
explore-propose/bare-sdk-script.md            ← variant (a) — paste into Claude Code
explore-propose/prompts/                      ← shared prompt files for (b) and (c)
propose-critique/multi.pipeline.ir.json
propose-critique/single.pipeline.ir.json
propose-critique/bare-sdk-script.md
propose-critique/prompts/
```

The pipeline IRs are NOT installed as builtins (the
`session_mode: "single"` gate at the generator layer remains in place
per niche spec §10.4). They live here as research artifacts; submit
them ad-hoc via `POST /api/kernel/tasks/run` with the IR contents as
the body.

## 2. Why two scenarios, not one

Single-scenario results are too easy to dismiss as task-specific. Two
scenarios drawn from different §4 examples — explore-propose covers
"open-ended exploration history" and propose-critique covers "rejected
alternatives reasoning" — give independent evidence channels.

If both scenarios show single beating multi+ports on §7.3 quality at
≤20% cost premium, the niche is real. If neither does, the niche is
empty and the runtime feature should be retired. Mixed (one scenario
each way) means the niche may exist but is narrower than the spec
claims; redefine §2 criteria before resuming.

## 3. Operational quickstart

```bash
# 1. Confirm the kernel-next server is up.
curl -s http://localhost:3001/health/ready

# 2. Launch each variant. Replace <input> with the experiment input
#    (see `protocol.md §2` for the canonical inputs).
for scenario in explore-propose propose-critique; do
  for variant in multi single; do
    body=$(cat <<EOF
{ "ir": $(cat $scenario/$variant.pipeline.ir.json | jq -c .),
  "prompts": $(jq -n '{}' --rawfile a $scenario/prompts/explorer.md --rawfile b $scenario/prompts/proposer.md '{"explorer": $a, "proposer": $b}'),
  "seedValues": { "input": "<input>" } }
EOF
    )
    # Submit IR + prompts then start a task. Use the propose-then-run
    # flow described in protocol.md §3.
  done
done

# 3. Bare-SDK runs are manual: open Claude Code, follow each
#    bare-sdk-script.md verbatim, capture cost/wall-clock from the
#    /cost summary at session end.

# 4. Score every output against `quality-rubric.md`. Two reviewers
#    independently. Record agreement rate.

# 5. Fill `results-template.md`. Decide niche fate per
#    parent-spec §10.4 step 2's "experiment can fail honestly" clause.
```

Detailed protocol and contingencies (rate limits, partial failures,
cache priming) live in `protocol.md`.
