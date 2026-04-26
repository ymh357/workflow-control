# Quality Rubric

> The §7.3 quality contract claims single must produce a STRICTLY better outcome
> AND the preference must be ATTRIBUTABLE to working-state preservation.
>
> This rubric instantiates that test in a way reviewers can score without
> knowing which variant produced an output. Each dimension is 0-10. Use
> the integer scale; "halves" muddy the inter-reviewer agreement check.

---

## Universal dimensions (apply to every output)

### 1. Brief satisfaction (0-10)
Does the output address the explicit deliverables in the brief / prompt? Score by checklist: every required section present and non-trivial → 10. Each missing or hand-waved section → −2.

### 2. Specificity (0-10)
Does the output reference concrete artifacts (files, function names, alternative names, use cases) or only generic patterns ("consider auth", "watch for coupling")? Concrete throughout → 10. Generic throughout → 0.

### 3. Internal coherence (0-10)
Does the output's reasoning hold together? Score down for: contradictions between sections, recommendations that don't follow from observations, claims unsupported by anything earlier in the document.

---

## Scenario-specific attribution dimensions

These score WHETHER THE WORKING STATE WAS USED. They are the
make-or-break test for the niche claim.

### explore-propose

#### A1. Files-ruled-out integration (0-10)
Does the proposal explicitly reference files the explorer ruled out, with reasoning that connects to those rejections? "files NOT touched: <name> (because <explorer's reason>)" → +points; ignoring the ruled-out list → 0.

#### A2. Coupling-observation grounding (0-10)
Does the proposal's risk / approach section cite specific coupling observations the explorer surfaced? "We extract X from Y because the explorer noted Y depends on Z which would break" → +points. Risk section that lists generic risks → 0.

#### A3. Anti-hallucination (0-10)
Are the file paths and module names in the proposal actually present in the codebase? (Reviewer cross-checks.) Every reference real → 10. Each fabrication → −3.

### propose-critique

#### A1. Rejected-alternative re-examination (0-10)
Does the critique engage with the proposer's rejection reasoning, not just the chosen design? "The proposer rejected alt-X because Y; that reasoning is wrong / right because Z" → +points. Critique that ignores the alternatives section entirely → 0.

#### A2. Stress test originality (0-10)
Does the critique introduce a use case the proposer did NOT enumerate, and use it to expose something? Generic "what about <obvious case>" → low; targeted "the proposer's design fails when <specific scenario>" → high.

#### A3. Severity calibration (0-10)
Are the critique's severity labels (CRITICAL/MAJOR/MINOR/NIT) calibrated? Marking trivia as CRITICAL or marking a real bug as NIT → low. Reviewer judges by their own assessment of the issues found.

---

## Scoring procedure per output

1. Reviewer reads the output WITHOUT knowing which variant it came from.
2. Reviewer scores each of the 3 universal dimensions + 3 scenario dimensions = 6 dimensions × 0-10 each = 60 total.
3. Reviewer notes one sentence per dimension explaining the score.
4. Reviewer ALSO answers: "If you had to attribute this output's strengths/weaknesses to working-state preservation vs typed-port handoff, which way and how confidently?" Scale: −2 (clearly typed-port advantage) … 0 (can't tell) … +2 (clearly working-state advantage). This is the §7.3 attribution clause's empirical proxy.

## Aggregation

For each variant in each scenario:
- Mean total score (max 60)
- Mean attribution score (range −2 to +2)
- Per-dimension mean for the universal three (these should be roughly comparable across variants if the prompts are well-matched)
- Per-dimension mean for the scenario-specific three (these are where the niche either shows up or doesn't)

The decision tree in `protocol.md §5` reads off these aggregates.
