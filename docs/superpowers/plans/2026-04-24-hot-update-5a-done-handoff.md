# Stage 5A — Propose Pipeline Completion — Handoff

**Status:** Complete 2026-04-24.

**Roadmap bucket:** §7.2-7.6 B1/B2/B3/B4/B7/B14/B15/B16/B18/B20(骨架)/B21 落地。

## Delivered

### Module `apps/server/src/kernel-next/hot-update/`

- `types.ts` — 纯类型：`PipelineDiff` / `StageDiff` / `Impact` / `TaskImpact` /
  `SchemaDriftIssue` / `SafeRangeVerdict` / `DryRunInput` / `DryRunResult`
- `diff.ts` + `diff.test.ts` (9 tests) — `computePipelineDiff(base, proposed)`
  纯函数。
- `safe-range.ts` + `safe-range.test.ts` (5 tests) — `classifySafeRange(diff, impact)`
  纯函数：promptOnly / structural / empty 分类。
- `impact.ts` + `impact.test.ts` (5 tests) — `computeImpact(db, currentVersion,
  proposedIR, rerunFrom)` 只读 DB 计算活跃 task + schema drift + resumability。
- `dry-run.ts` + `dry-run.test.ts` (5 tests) — `dryRunProposal(db, input)`
  orchestrator。**零 DB 写入**，返回 `{ ok, diff, impact, safeRange,
  wouldAutoApprove, proposedVersion }`。
- `stage-5a.adversarial.test.ts` (5 tests) — 100 次 dry-run 零 DB 写入 /
  CONFLICT 路径 / 双 autoApprove 并发 / 无效 patch 零残留行 / proposedVersion
  确定性。

### `KernelService` (`mcp/kernel.ts`) 扩展

- `propose(args)` 新增 `autoApprove?: boolean`；内部调用 `dryRunProposal`，把
  结果 `{diff, impact, safeRange}` 写进 `pipeline_proposals.diagnostic_json`
  作 `__kind: "proposal-success-v1"`；autoApprove + safeRange.verdict='safe'
  时同 tx 写 `status='approved'`。
- `dryRunProposal(input)` — 纯转发到 `hot-update/dry-run.ts`。
- `updateRegistryPipeline(input)` — 覆写 `{REGISTRY_ROOT}/{name}/pipeline.ir.json`
  + INSERT `pipeline_versions`。目录缺失返回 `REGISTRY_PIPELINE_NOT_FOUND`。
- `rollbackHotUpdate(input)` — **骨架**：校验 `toVersion` ∈ task 的历史
  `from_version` ∪ `to_version`，写一行 `hot_update_events(status='rolled_back',
  diagnostic_json={__kind:'rollback-skeleton-v1'})`。真实状态回滚（supersede
  stage_attempts + 重启 runner）由 5B 接手。

### MCP 工具注册 (`mcp/server.ts`)

外部 (`external` surface) 新增：
- `dry_run_proposal`
- `update_registry_pipeline`
- `rollback_hot_update`

`propose_pipeline_change` input schema 新增 `autoApprove: boolean` 可选参数。
`server.test.ts` tool-list 断言从 17→20 / 16→19 同步更新。

### Diagnostic codes (`ir/schema.ts`)

新增 3 个：
- `CONFLICT` — baseVersion 缺失
- `VERSION_NOT_IN_HISTORY` — rollback 目标 task 无此版本历史
- `REGISTRY_PIPELINE_NOT_FOUND` — `{REGISTRY_ROOT}/{name}/` 目录不存在

### 文档

- `docs/product-roadmap.md` §7.2-7.6 B1..B22 状态列全部更新；§修订历史 加 v1.5 行。
- `docs/superpowers/specs/2026-04-24-hot-update-5a-propose-pipeline-design.md` —— spec
- `docs/superpowers/plans/2026-04-24-hot-update-5a-propose-pipeline.md` —— plan

## Not delivered (显式推迟)

| B 项 | 原因 | 接手 |
|---|---|---|
| B5 SSE `wf.hotUpdatePending` + UI | 本地单人 CLI 工具无 dashboard 紧迫性 | Phase 6 |
| B7 cost/latency 数值预估 | 需要历史 metrics，无数据基础 | Phase 6 / 5B 之后 |
| B8 同步触发 migration | 需要 5B migration 执行引擎 | 5B |
| B9 Worktree 切换 + 旧 diff 入 StageMemory | 需要 checkpoint infra（roadmap pending） | Phase 6 依赖项 |
| B10 Graceful session 中止 (1 轮总结) | AgentMachine 需加 summary-turn 状态 | 5C |
| B11 不相关 running stage 跑完 | 语义在 A2.3 INTERRUPT 机制已局部体现；完整实现 5C | 5C |
| B12 Single-session 摘要注入 | 依赖 checkpoint infra + tier1 注入机制 | 5C |
| B13 Parallel group 精细粒度 | `migrateTask` 注释自述 "fine-grained parallel migration deferred" | 5D |
| B17 Foreach schema-compat | kernel-next 尚无 foreach stage 类型 | 5D（或 foreach 引入后） |
| B19 Migration 失败完整回滚 | migrate-task 已有 status='failed' 行；完整状态回滚 | 5B |
| B20 真实回滚执行 | 骨架已到位，5B 挂真实逻辑到同一 MCP 表面 | 5B |
| B22 聚合查询 helpers | `hot_update_events` 数据已有，需查询 SQL + CLI | 5E |

## 5B 衔接合约

5B 只需修改 `runtime/` 和 `mcp/kernel.ts` 的 `migrateTask`，无需碰 `hot-update/`：

1. **dryRun 消费**：5B 内部调 `dryRunProposal(db, {...})` 拿 `impact.activeTasks`
   决定哪些 task 需要 graceful interrupt。`impact.activeTasks[].affectedStages`
   是 supersede 目标集合。
2. **autoApprove 语义**：5A 保证 autoApprove 仅在 `safeRange.verdict='safe'`
   时生效；5B 可以把 "approved" 看作 "已经人类/AI 授权"，不再做二次判断。
3. **diagnostic_json shape**：`pipeline_proposals.diagnostic_json` 现在总是
   JSON 且 `__kind='proposal-success-v1'`（成功路径）或无 `__kind` 的错误行
   （失败路径，沿用旧语义）。5B 必须**只读**这些行，不可覆写 diff/impact
   字段（保留完整审计）。
4. **`rollback_hot_update` MCP 形状**：`{ taskId, toVersion, actor } →
   { ok, eventId, diagnostic }`。5B 保持 API shape 不变，替换 body 实现。
5. **`rollback-skeleton-v1` 审计行**：5B 执行真实回滚时写新的 `__kind=
   rollback-v1` 或类似字段；不必清理骨架阶段写下的 rolled_back 行。

## Test counts

- 新增 server-side tests：
  - diff.test.ts: 9
  - safe-range.test.ts: 5
  - impact.test.ts: 5
  - dry-run.test.ts: 5
  - kernel.test.ts additions: 8
  - stage-5a.adversarial.test.ts: 5
  - server.test.ts 断言更新（不增 test 数）
  - 合计：37 new tests
- kernel-next/hot-update 全部 + mcp 全部：154 tests pass 0 fail
- 预期完整 server suite：仍然 1436+ passed 0 failed（Stage 6 baseline + 37）

## 已知的架构观察（非 blocker）

1. **`SchemaDriftIssue` 用严格字符串等价判断 port type**。`"string" → "string | null"`
   会被判为 drift。后续可升级到 TS AST subset 判断，但 5A 先保守。
2. **`classifyStageCategory` 在 portsOnly 分类上保守**：input port 纯增加本
   质上不破坏已完成 stage 的 outputs，但 5A 把它算 structural 以避免过拼图
   的错误自动批准。放宽留给 5B 的 migration plan 阶段。
3. **`propose()` 内部做了一次 `this.validate()`（含 tsc）+ 一次 `dryRun()`
   （含 structural/dag validator）**。结构有 validation 冗余。后续可把
   validation 收敛进 dryRun，但目前行为正确且 tsc 不会 double-run。
4. **`pipelineVersionHash` vs `versionHash` 混用**：propose/dry-run 用
   `versionHash(proposedIR)`（纯 IR），submit 用 `pipelineVersionHash({ir, prompts})`
   （含 prompt 内容）。这是既有语义，5A 保持一致。文档已在 §4 impact.ts
   说明 newSubmissionsOk=true 一律成立的假设。

## 下一步 (5B 启动 checklist)

- 读本 handoff 的 "5B 衔接合约" 段
- 读 `hot-update/dry-run.ts` 确认消费接口
- 读 `mcp/kernel.ts` 中 `migrateTask()` 与 `rollbackHotUpdate()`（后者是骨架 swap point）
- 起草 5B spec（`docs/superpowers/specs/2026-04-24-hot-update-5b-*`）
