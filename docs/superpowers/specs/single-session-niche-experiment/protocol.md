# Experiment Protocol

## 1. Pre-flight

- Confirm the kernel-next server is running on `localhost:3001` and the cross-segment-resume pivot is in place (`git log --oneline | grep cross_segment_resume_from` should show the November-26 commits).
- Confirm prompt cache is COLD before each scenario's first run, WARM for the rest. Ordering: `bare-SDK → multi → single` per scenario, all back-to-back, so the cache state is consistent across the variants and any prompt-cache advantage shows up uniformly.
- Pin the model: `claude-haiku-4-5` (the kernel default at this writing). All runs must use the same model — don't let the launcher's `model` override drift.

## 2. Canonical inputs

To make the comparison fair across variants AND across runs (in case
someone wants to re-do the experiment later), pre-commit to specific
inputs. Don't paraphrase.

### explore-propose
- `repoPath`: `/Users/minghao/workflow-control/apps/server/src/kernel-next/runtime/`
  (a real, mid-sized directory the team knows well — easy to tell whether the proposal references actual files vs. hallucinated names)
- `refactorGoal`: `"Extract the per-attempt SDK lifecycle (mcp factory, abort controller, heartbeat, stream pump, writer close) out of real-executor.ts into a SdkAttemptRunner class so doAttempt becomes a thin orchestration shell."`

The runtime directory has a clear "huge file plus several small ones"
shape that any decent explorer will notice; coupling observations here
are concrete (real-executor.ts depends on agent-machine, sdk-adapter,
stream-pump, port-runtime, execution-record-writer).

### propose-critique
- `apiBrief`: `"Design an HTTP API for the kernel-next dashboard to fetch attempt-level execution details: agent stream JSON, tool calls, prompt content, cost breakdown, and the optional sub-agent transcript. The endpoint must support the dashboard's tabbed view (one fetch per tab is fine; one fetch for everything also fine — pick one). Audience: a single user on a local-only deployment, no auth, may be called dozens of times per minute as the user clicks around. Constraint: kernel uses Hono + node:sqlite; do not introduce new dependencies."`

This brief has clean alternatives (one-fetch-per-tab vs all-in-one;
JSON-RPC-shaped vs REST-shaped; eager vs lazy-blob loading) so a real
proposer will surface them.

## 3. Per-scenario, per-variant procedure

For EACH scenario × EACH variant (2 × 3 = 6 total runs):

### multi / single (workflow runs)
1. Submit the IR + prompts via the propose flow (or via a one-shot HTTP call):
   ```bash
   curl -s -X POST http://localhost:3001/api/kernel/proposals \
     -H 'content-type: application/json' \
     -d '{ "ops": [], "actor": "niche-experiment", "rerunFromStage": null, "migrateRunningTasks": "none",
           "ir": <contents of multi.pipeline.ir.json or single.pipeline.ir.json>,
           "prompts": { "system/explorer": <explorer.md contents>, "system/proposer": <proposer.md contents> } }'
   ```
   (For propose-critique, the prompts are `system/proposer` and `system/critic`.)
2. Approve the proposal.
3. Launch a task on the new pipeline via the dashboard's launcher (that's why we built it!). Fill in the seed input from §2.
4. Wait for the task to reach `completed`. Capture from the task detail page:
   - Wall-clock (ended_at − started_at)
   - Cost (cumulative USD)
   - Input tokens
   - Output tokens
   - Final port value (proposalMarkdown / critiqueMarkdown)
5. Save outputs into `results/<scenario>/<variant>/`:
   - `metadata.json` — { wallClockMs, costUsd, inputTokens, outputTokens, taskId }
   - `output.md` — the final markdown port value

### bare-sdk
Follow `<scenario>/bare-sdk-script.md` verbatim. Save the same metadata
+ output.

## 4. Scoring

Once all 6 runs are saved, run the rubric in `quality-rubric.md` with
TWO independent reviewers per run. The reviewers should NOT know which
variant produced each output before scoring (file by hash, swap names
for `output_a.md` / `output_b.md` / `output_c.md`).

Capture per-run:
- Reviewer 1 score (0-10) per rubric dimension
- Reviewer 2 score (0-10) per rubric dimension
- Inter-reviewer agreement (Cohen's κ optional; just note disagreements ≥3 points)

## 5. Decision matrix

After scoring, fill `results-template.md`. Then apply this decision tree
strictly — don't fudge:

```
IF single's quality ≥ multi's quality + 2 points (avg across reviewers, both scenarios):
  AND single's cost ≤ multi's cost × 1.20:
    AND single's wall-clock ≤ multi's wall-clock × 1.10:
        → NICHE CONFIRMED. Update niche spec §10.4 step 3 with measurements.
        → Pipeline-generator gate may be lifted, with explicit niche criteria check.

ELSE IF single's quality < multi's quality OR cost > multi's × 1.5:
    → NICHE FALSIFIED. Retire the runtime feature.
    → Update niche spec §10.4 step 3 with negative result.
    → Remove session_mode='single' code paths (close §10.1 with "performance optimization
      framing wins, and the optimization doesn't pay off").

ELSE (mixed result — quality wins but cost doesn't, or one scenario each way):
    → NICHE NARROWER THAN SPEC. Document what's true: which sub-cases of §4 work, which don't.
    → Tighten §2 criteria; gate stays in place; revisit after another experiment.
```

## 6. Contingencies

- **Rate limiting**: if 429s show up, pause and resume — the F22 retry budget plus the new abortable backoff (commit c142e51) handles this gracefully.
- **MCP_ENV_MISSING**: the experiment pipelines don't declare external MCP servers, so this shouldn't fire. If it does, something is wrong with the IR — fix it before re-running.
- **Bare-SDK hits maxTurns**: record it as the result; do NOT re-run with higher turns. The cap is part of the §1 baseline contract.
- **Workflow run gets stuck in `running`**: the new graceful-shutdown work (commit 89d7f98) means a restart is safe. Cancel the task via the new dashboard button and re-run.
- **Quality rubric disagreement**: if reviewers diverge by ≥3 on the SAME dimension across multiple runs, the rubric is under-specified for the scenario at hand. Refine the rubric BEFORE re-scoring; don't average over an unstable measurement.
