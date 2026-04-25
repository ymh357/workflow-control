# Handoff: web3-research pipeline-generator Round 4

> **Date**: 2026-04-26 (session ended ~00:40)
> **Status**: Ready to invoke. All blocking dogfood findings fixed.
> **Action**: Start a new session, follow §"Round 4 invocation" verbatim.

---

## 1. What you're picking up

We are dogfooding `pipeline-generator` to produce a `web3-research` pipeline. Three earlier rounds failed for different reasons. All root causes are fixed. **Your job is round 4**: invoke generator with the now-stable infrastructure and either ship the resulting `web3-research` pipeline or surface yet another finding.

The fixes from rounds 1-3 are uncommitted (15 modified files + 4 new files). Decide whether to commit them before round 4 starts or as part of finishing — either order is fine since both `tsc` and `vitest` are green.

---

## 2. Current server / git state

- **Server**: Running at `localhost:3001` via `bun run dev` (tsx watch). Likely PID 20578 or similar (check `lsof -i :3001`). Latest reload was on 2026-04-26 ~00:34 after the F11 retry-default revert (reload count: ~4).
- **Branch**: `main`
- **Uncommitted modifications**:
  - `src/builtin-pipelines/pipeline-generator/pipeline.ir.json` (Finding 7: description→taskText/pipelineDescription rename)
  - `src/builtin-pipelines/pipeline-generator/prompts/system/{analysis,gen-skeleton}.md` (Finding 4 + 7: anti-pattern checklists, description rename)
  - `src/kernel-next/codegen/emit-ts.{ts,test.ts}` (Finding 5: `__gate_feedback__` synthesis)
  - `src/kernel-next/mcp/pg-entry.{ts,test.ts}` (Finding 1: 8K→64K; Finding 2: gate_queue.answered_at guard in wait_pipeline_result)
  - `src/kernel-next/mcp/tools/pg.ts` (Finding 3: `descriptionPath` arg; Finding 11: `maxRetries: 2` for pipeline-generator's RealStageExecutor)
  - `src/kernel-next/runtime/real-executor.ts` (Finding 8: synthetic 30s heartbeat ping; Finding 11 was rolled back to opt-in via pg.ts)
  - `src/kernel-next/runtime/orphan-reconciler.{ts,test.ts}` (Finding 12: skip `__gate_feedback__` in topo sort)
  - `src/kernel-next/runtime/runner.ts` (Finding 6: 30min→90min global timeout)
  - Other files (mock-executor / single-session.test / real-executor-prompt-builder) modified earlier this session for unrelated tasks; verified non-regressive.
- **New files**:
  - `docs/superpowers/specs/2026-04-25-web3-research-task-description.md` (the spec to feed)
  - `docs/superpowers/plans/2026-04-25-pipeline-generator-dogfood-findings.md` (12-finding log)
  - `src/kernel-next/hot-update/migration.single-session.test.ts` (unrelated: prior task on single-session × hot-update)
  - `src/kernel-next/pipeline.test.ts` (pre-existing, untouched this session)

**Test status**: 1789 passed / 4 skipped / 0 failed. tsc clean.

---

## 3. The 12 dogfood findings (all closed except F9 withdrawn / F10 subsumed)

| # | Finding | Status / Fix |
|---|---|---|
| F1 | `MAX_DESCRIPTION_LEN = 8000` too tight for real specs | ✅ 8K → 64K (`pg-entry.ts:73`, `tools/pg.ts:35`) |
| F2 | `wait_pipeline_result` history replay falsely settles on already-answered gate | ✅ Added `gate_queue.answered_at IS NULL` check before settling (`pg-entry.ts:388-413`) |
| F3 | No `descriptionPath` arg → callers must inline 37K-char specs via shell `jq` | ✅ Optional `descriptionPath: string` (absolute path, 64K cap) (`tools/pg.ts:35-71`) |
| F4 | Generator picks TS reserved words (`type`) as port names | ✅ Spec §6.2 + §8.9 + new pre-submit check in `gen-skeleton.md` |
| F5 | `__gate_feedback__` causes `WIRE_TYPE_MISMATCH` (codegen TS2339) | ✅ `emit-ts.ts` synthesizes `__gate_feedback__: string` for gate-stage Outputs |
| F6 | `runPipeline` 30min global timeout too tight | ✅ 30min → 90min (`runner.ts:213`) |
| F7 | `pipeline-generator` IR has duplicate `description` on input vs output | ✅ Renamed input → `taskText`, output → `pipelineDescription`. IR + 4 prompts + store_schema all updated |
| F8 | Heartbeat doesn't move during agent thinking — false-positive wedge signal | ✅ Synthetic 30s heartbeat ping in `real-executor.ts` |
| F9 | Round 3 analyzing skipped emitting some ports | (FALSE POSITIVE — withdrawn) |
| F10 | Anthropic API socket close mid-stream → stage error | (subsumed by F11) |
| F11 | `DEFAULT_MAX_RETRIES = 0` → no auto-retry on transient failures | ✅ Opt-in: pipeline-generator's RealStageExecutor sets `maxRetries: 2`. Default stays 0 to avoid silently retrying logic bugs in user pipelines |
| F12 | `classifyOrphan` topo sort treated `__gate_feedback__` reject-loop wires as forward edges → spurious cycles → false-terminal classification | ✅ Skip `__gate_feedback__` in `topologicalStageOrder` (matches `validator/dag.ts:44`) + regression test |

Full text + reproduction recipes + suggested-fix details: see `docs/superpowers/plans/2026-04-25-pipeline-generator-dogfood-findings.md`.

---

## 4. Round 4 invocation

```bash
# Sanity check server is up
curl -fsS -X POST http://localhost:3001/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' --max-time 10 \
  | jq '.result.tools | length'   # expect: 29

# Invoke. After F3 fix, prefer descriptionPath over inline jq plumbing:
curl -fsS -X POST http://localhost:3001/api/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "start_pipeline_generator",
      "arguments": {
        "descriptionPath": "/Users/minghao/workflow-control/docs/superpowers/specs/2026-04-25-web3-research-task-description.md"
      }
    }
  }' --max-time 30 | jq -r '.result.content[0].text'
```

Expect: `{"ok":true,"taskId":"<uuid>","versionHash":"07589eb0...","pipelineDir":"pipeline-generator"}`.

The versionHash should match `07589eb0039069d6285f94cbd1ce51d0e2ed8ce09aa5c0883ad7e97c62346ed0` (= the post-F7 builtin pipeline-generator IR hash). If it differs, the builtin IR has changed since this handoff was written — investigate before proceeding.

---

## 5. Monitoring (persistent + don't cancel on heartbeat silence)

```
Monitor({
  description: "round 4 — DON'T CANCEL on heartbeat silence (Finding 8)",
  timeout_ms: 3600000,
  persistent: true,
  command: `
TID=<the taskId from the curl response>
DB=/tmp/workflow-control-data/kernel-next.db
last=""
while true; do
  out=$(sqlite3 "$DB" "SELECT group_concat(stage_name||':'||status, ',') FROM (SELECT stage_name, status FROM stage_attempts WHERE task_id='$TID' AND stage_name NOT LIKE '\\\\_\\\\_%' ESCAPE '\\\\' ORDER BY started_at)" 2>/dev/null)
  if [ "$out" != "$last" ]; then
    echo "$(date +%H:%M:%S) $out"
    last="$out"
  fi
  finals=$(sqlite3 "$DB" "SELECT final_state || '/' || reason FROM task_finals WHERE task_id='$TID'" 2>/dev/null)
  if [ -n "$finals" ]; then
    echo "$(date +%H:%M:%S) FINAL=$finals"
    exit 0
  fi
  sleep 5
done
`
})
```

**Discipline rules learned the hard way**:
1. **Do NOT change any `apps/server/src/**` file while round 4 is running.** tsx watch will hot-reload, killing the in-flight SDK subprocess.
2. **Do NOT cancel on heartbeat silence.** F8's fix is synthetic 30s ping, but the *agent* may still legitimately think for many minutes. Silence ≥ 5 min during analyzing is normal.
3. If anything looks wrong, query state via `get_task_status` MCP or direct `sqlite3` first; don't preemptively `cancel_task`.

---

## 6. Expected timeline & cost

Based on rounds 1-3 telemetry:

| Stage | Wall-clock | Cost | Notes |
|---|---|---|---|
| analyzing | 4-10 min | ~$1-2 | thinking-heavy; uses Read tool fallback for spec discovery |
| gate (awaitingConfirm) | human-bound | $0 | I'll need you to approve via `answer_gate` |
| genSkeleton | 5-7 min | ~$1.5 | now retries 2× on transient failure (F11) |
| genPrompts | 4-6 min | ~$1 | parallel with genSkeleton in builtin IR |
| persisting | 3-5 min | ~$1 | submits IR via `submit_pipeline`; F4/F5/F7 fixes should make 1st submit pass |
| **Total** | **20-30 min** | **~$5-7** | within 90min runPipeline ceiling |

---

## 7. Acceptance criteria for round 4 success

The dogfood is "complete" when:

1. ✅ `task_finals.final_state = 'completed'` for the round 4 taskId
2. ✅ `persisting.versionHash` (output port) is non-empty and points to a valid `pipeline_versions` row
3. ✅ The new `web3-research` pipeline IR satisfies §10 of the spec (the 17-point capability checklist), specifically:
   - 7-9 stages with one human gate
   - selectType-style stage emits `entityType` (NOT `type`) + `atomSet`
   - atomAnalysis-equivalent stage emits a single markdown port
   - adversarialFactCheck-equivalent prompt forbids store-as-evidence + mandates ≥3 external URL fetches
   - All ports use real TS literals (not `unknown`)
   - No legacy `condition` / `human_confirm` / `foreach` types
   - `session_mode: "multi"`
4. ✅ Test it: invoke the new `web3-research` pipeline against a real Web3 target (e.g., "research Arbitrum's tokenomics") and observe stage progression at minimum through scope + gate.

If any of 1-3 fails, it's a new finding — append to the findings doc, fix, retry round 5.

---

## 8. After successful round 4 — wrap up

1. Add §修订历史 entry to `docs/product-roadmap.md` recording the dogfood + 12 findings + new web3-research pipeline shipping
2. `git add` the 15 modified + 4 new files. Commit message draft:
   ```
   feat(web3-research): ship via pipeline-generator dogfood
   
   12-finding dogfood loop produced web3-research pipeline. Major
   infrastructure fixes:
   - F1 description ceiling 8K→64K
   - F2 wait_pipeline_result gate-replay guard
   - F3 descriptionPath arg
   - F5 __gate_feedback__ codegen
   - F6 runPipeline 30→90 min
   - F7 pipeline-generator description port disambiguation
   - F8 synthetic heartbeat ping
   - F11 opt-in retry for pipeline-generator
   - F12 orphan-reconciler skip __gate_feedback__ in topo sort
   ```
3. Verify post-commit: `npx tsc --noEmit && npx vitest run`. Should still be 1789 / 4 / 0.
4. Optionally start dogfooding the new web3-research pipeline on a real research target.

---

## 9. Things to NOT do in the new session

- Don't restart the server unless it's actually crashed. Hot-reload during a running task wastes ~$1+ of agent work.
- Don't `cancel_task` based on heartbeat silence alone (F8 lesson).
- Don't change `apps/server/src/**` while round 4 is running (will trigger reload).
- Don't reject the gate without first reading the round-4 analyzing output. The spec quality should be high enough that approve is the right default.

---

## 10. Quick references

- **Spec**: `docs/superpowers/specs/2026-04-25-web3-research-task-description.md` (631 lines, 37K chars)
- **Findings log**: `docs/superpowers/plans/2026-04-25-pipeline-generator-dogfood-findings.md`
- **DB**: `/tmp/workflow-control-data/kernel-next.db`
- **Server log**: `/tmp/wfctl-server.log` (tail it if anything looks weird)
- **MCP endpoint**: `POST http://localhost:3001/api/mcp` with headers `Content-Type: application/json` + `Accept: application/json, text/event-stream`
