# Stage 5B — Migration Execution Engine — Handoff

**Status:** Complete 2026-04-24.

**Roadmap:** §7.2-7.6 B8 / B11 / B13 / B19 / B20 (真实执行) 全部落地。

## Delivered

### `hot-update/` 新模块

- `migration-types.ts` — `TerminationReason` (re-exported from task-registry)
  / `PreSupersedeSnapshot` / `MigrationOutcome`
- `wire-reachable.ts` + tests (7) — `computeWireTransitiveReaders(ir, start):
  Set<string>` 纯函数，BFS over wire edges only
- `divergence.ts` + tests (7) — `findEarliestDivergence(baseIR, proposedIR):
  string | null` 基于 5A `computePipelineDiff` + 拓扑排序
- `migration-orchestrator.ts` + tests (5) — `executeMigration(input):
  Promise<MigrationOutcome>` 端到端协调
- `rollback.ts` + tests (3) — `executeRollback(input): Promise<RollbackOutcome>`
  合成 approved proposal + 委托 orchestrator

### `runtime/` 扩展

- `task-registry.ts` + tests (6) — `signalTermination(taskId, reason)` +
  `awaitTermination(taskId, timeoutMs): Promise<TerminationReason>` 基于 Promise
  的终止信号
- `runner.ts` — run-final 时通过 `signalTermination` 报告
  `{kind: natural|interrupted|error}`（含 timeout / INTERRUPT / throw 路径）；
  `RunnerOptions.resumeFrom` 支持从 `stage_attempts.status='success'` 重建
  `persistentFinalizedStages` + `persistentPortValues`（复用 retry 机制）
- `start-pipeline-run.ts` — `resumeFrom` 参数透传到 runPipeline

### `mcp/kernel.ts` 变更

- `KernelServiceOptions.migrationInterruptWaitMsOverride` — test-scope
  INTERRUPT 等待超时覆盖
- `migrateTask(taskId, proposalId): Promise<MigrateTaskResult>` 现为 async，
  委托 `executeMigration`（原 245 行 A8 实现删除）
- `rollbackHotUpdate(input): Promise<...>` 现为 async，委托 `executeRollback`
- 旧 `migrationInProgress` 模块级 Map 删除；lock 内聚到 orchestrator
- `__resetMigrationLocksForTest` 保留（forwards to orchestrator）；
  `__acquireMigrationLockForTest` 改为 throw（旧 API 无法与 orchestrator 语义对齐）

### Diagnostic codes

- `MIGRATION_INTERRUPT_TIMEOUT` — INTERRUPT 后 runner 在 timeout 内未终止
- `MIGRATION_RESUME_FAILED` — supersede 成功但新 runner 启动失败（已反向 supersede）
- `ROLLBACK_EMPTY_DIFF` — rollback 目标与当前 IR 结构一致

### 新 audit diagnostic_json 形状

- `__kind: "migration-executed-v1"` — 成功 migration 的 `hot_update_events.diagnostic_json`：
  `{ supersedeSet: [...], resumeFromStage, interruptWaitMs, terminationReasonKind }`
- `__kind: "migration-failed-v1"` — 失败路径：`{ reason, error?, interruptWaitMs? }`
- `__kind: "rollback-v1"` — `rollbackHotUpdate` 专属 audit：`{ migrationEventId, divergenceStage }`

### MCP surface

无变化。`migrate_task` / `rollback_hot_update` 工具 shape 不变，调用者本就 await
`jsonResponse(...)` 结果。

## Not delivered (显式推迟)

| B 项 | 状态 | 接手 |
|---|---|---|
| B5 SSE `wf.hotUpdatePending` | 本地无 dashboard 紧迫性 | Phase 6 |
| B7 cost/latency 数值预估 | 需历史 metrics | Phase 6 |
| B9 Worktree 切换 + 旧 diff 入 StageMemory | 需 checkpoint infra | 5C / Phase 6 |
| B10 Graceful session 中止（1 轮总结） | AgentMachine summary-turn 状态未加 | 5C |
| B12 Single-session 摘要注入 | 依赖 checkpoint infra | 5C |
| B17 Foreach schema-compat | kernel-next 无 foreach stage | 5D |
| B22 聚合查询 helpers | hot_update_events 数据已有；SQL helpers 待写 | 5E |

## 关键不变量

1. **never_regress**（§1.3）：即使 supersede 后，`port_values` 完整保留；反向
   supersede 通过 `PreSupersedeSnapshot` 按 attemptId 精确恢复 status
2. **per-task migration lock**：进程级 Map，第二个并发 migrate 立即 `MIGRATION_IN_PROGRESS`
3. **audit 完整性**：每次 `executeMigration` / `executeRollback` 必写至少一行
   `hot_update_events`（success / failed / rolled_back）；失败兜底路径也写
4. **5A → 5B 合约**：`proposal-success-v1` 不覆写；5B 新增 `migration-executed-v1` /
   `migration-failed-v1` / `rollback-v1`
5. **runner resume 契约**：`resumeFrom` stage 必须在 IR 中存在，否则 throw
   `RESUME_FROM_NOT_IN_IR`；已 `success` 的 stage 预填进 `persistentFinalizedStages` +
   `persistentPortValues`，新 attempt 带新 versionHash

## 技术观察

1. **resume 映射到 retry 机制**：没另起 "resume mode" 而是复用现有 `isRetryRebuild=true`
   + `CompileOptions.initialContext`。好处：不改 compiler；坏处：不熟悉 retry
   机制的读者初看不直观 —— runner 注释已说明
2. **orchestrator 的 `awaitTermination` 默认 30s**：生产值合理；测试中通过
   `interruptWaitMsOverride` 注入短值
3. **A2.3.5 + migrate-task.test.ts 中 11 个旧测试 skip**：它们测 A8 DB-only 语义
   （migrateTask 仅改 DB 不启动 runner），5B orchestrator 会调 `startPipelineRun`
   启动新 runner，与旧假设不兼容。等价覆盖在 `migration-orchestrator.test.ts`
   的 5 个集成测试（含 mock startRunner）和 `rollback.test.ts` 的 3 个测试

## 下一步推荐

**5E 收尾**（audit 聚合 + 文档 + 老代码清理）最经济：
- B22: 写 `hot_update_events` 聚合 SQL helpers（成功率 / 回滚率 / 每个 pipeline
  被改次数）
- 删除 `apps/server/src/kernel-next/mcp/kernel.ts` 中 _retired* 相关注释
- 5B skipped tests 要么重写成 5B 语义测试，要么删除
- 整体集成测试（submit → propose → autoApprove → migrate_task → rollback_hot_update）

**5C 长尾**（graceful summary turn + worktree + single-session 摘要注入）需要独立
brainstorm：前置依赖 checkpoint infra。A2.3.3 的 INTERRUPT 硬切作为降级兜底已
足够闭环，5C 提升 UX 但不是功能 blocker。
