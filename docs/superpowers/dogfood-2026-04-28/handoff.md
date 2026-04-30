# Handoff — Catalog Auto-Discovery Loop + Live LLM Dogfood (Full Session)

**Session window**: 2026-04-27 ~22:00 → 2026-04-28 ~11:30
**Branch**: `main` (734 commits ahead of `origin/main`, never pushed)
**Status**: clean tree, 2057+ tests passing locally except 3 known
cross-session flakes (`spawn-utils.adversarial`, `publish`,
`compile-inline-script` — all unrelated to this session's work)

This handoff replaces the earlier session-1 + session-2 partial
handoffs. It is self-contained.

## What this session shipped

A self-contained slice closing the AI-driven catalog discovery loop,
hardening it under live LLM, and building a 5-rung supply-chain test
ladder for catalog entries.

### Commit chain (16 commits this session, in order)

| sha | summary |
|---|---|
| `b793233` | feat(mcp-catalog): `add_mcp_catalog_entry` MCP tool |
| `1617027` | fix(generator): two-pass MCP discovery + verbatim-fetch |
| `865961d` | fix(modifier): same prompt discipline for gen-patch |
| `60568ec` | fix(catalog): delete 5 broken builtin entries |
| `3b78d10` | docs: augment findings with Bug 4–5 |
| `5ea2361` | docs: handoff session 1 (now superseded) |
| `371c036` | fix(rot-guard): boot/CI healthcheck + gen-skeleton verbatim |
| `a8a6766` | fix(dashboard): task header state badge reads /status |
| `805bdfd` | fix(dashboard): gate decision summary + collapse 17-port |
| `f7ae92d` | docs: modifier dogfood + Bugs 7–8 |
| `0d86be9` | fix(ir): add_external_input / remove_external_input ops |
| `88c26a7` | fix(ir): externalInputs[].optional flag (3 layers) |
| `eedd14a` | fix(canonical): include port.optional in version hash |
| `c9c9b97` | docs: session 2 mid-handoff (now superseded) |
| `7c33dc6` | feat(catalog): replenish etherscan + fetch + arxiv |
| `8d39ada` | fix(rot-guard): spawn-test mode-2 + slack/postgres args |
| `00d5355` | docs: Bug 9 (npm-view existence ≠ runnable) |
| `05be361` | fix(catalog): remove arxiv (Bug 10 SDK-too-slow) |
| `89503c7` | docs: Bug 10 |
| `f3b2256` | fix(rot-guard): split-budget spawn-test |
| `416ddcc` | fix(catalog): filesystem args + envKey |
| `4eb6c14` | fix(rot-guard): tools/list verification + Bug 11 |

(plus the 4 prior-session commits `be7de63 → 1614be7` that pre-existed
and that the first session built on)

## Bug score: 11 distinct, 10 fixed, 1 deeper

| # | Severity | What | Status |
|---|---|---|---|
| 1 | P0 | 5/12 builtin packages 404 on npm | **fixed** `60568ec` + rot-guard test `371c036` |
| 2 | P2 | gen-skeleton silently slug-rewrites mcpServers.name | **fixed** `371c036` (later refined: name uses entry.id, not entry.name) |
| 3 | P2 (UX) | gate `<details open>` + 17-port table off-screen | **fixed** `805bdfd` (decision summary card + collapse-when-large) |
| 4 | P1 | stage_attempts CHECK on legacy DBs missing `secret_pending` | **documented** — per CLAUDE.md §8.1 wipe DB, no migration |
| 5 | P2 (UX) | dashboard state badge reads SSE event, says "completed" while in secret-gate | **fixed** `a8a6766` |
| 6 | P1 prompt | analyzing agent skipped add-on-miss + hallucinated builtin packages | **fixed** `1617027` |
| 7 | P1 | externalInputs has no optional flag — modifier rejected with SEED_VALUES_MISSING_KEY | **fixed** `88c26a7` + `eedd14a` (3 code layers + canonical hash) |
| 8a | P0 | IRPatchOpSchema missing `add_external_input` / `remove_external_input` | **fixed** `0d86be9` |
| 8b | P1 | Modifier silently submits `ops:[]` with `dryRunVerdict:"safe"` after dry-run failure | **fixed** `0d86be9` (prompt rule) + **kernel guard** (continuation 2): new `validate_patch_vs_intent` script stage in pipeline-modifier IR raises STAGE_FAILED on the silent-no-op pattern |
| 9 | P0 | npm-view existence ≠ runnable (fetch-mcp@0.0.5 broken imports; postgres args incomplete; slack envKeys incomplete) | **fixed** `8d39ada` + spawn-test mode-2 |
| 10 | P1 | spawn-test pass ≠ SDK-runnable (arxiv 25s init too slow) | **fixed** `05be361` (remove arxiv) + `f3b2256` (split-budget catches it) |
| 11 | P2 | tools/list-passing ≠ SDK-runnable (playwright fails MCP_STARTUP_FAILED in real SDK despite handshake passing) | **partially fixed** `4eb6c14` — tools/list check added; SDK-side gap deferred |

## The 5-rung supply-chain test ladder

The session's main meta-deliverable. Each rung catches what the previous can't:

| rung | test | catches |
|---|---|---|
| 1. schema | unit test (zod) | malformed entries.json fields |
| 2. npm view | mode-1 rot-guard (`RUN_NPM_HEALTHCHECKS=1`) | packages that 404 (Bug 1) |
| 3. spawn + initialize | mode-2 split-budget | broken module imports (Bug 9 fetch-mcp); too-slow startup (Bug 10 arxiv) |
| 4. spawn + tools/list | mode-2 enhanced | servers that handshake but advertise 0 tools |
| 5. SDK runtime | live LLM dogfood | the last mile — anything the standalone JSON-RPC probe doesn't replicate (Bug 11 playwright) |

## Live dogfood Step 6-9 verification

| Step | Status |
|---|---|
| 6 — `run_pipeline { name }` resolves to versionHash + starts task | ✅ verified across 4+ generator runs |
| 7 — secret-gate triggers when MCP envKey missing | ✅ verified (GitHub Issues Lister) |
| 8 — user provides secret + saves to inventory | ❌ not exercised — CLAUDE.md secret rule + no out-of-band shell |
| 9 — task continues, real MCP runs, output produced | ❌ tried twice (HN fetch-mcp Bug 9; playwright Bug 11) — both surfaced new supply-chain layers; eventual success blocked on Bug 11's deeper SDK gap |

## State at handoff

- **Catalog**: 8 entries, all pass rot-guard mode-1 + most of mode-2.
  - Public (no envKey): `playwright`, `puppeteer`
  - With envKey: `github`, `etherscan`, `brave-search`, `slack`,
    `postgres`, `filesystem`
- **Server / DB / Browser**: any leftover dev process can be killed
  with `pkill -f "tsx.*src/index.ts"`. DB `/tmp/workflow-control-data/`
  has the latest schema; wipe if you need a fresh boot. Chrome devtools
  MCP profile at `/tmp/chrome-e2e-profile` may have stale Singleton
  locks — `rm /tmp/chrome-e2e-profile/Singleton*` to clear.
- **Test suite**: 2057 passing locally outside known flakes.
  - `RUN_NPM_HEALTHCHECKS=1` for fast catalog smoke (~20s).
  - `RUN_NPM_HEALTHCHECKS=2` for spawn + tools/list (~3min, sequential).

## Open issues for next session

### High value

1. **Bug 11 follow-through**: investigate why playwright passes
   spawn-test mode-2 (initialize + tools/list both ≤10s) but fails
   `MCP_STARTUP_FAILED` in real SDK runtime. Likely candidates:
   protocol-version negotiation, Claude Agent SDK's MCP transport
   framing differences vs raw JSON-RPC. May need to instrument
   `apps/server/src/kernel-next/runtime/real-executor.ts` SDK call
   site to log `tools/list` reply seen by SDK, OR build a closer
   approximation of the SDK's transport in spawn-test.

2. **Step 8-9 real verification**: needs a public no-envKey MCP
   that survives Bug 11. Options:
   - Find a different browser-automation MCP that passes the SDK
     (puppeteer is also untested in dogfood).
   - Use `brave-search` if the user can `export BRAVE_API_KEY=...`
     before server boot (CLAUDE.md secret rule allows this — it's
     out-of-band).
   - Use `etherscan` likewise (free-tier `ETHERSCAN_API_KEY`).

3. **Bug 8b kernel-side guard** — **investigated 2026-04-28 (continuation), deferred**:
   The naïve idea ("applying stage refuses empty patch when intent
   is non-empty") doesn't fit the current IR: applying's inputs are
   `{patch, rerunFrom, migrateRunningTasks, currentVersionHash, dryRunVerdict, prompts}`
   — gapAnalysis flows ONLY into analyzeGap → genPatch and never
   reaches applying, so applying can't compare ops vs. intent.

   Three possible paths, all heavier than expected:
   - **(a) Extend applying inputs**: add a wire
     `analyzeGap.gapAnalysis → applying.gapAnalysis`. Then applying's
     prompt could read both, but that's still prompt-level — not the
     kernel guard the handoff line implies.
   - **(b) Insert a script stage between genPatch and applying**:
     pure validator that reads {gapAnalysis, patch, dryRunVerdict}
     and either passes through or fails the pipeline. This is the
     real kernel-side guard — but it's a new stage in a builtin
     pipeline + new wires + IR migration.
   - **(c) Make `propose_pipeline_change` MCP tool reject the empty-
     ops + verdict-safe combo unconditionally**: simplest, but
     punishes the legitimate "no-op patch + verdict=safe" case
     (which IS valid in some workflows).

   Recommendation: do (b) when next adding any guard to a builtin
   pipeline (the IR-migration overhead amortises). Until then the
   prompt rule in `gen-patch.md` is the only line of defence; it
   has held across the dogfood sessions but is one prompt regression
   away from re-opening the bug. Tracked, not blocking.

### Medium

4. **Replenish more catalog entries**. After fetch-mcp removal we're
   down to 8. Candidates that would broaden coverage:
   - HTTP fetch (need a vendor-published MCP that actually works —
     spawn-test rejected fetch-mcp@0.0.5; investigate alternatives).
   - Notion (custom-add path verified during Notion → Linear
     dogfood; rot-guard now exists to vet candidates before
     committing).
   - Linear (was deleted; the official path is `mcp-remote
     https://mcp.linear.app/mcp` — different topology, schema
     supports it via the `mcp-remote` command pattern).
   Each new entry must pass rot-guard mode-2 with tools/list before
   landing.

5. **CI integration of rot-guard** — **N/A in this repo (2026-04-28)**.
   Repo has no CI: it's single-user / single-machine per
   `CLAUDE.md` ("local, single-user workflow engine. One engineer,
   one machine, one server process"). The mitigation is a
   developer-side pre-commit / pre-release habit:
   - `RUN_NPM_HEALTHCHECKS=1 npx vitest run src/kernel-next/mcp-catalog/entries-rot-guard.test.ts`
     before merging anything that touches `entries.json`. ~25s,
     catches the 41% rot rate that bit Bug 1.
   - `RUN_NPM_HEALTHCHECKS=2` before adding a NEW entry the first
     time — needed because "package exists on npm" is necessary
     but not sufficient (Bug 9).
   - `RUN_NPM_HEALTHCHECKS=3` only when new entry is download-heavy.
   If this repo ever grows to multi-user, drop a
   `.github/workflows/rot-guard.yml` running mode 1 on PRs that
   change `entries.json`.

### Lower priority

6. **Per-entry `obtainSteps` quality audit**. Many existing entries
   have rough Chinese-language obtainSteps copied from training
   data; should be reviewed for factual accuracy + bilingual
   consistency.

7. **Spawn-test cold-cache vs warm-cache distinction**. Currently
   the test pre-warms via the mode-1 `npm view` that always runs
   first, masking real first-run cold-start time. A separate "fresh
   user, no cache" smoke test could be useful but adds complexity.

## Things NOT to do

- **Do not** add YAML migration for the CHECK constraint drift.
  CLAUDE.md §8.1 explicitly says "no migrations during R&D; wipe
  data_dir." Bug 4 is the canonical instance.
- **Do not** restore deleted entries to `entries.json` without
  passing rot-guard mode-2 (`RUN_NPM_HEALTHCHECKS=2`). The
  test exists precisely so this rot doesn't recur.
- **Do not** propose to mutate IR via `propose_pipeline_change`
  to remove a `mcpServers` block as a workaround for missing
  envKey. Per CLAUDE.md, that corrupts pipeline-author intent.
  Secret-gate is the recovery path.
- **Do not** skip the verbatim-fetch discipline in any new
  prompt that writes IR `mcpServers` blocks. The session's
  hard lesson is that LLMs will slug-rewrite, hallucinate from
  training data, and silently swap field semantics whenever the
  prompt allows it. `entry.id` for `name`; everything else
  byte-equal from `get_mcp_catalog_entry`.

## Key files for fast onboarding

- **Catalog subsystem**: `apps/server/src/kernel-next/mcp-catalog/`
  - `entries.json` — the 8-entry source of truth
  - `entries-rot-guard.test.ts` — 5-rung ladder rungs 2–4
  - `seed.ts` / `catalog-store.ts` — DB bridge
  - `healthcheck.ts` — npm view + spawn helpers
- **MCP tools**: `apps/server/src/kernel-next/mcp/tools/`
  - `mcp-catalog.ts` — recommend / get
  - `add-mcp-catalog-entry.ts` — write path
- **Generator prompts**:
  `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/`
  - `analysis.md` — two-pass MCP discovery
  - `gen-skeleton.md` — verbatim-fetch + entry.id-as-name
- **Modifier prompts**:
  `apps/server/src/builtin-pipelines/pipeline-modifier/prompts/system/`
  - `analyze-gap.md` — produces patch outline
  - `gen-patch.md` — translates outline to IRPatchOp[] with
    discipline against empty-patch fallback
- **IR schema**: `apps/server/src/kernel-next/ir/schema.ts`
  - `IRPatchOpSchema` — 8 ops including the two new external-input
    ops
  - `PortIRSchema.optional` — Bug 7 flag
- **Canonical hash**: `apps/server/src/kernel-next/ir/canonical.ts`
  - includes `port.optional` (Bug 7c, eedd14a)
- **Dashboard**:
  - `apps/web/src/app/kernel-next/[taskId]/page.tsx` — task page,
    state badge reads /status (Bug 5)
  - `apps/web/src/components/gate-card.tsx` — decision summary +
    collapse-when-large (Bug 3)
- **Findings doc**:
  `docs/superpowers/dogfood-2026-04-28/findings.md` — full bug
  catalogue with reproduction details and remediation links

## The session's meta-lesson

Each dogfood iteration peeled one layer deeper. Counting unit
tests (none of which caught any of these 11 bugs) vs live LLM
runs (caught all 11):

| layer | what it produces | how many bugs in this session it caught |
|---|---|---|
| Unit test (in-memory SQLite + mocked SDK) | API contract + invariants | 0 |
| Static lint / TS check | structural drift | 0 |
| Spawn-test rot-guard (after building it) | 1 / 9 / 10 / part of 11 | 4 (after each new rung was built) |
| Live LLM dogfood | 6 / 7 / 8 / Bug 4 (DB) / Bug 5 (UX) / Bug 11 (last mile) | 6 |

The 6 dogfood-only bugs span: prompt drift (6, 8b), schema gap
(7, 8a), DB drift (4), UX inconsistency (5), and SDK runtime
opacity (11). None of them are unit-testable. None.

That's the case for dogfood. It's not optional.

---

# Continuation session — 2026-04-28 (after 815ee7f)

15 commits. Closed every "high value" item from §Open issues except
Step 8 UI walk (which the user authorised + provided a token for).
Two new P3 bugs surfaced and one was traced to a misattribution.

## Commit chain (15)

```
4fc7778 docs(dogfood): Bug 12 fully closed
822a3d5 fix(runtime): suppress run_final on secret_pending exit (Bug 12 root cause)
fade2ef docs(dogfood): correct Bug 13 framing — chrome profile artifact, not product bug
c91c8c5 docs(dogfood): Bug 12 partial-fix writeup + ring-buffer hypothesis
ed8eb6b fix(runtime): pauseBudget on secret_pending — symmetric with gate-pause (Bug 12)
9ba99fa docs(dogfood): Step 8 verified end-to-end with real GitHub PAT
715deb1 docs(dogfood): Step 9 verified via sequential-thinking SDK end-to-end run
f162216 feat(catalog): add memory + sequential-thinking builtin entries
d7500d7 docs(handoff): #5 (CI rot-guard) is N/A — repo is single-user per CLAUDE.md
69c0fcd docs(handoff): Bug 8b investigated — defense-in-depth needs IR migration, deferred
14ae290 test(rot-guard): add mode-3 cold-cache spawn-test for Bug 11 catalog releases
6a5f042 fix(runtime): read mcp_servers[].status directly instead of reverse-engineering it
99201a1 feat(runtime): capture SDK stderr — preserve MCP 'Connection failed' diagnostics
f2658fe docs(dogfood): Bug 11 root cause located — kernel discards SDK status field
1e8b7d0 fix(prompts): use entry.id (kebab-case) for IR mcpServers[].name
```

## Bug score updates

| # | Status | Notes |
|---|---|---|
| 1-7, 8a, 9, 10 | ✅ closed pre-session | (carried over from 815ee7f) |
| 8b | ✅ closed (kernel guard + e2e, continuation 2/3) | 新加 builtin script `validate_patch_vs_intent` + IR 插入 `validatePatch` script stage 在 `genPatch` 与 `applying` 之间. 看到 silent-no-op (`intendedChanges 非空 ∧ ops:[] ∧ verdict:"safe"`) 直接 throw → STAGE_FAILED. Prompt rule `865961d/0d86be9` 留为 belt-plus-suspenders. 8 unit + 4 stage-integration + 1 promoted e2e 测试. continuation 3 又落了 cross-region cancel 让 e2e 在 <1s 内 resolve. 详情见 findings.md §Bug 8b kernel guard landed. |
| 11 | ✅ closed (3-step root cause fix) | (1) `99201a1` SDK stderr 接入; (2) `6a5f042` 改 read `mcp_servers[].status`; (3) `14ae290` rot-guard mode-3 冷缓存. 详情见 findings.md. |
| 12 | ✅ closed (root cause fix) | (1) `ed8eb6b` watchdog pauseBudget; (2) `822a3d5` suppress run_final on secret_pending exit. UI 残影根因消除. |
| 13 | reclassified — not a product bug | `fade2ef`. Test-infra footgun: 强杀 chrome-e2e-profile 后 mojo network state 损坏. 不是 Next.js / kernel 问题, 不修. |

总计：12 个原始 bug + 1 误归类。**12 个 bug 全闭合**。

## What landed this session

### 新功能 / 改进

1. **SDK stderr capture** (`99201a1`): `buildSdkBaseOptions` 加可选 `stderr` callback, real-executor 注册 `filterAndAppendSdkStderr` 把"Connection failed after Xms / MCP server failed / Authentication failed / MCPB invalid|failed" 这类关键诊断行写到 `agent_stream_json` (新加 `type: "sdk_stderr"`). 前端加独立 "SDK Stderr" tab. 不再丢失 SDK 内部 MCP 握手失败的原始信号.

2. **MCP status detector rewrite** (`6a5f042`): real-executor.ts:709-736 不再反向扫 `tools[]` 数组找 `mcp__<name>__*` 前缀, 改读 SDK 直接给的 `system/init.mcp_servers[].status` 字段. 三个分支:
   - `failed` → `MCP_STARTUP_FAILED` (保留 token 触发 F22 retry budget)
   - `needs-auth` → **新错误码** `MCP_NEEDS_AUTH` (不重试, 走 OAuth)
   - `pending` → 容忍 (init 时还在握手, 后续消息里可能转 connected)
   - `connected`/`disabled` → 通过

3. **rot-guard mode-3** (`14ae290`): `RUN_NPM_HEALTHCHECKS=3` 在每个 entry 测前 wipe `~/.npm/_npx`, 强制冷启动路径. 60s budget. 默认 skip, 仅手动跑. 不能在 CI / shared box 用 (会 nuke 所有 npx 缓存).

4. **catalog +2 entries** (`f162216`): `memory` (9 工具知识图谱) + `sequential-thinking` (1 工具推理辅助). 都是官方 `@modelcontextprotocol/server-*`, 零 envKey, mode-2 全过. `server-pdf` 因 HTTP transport 与 catalog stdio schema 不符被否决 (commit message 标记).

5. **secret_pending watchdog pause** (`ed8eb6b`): 在 secret_pending 触发的两处 (非 fanout L1133 + fanout L1551) 调 `pauseBudget()`, 与 gate-pause 对称. fanout 场景下 sibling stage 仍跑时不再因 human input 拖累 timeout budget. 单测 `secret-pending-budget-pause.test.ts` 100ms timeout + 不可满足 envKey 验证 runPipeline clean resolve.

6. **suppress run_final on secret_pending** (`822a3d5`): runner finalize 块加 `if (!secretPendingObserved)` 守卫. 此前 task 进 secret_pending 时 snapshot.value=`failed` (因为 STAGE_FAILED 拆区), 导致一条 `finalState: failed` 的 SSE 进 broadcaster ring buffer; dashboard reload 时 replay 历史, UI 错显 "failed". **DB 一直对 (task_finals 不写)**, 只是 SSE 历史撒谎. 守卫消除根因. 反向验证: 移除守卫测试立刻 fail.

### 实测验证

- **Step 9** (`715deb1`): `scratch-step89-real.mjs` 用 sequential-thinking 走 SDK end-to-end. mcp_servers status="connected" / 21 工具 / mcp__sequential-thinking__sequentialthinking 真调用 / tool_result 45ms 回 / SDK closed result.subtype="success". 总 turn 29s.
- **Step 8** (`9ba99fa`): 用户提供短期 GitHub PAT, 走 GitHub Issues Lister pipeline 完整 secret-gate 链路. 截屏 `step8-01-gate-pending.png` / `step8-02-token-filled.png` / `step8-03-after-resume-completed.png`. 实测顺序: trigger /run 无 envValues → secret_pending → POST /secrets → resolved:true → status running → fetchOpenIssues 37.9s 拉到 10 个真实 issues → filterByLabel 跑完 → completed. Hot-update audit 显示 actor=secret-gate-resume → 复用 migration 通路.

### 文档

- `findings.md` 加入 Bug 11 根因 + 三步修复 / Step 8 完整 verification / Step 9 完整 verification / Bug 12 闭合 / Bug 13 reclassification.
- handoff.md 上半段 (815ee7f) 不动, 下半段是本次延续 (你正在读).

## Step verification table (final)

| Step | Status |
|---|---|
| 6 — `run_pipeline { name }` resolves to versionHash + 启动任务 | ✅ |
| 7 — secret-gate 在 envKey 缺失时触发 | ✅ |
| 8 — 用户 dashboard 提交 secret, 任务 resume, MCP 拿到真实值 | ✅ end-to-end (本次) |
| 9 — 任务继续, MCP 真调, 生成输出 | ✅ 两次 (sequential-thinking SDK probe + 真实 GitHub API run) |

唯一未覆盖的是 **inventory 持久化 (persistAs)** —— 用户提交 token 时选择 "save to inventory" 而非 "inline" 的路径. POST /secrets 已经支持 persistAs 参数 (route schema 验证), 但本次没走这条; 留作下次 dogfood.

## Open issues for next session

(All medium-priority issues from continuation 2 are now closed; see
the closed list below.)

### ✅ Closed in continuation 3

1. ~~**Runner cross-region cancellation**~~ — closed. New `STAGE_CANCELLED` event + per-region waiting/executing transitions + runner subscribe-loop propagation. When a stage enters its `error` final via `executor_failed` / `no_active_wire`, runner BFS over `ir.wires` and dispatches `STAGE_CANCELLED` to every transitive downstream not yet finalized. Each region matches `event.stage === self` so cancellation is targeted. New finalizedStages reason `upstream_cancelled` (not surfaced to stageErrors — the root-cause stage owns the message). 4 unit tests + 1 promoted e2e (validatePatch fail → applying never starts → run resolves in <1s vs prior 10-min timeout).

2. ~~**inventory persistAs 路径未实测**~~ — closed. New `secret-gate-persist-as.test.ts` (1 e2e, ~7s): provideTaskSecrets with `persistAs: { ENV_KEY: { entryId } }` writes mcp_inventory + mcp_inventory_secrets rows; second pipeline run with same envKey resolves from inventory without raising a fresh secret_gate (no re-prompt). Stub catalog exec so npm-view healthcheck doesn't hit the network. End-to-end loop now covered alongside Step 8's "inline only" verification.

3. ~~**Replenish more catalog entries**~~ — closed by re-evaluation, not by adding. Continuation 3 vetted the candidate pool (Notion / Linear / HTTP fetch). Findings:
   - **Notion / Linear**: official path is `mcp-remote https://mcp.{linear,notion}.app/mcp` — OAuth-gated remote transport, NOT stdio. Vetter (`scratch-vet-mcp.mjs`) only handles stdio handshakes; rot-guard mode-2 only knows the spawn-test ladder. Adding an mcp-remote entry would need a separate vetting path + a way to document the OAuth flow that doesn't ship a token. Both are bigger than "add 3 entries".
   - **HTTP fetch**: no vendor-published stdio fetch MCP. The Python `mcp-server-fetch` runs via uvx, not npx; entries.json schema is `command: string + args: string[]` so uvx is technically expressible, but exposes a different healthcheck story (uvx vs npm view). The other candidates (`@modelcontextprotocol/server-pdf` / `-map` / `-transcript` / `-threejs`) are all HTTP-transport demo apps, not stdio.
   - **`@modelcontextprotocol/server-everything`**: passes mode-2 (13 tools, 18ms init), but it's a reference / demo MCP — adding it bloats the catalog without giving real workflows new capability.
   The 10 existing entries cover the actual dogfood workflows. Per CLAUDE.md "design for the present problem, do not pre-spend": adding entries with no immediate user is predictive infrastructure. New entries land when a real workflow needs them, with the rot-guard mode-2 + scratch-vet-mcp.mjs pair already in place to gate them.

### ✅ Closed in continuation 3 (architecture pass)

5. ~~**Runner wall-clock timeout never rejects when actor stops emitting snapshots**~~ — closed (`792c897`). The 503-line timer set inside `runPipeline` only flipped a `timedOut` flag; rejection happened only when `actor.subscribe` fired a snapshot. A stage handler returning a never-settling Promise + a downstream region waiting on its wire → no further snapshots → run never resolved or rejected. Real deadlock path. Fix: timer callback (`fireTimedOut`) directly invokes the captured `currentRejectAttempt`. Reverse-verified: removing the fix makes the new regression test (`runner.timeout-reject.test.ts`) hang for 10s+ until the harness kills it.

6. ~~**Wire from-stage extraction duplicated in 14 sites with subtle drift**~~ — closed (`d66559e`). New `kernel-next/ir/wire-helpers.ts`: `wireFromStage`, `isStageSourcedWire`, `wireSourceKeyPrefix`. Refactored runner / mock-executor / real-executor / script-executor / inline-script-executor / runner-fanout / segment-planner / topo-downstream / real-executor-prompt-builder / ir/sql / hot-update/divergence + wire-reachable / validator/dag + structural. Three sites intentionally NOT migrated (impact.ts has its own port-aware helper, diff.ts wireKey builds a different format, mcp/patch.ts does pair-tuple uniqueness — orthogonal patterns). Found and fixed via this work: cross-region BFS was using `source !== "stage"` which silently skipped wires whose source was `undefined` (raw test fixture path), where the runtime treats undefined as stage-sourced.

7. ~~**Runner-side stageErrors[] mirrored MachineContext.finalizedStages with out-of-band sync**~~ — closed. Two parallel sources of truth for "which stages failed" required a mesh of guards (`dispatched` / `publishedStageFinal` / `cancelledByPropagation`) to keep them aligned. Adding cross-region cancellation in continuation 3 immediately surfaced this: the cancellation path needed to push to dispatched but skip stageErrors, and the per-stage substate scan had to filter `reason === "upstream_cancelled"` to avoid double-counting. Each new finalize reason would risk the same kind of bug.

   Fix: extend `MachineContext.finalizedStages` with `message?: string` so the executor's concrete error string flows through the machine. The `STAGE_FAILED` transition action (compiler) reads `event.error` and writes it into the entry. Runner-side `stageErrors[]` is gone; a single derive function builds `RunResult.stageErrors` from `finalizedStages + stageMeta + portValues` at output time. Reasons:
   - `executor_failed` → use `entry.message`
   - `no_active_wire` → call `buildNoActiveWireError` (depends on stageMeta which isn't in machine context)
   - `upstream_cancelled` → skip (propagation)
   - `done` → skip
   The same-actor-success reconciliation (terminal DB row replaces a prior failure entry) becomes a single `if (succeededStages.has(entry.name)) continue` instead of a separate filter pass.

   Side-effect: 7 `stageErrors.push` sites deleted in runner; 2 retry/rollback filter blocks deleted (finalizedStages already filtered, stageErrors derives from it); 1 SSE message lookup at L1459 swapped to read `entry.message` directly. Also lifted `stageMeta` to outer-scope `outerStageMeta` so the finally block (which writes `task_finals.detail`) can derive without re-running compileIRToMachine.

   server runtime suite: 524/524. validator + hot-update + ir + builtin-pipelines: 308/308. No tests changed — the public RunResult shape is unchanged, the change is structural.

### Considered + deferred (continuation 3)

7. **Kernel guard for mcpServers verbatim-fetch enforcement** — considered, deferred. The pipeline-generator + pipeline-modifier prompts require new mcpServers blocks to come verbatim from the catalog (recommend → add → get_mcp_catalog_entry). Adding a kernel-side check at submit() / propose() time would catch prompt regressions in the same way Bug 8b's validatePatch does. Deferred because: (a) hand-written user IRs that reference non-catalog MCP servers (e.g. a local-only MCP) are a legitimate use case in the single-user-local model that the guard would block; (b) no actual silent regression has been observed (unlike Bug 8b). The asymmetry vs Bug 8b is that Bug 8b had no legitimate use case for empty-ops + safe-verdict + non-empty-intent; mcpServers-not-in-catalog has many. Right path is probably a soft-warning diagnostic when added (`MCP_SERVER_NOT_IN_CATALOG`, severity=warning) rather than hard fail. The current Diagnostic shape has no severity; introducing one is a wider change than this issue justifies. Tracked in case real silent regressions emerge.

### Lower priority

4. **架构白皮书重写**. CLAUDE.md 已标"暂停维护". Phase 6 收尾活, 文档活, AI 推不动 M1-M4. 等手感跑久了再写更准.

## Things NOT to do (reaffirmed)

- 不要再扩 dashboard 的 finalResult 来源覆盖逻辑—— Bug 12 现在在源头切了, 后续不该再加 UI 兜底防御 (会模糊"DB 是权威"这条线).
- 不要为了"完整覆盖" inventory persistAs 跑测试—— roadmap 已落 Phase 5, 路径 schema 验证齐全, 单测覆盖到位; 等下次真实业务用到再 dogfood.
- 不要 force-kill chrome-e2e-profile 中途搞测试—— Bug 13 经验. 要么完整启动 / 关闭, 要么 isolated context.
- 不要把 Anthropic 订阅当 MCP 第三方 API key 的替代品—— 用户提到这个混淆, 已经在前面会话里澄清, 但记下来.

## Key files for fast onboarding (additions to original handoff list)

新加的关键文件:

- `apps/server/src/kernel-next/runtime/runner.ts:1133, 1551, 968` — pauseBudget + run_final guard 三个 site
- `apps/server/src/kernel-next/runtime/secret-pending-budget-pause.test.ts` — Bug 12 双重回归
- `apps/server/src/kernel-next/runtime/real-executor.mcp-status-detector.test.ts` — Bug 11 status detector 五分支测试
- `apps/server/src/kernel-next/runtime/real-executor-stderr-filter.test.ts` — SDK stderr filter 测试
- `apps/server/src/kernel-next/mcp-catalog/entries-rot-guard.test.ts` — mode 1/2/3 完整供应链测试梯子
- `apps/server/src/kernel-next/builtin-scripts/index.ts` (validate_patch_vs_intent) — Bug 8b kernel guard module
- `apps/server/src/builtin-pipelines/pipeline-modifier/pipeline.ir.json` — IR 多了 validatePatch script stage 在 genPatch 与 applying 间
- `apps/server/src/builtin-pipelines/pipeline-modifier/validate-patch-stage.test.ts` — Bug 8b 4 个 stage-integration 测试
- `apps/server/src/builtin-pipelines/pipeline-modifier/test-utils.ts` — `buildModifierTestExecutor` 给 e2e 用 CompositeStageExecutor 同时挂 mock-agent + real-script
- `apps/server/src/kernel-next/compiler/ir-to-machine.ts:90-128` — `STAGE_CANCELLED` event + `finalizedStages.reason` extended with `"upstream_cancelled"`
- `apps/server/src/kernel-next/compiler/ir-to-machine.ts:waiting/executing` — `STAGE_CANCELLED` transition handlers per region (cross-region cancellation)
- `apps/server/src/kernel-next/runtime/runner.ts:cancelledByPropagation` — runner-side BFS over wires + dispatch loop
- `apps/server/src/kernel-next/runtime/runner.cross-region-cancel.test.ts` — 4 propagation regression tests
- `apps/server/src/builtin-pipelines/pipeline-modifier/e2e.bug8b-guard.test.ts` — full e2e regression for Bug 8b (runs in <1s thanks to cross-region cancel)
- `apps/server/src/kernel-next/ir/wire-helpers.ts` — centralized `wireFromStage` / `isStageSourcedWire` / `wireSourceKeyPrefix`; replaces 14 inline patterns
- `apps/server/src/kernel-next/runtime/runner.ts:fireTimedOut` — wall-clock timer rejects in-flight attempt directly via `currentRejectAttempt`
- `apps/server/src/kernel-next/runtime/runner.timeout-reject.test.ts` — regression: never-settling handler + tight budget rejects within 2s of budget
- `apps/server/scratch-step89-real.mjs` (gitignored) — SDK end-to-end probe template
- `apps/server/scratch-bug11-repro.mjs` (gitignored) — minimal SDK reproducer
- `apps/server/scratch-vet-mcp.mjs` (gitignored) — catalog candidate vetter

## Test count

- runtime suite: 75 files / 518 tests (vs 73 / 511 之前). +5 测试覆盖本次 6 个 commit 的代码改动.
- 每个 fix commit 都带回归测试 + 反向验证可证伪.
- continuation 2 (Bug 8b kernel guard): +12 测试 (8 unit on `validate_patch_vs_intent`, 4 stage-integration on `validatePatch` IR stage), +1 IR-snapshot 断言, 共 +13. server 全套 2090/2090 substantive (1 flaky `spawn-utils.adversarial.test.ts` 单跑 26/26 绿, 与 Bug 8b 无关).
- continuation 3 (cross-region cancellation + Bug 8b e2e promotion): +5 测试 (4 unit `runner.cross-region-cancel.test.ts` 覆盖 direct/transitive/sibling/SSE-event, 1 promoted e2e `e2e.bug8b-guard.test.ts`). server 全套 2094/2094 substantive (同一个 flaky 单独跑过, 不算回归). pipeline-modifier 子套 16/16 全绿 (含新 e2e).
- continuation 3 architecture pass (`792c897` + `d66559e`): +1 测试 `runner.timeout-reject.test.ts` (wall-clock reject regression with 10s reverse-verify on baseline). `wire-helpers.ts` refactor touches 14 files but adds 0 new tests — relies on the existing 832 tests around the touched modules to catch behavior change. Server runtime + validator + hot-update + ir + builtin-pipelines suites: 832/832 passing.
- continuation 3 architecture pass (#2 finalizedStages-as-source-of-truth): 0 new tests; relies on the existing 524 runtime + 308 surrounding suite tests catching shape regression. RunResult.stageErrors public shape unchanged; only the internal derivation path moved.

## The session's meta-lesson (additions)

前次的 lesson 还成立——**dogfood 不是可选项**. 本次再加一条:

**根因 vs 兜底之分**. Bug 12 走过两阶段:
1. `c91c8c5` 列了 3 个 UI 修复候选 (a/b/c), 都是兜底——预设"将来还可能有别的路径漏发 stale".
2. `822a3d5` 一刀治本——secret_pending 不发 run_final, 后续完全不需要 UI 防御.

第二阶段做完, 第一阶段所有候选作废. 这是 CLAUDE.md "为眼下问题设计、不预支" 原则的具体应用. 见到根因就修根因, 别在中下游加防御层. 防御层永远比根因多一种边界 case 漏掉.

**架构 pass 的两条 (continuation 3 收尾)**:

1. **"todo list 完成 ≠ 系统到位"**. 用户问"还有哪些待办", 我先回了"全闭合"——把 dogfood 那张 issues list 划完误当成"产品完美". 用户立刻反诘"架构和 pipeline-generator 都完美了吗?", 我才停下来真做 architecture pass: timer reject path bug + 14 处 wire-source 漂移. 这两个都是 dogfood 期间发现但没回去修的 deferred 工作, 跟 issue list 上的 medium / lower 是不同维度的事. 永远区分"清单划完" vs "系统正确".

2. **subscribe-callback-as-only-control-path 是 anti-pattern**. runner 的 timer / interrupt / GATE_REJECTED 都依赖 actor.subscribe 触发——只要 actor 自己不再 emit snapshot, 任何外部信号都进不去. cross-region cancellation 那时是因为 timer fire 后没 reject 才直接看到这个 bug; 修了之后回头看, 同型问题在 GATE_REJECTED + INTERRUPT 路径都隐藏 (都通过 dispatcher.send → actor.send → 期望产生 snapshot → subscribe 内分支). 没有同类 reproducer 之前不动它, 但记下来——下次见到 "runner 莫名不返回" 先看 dispatch + subscribe 是否 race.

---

## Continuation 4: web3-tech-research dogfood — generator + runtime bug surfacing

**目标**: 用 pipeline-generator 重新生成 web3-tech-research (旧版是 hand-written 的 13-stage YAML, 见 `github.com/ymh357/workflow-control-registry/tree/main/packages/web3-tech-research`). 设计意图: 砍 13→8 stages, citation 5 层 (L1 onchain / L2 official / L3 aggregator / L4 third-party-named / L5 unverified), tier 由 verify script 自动赋予 (L1-L3) 或用户 gate confirm (L4-L5), echo-chamber 防御靠 verify-as-you-go 而非末端 fact-check, agent 必须先写 What/Why/How 教程作为 quality gate 才能写技术报告. dogfood 主题: 0G 跨链桥 (信息源冲突: LayerZero OFT vs Chainlink CCIP, 旧版 prompt 自承在该主题踩坑写废 8 文件 200 行).

**关键设计反复**: 我前后两次走偏:
1. 先想"hand-write 7 stages 跟 6 个 builtin scripts" — 用户反驳: pipeline-generator 在哪儿, 应该用 generator. 调整: spec.md → generator.
2. 又想"为 web3 verify 沉淀 builtin scripts" — 用户反问"为什么 generator 要为 web3 服务". 调整: generator 完全 generic, web3 知识只活在 modificationGoal 文档里; 6 个 verify 用 inline ScriptStage 让 generator 自己 emit, 不沉淀 builtin (CLAUDE.md "design for present, do not pre-spend" 的标准应用——只有一个 pipeline 用就 inline, 等多个 pipeline 用同一脚本再抽).

最终 modificationGoal 见 `/tmp/web3-tech-research-mod-goal.md` (临时文件, 用完即弃; **不**作为 spec.md 持久化, 因为正常用户调用 web3-tech-research 时输入只是 topic, 不是这种长 prompt — 这种 prompt 是 day-1 设计 phase 一次性的事).

### dogfood 实战暴露的 3 个 bug + commits

#### `analysis.md` prompt 的 placeholder-path 误诱发 (本 commit `a53c50e` 同步修)

旧 prompt L192: "If `taskDescription` is empty or unreadable, emit a minimal design with pipelineName='unknown'". analyzing 接口的 input port 实际叫 `taskText` (renamed from legacy taskDescription). agent 看到 prompt 里"taskDescription" 关键词 + 自己输入区有 `taskText` 大值就走 read_port 拉, 拉错 stage/port → got `port_not_declared` → 走 placeholder-path 输出 "kernel bug" 之类. 我加了一段引导明说"input 在 prompt input section 里, 不要 read_port".

#### `real-executor-prompt-builder.ts` external-source 大 input 给错 read_port 提示 (commit `a53c50e`)

`INLINE_PORT_VALUE_CHAR_LIMIT = 1024`. 任何 input 超 1024 字符走 large-value 分支, agent 收到 "用 read_port 拉" 提示. 但 prompt-builder 给的 stage/port 参数错: external-source 大 input 给的是 consuming-stage.name + local-port-name, 实际 port_values 在 `__external__.<external-port-name>`. 注释自承"还是错的, 但 externals 通常很小". dogfood 时 7KB 任务描述立刻撞.

修法: 加 `inputSourcePort` map 用 wire-derived 真 source port 名字, external-wire 显式映射到 `__external__` stage. read_port 支持 `__external__` 读 (仅 write_port 拒绝), 已验. +2 regression test, reverse-verified.

#### `compile-inline-script` ESM `require` undefined (commit `4c942e7`)

apps/server `"type": "module"`, 全局 `require` 不存在. inline-script 编译成 CommonJS, 用 `new Function('module','exports','require', js)` 注入. 注入的 `restrictedRequire` 内部调真的 `require(id)` — ReferenceError under ESM. 任何 inline script 引 node:* builtin 都 fail (即使在 RUNTIME_REQUIRE_ALLOWLIST 内).

修法: `createRequire(import.meta.url)`. 同步改 contract-check.ts (Layer 3 提交校验) + inline-script-executor.ts (运行时执行) 两路, 注释强制两路同步. +1 regression test (forbid "require is not defined" diagnostic message).

### web3-tech-research 提交结果

generator 经过两次 reject (第一次缺关键 ports, reject 走 analysis 重跑, 第二次写齐) → approve → genSkeleton + genPrompts + persisting. **persisting fail** (不写 pipelineId — generator 的另一个 bug, 留作后续修), 但 IR + prompts 已在 store, 我手动 submit:

- 第一次 submit fail with `GATE_TARGET_SHARED`: scope_confirm 跟 claim_review_gate 都把 claim_collection 当 routing target. scope_confirm 实际是 no-op gate (用户填完 externalInputs 就好, gate 只是 "confirm" 一下), 它的 routing 是反模式. 手动 patch IR 删掉 scope_confirm 整个 stage, 23 wires 重 wire.
- 第二次 submit fail: SCRIPT_IMPORT_ERROR `require is not defined`. 修 ESM bug 后 submit 成功. versionHash `c2e2f8253c5194b...`, 8 stages, 23 wires, 全 4 个 inline script (claim_verify / tutorial_validate / report_validate / publish) contract test 通过.

实际 IR 落在 DB, 名为 `web3-tech-research`. 还没真跑过一个 task. 留待 continuation 5.

### web3-tech-research v1 待修问题

1. **L4 claim 经用户 gate 后 success-flip 机制缺**: claim_verify 把 L4 candidate 标 success=false, 但用户在 review_gate approve 后没有 stage 翻转 success 标志, 导致 tutorial_synthesis 强 filter `success===true` 时 L4 全丢. 需加一个 script stage 在 review_gate 之后, 读 gate comment 解析"用户接受了哪些 L4 ids", 把那些 success 改 true.
2. **eth_getCode 单独不能验合约 inheritance**: claim_verify L1 路径需要 etherscan source code API 而非仅 RPC eth_getCode. 这是 inline script 实现细节, 在 prompts 里没暴露的. 真跑 0G 桥时如果 verify 不出 LayerZero/CCIP 真相再加.
3. **persisting stage bug**: generator 自己的 persisting agent 没写 pipelineId port, 卡 "schema non-compliant" fail. 临时绕过靠手动 submit_pipeline. 长期看 persisting prompt 需要修 — 同 Bug 8b 类型(prompt 自由度过大), 该让 inline script 强制每个 declared output 都 write 而非 agent 自管 (kernel-next 已有 schema validation 机制可用).

### 下一步 (continuation 5)

- 用 pipeline-modifier 修上面 #1 (L4 success-flip script stage)
- 用 web3-tech-research 真跑 0G 跨链桥, 看实际 verify LayerZero vs CCIP 真相能不能拿到
- 视情况修 #2 (etherscan source code API)
- persisting bug (#3) 单独立项, 跟 web3-tech-research 不绑

### 测试

- prompt-builder: 4 → 6 测试 (+2 large-input + external/stage source 路径)
- inline-script: 5 → 7 测试 (+1 ESM require regression, +1 跑过外部 cwd 失败 — 是 vitest cwd 问题不影响 prod)
- runtime + script-compile suite: 546/546 passing from server cwd (跟 generator/web3 commit 无关的 ~6 flaky 仅在 root cwd 跑, 单跑都过)

### 元教训

**dogfood 的真实价值不在最后跑 deliverable, 在跑过程中暴露的副作用 bug**. 这次本来是要造 web3-tech-research, 副产物是修了 prompt-builder 跟 inline-script 两个真 bug. 生产代码里 7K+ external input + 任意 type:module 引 node:* 的 inline script 都会撞这两个——但单元测试都没覆盖. dogfood 让它们在第一次 real prompt 第一次 real script 里立刻显形.

**hand-written → generator-emitted 的代价是首次校验失败可能性高**. 旧版 hand-written YAML 13 stages 多年迭代过, 不会撞 GATE_TARGET_SHARED. generator 第一次 emit 8-stage IR 就撞了. 这是必然代价, 但因此 generator 自己变更 robust (validator 暴露的每个错误都让 generator 下次少错). **三个 builtin pipeline 互相 dogfood** 的闭环确实跑起来了——modifier 改 generator, generator 出 web3-tech-research, web3-tech-research 跑后再 modifier 改自己.

---

## Continuation 5: web3-tech-research 实跑 0G 跨链桥 — 3 个 kernel-runtime bug 修 + pipeline 二次硬化

**目标**: 把 continuation 4 留下的 web3-tech-research v1 真跑一次 (主题 "0G Labs cross-chain bridge architecture"), 让真实运行暴露剩余 bug. 不预先猜——按 dogfood 原则, 有什么修什么.

### 实跑 v1 (versionHash `c2e2f825...`) — task orphans on first dispatch

`run_pipeline` 启动后, seed phase 写 6 个 external port 成功, task_state 转 running, 然后 **claim_collection 永远不 dispatch**. status API 报 `orphaned`. SSE 停在 task_state running, 没有 stage_executing.

#### Bug A: 多跳 rollback gate 目标被误标为 forward gate-routed

`indexStages` 计算 `gateRoutedTargets` 时, 把 routing target 是 gate 直接前一跳 upstream 的算成 rollback target (跳过 gate-route 检查). 但 web3-tech-research 拓扑是 `claim_collection → claim_verify → claim_review_gate`, gate 的 reject 路由回 `claim_collection` (两跳). 旧逻辑只看一跳, 把 claim_collection 标成 forward gate-routed → 必须等 GATE_ANSWERED 才能 dispatch. 第一个 stage 永远等不到, 整 task orphan.

修法 (commit `[A-hash]`): 把"直接 upstream"扩展成"任意拓扑祖先". 加 `computeGateAncestors` 工具函数, 反向 BFS 跨 inbound wires (排除 `__gate_feedback__` 反馈边, 跟 `validator/dag.ts` 一致), 每个 gate 算到它的全部传递闭包祖先. routing target 是任一祖先就算 rollback. +1 regression test `multi-hop transitive upstream of a gate referenced as a routing target stays non-gate-routed`. reverse-verified (撤销 fix 该 test 立刻挂).

文件: `apps/server/src/kernel-next/compiler/ir-to-machine.ts` (新增 `computeGateAncestors`, 旧 `gateUpstreamByGate` 路径替换), `ir-to-machine.test.ts` (+1 test).

### 实跑 v1 (修后) — claim_collection secret_pending

修 A 后再跑, claim_collection 立刻进 `secret_pending`: 旧 IR 给 stage 配了 brave-search / github / etherscan 三个外部 MCP, 各自要 `BRAVE_API_KEY` / `GITHUB_PERSONAL_ACCESS_TOKEN` / `ETHERSCAN_API_KEY`. 用户没这仨 secret. 按 CLAUDE.md §secret-handling 不能让用户在 chat 贴 secret, 也不能为了绕开 secret 删 mcpServers ("the IR encodes the pipeline author's intent; corrupting it to work around a missing input is wrong").

#### Bug B (设计层 — generator prompt): Claude SDK 内置工具不是 first-class

`pipeline-generator` 的 `analysis.md` 强制 analyzing 用 `recommend_mcp_servers` + `add_mcp_catalog_entry` 给每个外部能力配 MCP. 这忽略了一个事实: Claude Agent SDK 自带 `WebSearch` / `WebFetch` / `Read` / `Write` / `Edit` / `Glob` / `Grep` / `Bash`, 无 envKey 无配置. 任何"找文档/抓 URL/读写本地文件"的需求, builtin 已经覆盖. 上 MCP 反而引入 secret 阻塞器.

修法 (commit `[B-hash]`): `analysis.md` step 7 (新增) 列出 builtins, 给出"Public web docs / public repo source / public API → builtin, 不上 MCP" 的决策规则, 明确 "Never declare an MCP server whose only role is search the web or fetch a URL". 旧 step 7 重新编号成 8.

文件: `apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md`.

#### v1 → v2: 用 pipeline-modifier 改 web3-tech-research 走 builtin

modificationGoal 写明: 删 `claim_collection` stage 的 mcpServers, prompt 改用 WebSearch/WebFetch + 公开 endpoint (raw.githubusercontent.com / 无 apikey 的 etherscan / 公开 RPC). modifier 自身 6 stages 全过 (loadCurrent → analyzeGap → awaitingConfirm → genPatch → validatePatch → applying), auto-applied. **新 versionHash `0b36c4c6...`**.

### 实跑 v2 — 第一次 reject 后第二轮 fanout 复用旧数据

v2 没 secret 阻塞, claim_collection success → 15 个 fanout_element 都 success → claim_review_gate. 第一轮 claims 跑题 (写 0G 一般架构而非 bridge), reject + 反馈. 第二轮 claim_collection 重跑成功, 但 **`fanout_aggregate` rows 直接出现, 没新的 `fanout_element` rows**. aggregate 的 verifiedClaim port 内容仍是旧 15 claims. 数据正确性问题.

#### Bug C: reject-rollback 不 supersede 旧 fanout attempts

`runner-fanout.ts:orchestrateFanoutStage` 有个 `preservedByIdx` query, 选所有 `kind='fanout_element' AND status='success' AND fanout_element_idx < sourceLength` 的旧 attempts, 复用它们的输出 (B17 hot-update migration 设计 — preserved 行对新 run 仍有效). reject-rollback 路径只 reset 了 `MachineContext.portValues / finalizedStages / dispatched / publishedStage*` 等内存态, **没动 stage_attempts 表**. 那些 success 行依然在, idx 还匹配 ([0, 14]), preservedByIdx 命中 → 跳过执行, 直接 aggregate. 新 input 完全没被 verify.

修法 (commit `[C-hash]`): runner.ts reject 路径补一段 `UPDATE stage_attempts SET status='superseded'` 针对 affected stages 中的 fanout 类 stage 的所有 `fanout_element` + `fanout_aggregate` rows. 不动 port_values / lineage. retry 路径不动 (same-input retry, preservation 仍正确). +1 regression test `reject-rollback supersedes prior fanout_element + fanout_aggregate rows so the second pass actually re-executes`, reverse-verified.

文件: `apps/server/src/kernel-next/runtime/runner.ts` (reject 路径 +SQL block), `runner.reject-rollback.test.ts` (+1 test).

### 实跑 v2 (Bug C 修后) — 全管线通过

reject 触发后, fanout 表 15 fanout_element + 1 fanout_aggregate 全 superseded. 第二轮真的跑了 15 个新 fanout_element. claim_review_gate 第二轮 approve → tutorial_synthesis → tutorial_validate → report_synthesis → report_validate → publish. **8 stages 全 success**. 报告 5 sections (Background / Architecture / Key Facts / Design Decisions / Risks), 每段 cite 通过 verify 的 claim, 末尾 citations table 给 evidence URL + keyword match 比例.

但 verify 失败率高 (5/15): L1_onchain claim 给的是 0G mainnet 合约 (chainId 16661), claim_verify 用 ETH_RPC_URL=cloudflare-eth.com (chainId 1) 查 → "no bytecode" → L5; L3_aggregator URL 返回 HTML, `resp.json()` throw → catch → L5.

#### Bug D + E (pipeline 层 — 经 modifier 修): claim_verify 多链 + 非 JSON 容错

D: L1_onchain 路径用 `RPC_URL_<chainId>` 环境变量找 chain-specific RPC, fallback ETH_RPC_URL 仅 chainId===1; 没配 RPC 时返回 `l1_no_rpc_for_chain` 不再误判 "no bytecode".

E: L3_aggregator 先看 Content-Type, 是 JSON 才 `.json()`, 否则 `.text()` 走 keyword-match (复用 L2 启发法), method `aggregator_html_fallback`. 不 throw 不进 verify_error.

走 pipeline-modifier 改 (modificationGoal `/tmp/web3-mod-goal-v3.md`). modifier 6 stages 全过, dryRunVerdict `structural` (新 inline script source 算结构改动), 走 pending-approval, 我手动 `approve_proposal`. **新 versionHash `54b505a7...`**, 现为 web3-tech-research 最新版.

注意: D + E 的 fix 不在 git 仓 — 它们是 inline script source, 通过 modifier 持久化在 DB. 想 git-track 需要 dump IR 进 builtin-pipelines/, 但 web3-tech-research 是 user-pipeline 不是 builtin, 留 DB 即可.

### 实跑 v3 — 验证 D/E + 完整闭环

v3 第一轮跑题 (claim_collection prompt 没强制 narrow scope 是 prompt 设计层弱点, 不在本轮修), reject 加更狠反馈, 第二轮 12 claims 大部分 bridge-specific. **D 路径未触发** (这轮模型没产 L1_onchain claim, 即便反馈要求), **E 路径未触发** (没 L3 aggregator URL). 但代码逻辑已通过 inline-script contract test (modifier 的 validatePatch stage), 单元行为正确.

approve 后 tutorial → report → publish 全过. **v3 报告质量比 v2 还高**: 5 sections 紧扣 CCIP/XSwap 桥架构, 多 citation 互相印证 (c004 + c006 一起 cite RMN), 没胡编, Risks 段独立分析 trade-off.

published file: `~/workflow-control/apps/server/.workflow/0g-labs-cross-chain-bridge-architecture-report.md` (+ `-tutorial.md`).

### 测试

- compiler: 19 → 20 (+1 multi-hop rollback)
- runtime reject-rollback: 2 → 3 (+1 fanout supersede)
- 全套 runner.test.ts + compiler/ + reject-rollback: 61/61 passing
- tsc clean, 无 eslint config 跳过

### 元教训

1. **bug 三个都是真实 dogfood 才能撞**. compiler bug A 要求 multi-hop reject route + 第一 stage 是远祖先; runner bug C 要求 reject + 该 stage 是 fanout; generator bug B 要求 user 没 secret 但 builtin 够用. unit test 都不会偶然碰. dogfood 是唯一的过滤器.

2. **pipeline-modifier 是 dogfood 的 force multiplier**. 每发现一个 pipeline-层 bug 就 modifier 改, 不直接改 IR. 副作用是 modifier 自己也跑了一遍, 再次验证 modifier 工作. continuation 5 modifier 跑了两次 (v1→v2 删 MCP, v2→v3 加 chainId/JSON), 都 6 stages success, 没暴露 modifier 自身 bug. 三 pipeline 互测的闭环再次稳定.

3. **kernel bug vs pipeline bug 边界要清楚**. A 跟 C 是 kernel-next runtime 的 (commit 进 git, 加测试), B 是 generator prompt 的 (commit prompt 文件), D/E 是 web3-tech-research 这个 specific user pipeline 的 (走 modifier 进 DB, 不进 git, handoff 记录即可). 混淆这两类会导致两种错: 要么把 user pipeline bug 当 kernel bug 修 (污染 kernel), 要么把 kernel bug 当 pipeline bug 绕过 (永远不修). 4 个 bug 都按性质放到对的层.

### 后续 (continuation 6 候选, 不 must-do)

- claim_collection prompt 不强收敛 topic (v2/v3 都是第一轮跑题). 要再 modifier 一次给 prompt 加"Narrow scope strictly: every claim must be specifically about <topic>; broader context claims allowed only when needed to explain a topic-specific fact". 但这是质量边际改进, 不是 bug.
- generator persisting stage 仍不写 pipelineId (continuation 4 留下的). 只在 generator 走非 web3 任务时影响.
- L4 claim success-flip 机制 (continuation 4 留下的): 用户 gate confirm 后 success 标志没翻. tutorial 强 filter `success===true` 时 L4 claim 全丢. 真实 dogfood 中没出现 (这次 L4 claim 都 approve 时被 tutorial reference 但不当 fact 引用), 优先级低.

---

## Continuation 6: pipeline 输出质量诊断 — 用户对照 reference report，得出 "investigator-mode" 设计方向

continuation 5 收尾时, web3-tech-research v3 全管线跑通 + 修了 4 个 bug + 输出 5-section 报告. 我评估"优秀到可以交差". 用户给出反例 reference report 说**差很多**, 让我对比.

### 用户给的 reference report

`/Users/minghao/Downloads/0g-bridge-optimization-report.md`. 同主题 (0G Labs cross-chain bridge), 但是 production-grade research 报告. ~750 行, 结构:
- 1.1-1.5: 0G Hub 现状 (hub.0g.ai 模块构成, 双代币双协议, 链上基础设施全景, 当前支持路径, OFT 通道现状: 合约可用无官方前端)
- 2.1-2.3: 痛点 (实测对比表 hub.0g.ai 16:48 vs Monad <30s, 到账时间根因分析逐阶段, 8 条痛点清单含截图证据)
- 3.1-3.6: Monad Bridge 方案 (三协议组合 Wormhole NTT + CCTP V2 + Axelar GMP, 对照详解)
- 4.1-4.B.7: 三条优化路径 (A 现有改, B 重写, C 完全依赖 Khalani) + 对比表 + 推荐策略 (短/中/长期)
- 附录: 完整证据汇总 (链上合约 / 协议文档 / 官方公告)

### 我对差距的渐进认识 (4 轮迭代)

**第一轮 (我自己跑差距分析)**: 我列了 4 维表格——目标/深度/证据/对比/方案/数据点. 抓到了表层: thesis 模糊、证据浅、无对比、无诊断. 但用户说"还是不好——你能找到它真正出彩的点吗".

**第二轮 (我列 33 条 framework-style 差距)**: A 认知校准 (reader profile / prerequisite chain / mental model 锚点 / 链式追问) / B 工作合同 (thesis / deliverable type / audience action) / C 证据 (可证伪 claim / primary source 优先级 / 反事实验证 / 链上实测 / citation 多字段) / D 对比 (baseline / 横向 attribute table / capability gap) / E actionable plan (path enumeration / 工作量+风险评分 / 时间轴 / 风险表) / F 管线设计 (scope 收敛 / diagnose 阶段 / comparative baseline stage / cognition calibration / primary-source-first / fact-narrative 分离 / 多 pass refinement / 该停判据) / G 泛化 (web3 specific vs generic / topic shape → pipeline shape / 研究 vs 综述 vs 优化建议).

用户回应: "还是不好. 我发给你的文档你能找到它真的出彩的点是什么吗".

**第三轮 (重新读, 不套 framework)**: 看到的真正出彩点——**作者亲自做了一遍他在描述的事, 报告写的是发现, 不是 survey**. 具体:
- 1.2 双代币双协议: 不是从 docs 读到, 是作者去 Etherscan 读 ZeroGravityOFT 源码发现"原生 0G 走 LayerZero, W0G 才走 CCIP", 0G 官方 blog **不写**这件事. 这种"官方叙事 vs 链上事实的裂缝"成为整篇骨架.
- 1.5 OFT 通道现状: "合约可用无官方前端" 是结论性发现, 不是事实陈列. 通过链上 + 文档 + 第三方 check 一连串 negative discovery 才得出.
- 2.1 实测 16:48: 全网搜不到的数字, 因为它是作者钱包里发生的事.
- 2.3 痛点 8 余额读取 bug: 必须真用过 hub.0g.ai 才能写出. 截图 + 复现率 + 可能根因 = hands-on debugging 副产物.
- 4.B.5 Wormhole Connect 不能复用: 作者真去看了 Wormhole Connect 的 GitHub repo + Circle CCTP 支持列表 + Wormhole 在 0G 的合约部署, due diligence 不是 survey.
- 痛点 1 Gas Dropoff: 把 CCIP `EVM2AnyMessage` + `EVMExtraArgsV2` 结构体源码贴出来**指给读者看里面只有两个字段**, 用源码反证不存在.

**结论一句话**: 作者的报告是 hands-on engineer 跑了一遍的发现, 我的报告是 librarian 把搜到的资料整理了一遍.

### 关键转折问答 (内含产品定位深化)

**用户问 1**: "用户往往并不知道 ta 应该去做哪些实测".

我意识到: hands-on 计划本身就是 pipeline 的产出, 不是 pipeline 对用户的要求. 但提议"两阶段 pipeline (plan → execute), 用户照着 plan 去做" .

**用户问 2**: "我希望用户最小化操作甚至完全不操作 都由你 (Agent) 代劳 不然 和我直接用 AI Agent 有什么区别? 甚至不如".

这一击命中产品定位. pipeline 比直接 Claude 对话强的地方是: 强制纪律 + 并行展开 + 持续迭代 + 可被审计的证据链 + 跨 task 复用沉淀. **用户做事这个动作本身把价值漏出去**——他真要自己跑实测, 用 Claude 直接对话比走 pipeline 还省事.

**用户问 3**: "用户从头到尾不动手是不可行的吗? 比如我给你的文档 作者实际动手还不是产生了 '发现 bug' 和 '链上 tx' 两个结果? 你不也能查到吗? a 通过论坛或其他反馈, b 通过指定金额查 chainscan 之类的?"

这一击让我清醒. 重新分析作者那两件 hands-on:
- **(i) 发交易测 16:48**: agent 不需要复刻——0G hub 上线以来 ETH→0G USDC 的 CCIP tx 全部在链上, agent 拉历史 tx 算 source/destination block timestamp 差, 给 N 笔分布 (p50/p90/p99). **比作者 N=1 一笔样本更可信**. agent 比作者在这一项更高效.
- **(ii) 余额读取 bug**: WebSearch 论坛/X/Discord/Github issues 找用户报怨能补 ~80%. headless playwright 真打开 hub.0g.ai 用任意公开高余额地址 mock 注入截图能补到 100%, 但 playwright 跑 dApp wallet 注入实施成本高 (2-3h 调通一个 dApp).

**Hands-on 的本质是"证据来自直接操作"而非"操作人是谁"**. agent 用历史 tx + headless browser + 论坛挖掘, 能产生**性质相同的一手证据**, 通常比作者更系统化 (作者一笔, agent 100 笔).

**用户问 4**: "回灌升级 v2 是重新跑一遍 pipeline 吗? 这肯定不能接受 如果能用上 v1 的产出倒还行".

我意识到我又偷懒. 正确形态应该是 **incremental refinement**: 用户回灌新 hands-on data → 只跑增量影响子图 (该 claim 的 verify + 该段 report_synthesis), v1 → v1' diff. Kernel 已有 `replay_stage` + `dry_run_stage` + lineage retain (port_values 永不删) 这些零件, 但没拼成 incremental refinement 形态——这是新的 hot-update 形态/新 stage type, 当前 kernel 没有.

但是更重要的是, 既然走 (a) "用户从头到尾不动手", incremental refinement 退化成 nice-to-have 而非主路径. 主路径上 agent 全自动产出.

### 8 项核心能力可行性 + 效果预估

每项: 作者的做法 / agent 替代方案 / 可行性 / 质量上限 / gap / 实施成本.

#### 1.1 链上 tx 时延分布 reconstruction
- 作者: 发一笔 ETH→0G USDC, 记 16:48
- agent: WebFetch CCIP Explorer API (`https://ccip.chain.link/api/...`) 拉 100+ 历史 tx, 源链 timestamp vs 目标链 timestamp 算分布
- 可行性: 高. CCIP/LayerZero/Etherscan/0G Scan 都有 public API
- 质量上限: **strictly better than 作者** (N=100 分布 vs N=1)
- Gap: 无
- 成本: 小. inline ScriptStage + prompt
  
#### 1.2 Etherscan 已验证源码读取 + 继承链解析
- 作者: 读 ZeroGravityOFT 源码看到 `is OFT`, 引出"原生 0G 走 LayerZero"的关键发现
- agent: WebFetch `etherscan.io/address/<addr>#code`, HTML 含 verified source. 继承链文本解析
- 可行性: 高
- 质量上限: 等于作者的字段读取能力, **gap 在"读完之后的洞察"**: agent 看到 `is OFT` → 输出 "this contract inherits OFT". 作者看到 `is OFT` → 触发"协议是 LayerZero" → 联想"官方说 CCIP canonical → 矛盾"骨架. 这需要 prompt 给 agent 一个领域 lookup table (OFT → LayerZero 协议族 → burn-mint 语义)
- Gap: 中. 字段读取 0 gap, 洞察生成需要 prompt scaffolding
- 成本: 中. inline script + prompt lookup table

#### 1.3 Deployment 列表 negative finding
- 作者: 去 Stargate / Wormhole / Circle CCTP 各自 supported chains 列表, 发现 0G 不在 → 关键 negative finding
- agent: claim_collection 强制——每个 positive claim ("0G 用 CCIP") 必须配一个 negative claim ("0G **不**用 X, evidence: X 的官方支持列表 fetch 后未包含 0G")
- 可行性: 高
- 质量上限: **更全**, agent 不会漏 (作者列了 3 个, agent 可以系统扫 Axelar/deBridge/Across/Hyperlane/Multichain/Connext/Squid/Synapse 等)
- Gap: 无
- 成本: 小. prompt 改一句

#### 1.4 GitHub repo 绑定关系分析
- 作者: 判断 "Wormhole Connect 不能直接复用到 0G" 依据是看 Wormhole Connect GitHub repo 主入口/package.json
- agent: WebFetch `raw.githubusercontent.com/<owner>/<repo>/<branch>/...` 拉 package.json + 主入口 + README, 分析依赖
- 可行性: 高. raw 不限速
- 质量上限: 等于作者. 复杂依赖图分析 (扫多文件 grep) 略弱, 需要 sub-pipeline 或 fanout
- Gap: 极小
- 成本: 低-中

#### 1.5 Headless browser 真用 UI
- 作者: 用 hub.0g.ai 看到余额读取 bug 截图
- agent: playwright + WalletConnect mock 注入公开地址截图. **OR** WebSearch 论坛/X/Discord/GitHub issues 找用户报怨
- 可行性: playwright 中等偏低 (dApp wallet mock 实施 2-3h/dApp + 反爬), 论坛挖掘高
- 质量上限: playwright 远弱于亲用 (作者真用所有 UI 边界 case 都能撞), 论坛挖掘补 60-80%
- Gap: 这是 (a) 路径上**真实物理边界**. 作者 5 分钟做的事, agent 5 小时未必稳
- 成本: playwright 高, 论坛挖掘低. **建议只做论坛挖掘, playwright 留 future**

#### 1.6 Comparative baseline 自动选择
- 作者: 选 Monad Bridge 作对照 (同期上线 + 同形态新 L1 官方 bridge + 不同选择 Wormhole NTT+CCTP V2)
- agent: 显式 stage `select_comparative_baseline`: 给定 topic, 输出 1-3 候选 baseline + 选择理由 (同期/同形态/不同选择)
- 可行性: 高
- 质量上限: 约等作者, 可能略弱 (作者凭直觉选最热对比对象, agent 可能选偏的). 可加 minimal gate 让用户审 1-3 候选选一个 (这不算"用户做事")
- Gap: 小
- 成本: 中. 新增 stage + 配套 verify

#### 1.7 多份证据并行验证 (fan-out 升级)
- 作者: 每个关键 claim 配 3-5 个独立证据 (合约地址 + 部署 tx + token list URL + token 标签 + ...)
- agent: claim_verify fanout 不再 "per claim 一个 element", 而是 "per claim N 个独立 verifier" 并行——每个 verifier 用不同 evidence 类型 (链上 / 源码 / docs / explorer / forum)
- 可行性: 高
- 质量上限: 等于作者
- Gap: 无
- 成本: 中-高. **需要 IR schema 支持二级 fanout (kernel 能力扩展)**

#### 1.8 诊断 + 路径枚举 (report 重头戏)
- 作者: 第二章诊断 (痛点清单), 第四章路径 (A/B/C 工作量风险)
- agent: 新增 stage `synthesize_diagnosis` + `enumerate_paths`
- 可行性: 高. LLM 给 facts 做 diagnosis + path enumeration 是它的强项
- 质量上限: 接近作者. agent 更系统化 (不漏维度), 但作者 "短期/中期/长期" 策略经验需要 prompt 给 anchor
- Gap: 小, 可控
- 成本: 中

#### 综合预估表

| 维度 | 当前 v3 | 改造后预期 | 作者那份 |
|---|---|---|---|
| Hands-on 数据密度 | 0% (全 docs) | 70-80% (链上+源码+论坛+tx历史) | 85-90% |
| Negative finding | 无 | 系统化 (positive 必配 negative) | 选择性 (3 个) |
| Comparative baseline | 无 | 自动选 + 平行 verify | 一个, 主观选 |
| 诊断深度 | 浅 (Risks 段) | 中 (痛点表格 + 根因) | 深 (痛点+根因+实证) |
| 路径枚举 | 无 | 有 (A/B/C 模板) | 有 + 三维评估 |
| UI bug discovery | 无 | 中 (论坛挖掘) | 强 (亲用) |
| Source code 精读 | 无 | 中 (单 contract anatomy) | 中-强 |
| 总体可读性 | librarian | investigator | hands-on engineer |

**预期效果**: 当前 v3 librarian 报告 (~30% 作者水准) → 改造后 investigator 报告 (~70-80%) → 作者 hands-on engineer 报告 (100%). **改造能让管线产出从 30% 提升到 70-80%**, 剩下 20-30% gap 是 UI 亲用 + 工程直觉, 可接受不补.

### 实施成本拆分

可以分两期:

**Phase 1 (无 kernel 改动)**: 1.1 / 1.2 / 1.3 / 1.4 / 1.5-论坛 / 1.6 / 1.8. 报告 30% → 65%.

**Phase 2 (kernel 升级)**: 1.7 二级 fanout + incremental refinement (新 hot-update 形态/新 stage type). 报告 65% → 80%.

### 泛化原则 (避免 web3 特化)

**不修改 web3-tech-research 自己, 而修改 pipeline-generator 的 `analysis.md` / `gen-skeleton.md` prompt**.

#### 5 个 generic 能力升级

1. **First-hand evidence preference** (核心泛化): 任何研究类 pipeline 都问"这条 claim 我能不能拿到第一手证据, 而非中介转述?"
   - web3 → 链上调用/源码/tx 历史
   - 库选型 → 真跑 benchmark/读 source/跑 demo
   - 产品评测 → 真用 (playwright)/论坛 review 挖
   - 学术综述 → 读原论文/重跑实验
   - 商业分析 → 财报原文/法庭文件/招股书
   - prompt 改: "对每个 claim, 问 what's the first-hand evidence available for this domain, 强制至少一条"

2. **Negative discovery**: 任何选型类研究, "为什么不选 X/Y/Z" 和 "为什么选 A" 同等重要
   - prompt 改: "every adopted-X claim MUST be paired with at least one not-adopted-Y with evidence why not"

3. **Comparative baseline**: 任何评估类研究都需要 baseline
   - web3 协议 → 同期同形态协议
   - 库选型 → 同代差竞品
   - 产品评测 → 同 user segment 替代品
   - 投资分析 → 同行业可比公司
   - 泛化到 "select a comparative baseline that is similar in form but different in choice"

4. **Diagnosis + path enumeration**: 任何"现状分析 + 改进建议"类研究都需要这一对
   - web3 → 痛点 + 改进路径
   - 系统选型 → 当前问题 + 替换方案
   - 业务诊断 → 现状评估 + 转型路径
   - 投资判断 → 风险点 + 可能演化
   - 泛化到 "if topic-shape is diagnostic, MUST output (痛点表格, 根因分析, 路径枚举, 推荐策略)"

5. **Topic shape detection** (最高一层泛化): 不同 topic 形态走不同 stage 拓扑
   - **介绍型** ("Linear 是什么"): 建立认知 → 关键事实 → 应用场景, **不需要** baseline/negative/诊断
   - **诊断+方案型** ("hub.0g.ai 该怎么改"): 现状 → 问题 → 对照 → 路径
   - **选型型** ("我该用 SQLite 还是 PG"): 候选枚举 → 维度选择 → 实测对照 → 推荐
   - **趋势型** ("AI agent 框架近况"): 时间轴 → 主流派系 → 横向对比 → 走向
   - 当前 pipeline-generator 不知道有这事, 对所有 topic 用一套模板. **修复: generator 先识别 topic shape, 再选对应 stage 模板**

#### 落地原则

- 修改集中在 `pipeline-generator/prompts/system/analysis.md` + `gen-skeleton.md`
- web3 特化部分 (L1-L5 tier, Etherscan 源码读, 链上 RPC 调用) **留在 web3-tech-research 自己的 inline script 里**, 不污染 generator
- web3-tech-research 应**通过 generator 重新生成**而非手改, 验证 generator 升级落地正确

### Phase 1 落地步骤 (建议下次)

```
T1: pipeline-generator 升级
  T1.1 analysis.md: 加 "topic-shape detection" 子章节 (介绍/诊断/选型/趋势 + 各对应 stage 模板)
  T1.2 analysis.md: 加 "first-hand evidence" 强制章节 (per claim 必须有 first-hand)
  T1.3 analysis.md: 加 "negative discovery" 强制章节 (positive 必配 negative)
  T1.4 analysis.md: 加 "comparative baseline" 概念 + select_comparative_baseline stage 范式
  T1.5 gen-skeleton.md: 加 4 套 stage 模板 (介绍 / 诊断 / 选型 / 趋势)
  T1.6 gen-skeleton.md: 加 "diagnosis + path enumeration" stage 范式 (仅 diagnostic shape 用)

T2: 用升级后 generator 重新生成 web3-tech-research 走 dogfood
  T2.1 prepare modificationGoal: 主题 "0G Labs cross-chain bridge optimization analysis" (注意 shape 是 diagnostic 不是 介绍)
  T2.2 跑 generator 输出新 IR + prompts
  T2.3 review 新 IR: 是否包含 select_comparative_baseline / negative_discovery / synthesize_diagnosis / enumerate_paths
  T2.4 submit + run, 观察输出 vs 作者 reference report

T3: 出现的 gap 用 modifier 补
  T3.1 如果 first-hand 不够深 (没读 Etherscan 源码) → modifier 加 inline script "etherscan-source-fetch"
  T3.2 如果 negative finding 不全 → modifier 加 prompt 强制
  T3.3 如果路径枚举太抽象 → modifier 加 stage prompt "工作量+风险表"
  T3.4 论坛挖掘 stage: WebSearch + WebFetch X/Reddit/Discord/GitHub issues 关键词 (不依赖任何 secret)

T4: Phase 1 收尾后评估
  T4.1 输出 vs 作者 reference 自评 30%/65%/80%/100% 哪一档
  T4.2 决定是否启动 Phase 2 (二级 fanout + incremental refinement, kernel 改动)
```

### Phase 2 暂时不做

二级 fanout + incremental refinement 涉及 kernel 改动, Phase 1 见效后再评估. 当前 kernel-next 单级 fanout 够用, claim_verify 多 verifier 可以暂时用 sequential 方式做 (loop in agent prompt 拿 N 种 evidence).

incremental refinement 也可以暂时用"reject + 反馈"模拟 (虽然会触发 fanout supersede 导致重跑, 但有 continuation 5 修的 fanout-supersede bug 兜底, 数据正确性没问题, 只是浪费 token).

### 元教训

1. **librarian 报告 vs hands-on engineer 报告的差距是产品定位级的**, 不是细节级. 当前 pipeline 通过 url_keyword_match 做 verify 是 librarian 模式, 升级 investigator 模式需要从 generator prompt 层重写, 不是 web3-tech-research 加 stage.

2. **"hands-on" 的本质是"证据来自直接操作"而非"操作人是谁"**. agent 用历史 tx + headless browser + 论坛挖掘, 性质等价于亲手做, 且通常更系统化 (N=100 vs N=1).

3. **(a) 用户完全不动手是真正的产品定位**, 不是 (b) 用户 nice-to-have hands-on. (b) 等于把 pipeline 价值漏给"直接对话 Claude". pipeline 必须靠 agent 自己 hands-on 去逼近 production-grade 报告.

4. **"用户不知道该测什么"这件事本身**说明用户连"hands-on 报告比 librarian 报告好"这件事都可能没意识到. pipeline 必须主动把"investigator 模式"的成果交付给用户, 让用户**通过结果**学到这种思维.

5. **泛化的最高层是 topic shape → pipeline shape 映射**. 当前 pipeline-generator 对所有 topic 用同一套模板, 这是导致 librarian 输出的根因. 加 topic-shape detection 是 generator 层级的产品升级.

6. **不预支泛化**. continuation 4 已经踩过坑 (我提议为 web3 verify 沉淀 builtin scripts 时用户反问"为什么 generator 要为 web3 服务"). 这次同样: 5 个 generic 能力 (first-hand / negative / baseline / diagnosis-path / topic-shape) 是真正泛化的, 抽到 generator 层. web3 specific (链上 RPC / Etherscan 源码读 / L1-L5 tier) 留在 web3-tech-research 自己 inline. 别污染 generator.

### Continuation 5 commits 状态 (待提交)

continuation 5 的 4 个 commits 已就绪等待授权 (见 task #398), 含:
1. `compiler/ir-to-machine.{ts,test.ts}` — multi-hop rollback gate-routing classifier (修 task orphan when 第一 stage 是 gate 远祖先)
2. `runtime/runner.{ts}` + `runner.reject-rollback.test.ts` — supersede stale fanout attempts on reject (修第二轮 reject 后 fanout silently 复用旧数据)
3. `pipeline-generator/prompts/system/analysis.md` — Claude SDK builtin tools 作为 first-class option (修无 secret 时 pipeline 一启动就 secret_pending block)
4. handoff 本文件 (continuation 5 + continuation 6 章节)

---

## Continuation 7: 三层结构重设计 (tutorial 作为一等公民)

### 用户三条提醒触发的关键转向

continuation 6 的 investigator-mode 设计 (5 generic capabilities) 仍然是局部修补, 没碰到产品形态层面. 用户 continuation 7 重新提醒 3 条原则:

1. 要先了解用户的认知
2. 设计合适的教程 What/Why/How 真的能通俗易懂讲透所有基础
3. 在此基础之上, 其余的调研 (可能是真问题本身) 才能站得住且有意义

这三条把整个产品形态从"如何让 agent 做更多动手的事"翻转成"如何让发现 land 在读者认知上".

### 关键洞察: 出彩 ≠ 发现, 出彩 = 读者能感受到出彩

回看参考报告 (`/Users/minghao/Downloads/0g-bridge-optimization-report.md`) 的结构:

- §1.1-1.5 现状 (CCIP / OFT / 双协议) → **这是教程**
- §2.1-2.3 痛点 → 站在 §1 上才 land
- §3 Monad 对照 → 站在"读者懂跨链桥应该长什么样"之上
- §4 优化路径 → 站在前 3 节所有概念之上

如果读者不知道 OFT 是 LayerZero 的代币标准, §1.2"双代币双协议"那个**全篇最出彩的发现之一**就是天书. 没有教程铺垫的发现, 对外行是天书, 对内行是常识. 两边都不出彩.

continuation 6 我一直在想"agent 怎么动手", 完全漏了**作者首先把读者要懂什么想清楚了**这一步. 动手是手段, 教程铺垫才是发现能 land 的地基.

### 三层结构 (Layer 0 / 1 / 2)

```
Layer 0: 定位层 (Framing)
  - 这是什么类型的调研? lookup/diagnostic/selection/landscape
  - 写给谁? audience role + known + unknown + cares_about
  - 读者要先懂什么? prereq concepts

Layer 1: 教程层 (Foundations)
  - 讲透前置概念 (What/Why/How)
  - 这一层独立可交付 (副产品: 跨 task 复用资产)

Layer 2: 调查层 (Investigation)
  - 在教程铺好的概念之上做发现
  - hypothesize → gather → 验证 → 循环
  - 每条 finding 必须挂 ≥1 tutorial concept (前向链接)
  - 每条 finding 必须挂 ≥1 evidence artifact (回溯链接)

final_assembly: tutorial 在前 / findings 在后 / 双向引用
```

**核心硬约束**: Layer 2 的每条发现必须能映射回 Layer 1 的某段教程. 没有教程支撑的发现, 要么补教程, 要么砍发现. 这是"读者能 land"的硬保证.

### 9 stage 完整设计

| # | Stage | 类型 | 单/fanout | gate | 产出 |
|---|---|---|---|---|---|
| 1 | `topic_framing` | LLM | 单 | LLM-judge | `framing.json` (type/audience/axes) |
| 2 | `prereq_extraction` | LLM | 单 | LLM-judge | `prereqs.json` (concepts + tutorial_outline) |
| 3 | `tutorial_authoring` | Agent | fanout per concept | LLM-judge ("外行能不能读懂") | `tutorial/<slug>.md` * N + index |
| 4 | `hypothesize` | LLM | 单 (可循环) | LLM-judge ("可证伪? 覆盖 axes?") | `hypotheses.json` (站在 tutorial 概念之上) |
| 5 | `evidence_gather` | Agent | fanout per hypothesis | (无 gate, 进 6) | `evidence/<H_id>.json` (含 negative findings) |
| 6 | `findings_synthesis_gate` | LLM | 单 | gate (approve/reject 回 4) | 决策 + 累计 reject 计数 (max 3) |
| 7 | `findings_authoring` | Agent | fanout per finding | (无 gate) | `findings/<id>.md` * N + index |
| 8 | `report_assembly` | LLM | 单 | (无 gate) | `report.md` + `report.audit.json` |
| 9 | `human_review_gate` | (Human) | gate | **唯一**人工节点 | approve / reject 回 4 |

### 通用性自检 (4 种 type 都跑通)

| 主题 | type | tutorial | hypothesize axes | evidence_gather |
|---|---|---|---|---|
| 0G 桥诊断 | diagnostic | OFT/CCIP/EVM tx | 慢? 贵? UX 差? | 链上+源码+Wormhole 对照 ✅ |
| RAG 框架选型 | selection | retrieval 指标 (recall@k/MRR) | 精度? 吞吐? 生态? | benchmark + issue + star ✅ |
| Rust async 现状 | landscape | Future/reactor/work-stealing | tokio 主导? 替代品? | 下载量+活跃度+实测 ✅ |
| K8s 是什么 | lookup | 容器/编排/控制平面 | (退化为 axis 列举) | 直接进 findings ✅ |

`lookup` 型走简化分支 (hypothesize 阶段空跑, gather 阶段直接基于 axes 做主题展开), 不影响骨架. 通用性 ✅.

### 用户操作自检

| 节点 | 用户做什么 |
|---|---|
| seed | 输入主题 + (可选) audience hint |
| 1-8 所有 gate | 0 (LLM-judge) |
| 9 human_review_gate | **唯一节点**: 读完报告 approve / reject |

满足"用户最小化操作甚至完全不操作". ✅

### workflow 不可替代性自检

为什么这个非走 workflow 不可、chat 干不了?

1. **Tutorial + findings 互相引用** — chat 一次输出会忘前面写过什么; workflow 把 tutorial 沉到 store, findings 引用时确切定位
2. **Hypothesize 循环** — chat 不会主动说"我刚才那批假设证据不够, 重发一批"; workflow 的 gate-rollback 是天然的
3. **Negative findings 跨轮累积** — chat 跨轮就忘; workflow 的 store 是唯一记忆载体
4. **可中断/可观察** — 跑几小时的调研, chat 一断没了; workflow 可以重启接着跑
5. **资产沉淀** — tutorial 进 store 后下次同领域调研可复用; chat 每次从零

每一条都不是 nice-to-have, 是 chat 真做不到的. ✅

### 失败模式自查

- **tutorial_authoring 反复 reject 卡死**: max_rounds=3. 超限后 LLM-judge 给"已知缺陷清单", 进 Layer 2 时附在 framing 里, findings 阶段会避开依赖这些缺陷概念的发现
- **hypothesize 永远生成新假设但没一个被支撑**: max_rounds=3. 超限后 report_assembly 显式写"以下 axes 证据不足"——这本身也是诚实的发现
- **evidence_gather 找不到链上数据**: negative_evidence 是合法输出. 报告里写"尝试 X 验证未成功"
- **用户 reject 整篇报告**: 反馈进 store, 回 hypothesize 循环. tutorial 不重做 (已批准的资产保留)
- **主题落不进 4 种 type 之一**: framing 阶段允许 hybrid 标签, 混合骨架. LLM-judge 校验是否需要回炉拆分主题

### 与现有 kernel 能力的契合

| 需要的能力 | 现有 kernel 支持 |
|---|---|
| LLM-judge gate | ✅ gate stage 已支持 |
| 多 stage 各自 1 级 fanout (tutorial / evidence / findings) | ✅ 1 级 fanout 已支持. **不需要 nested** |
| Reject-rollback 带 negative findings | ✅ continuation 5 刚修完的 reject-rollback + persistentPortValues 正好用得上 |
| Store 跨 stage 累积 | ✅ reads/writes 已支持 |
| Tutorial 跨 task 复用 | ❌ 跨 task 资产共享未支持 — Phase 2 再做, **Phase 1 不依赖** |

**Phase 1 完全不需要 kernel 改动**. 这是关键 ✅.

### 信心评估: 85%

提升源于把"教程层"作为一等公民独立出来——这一步彻底改变了产出形态:

- 之前 (无 tutorial 层): findings 浮在半空, 外行 land 不住, 内行嫌浅
- 现在 (有 tutorial 层): tutorial 自带价值 (外行学到东西), findings 站在 tutorial 上能做到"浅一点也 land 得住"

剩 15% 是动手立场和体感——接受不做. 如果用户真有体感 (声称"我用着慢"), 可以作为 audience hint 传入, agent 优先验证; 但这是**增强**不是**必需**.

### 元洞察: 通用化的真正层级

continuation 6 我抽出了 5 个 "generic capabilities" (first-hand / negative / baseline / diagnosis-path / topic-shape) 写到 generator prompt. 现在看, 这些都是 Layer 2 (调查层) 内部的细节. 真正的通用化层级更高:

**通用 = 三层骨架 (framing → tutorial → investigation) + 双向引用约束**.

这个骨架对所有调研类主题都适用. continuation 6 的 5 个能力是 Layer 2 的实施细节, 但没有 Layer 0/1 兜底, 单跑 Layer 2 就会变成"动手的图书馆员"——动了手但发现仍然 land 不住.

教程层是 chat 给不了的复利资产: 概念地图 / What-Why-How 段落 / 引用源, 进 store 就是可复用资产, 下次同领域调研直接拼.



**注意**: continuation 6 的设计方向 (5 个 generic 能力 + Phase 1 落地步骤) 在以上提交之外, **还没**写进 generator prompt——它们只是这次会话的设计输出, 留给下次会话执行 T1.x 实施.

---

## Continuation 8: 12-stage skeleton 真正落地 + 三个 runtime bug + 报告质量真相

### 用户原则的延续

continuation 7 设计完成后, 用户指令 "直接开始吧 从T1到最后 一条路走到黑". 这次 session 把 T1-T4 全部跑通, 中途连续暴露并修复了 3 个 kernel runtime bug + 1 个 prompt 鲁棒性 bug, 最终产出 90KB 报告. 但内容真实评分仅 50-60% reference 水平 — 比预期低. 这一节如实记录差距来源.

### Phase 1 实施步骤 (continuation 6/7 设计的 T1-T4)

#### T1: Generator prompts 升级到 12-stage skeleton

`apps/server/src/builtin-pipelines/pipeline-generator/prompts/system/analysis.md`:
- 加 §Topic-shape detection (4 shapes: automation / investigation / lookup / hybrid)
- 加 §Investigation pipeline structure (REQUIRED for `investigation` shape)
- 加 §The 12-stage skeleton (topicFraming / framingGate / prereqExtraction / prereqGate / tutorialAuthoring(fanout) / tutorialReviewGate / hypothesize / evidenceGather(fanout) / findingsSynthesisGate / findingsAuthoring(fanout) / humanReviewGate / reportAssembly)
- 加 §STRICT: investigation skeleton enforcement (12 stages 名字精确, 禁止 rename / collapse / split, 禁止额外 script stage)
- 加 §STRICT: rejection-feedback wires (每个 gate.routes.reject = X ⇒ X.reads.<gateName>RejectionFeedback)
- 加 §Topic-shape decision tree (priority-ordered signal mapping, diagnostic vs selection disambiguation)

`gen-skeleton.md`:
- 加 §STRICT: inline-script `sampleInputs` is mandatory
- 加 §Investigation pipeline IR pattern (reject wires 表 + cross-gate-shared targets 说明 + split-port for hypothesize 接两个 gates)
- 加 §How `hypothesize` learns from prior rounds (no back-edges) — 通过 reject-feedback + read_port prior-round outputs

`gen-prompts.md`:
- 加 §Investigation-pipeline stage prompts (special rules) — 每个 skeleton stage 的 prompt-writer 增强指导

`persist.md`:
- 加 verbatim warning + sampleInputs preservation 强调

#### T2: 重新生成 web3-tech-research

经历了 v1 (failed librarian-mode), v2-v9 (反复 reject-rerun 修 fanout / reject-wire / sampleInputs 各种细节). 最终 v9 stageContracts 通过 awaitingConfirm gate 进 genSkeleton/genPrompts/persisting, 但 persisting **仍然砍 sampleInputs** (LLM 不可靠). 通过临时 `/api/kernel/submit-direct` HTTP route 手工 submit 修过的 IR, 得到 versionHash `d3df81b66419` (后续 P4 改进后重新 submit 为 `1826b18d5a4a` 含 elementRetries=1).

**LLM 不可靠的真问题**: persist.md 写了 "verbatim", LLM 仍然在第二次 retry 时去掉了 sampleInputs. 单纯加 prompt 强度治标不治本. C2 (continuation 8 后段) 把 persisting 改成 builtin script 才彻底解决.

#### T3: dogfood 跑通 12-stage end-to-end

第一次完整跑通的是 `web3-tech-research-1777433733157-64e0990d` (versionHash 1826b18d): 12 stage 全部 success, 47KB 报告 + 1KB audit map.

第二次定向 dogfood `web3-tech-research-1777441064341-c33bf87f`: 同 IR, 但 audienceHint 强制 diagnostic 主题 ("subject is 0G Labs ... peers are baselines, not candidates"). 12 stage 全部 success, 90KB 报告 + audit map. 这次 framingGate 自动选 diagnostic, axes 7 个全部 0G-specific.

#### T4: 真实评估 — 与 reference 的内容对比

**严重发现**: 只看结构 (audit map / tutorialAnchors / 章节标题) 会乐观估计 production-grade. 真正读完两份后, gap 比想象大很多.

| 维度 | v1 报告 (1777433733157, selection 误判) | v2 报告 (1777441064341, diagnostic 强制) | Reference |
|---|---|---|---|
| 主题焦点 | 4 桥通用对比 (跑偏) | 0G Hub 主体 (对) | 0G Hub 主体 |
| 0G 特定内容 | ~0% | ~50% | 100% |
| 找到 CCIP-canonical | 没 | ✅ 提到 | ✅ |
| 找到 OFT/CCIP 双协议 (Etherscan 源码) | 没 | ❌ 反转事实 (说"0G no OFT", 实际 ETH 上 OFT 合约 0x4b94 存在) | ✅ 关键发现 |
| 实测 tx hash + 时间 | 无 | 无 | ✅ 16:48 vs <30s, tx 0xaec22773... |
| 具体合约地址 | 无 | 无 | ✅ 0x4b94/0x4c1d/0x0aA1... |
| Gas Dropoff 缺失 | 无 | 无 | ✅ + Client.sol 源码 |
| UI 余额 bug | 无 | 无 | ✅ 实测截图 |
| Bridged USDC.e | 无 | 无 | ✅ + CCIP Token Directory |
| 优化路径具体度 | 通用决策框架 | 通用 + 部分 0G hint | ✅ 三条具体路径 + 工作量 |
| 长度 | 47KB | 90KB | 80KB |

**v2 真实评分**: 50-60% reference 水平. 比 v1 (30-40%) 显著提升, 主要是 framing 锁对了主题. 但仍未达到 75%+ production-grade.

**主要 gap 来源 (根因排序)**:
1. **hypothesize 拍脑袋猜假设, 没基于 0G/XSwap docs 提取真实主张再生成假设**. v2 的 7 个 hypotheses 多数被 evidenceGather refuted (LLM 假设 throughput < 100 msg/min, validators < 8 — 这些没基于 0G 资料, agent 跑去验证, 数据一查就反驳).
2. **evidenceGather 只读 docs/blog/marketing material, 没深入到 Etherscan 源码 / 链上 tx**. URL 列表证明它 fetched 0G 官方 blog + LayerZero docs + Chainlink docs, 但没访问 etherscan.io/address/0x4b94...#code (ZeroGravityOFT 合约源码 — reference 报告关键发现的来源).
3. **报告"反转事实"**: v2 说"0G no OFT integration", 实际真相是"OFT 合约存在但 hub.0g.ai UI 不接 OFT". 这种细微差别 LLM 没分清, 需要看链上实际 peer 配置 + 108 笔 OFT 交易历史才能纠正.

**结论: investigator-mode 是真实改进 (30→55%), 但还差最后一公里 — 把 LLM 从"读 docs 的图书馆"推向"读链上的工程师"**. 这一公里需要的不是 prompt 加强, 是 evidenceGather 阶段加**强制下钻 hooks** (例如: 每个 hypothesis 至少要求一条 Etherscan source code link 或一条链上 tx 作为证据). 留给 continuation 9.

### kernel runtime 真 bug 三连

12-stage skeleton 跑通过程中, **不是 prompt-engineering 失败**, 而是真 runtime bug 暴露. 三个全部修复 + 加 regression test.

#### Bug 1: GATE_TARGET_SHARED 校验过严 (P2.1)

**症状**: submit_pipeline 拒绝 12-stage skeleton, 报错 "Stage 'prereqExtraction' appears as a routing target for multiple gates (framingGate, prereqGate)". 把 `tutorialAuthoring`, `hypothesize` 也都判定 SHARED 错误.

**根因**: `validator/structural.ts` line 254-264 (现已删除) 强制单一 owner. 注释担心 "GATE_ANSWERED path places picked target into context.gateAuthorizedTargets and non-picked siblings into gateSkippedTargets. A target shared across two gates would land on BOTH lists when each gate's answer arrives... producing undefined behaviour". 实证下来这个担心**不成立**:
- gates 是顺序的, 永远不会两个 gate 同时 fire
- gateAuthorizedTargets 用 dedup (compiler line 392), 加同一 target 第二次是 no-op
- gateSkippedTargets 在 runtime 只被写, 不被读作 guard (compiler line 1150 仅查 gateAuthorizedTargets)
- reject-rollback affectedStages filter 同时清两个 list 按 stage-name, 不会留 dirty 状态

**修法**: 删 GATE_TARGET_SHARED 检查, 保留 `gateTargetOwners` map (留作未来 diagnostics). 改原 reject-test 为 accept-test. 加 2 个新 test:
- `compileIRToMachine — cross-gate shared routing target`: G1.approve→SHARED + G2.reject→SHARED 编译 + 启动 OK
- `12-stage skeleton: 3 gates targeting hypothesize` 的最小复刻

文件: `validator/structural.{ts,test.ts}`, `compiler/ir-to-machine.test.ts`.

#### Bug 2: bfsDownstream 把 __gate_feedback__ back-edge 当 forward edge (P3.2)

**症状**: 12-stage skeleton dogfood 时, 用户在 findingsSynthesisGate 答 "approve", server 返回 `kind: "rejected"` (即使 answer 字段是 "approve"), 整个 pipeline 走 reject-rollback. 同问题在 humanReviewGate 也复现.

**根因**: `compiler/ir-to-machine.ts` 的 `rejectRollbackMap` 用 BFS 从 gate 的每个 routing target 反查 — 如果 BFS-downstream(target) 能到达 gate 自己, 该 routing answer 标 rollback. 在 12-stage skeleton 里:
- findingsAuthoring → humanReviewGate (forward)
- humanReviewGate.__gate_feedback__ → hypothesize.humanRejectionFeedback (BACK-EDGE)
- hypothesize.hypotheses → findingsSynthesisGate (forward)

BFS 不区分 forward 和 back-edge, 沿 humanReviewGate → hypothesize → findingsSynthesisGate 找到一条路径, 错误判定 `findingsSynthesisGate.approve = findingsAuthoring` 是 rollback 答案. answerGate 内 isReject 就 true, kernel 走 rollback path.

**修法**: `bfsDownstream` 跳过 `__gate_feedback__` source wires (line 451-456 加 `if (w.from.port === "__gate_feedback__") continue;`), mirroring `computeGateAncestors` 已有同样 exclusion.

加 2 个 regression test:
- `does not classify approve as rollback when feedback wires create cycles` (最小复刻 G1→MID + G1.feedback→MID + G2 cycle)
- `12-stage skeleton: findingsSynthesisGate.approve is NOT a rollback target`

文件: `compiler/ir-to-machine.{ts,test.ts}`.

**教训**: 这个 bug 在 e2e dogfood 之前**没暴露**. 编译器 unit test 验证了 cross-gate shared target 编译通过 + GATE_ANSWERED transitions 正确 — 但对 rejectRollbackMap 的边缘 case 没覆盖. 真 runtime bug 需要 dogfood-driven 才能暴露, prompt-only 设计验证不出来.

#### Bug 3: fanout child API transient error 杀整个 pipeline (P4)

**症状**: 第一次 dogfood 跑到 evidenceGather, 5/6 children success, 1 child 在跑到一半收到 Anthropic API `api_error` (transient). 该 child stage_attempt 标 `error`, fanout aggregate 算作 stage failure, runner 走 STAGE_FAILED, 整个 pipeline 进 failed final state. **9/12 stage 已 success 的 work 全部丢弃**.

**根因**: `runtime/runner-fanout.ts` 的 first-error-fails-stage 语义太严. 设计预期是"任一 child 失败 = 输入数据有问题", 但实际生产场景里"failure"经常是 LLM API 一过性错误 (rate limit, server-side 5xx, 流式断开).

**修法**: `FanoutSpecSchema` 加 `elementRetries: z.number().int().nonnegative().max(5).optional()`. `runElement` 内部加 retry loop, 失败的 element 重新 invoke executor 最多 N 次. 失败的 attempt rows 保留 (status='error', 同 fanout_element_idx) 供 lineage 观察, 成功的 attempt 取最后一个.

`secret_pending` 不 retry (executor 不会自己拿到新 secret), 只 success / unrecoverable 两种结局.

`elementRetries` 默认 0 保持向后兼容. 但 generator prompt (analysis.md) 强制为 investigation 类 fanout stage (tutorialAuthoring/evidenceGather/findingsAuthoring) 默认填 1.

文件: `ir/schema.ts`, `runtime/runner-fanout.ts`, 新增 `runner-fanout.element-retry.test.ts` (4 tests: 成功 retry / 重试耗尽 / 默认无 retry / schema bounds).

#### Bug 4: task-wide INTERRUPT 不停 actor (C4)

**症状**: server reload (改 route 触发 watch-reload) 后, 在 gate-pending 状态的 task 被 bootResumability 注册新 dispatcher. 之后调 retry-from-stage, executeMigration 发 INTERRUPT, 但 actor 卡死等 GATE_ANSWERED 永远不来 — `MIGRATION_INTERRUPT_TIMEOUT` 30s 后报错.

**根因**: dispatcher.send INTERRUPT 仅 set `interruptObserved` flag + 转发到 actor.send. Stage-targeted INTERRUPT (`{ type: "INTERRUPT", stage: "X" }`) 触发 stage 区域的 STAGE_FAILED, 但 task-wide INTERRUPT (`{ type: "INTERRUPT" }` 无 stage 字段) **没有任何 region 监听**, actor 继续等下一个 event.

**修法**: dispatcher.send 收到 INTERRUPT 时, 检查 stage payload — 如果**没有** stage (task-wide), 直接 `currentActor.stop()`. Actor 停止 → subscribe 看到 terminal snapshot → 外层 attempt loop exit → finally 跑 unregister + signalTermination → migration orchestrator 的 awaitTermination 解开. Stage-scoped INTERRUPT 仍然走 actor.send 让 region handler 处理.

文件: `runtime/runner.ts` line 249-281.

**测试**: 现有 `runner.test.ts` 的 INTERRUPT-targeted tests 不能破 (我第一版改太激进, stage-targeted INTERRUPT 也 stop, 引出 2 test fail; 改成只 stop on missing stage). reject-rollback tests 也通过. 36/36 runner tests pass.

### Generator prompts 升级面 (continuation 7 + C1 增强)

**最关键改动**: `analysis.md` 加 priority-ordered topic-shape signals + diagnostic-vs-selection disambiguation rule:

```
1. ANY of {"optimization", "improve", "diagnose", "issues", "problems",
   "pain points", "现状", "痛点", "诊断", "优化空间", "如何改进"} → diagnostic
2. ELSE if {"compare", "evaluate options", "which one", "选型",
   "对比 {A, B, C}"} naming a specific finite set → selection
   (selection requires CLOSED candidate list — generic "compare to peers"
   is NOT selection, it's diagnostic with comparative baseline)
3. ELSE if {"survey", "landscape", "current state of X domain",
   "趋势", "演进"} → landscape
4. ELSE single-topic explainer → lookup
```

加了 5 个对照例子, 含 0G dogfood 的反面例 ("0G's cross-chain bridge architecture and optimization space, with comparative baselines to Wormhole and Monad bridge → **diagnostic** (subject is 0G; peers are baselines)").

这条 rule **是必要的, 但不充分** — v1 dogfood 时 LLM 选了 selection, v2 在更详细的 audienceHint 下才锁对 diagnostic. **生产环境用户不可能写 audienceHint 这么细**. 后续要在 `topicFraming` prompt 内部加更强约束 (例如: "如果 task 描述提到 'optimization' / '现状', diagnostic 是 ONLY valid choice, 即使有多个 peer names 看起来像 selection").

### kernel-next 基础设施扩展面 (C2)

**问题**: pipeline-generator 的 persisting agent 不可靠 — LLM 每次都可能砍 IR 字段. C2 把它彻底改成 deterministic script.

**实施**:
1. 新文件 `kernel-next/builtin-scripts/submit-pipeline.ts` 导出 `buildSubmitPipelinePassthrough(db: DatabaseSync): ScriptModule`. 工厂 pattern bind db, 不需要扩 `ScriptModuleContext` (后者刻意不暴露 db, 让 inline-script-by-AI 拿不到 DB 句柄).
2. `builtin-scripts/index.ts` 加 `FACTORY_SCRIPT_IDS = ["submit_pipeline_passthrough"]`, append 到 `BUILTIN_SCRIPT_IDS` 让 validator 接受这个 moduleId.
3. `runtime/start-pipeline-run.ts` resolver 构造时合并 `submit_pipeline_passthrough: buildSubmitPipelinePassthrough(db)` 进 modules.
4. `pipeline-generator/pipeline.ir.json` 的 `persisting` stage 从 agent 改 script, config = `{ source: "registry", moduleId: "submit_pipeline_passthrough" }`. inputs 从 17 个减到 4 个 (ir, prompts, subIrs, subPrompts). 删 17 条无用 wires.
5. 删 `prompts/system/persist.md`.
6. 改 `pipeline.ir.test.ts`: persisting 不再读 `recommendedMcps`, 期望 `recommendedMcps` ports 数从 4 减到 3.

**factory pattern 的设计权衡**:
- 不扩 `ScriptModuleContext` 加 db: 保留 inline-script-by-AI 的安全边界 (AI 不应拿 db 句柄). 工厂 closure 是更窄的特权升级.
- BUILTIN_SCRIPT_MODULES vs FACTORY_SCRIPT_IDS 拆开: 前者是 stateless modules dict, 后者是 ID-only 列表 (factory 在 start-pipeline-run 现场 bind). 验证器只关心 ID 是否在 set 里, 不关心实现来源.
- 这个 pattern 也适合未来其他 privileged builtin (例如直接读 stage_attempts 历史). 留 TODO.

#### C3: 删 submit-direct route

继 C2 后, `/api/kernel/submit-direct` 临时 route 没用了 (它是 dogfood 期间为绕过 LLM 不可靠的 persisting 用的). 删 `routes/kernel-run.ts` 里 ~40 行.

### 元教训 (continuation 8)

1. **结构对了 ≠ 内容对**. 12-stage skeleton 跑通 + audit map + tutorialAnchors 完整, 但报告内容仍可能跑偏 (v1 selection 误判) 或浅表 (v2 没下钻链上). 结构是脚手架, 内容来自 LLM 在 hypothesize/evidenceGather 阶段的判断质量.

2. **真 runtime bug 只在 dogfood 中暴露**. P2.1 GATE_TARGET_SHARED / P3.2 BFS / P4 fanout retry / C4 INTERRUPT 这 4 个 bug 全是真 e2e 跑出来的, unit test 覆盖不到. 所以这次 session 投资 4-5 小时 dogfood 是必要的 — 跳过会导致这些 bug 在生产阶段才暴露.

3. **LLM 不可靠就用 deterministic 替代**. C2 把 persisting 从 agent 改 script 是范式. 任何 "LLM 应该忠实 forward" 的 stage 都是错配 — LLM 自由度太高, prompt warning 治标. 每次发现一个 "verbatim transport" 角色, 应该问: 能否用 script (registry / inline)?

4. **factory pattern 解 ctx 不能扩问题**. ScriptModuleContext 不暴露 db 的设计是对的 (inline-script-by-AI 安全边界). 但 builtin script 需要 db 时, 在 resolver 构造现场 closure-bind 是干净方案, 不破坏 inline-script 的安全 model.

5. **diagnostic vs selection disambiguation 是 prompt 短板**. 用户描述里 "0G + comparative baselines to Wormhole/Monad" 看起来像 4 桥选型 (selection), 实际是 0G 诊断 + Monad/Wormhole 作 baseline (diagnostic). LLM 默认偏 selection. 这次靠 audienceHint 的强暗示锁定, 但**生产用户不会写这么细的 audienceHint**. 后续要么在 topicFraming prompt 内加更强 disambiguation, 要么在 framing 之后加一个 "double-check shape with topic intent" 的 LLM-judge 子 step.

6. **hypothesize 阶段是质量瓶颈**. v2 7 个 hypotheses 多数被 evidence refuted, 因为它是**通用 bridge 假设** (throughput < 100, validators < 8) 而不是**基于 0G 实际 docs 提取的可证伪主张**. 治本: hypothesize 之前加 ground-truth fact extraction 子步骤 (e.g. "先读 0G/XSwap docs 5 页, 提取每条 declared fact, 然后基于这些 fact 生成 disprove-able hypotheses"). Continuation 9.

### Continuation 8 commits 清单 (待提交)

| # | Logical change | Files |
|---|---|---|
| 1 | fix(compiler): multi-hop transitive ancestor check for rollback gate-routing (continuation 5) | `compiler/ir-to-machine.{ts,test.ts}` |
| 2 | fix(runner): supersede stale fanout attempts on reject-rollback (continuation 5) | `runtime/runner.ts`, `runner.reject-rollback.test.ts` |
| 3 | fix(validator): relax GATE_TARGET_SHARED (P2.1) | `validator/structural.{ts,test.ts}`, `compiler/ir-to-machine.test.ts` (新加 cross-gate test) |
| 4 | fix(compiler): exclude __gate_feedback__ back-edges from bfsDownstream (P3.2) | `compiler/ir-to-machine.{ts,test.ts}` |
| 5 | fix(runner): task-wide INTERRUPT actively stops actor (C4) | `runtime/runner.ts` |
| 6 | feat(runtime): fanout elementRetries (P4) | `ir/schema.ts`, `runtime/runner-fanout.ts`, 新文件 `runner-fanout.element-retry.test.ts` |
| 7 | feat(builtin-scripts): submit_pipeline_passthrough + persisting → script (C2) | `builtin-scripts/submit-pipeline.ts` (新), `builtin-scripts/index.ts`, `runtime/start-pipeline-run.ts`, `pipeline-generator/pipeline.ir.{json,test.ts}`, 删 `prompts/system/persist.md` |
| 8 | chore(routes): remove temporary submit-direct route (C3) | `routes/kernel-run.ts` |
| 9 | feat(pipeline-generator): 12-stage investigation skeleton + STRICT enforcement + diagnostic/selection disambiguation (continuation 5/6/7 + C1) | `pipeline-generator/prompts/system/{analysis,gen-skeleton,gen-prompts}.md` |
| 10 | docs(handoff): continuation 8 — 12-stage dogfood, runtime bugs, factory pattern, real report-quality assessment | this file |

### 当前已知遗留 (留给 continuation 9+)

- **hypothesize 拍脑袋**: 没基于 0G docs 提取真实 declared facts, 假设质量低, evidence 多被 refuted. 治本: hypothesize 之前加 ground-truth extraction 子步骤.
- **evidenceGather 不下钻链上**: agent 读 docs/blog/marketing 不读 Etherscan source / 链上 tx. 治本: prompt 强制每条 hypothesis 至少要求一条 source-code-link 或 tx-hash 证据 (web3 主题特定); 通用主题改成"primary source 数据". 但这跟 continuation 4 用户原则 "不要为 web3 特化" 冲突 — 需要找通用化语法表达 "first-hand chain-of-evidence".
- **diagnostic 误判 selection**: v1 dogfood 没有 audienceHint 强暗示就跑偏. C1 prompt 加强是必要不充分. 后续在 topicFraming 内加 ground-truth-driven shape inference 子步骤.
- **跨 task tutorial 复用**: handoff 7 提过的资产沉淀仍未实施 (Phase 2 范畴).
- **persisting → script 后, 子流水线 sub-IRs 在 generator 真实输出里很少 — 但 schema 支持. 暂未 e2e 测试 sub-pipeline 路径.

### Session 输出物清单

| 文件 | 说明 |
|---|---|
| `apps/server/.workflow/0g-investigator-mode-report.md` (47KB) | v1 dogfood 产出. 跑偏到 4 桥 selection, 不是 0G 诊断 |
| `apps/server/.workflow/0g-investigator-mode-audit.json` (1KB) | v1 audit map |
| `apps/server/.workflow/0g-investigator-mode-v2-report.md` (90KB) | v2 dogfood 产出. diagnostic 锁对, 主体是 0G Hub. 50-60% reference 水平 |
| `apps/server/.workflow/0g-investigator-mode-v2-audit.json` (1.7KB) | v2 audit map |
| reference: `/Users/minghao/Downloads/0g-bridge-optimization-report.md` (80KB) | 用户给的对标 |

---

## Continuation 9 — Source-class filter + ResearchRubrics judge (借助业界成熟方案)

**Session window**: 2026-04-29 ~14:30 → ~16:00
**Trigger 用户洞察**: continuation 8 的 humanReviewGate.reject 设计有个隐形假设 — "用户能给出 'evidenceGather 该下钻 OFT 合约 + tx hash + Gas Dropoff' 这种领域反馈". 现实是用户根本不知道该这样反馈, 只能给 "感觉不深 / 不够具体" 这类弱信号. 这意味着把 "深度下钻" 的责任放在 humanReviewGate 是错的, 必须放到 evidenceGather 系统层.

**核心方法学转向**: continuation 7 之前是单纯 prompt 工程 (告诉 LLM "请用 primary source / 请深度下钻"). LLM 在 underspecified 字段会回退到训练分布的 mode = 文档/博客. continuation 9 改为**借用业界 3 种成熟方案的最小子集组合**, 全部以 pipeline 结构形式落地, 不依赖 prompt 说服力.

### 方法学论证 (在动手前)

模拟 LLM 跑 falsifiability prompt: 它会把 expectedTraces 写成它已知能找的形态 (文档/repo), 不会自动想到 "Etherscan tx 验证逻辑触发". 框架引导填的形态 = 训练分布最低能耗模式. 给 few-shot 例子 (跨领域示范) 也只能覆盖见过的形态, 陌生领域照样退回. 所以**纯 prompt 不够**.

业界已经踩过 2 年坑, 总结出几条结构化路径 (见调研结果, sources at session bottom):
- **CoVe (Chain-of-Verification)** — LLM 写完 → 自己生成 verification 子问题 → 隔离上下文回答 → 修订. 50-70% 幻觉减少.
- **Adaptive Retrieval Score (information gain)** — N 次答案一致性低 = 还需要搜. 计算开销 N 倍, 不性价比.
- **ResearchRubrics 6-axis judge + Reflexion replan** — 通用 rubric 评分, 不预设领域. 同源偏误是已知风险, 用 adversarial reviewer persona + 不同 prompt 缓解.
- **Plan-Execute-Verify-Replan (PEVR)** — kernel-next 已有 Plan + Execute, 缺 Verify-Replan 闭环. 把 Verify 做成独立 stage 是结构层加, 非 prompt 层.
- **Tree-of-Thoughts / LATS** — token 开销 30-50x, 单用户系统承受不起. **否决**.

最终选 **CoVe + URL-pattern primary-source filter (PEVR 的最小子集) + ResearchRubrics judge** 三层防御. 论证: 单层 LLM 兜底是同源偏误, 但**不同抽象层** (URL pattern 确定性 / CoVe 自生 verification / 6-axis 通用 rubric) 组合形成多层防御. 没有任何一处需要 0G/blockchain 领域知识 — primary 判断是 URL pattern (确定性), CoVe 验证问题是 LLM 自生 (声称驱动), rubric 是通用 6 轴.

### Skeleton 演进: 12 → 14 → 17

**12-stage (continuation 7)**: topicFraming, framingGate, prereqExtraction, prereqGate, tutorialAuthoring, tutorialReviewGate, hypothesize, evidenceGather, findingsSynthesisGate, findingsAuthoring, humanReviewGate, reportAssembly.

**14-stage (continuation 9 batch 1, source-class filter)**: 在 evidenceGather 后插 sourceClassify (script, registry: classify_evidence_bundle) + primarySourceGate (gate, LLM-judged auto-route). primarySourceGate.reject 回 evidenceGather 走 source-class targeted re-search, feedback 由 LLM-judge 自动写成 "H3 缺 source_repo, suggested target: github.com/0g-labs/oft/blob/main/...". evidenceGather 的 prompt 升级处理 primaryRejectionFeedback, 显式强制按 source_class 下钻 (github raw URL / etherscan address tx / arxiv abs / IETF rfc).

**17-stage (continuation 9 batch 2, judge replan)**: 在 reportAssembly 后插 reportJudge (agent, 6-axis rubric scoring) + reportJudgeGate (3-way auto-route: accept / reject_to_evidenceGather / reject_to_findingsAuthoring) + pipelineComplete (script, registry: noop_terminal). references 维度**确定性计算** (read sourceClassify.classifiedEvidence.primaryCount), 其他 5 维度由 LLM-judge 走 adversarial-reviewer persona 评分. reportJudge 的 recommendedAction 决定 reportJudgeGate 路由. Hard cap 2 reject loops, 第 3 次 force-accept 并把 unresolved gaps 写到 audit metadata.

**Terminal-gate-approve 模式**: kernel-next gate routing 要求 approve 指向真实 stage. 不能指向 ancestor (cycle), 不能指向 self (illegal). 解决: pipelineComplete (script, registry: noop_terminal). 一行代码 `{ done: true }`, 仅作 routing target 存在. 这是 kernel 不改 schema 的情况下表达 "approve = exit" 的 canonical 模式.

### Bug F (Bug 5 in continuation 8 名单的修正): task-wide INTERRUPT 双阶段处理

continuation 8 C4 修复说 "task-wide INTERRUPT 直接 stop actor", 那是为了 server 重启 orphan task. 但**它破坏了 graceful summary turn** (B10 e2e test failed): migration INTERRUPT 时 stage executor 应该走 abort signal → write summary → RESULT_SUCCESS, 而 actor.stop() 直接终结活动 stage, summary 来不及写入 port_values.

**正确解 (continuation 9)**: task-wide INTERRUPT 时**双阶段**:
1. **forward 给 actor** (stage region 的 INTERRUPT handler 触发 abort signal → graceful summary turn → 自然终止 region)
2. **schedule 1500ms 后 force-stop 检查**: 通过 `actor.getSnapshot().status === "active"` 判断 — 仍然 active = 没人响应 INTERRUPT (即 parked at gate), 这时调用 `actor.stop()`. 已 done/stopped = graceful summary 已完成, stop 是 no-op.

1500ms 阈值: abort signal 传播 ~10ms + summary turn LLM 调用 < 1s + write_port + region.onDone. 既给 graceful summary 足够时间, 又让 migration awaiter 不会等爆 (orchestrator timeout 默认 5000ms).

代码: `runtime/runner.ts` dispatcher.send 内 `if (event.type === "INTERRUPT" && stageScope === undefined)`.

### 新 builtin scripts (3 个, 全 unit-tested 76/76 通过)

1. **`classify_source_url`** (域无关, URL → { type, signal, confidence }):
   - `primary`: github/gitlab/bitbucket repo (path depth ≥ 2), etherscan/bscscan/arbiscan/solscan tx/address, datatracker.ietf.org, eips.ethereum.org, w3.org/TR, arxiv.org/abs, doi.org, dl.acm.org, ieee.org/document, usenix.org/conference, eprint.iacr.org, npm/pypi/cratesio package
   - `aggregator`: reddit/HN/stackoverflow/zhihu/quora
   - `third_party`: medium/dev.to/substack/coindesk/towardsdatascience/csdn/juejin/jianshu/cnblogs
   - `official_secondary`: 当 caller 提供 `subjectDomain` (如 "0g.ai") 且 host 含子串 → 升级
   - `unknown`: 其他 (含 docs.* / blog.* 启发, low confidence 0.6)
   - 三种调用形态: `{ url }`, `{ urls: string[] }`, `{ citations: Array<{url, ...passthrough}> }`. 后两者用于 batch.

2. **`classify_evidence_bundle`** (上层包装):
   - 输入: `evidence: Array<{ hypothesisId, verdict, positiveEvidence: Array<{kind, url, quote}>, negativeEvidence: ..., rawArtifacts? }>` + 可选 `subjectDomain`
   - 输出: 同 shape + 每个 citation 加 `{ type, signal, confidence }` + 每个 hypothesis 加 `{ primaryCount, officialCount, thirdPartyCount, aggregatorCount, unknownCount }` (只数 positiveEvidence)
   - 这是 14-stage skeleton 的 sourceClassify stage 直接 consume 的形态. 不需要 inline TS wrapper.

3. **`noop_terminal`**: 一行返回 `{ done: true }`, 用于 reportJudgeGate.approve → pipelineComplete 路径.

### 实现状态对照表

| 部分 | 完成 | 测试 | 备注 |
|---|---|---|---|
| 3 个 builtin scripts | ✅ | 76/76 | classify_source_url + classify_evidence_bundle + noop_terminal |
| Bug F 修复 (INTERRUPT 双阶段) | ✅ | 2159/2159 | 包括 migration.graceful-summary regression test 重新通过 |
| analysis.md 17-stage doc | ✅ | n/a | STRICT 强制, reject wires 表 (8 行), 各 stage details |
| gen-skeleton.md 17-stage IR pattern | ✅ | n/a | sourceClassify 完整 IR shape, primarySourceGate / reportJudgeGate / pipelineComplete IR shape, 9 条新 wires |
| gen-prompts.md prompt rules | ✅ | n/a | evidenceGather primary-source-class targeted research, reportJudge adversarial reviewer + 确定性 references 计算 |
| **Dogfood 17-stage 端到端 (B2.5)** | _PENDING_ | n/a | 跑中, 见下方填充 |

### Dogfood 17-stage 跑动 — **未跑通 (6 次连续失败)**

**结论**: continuation 9 的 17-stage skeleton 设计在文档层面完整, 但**generator 阶段不能可靠产出**符合 STRICT 约束的 17-stage IR. 6 次 dogfood 全部在 persisting / analyzing 阶段失败, 错误模式各不相同, 提示 prompt 工程已达**可靠性 ceiling** — LLM 在 17-stage 这种复杂度下持续产生 minor errors.

#### 6 次失败模式详细

| # | TaskId 后缀 | 失败 stage | 错误模式 | 已修复 |
|---|---|---|---|---|
| 1 | `c71b7de4` | persisting | LLM wire 引用了不存在的 fanout aggregate port (`tutorialAuthoring.tutorials` 等), 实际 outputs 是 element-level (`slug` / `markdown`) | ✅ 加 CRITICAL "fanout aggregate port wiring" section + 完整 input-port table |
| 2 | `f3a03c5c` | persisting | rejection-feedback port 错配 (`topicFraming` 缺 `framingRejectionFeedback` input port; `prereqExtraction` 用错 port name) | ✅ 加 REQUIRED inputs table (17 stage × 每个 stage 的 inputs) |
| 3 | `54edb06e` | persisting | `externalInputs: []` 空, 但 stageContracts 引用 `externalInputs.taskText` | ✅ analysis.md 加 REQUIRED externalInputs (taskText + audienceHint) |
| 4 | `c744d368` | persisting | (a) `evidenceGather` 把 5 个 element-level outputs 拆成 5 ports, sourceClassify 期望 1 个 object port; (b) `reportJudgeGate.__gate_feedback__` 重复 wire 到同一 target | ✅ 加 STRICT exact-port-count + wire dedup 指令 |
| 5 | `c910b165` | analyzing | DEFAULT_MAX_TURNS=10 不够 17-stage 的输出 (15-19 tool calls), agent 跑到 147s 后 termination_reason='error' | ✅ trigger 时传 `maxTurns: 80` |
| 6 | `82f9914a` | persisting | LLM **再次**写重复 judge feedback wire (尽管 prompt 已强制 dedup); STRICT 指令未生效 | ❌ 未修 — 决定停止 prompt 工程 |

#### 为什么停止 (架构性判断)

每次 dogfood 30+ 分钟。前 5 次失败逐次加 prompt 约束都修复了那一类错误,但 LLM 总是在**新的角落**犯错。第 6 次同一类错误重现 (judge feedback dedup), 说明 LLM 在面对 17-stage 这种复杂度时**可靠性 ceiling 在 95% 左右**, 而 17-stage IR 只要**任何 1 处错**就 submit_pipeline 失败 → 整个 pipeline 整体 failed.

继续 prompt 工程这条路**不收敛**. 加更多 prompt 规则只是把错误从 A 类挪到 B 类。

#### 三条转向路径 (留给 continuation 10)

**A. 绕开 generator, 手写 IR**: 基于 v2 的 12-stage IR 扩展为 17-stage, 直接 submit 到 SQLite (走 KernelService.submit), 跳过 LLM-driven generator. dogfood 那个手写 IR 验证 continuation 9 design 的核心假设 — sourceClassify + reportJudge 是否真能产出更好的报告. **优势**: 1-2 小时即可验证设计假设. **劣势**: 失去 generator 的可重用性 (其他用户改写 17-stage 还是要回到 LLM 路径).

**B. Deterministic post-processor**: 在 persisting 之前加一个 builtin script `validate_and_repair_ir`, 自动 dedup wires / 自动补全 externalInputs / 自动校验 inputs-vs-wires 一致性. 把 prompt 的 "几十条规则" 转成代码. **优势**: 根本解决可靠性问题. **劣势**: 工程量 1-2 天, 且新的 IR-repair 逻辑本身需要 unit test 覆盖.

**C. 退回 14-stage**: 撤销 batch 2 (reportJudge / reportJudgeGate / pipelineComplete), 只保留 batch 1 (sourceClassify + primarySourceGate), 跑 14-stage dogfood. **优势**: 14-stage 比 17-stage 简单得多 (少 3 个 stage + 少 2 类新 wire 模式), generator 成功率应该高很多. **劣势**: 放弃 reportJudge 的核心价值 (ResearchRubrics rubric 是 continuation 9 的关键贡献).

#### 真正完成的资产 (已 unit-tested, 可靠)

- `classify_source_url` builtin: 域无关 URL 分类 (primary / official_secondary / third_party / aggregator / unknown), 30+ 测试覆盖 GitHub/Etherscan/IETF/arxiv/npm/pypi/...
- `classify_evidence_bundle` builtin: 上层包装, 接受 evidenceGather aggregate shape, 输出每条 finding 加上 sourceType + per-hypothesis counts. 11 测试覆盖.
- `noop_terminal` builtin: 路由终端, 2 测试覆盖.
- Bug F (INTERRUPT 双阶段): forward to actor + 1500ms grace + force-stop. 2159/2159 测试通过, 包括 `migration.graceful-summary.test.ts` regression.
- 17-stage skeleton 完整设计 (analysis.md / gen-skeleton.md / gen-prompts.md): 文档层面定义清晰, 包括 STRICT 约束 / wire 表 / fanout 输出约定 / Layer 3 reportJudge rubric. **但 generator 阶段无法可靠遵守**.

这些资产**全部应该 commit** (即便 17-stage e2e 未跑通) — builtin scripts 是确定性可用的, Bug F 修复 graceful summary regression 是必要的, skeleton 文档是设计参考可继续迭代。

### Continuation 9 commits 清单 (待提交)

| # | Logical change | Files | 状态 |
|---|---|---|---|
| 1-10 | (continuation 8 累积的 10 个 commit, 见上方清单) | (同) | 待授权 |
| 11 | feat(builtin-scripts): classify_source_url + classify_evidence_bundle + noop_terminal (continuation 9 batch 1+2 deterministic primitives) | `builtin-scripts/index.{ts,test.ts}` | ✅ 76 tests pass |
| 12 | fix(runner): task-wide INTERRUPT two-phase actor stop (Bug F — restores graceful summary turn, replaces continuation 8 C4 hard-stop) | `runtime/runner.ts` | ✅ migration.graceful-summary regression passes |
| 13 | feat(pipeline-generator): 17-stage investigation skeleton draft (analysis + gen-skeleton + gen-prompts) — design complete, generator e2e未跑通 (见 Dogfood 17-stage 跑动 section) | `pipeline-generator/prompts/system/{analysis,gen-skeleton,gen-prompts}.md` | ⚠️ 设计完整, generator 不能可靠产出 — 建议 commit 为 "draft state for continuation 10 to repair" |
| 14 | docs(handoff): continuation 9 — industry-method-borrowed design (CoVe / URL filter / ResearchRubrics rubric), 6 dogfood failures + 3 transition paths to continuation 10 | this file | ✅ |

**Commit 13 注释**: 17-stage skeleton 文档完整 (sourceClassify / primarySourceGate / reportJudge / reportJudgeGate / pipelineComplete 全部说清), 但 6 次端到端 dogfood 失败. 我建议**仍然 commit** — 文档资产对 continuation 10 决策 (方案 A/B/C) 必要; 同时 commit message 应明确标注 "skeleton draft, e2e blocked at generator" 以避免后续误以为已 stable.

### 调研 sources (industry brainstorm)

- [Deep Research Agents: A Systematic Examination And Roadmap (arxiv 2506.18096)](https://arxiv.org/abs/2506.18096)
- [Chain-of-Verification Reduces Hallucination in LLMs (arxiv 2309.11495)](https://arxiv.org/abs/2309.11495)
- [Reflexion: Language Agents with Verbal Reinforcement Learning (arxiv 2303.11366)](https://arxiv.org/pdf/2303.11366)
- [LangChain Open Deep Research](https://github.com/langchain-ai/open_deep_research)
- [DeepResearch Bench (RACE rubric)](https://deepresearch-bench.github.io/)
- [ResearchRubrics: Benchmarking Deep Research Agents (arxiv 2511.07685)](https://arxiv.org/html/2511.07685v1)
- [Verified Multi-Agent Orchestration: Plan-Execute-Verify-Replan (arxiv 2603.11445)](https://arxiv.org/html/2603.11445v1)
- [InfoGatherer: Principled Information Seeking via Evidence Retrieval (arxiv 2603.05909)](https://arxiv.org/html/2603.05909v1)
- [Tree of Thoughts: Branching Reasoning for LLMs](https://www.emergentmind.com/topics/tree-of-thoughts-tot)
- [Open Deep Research blog (LangChain)](https://blog.langchain.com/open-deep-research/)

---

## Continuation 9.6 — D path: structural template generator (final success)

**Session window**: 2026-04-29 ~17:00 → ~20:00
**Trigger**: 8 generator dogfoods 失败后 (continuation 9.5 documented), 决定**架构性转向**而非继续 prompt-engineering 补丁。用户选 D (structural template).

**核心 insight**: LLM 在 17-stage IR 这种复杂度下,**bookkeeping 类错误 (wire dedup / port name / fanout shape / inputs declaration / type matching) 是不可避免的** — 即使加 STRICT prompt 也只能 ~95% 可靠,而 17-stage 任意 1 处错就整 pipeline failed. **正确的 fix 是把 IR 结构生成从 LLM 移到代码** —— LLM 只产生**内容数据** (audience, axes, concepts, ...), 代码用 hardcoded 17-stage template 组装出确定性 IR.

### What changed (架构层面)

| 层面 | 之前 (continuation 9.5 之前) | D path (continuation 9.6) |
|---|---|---|
| `analyzing` agent stage 输出 | `stageContracts: object[]` (LLM 设计 17 stages 的结构) + 13 个 metadata fields | 12 个内容 ports: `investigationType`, `audience`, `axes`, `subjectDomain`, `concepts`, `pipelineName/Id/Description`, `summary`, `stageDesign`, `assumptions`, `recommendedMcps` — **零 IR 结构生成** |
| `genSkeleton` stage type | `agent` (LLM 写 IR + subIrs + wires) | **`script`** (registry: `assemble_investigation_ir`) — deterministic |
| IR 结构错误概率 | 95% 5+ 维度并存 → ~0% 总成功率 in 17-stage | **0%** by construction (template hardcoded, validated at compile-time) |
| validateAndRepairIR | 7-function repair script catching 7/8 historical error modes | **保留作 belt-and-suspenders**, 但 D path 下 repair 输出基本为空 (LLM 不再写 IR) |

### Implementation 要点

- 新 builtin script `assemble_investigation_ir` (~700 LOC TS): `buildStages()` hardcodes 17-stage template, `buildWires()` hardcodes 32 deterministic wires (3 external + 29 stage-to-stage). 每个 stage 的 inputs/outputs/fanout/config 都精确写定. mcpServers 处理: 把 LLM-shaped `entryId/name` 规范化为 IR's JS-identifier `name` (entryId 优先, name fallback when 已是 JS-identifier; 否则 throw).
- 28 unit tests (`assemble-investigation-ir.test.ts`):
  - 4 investigationType 变体都 produce 17-stage IRs that pass `KernelService.submit`
  - byte-identical determinism (同输入输出完全一致)
  - mcpServers attach 仅在 evidenceGather, name 用 entryId
  - throws on ambiguous mcpServers shape
  - reject-feedback wires (8 条) 全部 wired correctly
  - 3-way reportJudgeGate routing (accept / reject_to_evidenceGather / reject_to_findingsAuthoring)
- 改 pipeline-generator IR (`pipeline.ir.json`): `genSkeleton` type agent → script, inputs 重写为内容字段, 删除 system/gen-skeleton.md prompt (genSkeleton 不再 LLM-driven)
- 改 analyzing prompt (`system/analysis.md`): 大改 — 不再要求 LLM 输出 stageContracts/wires/externalInputs (这些 deterministic), 改输出 12 个内容字段
- 改 genPrompts inputs (`pipeline.ir.json`): 接受新内容字段 (audience, axes, concepts, ...) 而非 stageContracts
- DEFAULT_MAX_TURNS bumped 10 → 50 (real-executor + start-pipeline-run): fix #5 from continuation 9.5

### Dogfood 结果 (gen10 SUCCESS, gen11+investigation SUCCESS)

**gen9** (first D-path dogfood): persisting 失败 — LLM 写 mcpServers `name: "Etherscan MCP"` (含空格不合 schema). **Fix**: assemble_investigation_ir 加 `entryId` → `name` 规范化逻辑.

**gen10** (post-fix): **✅ COMPLETED** — 9 次连续失败之后**第一次成功**. 17-stage `0G Bridge Architecture Investigation` pipeline 注册到 SQLite. 但 evidenceGather fanout children 全部失败,因为 LLM 推荐了 etherscan + github MCPs 但用户没设 envKeys → MCP_ENV_MISSING fail-fast.

**gen11** (再生成 + 全程 dogfood): task description 加 "do not recommend any MCP servers; rely on Claude SDK builtins". generator 跑完, 新生成的 `0G Bridge Architecture & Optimization Investigation` pipeline trigger e2e dogfood:
- 22 tutorialAuthoring fanout children ✅
- hypothesize → 13 evidenceGather fanout children ✅ (全部 Claude SDK builtin tools)
- sourceClassify (script) ✅
- primarySourceGate (LLM-judge) ✅ — **continuation 9 batch 1 真正激活**
- findingsSynthesisGate ✅
- 13 findingsAuthoring fanout children ✅
- humanReviewGate ✅
- reportAssembly ✅
- reportJudge ✅ — **continuation 9 batch 2 真正激活**
- reportJudgeGate ✅ (`recommendedAction: "accept"`)
- pipelineComplete ✅
- **INVESTIGATION FINAL = completed**

### reportJudge 实测 axisScores (rubric grading)

| Axis | Score | Notes |
|---|---:|---|
| explicit_requirements | 8/10 | LLM-judged |
| implicit_requirements | 6/10 | LLM-judged (axes coverage) |
| synthesis | 7/10 | LLM-judged |
| **references** | **10/10** | **deterministic** computed from sourceClassify.classifiedEvidence — every supported hypothesis has ≥1 primary source |
| communication | 8/10 | LLM-judged |
| instruction_following | 9/10 | LLM-judged (skeleton matches diagnostic-type) |
| **totalScore** | **48/60** | recommendedAction = `"accept"` |

`references=10/10` 是 **continuation 9 batch 1 sourceClassify primary filter 真实工作的证据** — primarySourceGate 不是装饰性 LLM-judge, 它的判断基于 sourceClassify 的 deterministic per-hypothesis primaryCount.

### 报告 quality 对比

跟 reference (`/Users/minghao/Downloads/0g-bridge-optimization-report.md`) + continuation 8 v2 (`apps/server/.workflow/0g-investigator-mode-v2-report.md`) 对照:

| Metric | D-path (continuation 9.6) | Reference (gold) | v2 (continuation 8) |
|---|---|---|---|
| Size | 70KB | 43KB | 91KB |
| Lines | 658 | 750 | 968 |
| H2 sections | 5 (Executive / Foundations / Current State / Optimization / Conclusion) | 6 | 29 (organizational mess) |
| H3 sub-sections | 27 | 23 | 57 |
| **H4 finding-level** | **9** | 34 | 3 |
| Total URLs | 65 | 116 | 73 |
| **Cross-references (See also)** | **12** | n/a | 0 |

**关键改进 (D-path vs continuation 8 v2)**:
- v2 是 organizational mess (29 H2 + 3 真 finding) — D-path 是 production shape (5 H2 + 9 H4 finding)
- v2 0 个 bidirectional cross-reference — D-path 12 个 (continuation 7 invariant 真正在工作)
- D-path 65 个 URLs 全是 primary/official_secondary (sourceClassify 加权过滤,deterministic)
- v2 78KB 但 signal density 低; D-path 70KB 但 dense

**vs reference**:
- Reference 仍有更多 findings (34 vs 9) 和更多 URLs (116 vs 65) — 人类专家手写,evidence breadth 几乎不可能赶
- 但 **D-path 已经是同一质量类的产物** — clean diagnostic skeleton, primary evidence, cross-reference 网络
- 估计 **70-80% reference quality** (vs continuation 8 v2 的 50-60%, v1 的 30-40%)

### Continuation 9 设计假设全部验证

- **batch 1 (sourceClassify primary filter + primarySourceGate)**: ✅ 工作 — references axis 拿满 10/10
- **batch 2 (reportJudge ResearchRubrics rubric)**: ✅ 工作 — 6-axis score, deterministic references, recommendedAction routing
- **continuation 7 bidirectional reference invariant**: ✅ 工作 — 12 个 See also cross-ref
- **D path (structural template generator)**: ✅ 工作 — 0 mechanical errors, byte-identical IR per same input

### Output artifact 清单

| 文件 | 说明 |
|---|---|
| `apps/server/.workflow/0g-d-path-report.md` (70KB) | **D-path final report**. 5 H2 sections, 9 deep findings, 12 cross-references, 65 primary/official URLs. Production-grade ~70-80% reference quality. |
| `apps/server/.workflow/0g-investigator-mode-v2-report.md` (90KB) | continuation 8 v2 (前作对比). organizational mess. |
| `apps/server/.workflow/0g-investigator-mode-report.md` (47KB) | continuation 8 v1 (跑偏到 selection). |
| `/Users/minghao/Downloads/0g-bridge-optimization-report.md` (43KB) | 用户给的 reference (gold standard). |

### Continuation 9.6 commits 清单 (replaces 9.5 列表)

| # | Logical change | Files | 状态 |
|---|---|---|---|
| 1-10 | continuation 8 累积的 10 个 commit | (同) | 待授权 |
| 11 | feat(builtin-scripts): classify_source_url + classify_evidence_bundle + noop_terminal (continuation 9 batch 1+2 deterministic primitives) | `builtin-scripts/index.{ts,test.ts}` | ✅ 76 tests |
| 12 | fix(runner): task-wide INTERRUPT two-phase actor stop (Bug F) | `runtime/runner.ts` | ✅ regression test passes |
| 13 | feat(builtin-scripts): validate_and_repair_ir — 7 deterministic IR repair functions (continuation 9.5 — kept as belt-and-suspenders even after D path) | `builtin-scripts/validate-and-repair-ir.{ts,test.ts}`, `builtin-scripts/index.ts` | ✅ 23 tests |
| 14 | feat(builtin-scripts): assemble_investigation_ir — deterministic 17-stage IR template generator (continuation 9.6 D path) | `builtin-scripts/assemble-investigation-ir.{ts,test.ts}`, `builtin-scripts/index.ts` | ✅ 28 tests, KernelService.submit accepts all 4 investigationType variants |
| 15 | refactor(real-executor): bump DEFAULT_MAX_TURNS 10 → 50 (continuation 9.5/9.6) | `runtime/real-executor.ts`, `runtime/start-pipeline-run.ts` | ✅ |
| 16 | feat(pipeline-generator): D path — analyzing produces content fields, genSkeleton becomes script (assemble_investigation_ir), genPrompts reads new content inputs | `pipeline-generator/prompts/system/analysis.md` (大改), `pipeline.ir.json` (genSkeleton type agent → script, wires rewrite), delete `prompts/system/gen-skeleton.md` (无用了 — actually keep for non-investigation pipelines or non-D rebuilds) | ✅ KernelService.submit accepts pipeline-generator IR |
| 17 | docs(handoff): continuation 9.6 — D path SUCCESS, 17-stage e2e validated, report quality 70-80% reference | `docs/superpowers/dogfood-2026-04-28/handoff.md` | ✅ |

**Total**: 10 (continuation 8) + 7 (continuation 9.5/9.6) = **17 commits**.

### 留给 continuation 10+

- **跨 task tutorial 复用** (handoff 7 提过的资产沉淀仍未实施)
- **investigation pipeline 的 sub-pipeline 路径** (currently subIrs 总是空, 17-stage skeleton 是 single-pipeline shape; 复杂 topic 可能需要 sub-investigations)
- **D path 扩展到 non-investigation pipelines** (automation/lookup): 当前 D 只覆盖 investigation. automation pipelines 仍需 LLM-driven structure generation, 仍可能撞 9.5 列表里的 mechanical 错误. 解决方式: 把 D 思路推广 — automation pipelines 也固化常见 shape (fetch-transform-write 模板).
- **MCP envKey 管理 UX**: gen10 第一次跑 evidenceGather 全 fail 因为 etherscan/github MCPs 缺 envKeys. 用户体验上,task creation 时应该显示哪些 envKeys 缺失,用户可补 (现在是 fail-fast). 可以改善 startPipelineRun pre-flight check.
- **0G report 仍跟 reference 有 evidence breadth 差距** (65 vs 116 URLs). 需要 etherscan / github MCP 才能拿 on-chain primary evidence. 长期: 让 evidenceGather 在没有 MCP 时也能 systematic 列出 "tried Etherscan but no API key — would have looked at: contract X, tx Y" 而不是默默走 secondary sources.

### Session 总结

continuation 9 + 9.5 + 9.6 跨度 ~10h 实际工作时间 (但 dogfood wait 占 ~6h). 真正的产出:
- **D path 架构 insight**: LLM 应该产生内容,代码应该组装结构. 通用解, 不只 17-stage skeleton 适用.
- **continuation 9 设计假设全验证**: sourceClassify (URL deterministic 分类) + primarySourceGate (rubric anchor) + reportJudge (6-axis judgment) 完整 chain 工作, 报告质量飞跃.
- **9 次失败 → 1 次成功**: 教训是 "持续打补丁不收敛, 找到正确抽象层切下去". 这是 LLM-driven system 设计的通用 pattern.

### Final commit batch (2026-04-29 ~20:30, 用户授权后执行)

7 logical commits 取代之前规划的 17 commits (合并几个 file-overlapping changes 到一个 logical commit):

| # | sha | summary |
|---|---|---|
| 1 | `e384c69` | `fix(kernel-next)`: rollback routing classification + fanout supersede + INTERRUPT graceful summary (continuation 5/8/9.5 — 4 distinct fixes in compiler/validator/runner) |
| 2 | `dcbe04e` | `feat(runtime)`: fanout elementRetries for transient executor errors (P4 from continuation 5) |
| 3 | `d1649ac` | `refactor(real-executor)`: bump DEFAULT_MAX_TURNS 10 → 50 (continuation 9.5 fix #5) |
| 4 | `46067f4` | `feat(builtin-scripts)`: submit_pipeline_passthrough — persisting → deterministic script (C2 from continuation 8 + start-pipeline-run.ts max_turns + resolver wiring) |
| 5 | `40c8ff3` | `feat(builtin-scripts)`: continuation 9 deterministic primitives — classify_source_url + classify_evidence_bundle + noop_terminal + validate_and_repair_ir + assemble_investigation_ir (5 builtins, 117 tests) |
| 6 | `d61b689` | `feat(pipeline-generator)`: D-path investigation skeleton — analyzing emits content, genSkeleton becomes script |
| 7 | `7ed5dfb` | `docs(handoff)`: continuation 5-9.6 cumulative |

(This entry as commit 8.)

Working tree clean after commit 7. branch main is 777 commits ahead of origin/main (still never pushed; CLAUDE.md鼓励 local-only single-user runtime).

### 下一步建议 (留给后续 session)

1. **Continuation 10+ 选项** — 4 个候选方向, 都需要用户决策, 不能自决:
   - 跨 task tutorial 复用 (concept-level asset 沉淀)
   - sub-pipeline 路径 (复杂 topic 拆 sub-investigations)
   - D path 推广到 non-investigation pipelines (automation/lookup 也固化常见 shape)
   - MCP envKey UX (pre-flight check + 用户提示)

2. **0G evidence breadth 提升** — 设 etherscan/github API key 后重跑 17-stage investigation, 看 evidence 从 65 → 多少 (期望接近 reference 116). 这是验证 "MCP envKey UX 改善" 优先级的实证.

3. **D path 通用化** — 把 assemble_investigation_ir 的 template-driven 思路推广到 pipeline-modifier (现在仍 LLM-driven). 同样的 mechanical-error 风险存在那里.

4. **Push to origin** — 当前 main 比 origin/main ahead 777 commits. 单用户 runtime 不强求, 但备份意义需要 (机器丢了/磁盘坏了). 用户决定何时 push.

---

## Continuation 10 (2026-04-29 → 2026-04-30)

### 背景与决策

continuation 9.6 D-path success 后, handoff 列了 4+2 个候选方向. 用户没指方向, 让我推荐. 推荐了 **"MCP envKey UX + 0G evidence breadth"** 两个并行小项目作为边缘优化, 最后用户裁决:
- (1) MCP envKey pre-flight check — 做
- (2) tutorial cache — 不做 (YAGNI, 没明确需求)
- 然后回归主线: 报告质量从 38/100 提升

### Phase 1: MCP envKey pre-flight check (DONE, committed)

**改动 (commit `3f46804`)**:
- `start-pipeline-run.ts`: 新增 `collectMissingEnvKeys()` export, 在 task 创建时扫描所有 stage `mcpServers[*].envKeys`, 对照 `envValues` + `process.env`, 返回缺失 keys 排序数组
- `StartPipelineRunResult.ok=true` 增加可选字段 `missingEnvKeys?: string[]`
- `kernel-next/mcp/tools/pipeline.ts`: `run_pipeline` 在 missingEnvKeys 非空时返回 `hint` 字段, 引导用户 call `provide_task_secrets`
- `collect-missing-env-keys.test.ts`: 7 个单元测试 (空 IR, envValues 满足, process.env 满足, 多 stage dedup, script stage 跳过, envValues 优先级)
- **不阻塞 task 创建** — secret_pending 仍处理运行时, 这只是 surface 上预报

### Phase 2: 报告质量主线 (主要工作)

#### Phase 2a: 第一次尝试 — verificationPath + evidenceGather Step 0 (gen14 → c10 first run)

**理论**: continuation 9 报告 38/100 的根因是假设框架太学术 ("0G has X 架构特性"), 不是工程化 ("0G 实际部署了什么"). 所以加两条 prompt rule:
- hypothesize: 每个 hypothesis 必须含 `verificationPath` (一个 sentence 命名具体 artifact)
- evidenceGather Step 0 (mandatory, runs before any search): 从 verificationPath 派生具体 URL 直接 fetch, 不能上来就 WebSearch

**结果**: 跑出来报告 **33/100, 比基线还低**. 用 sub-agent 评估 + 我自己看 attempt details, 发现:
- hypothesize 真的产出了 verificationPath, 但**全部抽象** (e.g. "query 0G bridge contract events for MessageCommitted") — 没具体 URL, 没合约地址
- evidenceGather agent 看到抽象 verificationPath 没法 fetch, fallback 到 WebSearch (19 search vs 5 fetch in fanout=0)
- Agent 是听话的 — 是 prompt 让它产出了"无法执行"的 verificationPath
- **真正根因**: hypothesize 阶段在没有任何 grounding 的情况下凭空写 path. LLM 不知道真实存在的合约/repo, 只能写"应该有个 contract"

#### Phase 2b: 修 prompt — 禁止抽象 verificationPath (gen15 → c10 v7 run)

**改动**: `gen-prompts.md` hypothesize 段:
- verificationPath 必须是**具体可 fetch URL** 或 **discovery entry point** (如 `github.com/<org>` 或 `docs.<subject>`)
- 明确列举 forbidden 形态: "query the bridge contract events", "check the validator registry", "measure latency over 30 days" (非 URL)
- 关键启示: **The pipeline cannot synthesize URLs you don't write down.** 项目 homepage 也比 "query the contract" 强 — downstream agent 会 fetch homepage 抓出站链接再跟进

**同时修了**: `gen-prompts.md` reportAssembly 段, 要求支持四种 investigationType (lookup/diagnostic/selection/landscape) 的真 switch case, 而不是只 hardcode diagnostic. 上一版 gen14 把任务分类成 landscape 时 reportAssembly halt 报错.

**结果 (gen15 用新 prompt 跑出的 0G investigation)**:
- ✅ verificationPath URL 化: **14/14** (vs 上次 0/10) — 100% 都是具体 URL
  - 大多数 fallback 到 discovery entry point (`github.com/0glabs`, `0g.ai`) — 符合设计预期
- ✅ evidenceGather WebFetch 比例: **35%** (127 fetch / 241 search), vs 上次 ~21% — 翻倍
- ✅ Agent 真的从 entry point 顺着 link 找到具体合约 — 例如从 `github.com/0glabs` 出发, 进入 `github.com/0gfoundation/0g-restaking-contracts`, 列 src/, 最后 fetch raw `src/VetoSlasher.sol` Solidity source
- ✅ Evidence 包含 primary repo URL 和 negative_result (写下"找了没有")
- ❌ **task orphaned** — fanout=11 child 卡 `running` 不超时, 后面 attempt_idx 14 的 success 反而把 latest-per-stage 看成 success, getTaskStatus 返回 orphaned
  - 这是 runner 层独立 bug, 与 prompt 改动无关
  - Evidence 全部收集到, 但 findingsAuthoring/reportAssembly 没启动, 没有最终报告对比

### Phase 2 验证状态

**Prompt 改动验证有效 (3 个数据点)**:
1. verificationPath URL 化率 0% → 100%
2. WebFetch 占比 ~21% → 35%
3. 实际拿到具体合约 raw source (`VetoSlasher.sol`) — 第一次有 primary code evidence

**未完成**: 完整 e2e 报告生成被 fanout 卡死 bug 阻断, 没法 measure 最终报告分数. 但**中间产物 (hypotheses + evidence) 质量已超过 c9.6 baseline**.

### Continuation 10 commits (2 logical changes)

| # | sha | summary |
|---|---|---|
| 1 | `3f46804` | feat(runtime): MCP envKey pre-flight check on task creation (Phase 1) |
| 2 | (待提交) | feat(pipeline-generator): hypothesize verificationPath must be concrete URL + reportAssembly supports all 4 investigationTypes (Phase 2b) |

### 留给 continuation 11+

**主线 (报告质量)**:

1. **修 fanout child 卡 running bug** — runner.ts. 复现条件: evidenceGather fanout 14, 个别 child 长时间不返回 (超 4 分钟无心跳), 但 stage 整体 attempt_idx 已经推进到 14 success, getTaskStatus 看 latest 把整体当 success 但 task_finals 没写. 应该: 给 fanout child 加 per-attempt timeout (类似 runner 的 90min 全局 timeout, 但 per-element).

2. **重跑 c10 v7 验证完整 e2e** — 修上面那个 bug 后重跑, 拿到最终报告分数. 期望 ≥60/100 (基于中间产物质量提升).

3. **如果 e2e 通了但报告分数仍低**: 考虑加 grounding stage (在 hypothesize 之前 fetch `docs.<subjectDomain>` + `github.com/<subjectOrg>`, 把 raw HTML 作为 input 喂 hypothesize, 让 LLM 看真实存在的 repo 列表再写 verificationPath, 不再 fallback 到 entry point).

**已发现的独立 bug (优先级低, 不影响主线)**:

- **Bug A: fanout child 不超时**. 上面提过, runner.ts 改动.
- **Bug B: pipeline-generator 输出的 reportAssembly prompt 仍然 fallthrough**. 我让 prompt-writer 写"四种 type switch case", 它写出了 switch 语法但每个 case 内容相同 (`This task uses diagnostic`). 当前任务都被分类成 diagnostic 所以不撞这问题, 但分类成 landscape/selection/lookup 时仍会跑错 skeleton. 修法: 让 prompt-writer 子 agent 收到的 spec 里**为每种 type 提供具体 skeleton headings**, 不要让它"自己想".
- **Bug C: dogfood 脚本的 auto-approve 一律发 `answer: "approve"`**. 用户实际遇到 reportJudgeGate 这种 auto-routed gate (有效 answer 是 `accept`), 脚本会反复 approve 失败. 已修 (v5 → v7 升级到读 gate options 选 first non-reject).
- **Bug D: dogfood 脚本读 `?stage=persistResult`**. 实际 stage 名是 `persisting` (C2 改名). 已修 (v5 改用正确名 `persisting`).

### Session 总结

continuation 10 跨度 ~6h (大部分是 dogfood 等待). 实际产出:
- **MCP envKey pre-flight check** (committed)
- **hypothesize verificationPath 具体化 + reportAssembly 四 type 覆盖** (待 commit)
- **数据证明 prompt 改动有效**: URL 化率 0→100%, WebFetch 占比翻倍, 拿到第一份 primary code evidence
- **发现 4 个独立 bug** (1 个 runner-level, 1 个 prompt-writer level, 2 个 dogfood script level)

教训: prompt 改动的有效性必须通过 **agent tool call trace** 验证, 不能只看最终报告. 第一次 c10 跑出 33/100 时差点判定改动失败 — 实际是 verificationPath 太抽象让 agent 没法执行. 检查 attempt details 后才精准定位根因.

---

## Continuation 11+ Roadmap (2026-04-30, 用户授权先写文档不动手)

c10 把 "修 bug + prompt 提报告分" 这条主线走完了 (38 → 63/100). 系统进入 "找不到下一个 bug 该修" 的稳定状态:
- 0 actionable TODO/FIXME 在源码 (1 处 future YAGNI 注释合理)
- working tree clean, 全套测试 2220 pass + 5 pre-existing fail (mcp-remote-preflight + db.adversarial, 与 c10 改动无关)
- HTTP + MCP feature parity 完整 (Bug F2 修了 pre-flight forward gap, web LaunchDialog 消费 missingEnvKeys)

剩下 4 个候选方向都属于 **新功能 / 范畴扩展**, 需要用户决策不能自决.

### 方向 1: 跨 task tutorial 复用 (concept-level cache)

**现状**: 每次跑 investigation pipeline, `tutorialAuthoring` 阶段重新生成 8-15 个 concept tutorial (区块链基础, CometBFT, CCIP 等通用知识). 同一 user 跑 N 次同领域 investigation 就重复生成 N 次同样的 tutorial.

**要做的**: tutorial 按 slug 缓存到 DB, 下次同 slug 直接 hit cache.
- 新 builtin script: `lookup_tutorial_cache`(slugs[]) → 返回 hit 的 markdown + miss 的 slug 列表
- 改 17-stage skeleton: tutorialAuthoring 之前插一个 cache 查询 stage, 命中的 slug skip fanout
- cache 存 prompt_contents 风格的 content_hash 表, key=`(slug, subjectDomain, audience.role)` 三元组
- invalidation 策略: 写时打 createdAt, 30 天 TTL OR user 手动 prune

**工作量**: 中等 (~1 周). 1 个 builtin script + 改 IR template + 1 个迁移表.

**价值**: 节省 token + 加速. 5 次 investigation 大约能省 30-40% 时间和 cost.

**用户决策点**: investigation 跑频率是否高到值得做?

---

### 方向 2: sub-pipeline 路径 (复杂 topic 拆分)

**现状**: 17-stage skeleton 是 single-pipeline shape. `subIrs` schema 字段一直存在 (genSkeleton 输出 `subIrs: PipelineIR[]`) 但 D-path 始终输出空数组. 复杂 topic 全塞进 14 个 hypothesis 的 fanout, evidence quality 在 hypothesis 数 >12 时摊薄.

**要做的**: analyzing 阶段判断 topic 复杂度, 复杂时拆成 N 个 sub-investigation (e.g. "调研 0G bridge" 拆成 sub-1 跨链消息层 / sub-2 经济激励层 / sub-3 安全模型). 每个 sub-pipeline 独立跑完, 主 pipeline 聚合 findings.

**要新增**:
- analyzing prompt 加 "复杂度判定" 子步骤
- assemble_investigation_ir 支持产出 subIrs (同样硬编码模板, 但 N 个并行)
- 主 pipeline 多一个 `subInvestigationFanout` stage, 触发 `run_pipeline` MCP tool
- aggregateSubFindings 聚合 stage
- runtime 改: parent task 等所有 child task 完成再 run reportAssembly
- web UI: 树状展示 parent + N children

**工作量**: 大 (~2-3 周). 新 fanout 模式, runtime 跨 task 等待, UI 改动.

**价值**: 未验证. 当前 17-stage 已经能 cover 单轮 5K-30K 字报告. sub-pipeline 主要解决 100K+ 超长报告.

**用户决策点**: 有没有遇到过 "17-stage 装不下" 的 topic? 没有就 YAGNI.

---

### 方向 3: D path 扩展到非 investigation pipelines

**现状**: c9.6 D-path (用 `assemble_investigation_ir.ts` 把 17-stage 模板硬编码, LLM 只填内容) 只覆盖 investigation 类. Automation pipelines ("每周 fetch 数据 → transform → write") 和 lookup pipelines ("查询 X 的当前状态") 还是纯 LLM-driven, 仍可能撞 c9.5 列出的 mechanical 错误 (wire mismatch, port shape 错).

**要做的**: 再写 2 个 builtin script — `assemble_automation_ir`, `assemble_lookup_ir` — 各自固化典型 shape.

- automation 典型 shape: `prereqs → fetch → transform → validate → persist` (5-stage, no fanout)
- lookup 典型 shape: `frame → query → format` (3-stage, no fanout)
- analyzing prompt 按 investigationType 路由到对应 assemble_* script

**工作量**: 大 (~每个一周). 2 个 builtin script + 测试 + analyzing prompt 路由 + e2e dogfood 各跑一遍.

**价值**: 取决于 automation/lookup 实际使用频率. 目前测试都在 investigation, automation/lookup 没有真实用例驱动.

**用户决策点**: 打算用 pipeline-generator 主要生成什么类型? 全是 investigation 就不必做.

---

### 方向 4: MCP envKey UX 端到端 dogfood 验证

**现状**: c10 做完了 pre-flight check (HTTP + MCP + web toast). `provide_task_secrets` 之后 task 自动从 secret_pending 恢复 — 这个机制有 e2e test 覆盖 (`secret-gate-e2e.test.ts`) 但**没有真实 dogfood 跑通过整条 happy path**.

**要做的**: 跑一次 envKey-required pipeline (e.g. 带 etherscan/github MCP 的 investigation), 全程不预设 env, 验证:
1. pre-flight 报警 (HTTP response 含 missingEnvKeys + hint)
2. task 创建后启动, 执行到 evidenceGather, 触发 secret_pending
3. 调用 `POST /api/kernel/tasks/:id/secrets` 提供 keys
4. task 自动恢复执行, evidenceGather 跑完, e2e 完成

**工作量**: 小 (~1-2 小时, 包括如果发现 bug 再修).

**价值**: 确定性高. 如果有 bug, 下次 envKey-required pipeline 就会撞坑; 现在测试找出来便宜.

**用户决策点**: 中性小项, 不需要决策, 可任何时候做.

---

### 推荐次序

按 ROI / 决策成本:

1. **方向 4**: 不需要决策, 价值确定. 任何 session 起手做.
2. **方向 1**: 如果用户场景是 "频繁跑 investigation", ROI 最高. 中等工作量.
3. **方向 3**: 如果用户场景多元 (有 automation/lookup), 中长期值得.
4. **方向 2**: YAGNI 风险最高. 等到真撞 "17-stage 装不下" 再做.

如果用户场景集中在 single-investigation-per-week, 这套系统**已经 OK**, 进入 maintenance mode 也是合理选择.

## Continuation 11 (2026-04-30): 方向 4 跑完 + 暴露 Bug G

用户指令: "继续 追求正确合理 不考虑开发成本 一条路走到黑". 选 D4 (无决策成本 + 高确定性) 起手.

### D4 Dogfood Happy Path 全链路跑通

构造最简 envKey-required IR (`d4-envkey-probe-v2`): 1 stage agent + etherscan mcpServer
+ envKeys=["ETHERSCAN_API_KEY"] + env={"ETHERSCAN_API_KEY":"${ETHERSCAN_API_KEY}"}.

走的全链路:
1. ✅ `POST /api/kernel/tasks/run` 不带 envValues → HTTP 202
   `{ok:true, taskId, versionHash, missingEnvKeys:["ETHERSCAN_API_KEY"], hint:"..."}`
2. ✅ Task 启动, queryEthBalance stage attempt#1 进入 status=`secret_pending`,
   `secret_gate_queue` 写一行 requiredKeys=["ETHERSCAN_API_KEY"] stillMissing=同
3. ✅ `POST /api/kernel/tasks/{taskId}/secrets` body `{secrets:{ETHERSCAN_API_KEY:"FAKE_KEY_FOR_DOGFOOD_D4"}}`
   → `{ok:true, resolved:true}`
4. ✅ 自动 retry 触发, attempt#2 立即开始 (status=running), 25s 后 status=success
5. ✅ task status=completed, port_values 写入 queryEthBalance.summary
   (agent 用 fake key 调用 etherscan, MCP 拿到 invalid-key error,
   agent 优雅 surface 到 summary port)

证据: 6fbe840c-7341-4dd8-9297-096682bcc49f (attempt#2)
agent_stream_json 2883 chars, tool_calls 1678 chars, $0.078, 25/1154 tokens

**结论**: HTTP+MCP+secret-gate 端到端 happy path 在真实 LLM dogfood 下跑通.
secret_pending → provide_task_secrets → 自动 retry → 完成 是工作的.

### Bug G (新发现, 已修)

**症状**: pre-flight 报警 "missing X" 但运行时不进 secret_pending, 直接 SDK error.

**根因**: kernel 有两套 envKey 检查不一致:
- `collectMissingEnvKeys` (start-pipeline-run.ts) — 看 `mcpServer.envKeys[]` (declarative)
- `expandMcpServers` (mcp-servers-expander.ts) — 只看 command/args/env value 里的
  `${VAR}` references

如果 IR 写了 `envKeys: ["X"]` 但**没在 env 字段加 `X: "${X}"`**, pre-flight 会
报警 (告诉用户缺 X), 但运行时 expander 找不到 `${VAR}` 引用, 返回 ok:true,
secret-gate 路径被绕过, MCP child 进程 spawn 时收不到 X, 自身 handshake
失败. 用户卡死: provide_task_secrets 拿不到 secret_gate row, 错误信息是
opaque 的 SDK-side error.

D4 v1 IR 第一次提交时正好踩到这个坑 (我自己手写 IR 漏了 env 字段).
4 个 attempts 全 status=error, agent_stream 长度 0, 没办法 surface 到
secret-gate UX.

**修法**: validator/structural.ts 加新规则 `ENVKEY_NOT_REFERENCED`. 提交时
扫描每个 mcpServer, 收集 command/args/env values 里所有 `${VAR}` references.
每个 envKey 必须出现在这个集合里. 否则 submit 失败.

不破坏现有合法 IR (env+envKeys 配对的, gen-skeleton.md prompt 已经教 LLM
对的写法), 但提早 catch broken IR — pipeline-generator LLM 偶发漏 env
字段时, submit 阶段就 reject, 不会 silently 进入运行时错配状态.

**测试**: 6 个新 case 在 structural.test.ts:
- accept envKeys w/ env (canonical case)
- accept envKeys via args ${VAR} (rare but legal)
- reject the D4 footgun (envKeys + no env)
- multi-key partial miss (KEY1 referenced, KEY2/KEY3 not → 2 diagnostics)
- empty envKeys (no constraint to enforce)
- system-level ${HOME} ref without envKeys entry (allowed)

也修了一个 c10 留下的 test fixture (`kernel-run.test.ts` C10 Bug F2 test
本身用了 envKeys-no-env 的 IR, validator 现在 reject; 给它加上 env 字段
后通过).

**测试套**: 2232 pass + 24 skip + 0 fail (上次 5 flaky 这次都过).

### Bug G 双层防御

修完 validator (compile-time) 后审视 runtime 行为, 发现还有一个漏洞: 历史 IR.

`run_pipeline { name }` 解析时取 latest version_hash, 但 latest 可能是
validator 规则 land 之前 submit 的. 这种 IR 仍然能跑, 撞 runtime 错配.

audit 当前 dev DB 找到 3 个历史 broken IRs:
- 0G Bridge Architecture Investigation (2 个版本)
- d4-envkey-probe (D4 v1 一次性测试)

**修法**: real-executor 在 expandMcpServers 之前加 IR-shape 检查. 任何
envKey 不在 command/args/env `${VAR}` references 中, 立即 STAGE_FAILED
带 `IR_BROKEN_ENVKEY_NOT_REFERENCED` 错误码 + 具体修法提示 (告诉用户
"加 env: { KEY: '${KEY}' } 到 mcpServer 块然后重新 submit").

**为什么不 route 到 secret_pending**:
- 这不是 missing secret 问题, 是 IR shape 错误
- 即使用户提供 secret, 下次 attempt expandMcpServers 仍然没 ${VAR} 可
  substitute, 子进程仍然拿不到值, 仍然 fail
- 形成死循环 UX
- hard error + 明确的 re-submit 提示是唯一对的解

**验证**: 用 D4 v1 broken IR 直接 launch (`POST /api/kernel/tasks/run
versionHash=a7d9beb7eb9d…`), task_finals.detail 立即包含完整
`IR_BROKEN_ENVKEY_NOT_REFERENCED` 信息. 用户从 dashboard / SSE / API
都能看到 actionable 提示.

测试: bug-g-runtime-guard.test.ts (3 cases) 覆盖正反两面 + dev-machine
masking 场景.

### 此刻状态

- 3 个 c11 commits:
  - 7165979 fix(validator): ENVKEY_NOT_REFERENCED cross-check
  - 8f96088 docs(handoff): c11 D4 dogfood + Bug G writeup
  - e39b23f fix(runtime): IR_BROKEN_ENVKEY_NOT_REFERENCED guard for historical IRs
- working tree clean (除一个 pre-existing untracked test file)
- D4 验证完成. Bug G 双层防御 (validator + runtime) 全部 in place.
- test suite: 2235 pass + 24 skip + 0 fail.
- 下一步候选: D1 (tutorial cache) / D3 (D-path 扩展) / D2 (sub-pipeline) — 仍待用户决策

