# Stage 5E — Hot Update Finalization Design

**Goal:** 收尾 B 系列。提供 `hot_update_events` 聚合查询，清理 11 个 5B
skipped legacy test，补全整体集成测试，更新 roadmap。

**Scope boundary:** 不触及 5C（graceful summary turn / worktree / single-session
摘要注入）。仅对"已落地 5A+5B 成果"做收口。

## 1. B22 聚合查询

### 1.1 新 MCP 工具：`query_hot_update_stats`

**目的**：帮 AI / 运维回答 "哪个 pipeline 被频繁热改？成功率怎样？回滚率？"
这些问题直接对应"哪条 pipeline 本身设计有问题"的信号。

**输入**（全部 optional，all AND）：
```ts
{
  taskId?: string;               // scope to one task
  pipelineName?: string;         // scope to migrations whose from/to版本对应此 pipeline
  sinceMs?: number;              // started_at >= sinceMs (epoch ms)
  untilMs?: number;              // started_at <= untilMs
  actor?: string;                // exact actor match
}
```

**输出**：
```ts
{
  ok: true,
  stats: {
    totalMigrations: number;
    successCount: number;
    failedCount: number;
    rolledBackCount: number;
    successRate: number;        // successCount / totalMigrations (0 when total=0)
    rollbackRate: number;       // rolledBackCount / totalMigrations
    byPipelineName: Record<string, {
      total: number;
      success: number;
      failed: number;
      rolled_back: number;
    }>;                          // pipeline_name resolved by JOIN with pipeline_versions
    byActor: Record<string, number>;  // count per actor
    topChurnPipelines: Array<{     // sorted by total DESC, top 10
      pipelineName: string;
      total: number;
      successRate: number;
      rollbackRate: number;
    }>;
  }
}
```

**SQL backbone**：
```sql
SELECT hue.status, hue.actor, pv.name AS pipeline_name, hue.task_id
FROM hot_update_events hue
LEFT JOIN pipeline_versions pv ON pv.version_hash = hue.to_version
WHERE (? IS NULL OR hue.task_id = ?)
  AND (? IS NULL OR pv.name = ?)
  AND (? IS NULL OR hue.started_at >= ?)
  AND (? IS NULL OR hue.started_at <= ?)
  AND (? IS NULL OR hue.actor = ?);
```

聚合在 TypeScript 侧完成（SQLite 支持 GROUP BY 但 byPipelineName + topChurn
需要 sort + slice，TS 更直接）。

### 1.2 模块位置

`apps/server/src/kernel-next/hot-update/stats.ts`
- `computeHotUpdateStats(db, input: StatsInput): StatsOutput` 纯函数（只读 DB）
- `stats.test.ts`

`mcp/kernel.ts` 加方法 `queryHotUpdateStats(input): StatsOutput` 直接 delegator。

`mcp/server.ts` 注册 `query_hot_update_stats` tool（external surface）。

## 2. 清理 11 skipped legacy tests

### 2.1 `migrate-task.test.ts`（9 skipped）

| line | 测试名 | 决策 |
|---|---|---|
| 241 | marks rerunFrom + downstream stages superseded | **删除** — orchestrator `idle task` test 等价覆盖 |
| 349 | rerunFrom=null produces a forward-only migration | **删除** — orchestrator `idle no rerunFrom` 路径覆盖 |
| 413 | releases lock on happy path | **删除** — orchestrator `concurrent lock` test 覆盖 lock 释放 |
| 442 | rejects concurrent migrate | **删除** — orchestrator concurrent test 覆盖 |
| 481 | lock released after idempotent second migrate | **删除** — 同 413 |
| 505 | failure path writes status='failed' audit row | **删除** — orchestrator resume-failure test 覆盖 |
| 545 | sends INTERRUPT for each running stage | **删除** — orchestrator interrupt timeout + resume tests 覆盖 |
| 592 | broadcasts INTERRUPT for every running stage (parallel) | **删除** — B13 test 覆盖 parallel 语义 |
| 649 | no-op when taskRegistry has no dispatcher | **删除** — orchestrator `idle task (no runner)` 覆盖 |

所有 9 个都有等价 orchestrator 测试。直接删 9 个 `it.skip(...)` 块。

### 2.2 `a2-3-5-live-migration.adversarial.test.ts`（2 skipped）

这是 A2.3.5 里程碑的端到端 real-executor + INTERRUPT 测试。跟 5B orchestrator
语义不兼容（它们假设 migrateTask 只改 DB，5B 会启动新 runner）。

**决策**：**删除整个文件**。理由：
- 核心行为 "INTERRUPT → agent 收到 → summary turn → 写 port → result" 在
  `agent-machine.test.ts` 和 `real-executor.test.ts` 已充分覆盖
- migration 端到端场景在 `migration-orchestrator.test.ts` 覆盖（含 INTERRUPT
  timeout + resume）
- 保留 skipped 文件占位没价值

### 2.3 Kernel.test.ts 中 1 个 skipped 5A rollback test

Stage 5B 迭代时留下的 `"valid history match → Stage 5B really executes migration"`
skipped block 是占位说明，**保留**（文字说明指向 rollback.test.ts 的覆盖位置）。

## 3. 整体集成测试

新 `apps/server/src/kernel-next/hot-update/end-to-end.test.ts`：

### 3.1 场景：autoApprove safe → migrate idle → stats 可查

```
1. submit diamondIR
2. seed stage_attempts 'A success'
3. propose update_stage_config(A promptRef) autoApprove=true
   → expect autoApplied=true, status='approved'
4. migrate_task → orchestrator 走 idle path with mock startRunner
   → expect MigrationOutcome.ok=true, supersededStages=[A, B, ..., D] (wire-reachable)
5. query_hot_update_stats(taskId) → expect
   { totalMigrations=1, successCount=1, failedCount=0, rolledBackCount=0 }
```

### 3.2 场景：forward → rollback → stats 反映两段

```
1. submit + propose + autoApprove + migrate (same as 3.1)
2. seed new attempt on proposed version
3. rollback_hot_update(taskId, v1) → expect ok
4. query_hot_update_stats(taskId) → expect
   { totalMigrations=3, successCount=2, rolledBackCount=1 }
   (migration executed-v1 事件 + migration-executed-v1 from rollback + rolled_back)
```

### 3.3 场景：INTERRUPT timeout → 状态保留 + 审计 failed

```
1. submit + seed 'A running'
2. register mock dispatcher that swallows INTERRUPT
3. propose + autoApprove
4. migrate with short interruptWaitMsOverride
   → expect MIGRATION_INTERRUPT_TIMEOUT
5. query_hot_update_stats(taskId) → expect failedCount=1, successCount=0
```

## 4. Roadmap 更新

- §7.6 B22 改 ✅ 5E
- §7.4 5.17-5.20 全部标 ✅
- 修订历史 v1.7 行

## 5. 无变动项

- 不改 IR schema
- 不改 MCP 现有 tool shapes
- 不删 kernel.ts 的 `_retiredA8MigrateTask` 相关注释（5B 已完成，这些 comment
  已留在 `__acquireMigrationLockForTest` throw 里了）
- 不写白皮书 / README（CLAUDE.md 约束）

## 6. 成功标准

1. `query_hot_update_stats` MCP 可用，返回结构如 §1.1 所示
2. 5B skipped tests 全部清理（删文件 / 删 block）
3. 3 个 end-to-end 集成测试绿
4. 全 server suite green，tsc clean
5. roadmap 更新；v1.7 handoff 文档

完成后 B 系列 22 项中（去掉 5C 推迟的 B9/B10/B12）**全部落地**。
