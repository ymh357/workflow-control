# Experiment Results

> Fill this in as the experiment runs. Don't average / round prematurely
> — record raw per-run numbers and let the decision matrix do the work.

## Run metadata

### explore-propose

| Variant | taskId / session | Wall-clock (s) | Cost (USD) | Input tokens | Output tokens | Notes |
|---|---|---|---|---|---|---|
| bare-sdk |  |  |  |  |  |  |
| multi    |  |  |  |  |  |  |
| single   |  |  |  |  |  |  |

### propose-critique

| Variant | taskId / session | Wall-clock (s) | Cost (USD) | Input tokens | Output tokens | Notes |
|---|---|---|---|---|---|---|
| bare-sdk |  |  |  |  |  |  |
| multi    |  |  |  |  |  |  |
| single   |  |  |  |  |  |  |

## Quality scores

### explore-propose

For each variant, capture both reviewers' totals + per-dimension breakdown.

| Variant | R1 total | R2 total | Mean | Brief | Specificity | Coherence | A1 ruled-out | A2 coupling | A3 anti-halluc | Attribution |
|---|---|---|---|---|---|---|---|---|---|---|
| bare-sdk |  |  |  |  |  |  |  |  |  |  |
| multi    |  |  |  |  |  |  |  |  |  |  |
| single   |  |  |  |  |  |  |  |  |  |  |

### propose-critique

| Variant | R1 total | R2 total | Mean | Brief | Specificity | Coherence | A1 alts re-exam | A2 stress test | A3 severity | Attribution |
|---|---|---|---|---|---|---|---|---|---|---|
| bare-sdk |  |  |  |  |  |  |  |  |  |  |
| multi    |  |  |  |  |  |  |  |  |  |  |
| single   |  |  |  |  |  |  |  |  |  |  |

## Inter-reviewer agreement

Per scenario, count the dimensions where R1 and R2 differ by ≥3 points.
If agreement is poor (≥3 dimensions), note which ones and add a third
reviewer for those before applying the decision tree.

| Scenario | Dimensions disagreed (≥3 pts) | Resolution |
|---|---|---|
| explore-propose |  |  |
| propose-critique |  |  |

## Decision

Apply `protocol.md §5` strictly. Don't fudge.

- [ ] Single quality ≥ multi + 2, both scenarios?
- [ ] Single cost ≤ multi × 1.20, both scenarios?
- [ ] Single wall-clock ≤ multi × 1.10, both scenarios?

**Verdict**: ☐ NICHE CONFIRMED  ☐ NICHE FALSIFIED  ☐ NICHE NARROWER

**Action items derived from the verdict**: …

## Attribution narrative

For each scenario, write 2-3 paragraphs explaining the attribution
score. Specifically: did single's output reference reasoning that the
multi+ports handoff couldn't have carried? Or did the multi+ports
output land in the same place from the structured handoff alone?

This narrative is what closes the niche spec §10.3 circular-reasoning
concern. Without it, the verdict is just numbers and isn't trustworthy.
