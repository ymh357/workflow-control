# Single-Session Mode — Canary Dogfood Handoff

**Date:** 2026-04-25
**Milestone:** Post-v1.20 dogfood + bug fixes + prod canary verification
**Roadmap coverage:** §4 line 105 / §修订历史 1.21
**Branch:** main

This handoff covers the work after v1.20 shipped the single-session
mode plan. v1.20 closed 12 implementation tasks; v1.21 is the
**dogfood + reality check** round that uncovered four real bugs and
added one production canary verification.

## Result summary

Four bugs fixed, one architectural decision validated, one unverified
claim in v1.20 corrected.

| ID | Bug | Severity | Detection method | Fix commit |
|---|---|---|---|---|
| 1 | `segment-planner` walked IR-file order, not topological | High — broke smoke-test canary entirely | Live MCP run + DB inspection | `ba4b7de` |
| 2 | `v_segment_continuity` view: GROUP_CONCAT order undefined + `CREATE VIEW IF NOT EXISTS` blocks DDL upgrades | Medium — observability wrong | Live DB inspection (saw `echoBack->greet` instead of `greet->echoBack`) | `190ce5d` |
| 3 | `segmentContinuationFor` conflated "resume?" and "continuation prompt form?" — fan-out branches got no resume | High — violates spec §3 cross-segment resume promise | Reality-checker subagent (Q3 evaluation) + diamond IR test | `71cc603` |
| 4 | `segmentContinuationFor` SQL accepts superseded/error attempts when picking session | Medium — retry could revive corrupt SDK conversation | Code-walk during Q4 evaluation | `83da71c` |

## What was done

### Phase 1: Q1-Q6 sacrifice evaluation

The user asked: "single-session 模式当前牺牲了什么？" — a structured
review of nine concerns in spec §1 §3-§5 §10 §11. Each was evaluated
through a separate Q numbered to keep context clean. Results:

- **Q1 reads value 重复**: Three positions evaluated (a maintain / b
  trust SDK memory / b' reference-only inputs section). Reality
  checker subagent (opus) verdict: **(a) maintain**. Key finding:
  LLM必须 *复述* value 才能用它，所以 (b)/(b') 不消除重复，只是把它从
  prompt 移到 assistant message。Cost ≪ debug-time loss + 违反硬约束。

- **Q2 output protocol 重发**: Maintain. 指令重复 ≠ value 重复，对
  LLM 友好。Token 量小（< $1/年 at typical usage），不重复反而风险
  （LLM 长 conversation 后 forget format）。

- **Q3 段内不能并发 / subagent 解决吗**: 问题分两层——IR 拓扑级 fan-out
  自动降级（spec §3 设计），段内 stage 内部并发（SDK sub-agents 已支持）
  正交于 single mode。**测出真 bug**: cross-segment resume 实际不工作
  → 修复（见 Bug #3）。

- **Q4 回到某 stage 不重头跑**: `runPipeline.resumeFrom` + `replay_stage`
  + `retry_task` 三种 API 已存在；single mode 下 cross-segment resume
  让 retry 自动复用上游对话历史。**测出真 bug**: SQL 不过滤 status
  → 修复（见 Bug #4）。

- **Q5 主动 /compact 缓解 history**: SDK 不暴露 manual compact API
  (Query 只有 interrupt/setModel/setPermissionMode)。SDK 自动 auto-compact
  已观测工作 (cache_read 实测稳定 ~70K)。**Application-level summary**
  (让某 stage emit summary 给下游) 当前不做——前提条件（长段、推理质量
  下降）都不存在；真出现时正确解决方案是缩短段长，不是 summary。

- **Q6 hot-update 段切碎**: 已被 Q4 retry_task 实测覆盖（retry_task
  内部走 executeMigration，跟 hot-update 同代码路径）。Mid-flight 时序
  协调测试 ROI 太低，不单独写。

Conclusion: Five of six questions don't need code changes; one (Q3)
revealed a spec-implementation gap; one (Q4) revealed a SQL filter bug.

### Phase 2: Bug fixes

**Bug #1 — segment-planner walks file order, not topological order**

Discovered: First live smoke-test run after v1.20 ship returned
`v_segment_continuity` empty. DB showed two distinct session_ids
(`1a7dfef8...` for `greet`, `ac3e0eb4...` for `echoBack`) instead of
shared. Root cause: `smoke-test/pipeline.ir.json` lists `echoBack`
before `greet` in the stages array (authoring-time choice), and
`planSegments` iterated `ir.stages` directly. Naive walk produced
two size-1 segments instead of one merged size-2 segment.

Fix: Add Kahn-style `topologicalStageOrder` helper. Stages with cycles
(which canonical IR validation rejects upstream) fall back to
file-order so the planner is robust against corrupt IR. Regression
test: IR with downstream stage listed first must still produce one
segment.

**Bug #2 — v_segment_continuity view ordering + DDL upgrade**

Discovered: After Bug #1 fix, smoke-test correctly shared session,
but `v_segment_continuity` reported `stage_path: echoBack->greet`
(reverse chronological). Two issues: (a) GROUP_CONCAT preserved the
default-but-undefined row order, not chronological; (b) `CREATE VIEW
IF NOT EXISTS` blocked future definition changes from taking effect
on dev DBs without manual surgery.

Fix: Wrap the join in a `started_at`-sorted subquery so GROUP_CONCAT
sees rows in execution order. Switch to `DROP VIEW IF EXISTS;
CREATE VIEW` for idempotent DDL on every schema init.

**Bug #3 — segmentContinuation conflated resume + prompt form**

Discovered: Reality-checker subagent during Q3 evaluation. Diamond
fan-out `a→b, a→c` test showed segment-planner correctly produced
`[["a","b"], ["c"]]`, but stage `c` got no `segmentContinuation` at
all — runner's `if (idx === 0) return undefined` short-circuit fired
before any cross-segment lookup. Spec §3 explicitly promises "the
next segment opens a new query with options.resume pointing at the
prior segment's session_id" — implementation didn't honor this.

Root cause: `segmentContinuation !== undefined` was being used to
control TWO orthogonal things: (a) whether to call `options.resume`
(should always be true when an upstream agent has a persisted session)
and (b) whether to render continuation prompt form (only true when
this stage is mid-segment, not when it starts a new segment that
happens to resume).

Fix: Add `isContinuationStage: boolean` to `segmentContinuation`.
Runner does two-phase lookup: (1) walk preceding stages within this
segment (Phase 1), (2) BFS upstream by wires for nearest agent
ancestor with persisted session (Phase 2). real-executor reads
`continuationMode = isContinuationStage` instead of
`continuationMode = (segmentContinuation !== undefined)`.

Tests added:
- diamond fan-out: c resumes a's session with full prompt form
- linear 3-stage: c continues b's session with continuation form
- real-executor: isContinuationStage=false → full prompt + resume
- real-executor: isContinuationStage=true → continuation form

**Bug #4 — SQL not filtering by attempt status**

Discovered during Q4 code-walk. `segmentContinuationFor` SQL used
`ORDER BY started_at DESC LIMIT 1` without filtering by status. If
a stage was retried (prior attempt `superseded` by hot-update or
explicit retry), the most-recent-by-time but stale-by-status attempt
could be picked, resuming a corrupt SDK conversation.

Fix: Add `WHERE sa.status IN ('success', 'running')` to both Phase 1
in-segment and Phase 2 BFS-upstream queries. The `'running'` part is
critical — upstream stage typically hasn't yet transitioned from
`'running'` to `'success'` when downstream queries fire (PORT_WRITTEN
dispatch is synchronous, status update happens after writePort calls).
A pure `status='success'` filter broke 4 of 5 single-session tests.

Three new direct unit tests:
- prefers latest SUCCESS over earlier SUCCESS (sanity)
- prefers earlier SUCCESS over later SUPERSEDED (the bug)
- returns undefined when only error attempts exist

`segmentContinuationFor` exported for direct unit testing.

### Phase 3: Production canary on real PR-worthy work

Ran `pr-description-generator` (single-mode 2-stage agent pipeline)
against the work range `163ae51..HEAD` (= the v1.20 + v1.21 work
itself, 25 commits). The pipeline used the very mode it was canary-
ing.

Live data captured in DB (taskId
`pr-description-generator-1777121398820-cb8f6645`):

| Stage | session_id | token_input | token_output | cache_read | cache_creation | cost_usd |
|---|---|---|---|---|---|---|
| fetchDiff | `50d3c99b...` | 756 | 29677 | 879840 | 81189 | 0.340 |
| writePr | `50d3c99b...` (same!) | 43 | 11577 | 508664 | 94178 | 0.227 |

Total cost: $0.567. Both stages share session_id, confirming
single-mode end-to-end.

`v_segment_continuity` row:

```
task_id   = pr-description-generator-1777121398820-cb8f6645
session_id = 50d3c99b-25d8-4c72-a96e-6ec11efb0625
stages_in_segment = 2
stage_path = fetchDiff->writePr
segment_input_tokens = 799 (756 + 43)
segment_cache_reads = 1388504 (≈ 1.39M tokens)
segment_cache_creates = 175367
```

**Key finding — writePr token_input = 43**: The writePr stage's prompt
itself was only 43 tokens of new input (the continuation prompt form
+ identity block). All the 25 commits' diff content was reused from
the SDK conversation history (cache_read = 508K). In a multi-mode
equivalent, writePr would need to inline the entire diffText (50K+
tokens) into its own prompt — meaning ~$0.15 of additional input
cost per run. Single mode actually saves money on this canary.

**Quality verdict**: AI-generated PR description was factually accurate
(referenced exactly the right files at correct paths), structurally
correct (3 summary bullets, 9 file-grouped notable changes, 5 test
plan checklist items), and recalled the dogfood findings (it cited
"echoBack listed before greet → segment-planner topological order"
in the test plan, which is exactly the regression test added in
commit `ba4b7de`). No hallucination, no missing major change.

The PR title it generated:
`feat(single-session): implement session continuation for agent chains`

## Code changes

**Modified:**
- `apps/server/src/kernel-next/runtime/segment-planner.ts` — added
  `topologicalStageOrder` helper, walk uses topo order
- `apps/server/src/kernel-next/runtime/segment-planner.test.ts` —
  regression test for downstream-first IR
- `apps/server/src/kernel-next/runtime/runner.ts` — rewrote
  `segmentContinuationFor` (two-phase + status filter); added
  `findUpstreamSessionByWires` BFS helper; exported function for tests
- `apps/server/src/kernel-next/runtime/runner.single-session.test.ts`
  — diamond fan-out test, linear-3 test, retry status-filter tests
- `apps/server/src/kernel-next/runtime/executor.ts` — added
  `isContinuationStage: boolean` to segmentContinuation type
- `apps/server/src/kernel-next/runtime/real-executor.ts` —
  `continuationMode` reads `isContinuationStage`, not
  `segmentContinuation !== undefined`
- `apps/server/src/kernel-next/runtime/real-executor.test.ts` —
  isContinuationStage=true vs false prompt form tests; reuse
  `makeFakeStream` for subAgents test (slow-path 5s flake)
- `apps/server/src/kernel-next/ir/sql.ts` — view DDL: DROP+CREATE,
  sorted subquery for stage_path
- `apps/server/src/kernel-next/ir/sql.test.ts` — view chronology test
- `docs/superpowers/specs/2026-04-25-single-session-mode-design.md`
  — updated §6.2 / §6.3 for new isContinuationStage contract;
  removed duplicate "No XState changes" paragraph
- `docs/product-roadmap.md` — §修订历史 1.21 entry

## Commits (chronological, 7 total post-v1.20)

```
ba4b7de fix(segment-planner): walk in topo order, not ir.stages array order
190ce5d fix(v_segment_continuity): order stage_path chronologically + idempotent DDL
9cfea25 fix(real-executor.test): also dedupe subAgents test slow-path
1b77d2d test(single-session): document spec §3 vs implementation gap on diamond fan-out
71cc603 fix(single-session): cross-segment resume per spec §3 + decouple prompt form
83da71c fix(single-session): segmentContinuationFor must filter superseded/error
0af6248 docs(roadmap): record §修订历史 1.21 — single-session dogfood bug fixes
```

## Test verification

- 595 runtime+ir tests pass (594 pre-existing + 1 from view chronology)
- tsc clean
- Live verification:
  - smoke-test (linear 2-stage): shared session_id, 137K cache reads,
    stage_path correct
  - diamond fan-out (3 stages, fanout): shared session_id across all
    three (cross-segment resume working), 200K segment cache reads
  - retry_task (diamond after first run): new attempts get fresh
    session, do NOT resume superseded one (Bug #4 fix verified)
  - pr-description-generator on real 25-commit range: 1.39M segment
    cache reads, $0.57 total, AI output factually correct

## What stays open

- **Mid-flight hot-update + single-session combo test**: covered
  indirectly via `retry_task` (which uses `executeMigration` =
  hot-update orchestrator), but no test specifically exercises the
  scenario "stage 2 is mid-flight, hot-update changes stage 3, INTERRUPT
  fires, segmentContinuation routes correctly to new stage 3 with
  resumed prior session". ROI for writing this is low (would need
  artificial slow agent + curl timing) — covered functionally by
  Bug #4 unit tests + retry_task live test.
- **Long single-mode segments (5+ agent stages) in production**: no
  examples exist yet. pipeline-generator's gen-skeleton.md teaches
  "default multi, single needs explicit reasoning" so generator
  shouldn't produce long single segments by accident. If they appear,
  observe via `v_segment_continuity` and decide whether to add
  spec §4.5 length guidance.
- **`MockStageExecutor.executeStageWithSessionPersist` 70-line
  duplication of top-level `executeStage`**: deferred from Task 7
  code-quality review (I-1). Mock-test-only code, narrow surface,
  clean refactor would expose `beforePortWrite` hook on top-level
  executeStage. Not blocking; left as a known follow-up.

## Where to look next session

If picking up the single-session work later:

1. **Spec is current**: `docs/superpowers/specs/2026-04-25-single-session-mode-design.md`
   §6.2 / §6.3 reflect the v1.21 contract. §1-§5 are unchanged.
2. **Roadmap §修订历史 1.20 + 1.21** record the milestones.
3. **Live data**: query `v_segment_continuity` on `kernel-next.db`
   to see segment behavior across runs.
4. **MCP entry points** for single-mode work:
   - `submit_pipeline` (bootstrap a new IR with `session_mode: "single"`)
   - `run_pipeline` (start a task — looks up latest version by name)
   - `retry_task` (rerun from a stage; works in both single and multi)
   - `replay_stage` (debug a single stage in isolation; doesn't touch
     official task state)
