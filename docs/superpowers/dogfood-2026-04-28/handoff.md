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
