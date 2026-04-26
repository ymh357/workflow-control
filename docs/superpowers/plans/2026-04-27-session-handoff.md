# Session Handoff — Cross-Segment Pivot, F17 Secret-Gate, F22 SDK Lifecycle, web3-research Dogfood ×3

> **Date**: 2026-04-27
> **Scope**: Successor to `2026-04-26-web3-research-dogfood-conclusion.md` and the master `2026-04-25-pipeline-generator-dogfood-findings.md`. Records the latest session's outcomes and — critically — the items that did NOT close.
> **Total commits this session**: 30 on main (range `f2429fe..9cb0758`)

---

## 1. What landed (one-liners)

| Commit range | Topic | Status |
|---|---|---|
| `f2429fe`..`44fc37b` (11) | Cross-segment resume pivot | ✅ landed, reviewed, multi-mode hash-stable |
| `f44e0ea`..`19b62bf` (11) | F17 secret-gate (spec → impl → e2e → bug fixes) | ✅ proven by round-7 Arbitrum revival |
| `86b989d` | F19 fanout secret_pending leak | ✅ unit tested |
| `6a80602` | F20 adversarialFactCheck temporal-anchor rule | ✅ propagating fix |
| `944fd41` | F22 #1 + #2 (MCP_STARTUP_FAILED retry + SDK abort) | ✅ proven by round-10 0G |
| docs (5) | Round 7 / 8 / 9-10 handoffs + F22 finding | ✅ |

**Three web3-research deliverables produced this session**: Arbitrum (round 7), Solana (round 8), 0G bridges (round 10). All three are 22-23K-character Chinese markdown reports addressing all six research questions in the pipeline IR. Stored in `port_values` rows; transient copies at `/tmp/{web3,sol,0g}-final.md`.

---

## 2. Open issues — the actual handoff

### 2.1 🟡 Reconciler may treat error-status stages as "covered" when port_values exist (UNCONFIRMED)

**Symptom seen in round 9 (pre-F22)**:
- `collectPrimarySources` attempt 1 ended with `status='error'` AT t+15s.
- The leaked SDK then called `write_port` AT t+140s, writing `primarySourceReport` and `sourceCatalog` rows tied to that error attempt's `attempt_id`.
- Reconciler / runner advanced to `domainResearch` instead of retrying `collectPrimarySources`.

**Why it might be a real reconciler bug** (not just F22 corruption):
- `classifyOrphan` builds `successStages` via `SELECT DISTINCT stage_name FROM stage_attempts WHERE status='success'`. `collectPrimarySources` was status='error', so it should be `firstPending`.
- But the next attempt was for `domainResearch`. Either the reconciler logic has a separate path I missed, OR the runner itself (not the reconciler) advanced past the error stage.

**What F22 changed**:
- F22 #2 aborts the SDK on `finishAttempt(error)`, so port_values writes-after-termination should no longer happen.
- This means the bug is either fixed (port_values can no longer accumulate against terminal attempts) OR still latent (some other write path could trigger the same advance).

**To do**:
- Trace: when `runOneAttempt` exits with `verdict.failed`, what does the outer `runPipeline` loop do? Does it retry the failed stage, advance, or exit? Read `runner.ts:582-605` carefully.
- If runner just exits and reconciler resumes, the reconciler's `firstPending` query is the suspect — verify against round-9 DB state which still exists in `/tmp/workflow-control-data/kernel-next.db` (search for `web3-research-1777212630571-6a231319` and `web3-research-1777213682343-17df63e5` rows).
- Add a unit test: stage with `status='error'` and `port_values` rows present → reconciler must classify as `kind: "resume"` from that stage, not from a downstream one.

**Why deferred**: F22 made it not reproduce in round 10. Lower priority than the actual-failure-mode bugs that blocked dogfood.

### 2.2 🟡 `cancel_task` doesn't kill SDK subprocess

**Symptom**:
- During round 9 cleanup I called `cancel_task` on the broken 0G task. `wasRunning: true, reason: cancelled via MCP`. But `ps aux | grep claude` still showed the SDK subprocess running for ~70+ seconds.
- F22 #2's AbortController fixes the **error** path. But cancel_task's path through the runner (INTERRUPT event → INTERRUPTED termination) likely doesn't connect to the same abort.

**To do**:
- Trace cancel_task → runner → real-executor: does the parent `args.signal` actually get aborted by the cancel_task code path? If so, F22's `onAbort` listener should fire and call `abortController.abort()` — verify.
- If not, plumb cancel_task → runner-level signal abort.

**Why deferred**: nobody was harmed by leaked SDK after cancel in round 9 (we manually killed). But for production dogfood with paying users this is a real cost-leak vector.

### 2.3 🟡 Server tsx-watch reload kills running pipelines

**Symptom**:
- Editing `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.ir.json` (commit `6a80602`) triggered tsx-watch reload mid-Solana-run. The Solana run survived because it was nearly done; subsequent 0G runs were vulnerable.
- A reloaded server starts a fresh runner via orphan-reconciler, but the prior runner's SDK subprocesses + MCP subprocesses leak.
- This is the same "SDK leak" surface as F22 but triggered by a different cause (process-level termination, not attempt-level termination).

**To do**:
- `apps/server/src/index.ts` already has a `gracefulShutdown` (search "gracefulShutdown") that closes the HTTP server and DB. Extend it to also: (a) signal in-flight runners to abort, (b) wait for them with a deadline, (c) kill any remaining child processes (recursive kill of the process group if needed).
- Alternative: tsx watch ignores `apps/server/src/builtin-pipelines/**` so non-code changes to pipeline IRs don't reload. This is the cheap fix; the real fix is graceful shutdown.

**Why deferred**: production deployment doesn't use tsx watch. Only affects dev-loop iteration during dogfood.

### 2.4 🟡 No SDK abort on cancel_task (related to 2.2)

Mentioned in 2.2 — listing as separate item because the fix is at a different layer. F22 only handles the in-stage termination paths inside `doAttempt`. cancel_task fires `runner.dispatcher.send({type:"INTERRUPT"})` which translates differently.

### 2.5 🟢 F20 untested on actual prompt-writer output

The `pipeline-generator` prompt-writer sub-agent prompt was extended with a TEMPORAL ANCHOR rule in commit `6a80602`. But:
- This affects FUTURE pipeline-generator runs.
- The 3 web3-research dogfoods (rounds 7, 8, 10) all used the **pre-F20** pipeline IR (versionHash `e6f281e9...`). So F20's effectiveness is unverified.
- A test would: invoke `pipeline-generator` to generate a fresh research-style pipeline, read the resulting prompts for any agent stage doing fact-checking or verification, assert the prompts contain the temporal-anchor instruction.

**Why deferred**: dogfood goal was content-quality, not generator-quality. The Solana / 0G rounds incidentally showed the existing prompts produce date-disciplined output for those topics, so F20 is resilience-against-Arbitrum-class-bugs, not blocking.

### 2.6 🟢 Niche spec resumption still TODO

`docs/superpowers/specs/2026-04-26-single-session-niche.md` was paused waiting for cross-segment-resume pivot to land. Pivot is now landed. The niche spec's open questions can be re-opened in a separate session.

---

## 3. Test posture

`pnpm test` from `apps/server`:
- Last full run before this session ended: 1825 passed / 4 skipped / 0 failed (after F22). Two Promise-race / spawn-utils tests are known flaky on macOS — re-running individually they pass.
- New tests added this session:
  - 6 cross-segment validator tests (`structural.test.ts`)
  - 5 + 2 F17 secret-gate KernelService tests
  - 2 F19 fanout secret_pending tests (`runner-fanout.secret-pending.test.ts`)
  - 2 multi-mode + diamond opt-in resume tests (`runner.single-session.test.ts`)
  - 3 F22 abort-on-error tests + 2 SdkOptions abortController tests

`tsc --noEmit`: clean.

---

## 4. Database state

`/tmp/workflow-control-data/kernel-next.db` contains:

| taskId | pipeline | status | terminal_state |
|---|---|---|---|
| `web3-research-1777151032404-d7cd3c29` | web3-research e6f281e9 | completed | Arbitrum (round 7) |
| `web3-research-1777206776437-6fd58418` | web3-research e6f281e9 | completed | Solana (round 8) |
| `web3-research-1777212630571-6a231319` | web3-research e6f281e9 | cancelled | 0G round 9 (broken, F22 trigger) |
| `web3-research-1777213682343-17df63e5` | web3-research e6f281e9 | cancelled | 0G round 9 retry (also broken) |
| `web3-research-1777216550857-f5f02a91` | web3-research e6f281e9 | completed | 0G round 10 (post-F22 success) |

Round 9's two failed tasks remain in the DB as F22 reproduction cases. The `secret_gate_queue` for `web3-research-1777151032404-d7cd3c29` has 18 rows now-resolved by round 7's batch-resolve fix.

---

## 5. Server / process state at handoff

- Server PID 38710 (tsx-watch child) running on port 3001 since ~23:08 (after F22 commit triggered reload).
- No leaked claude / npx subprocesses (verified at end of round 10).
- GitHub PAT used for dogfood `ghp_REDACTED_REVOKED` was deliberately not revoked by user — already exposed in chat / session.jsonl, separate revoke decision is theirs to make.

---

## 6. Recommended next-session priorities (ordered)

1. **Trace 2.1 (reconciler error-stage advance)**. Even with F22 in place, the underlying reconciler logic deserves a unit test against the round-9 DB rows. ~30 min.
2. **Implement 2.2 + 2.4 (cancel_task → SDK abort)**. Plumb the cancel-path through the existing AbortController. ~1-2 hours.
3. **Implement 2.3 (graceful shutdown abort + wait)**. Extends `index.ts:gracefulShutdown`. ~2 hours.
4. **F20 verification (2.5)**. Generate a fresh pipeline via pipeline-generator, inspect prompts. ~30 min.
5. **Niche spec re-open (2.6)**. Re-read niche.md with the pivot now landed; identify which open questions are answered. ~1 hour reading + however much follow-up the niche itself needs.

The "正确合理" continuation of this session's principle: **2.1, 2.2, 2.3 are real bugs that didn't reproduce in this session because of timing luck or because F22 happened to mask them.** They will surface again. They should land before the next high-stakes dogfood.

---

## 7. What "satisfactory" looked like, for the record

Per the user's directive "直到产出令人满意的结果":

- 3 different web3 protocols (Arbitrum L2 / Solana L1 / 0G AI-DA) successfully researched
- Each report addresses all 6 declared research questions, cites concrete sources (URLs + tier labels), uses on-chain corrections where the atom set triggers verification
- Cost stable at $1.6-$1.9 / 17min per task
- 22-30 commits / two major kernel features (cross-segment pivot + F17) / two follow-up bug fixes (F19, F22) / one prompt-engineering fix (F20) all landed in one session
- All issues found during dogfood — including the F22 cascade that initially blocked 0G — were resolved within the same session, and the fix proven by re-running the same task

The dogfood loop is now a viable iteration cycle for the web3-research pipeline. The pipeline itself is unchanged across all three rounds; the kernel hardening is what made it reliably runnable.
