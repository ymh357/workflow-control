# Stage 5E — Hot Update Finalization — Handoff

**Status:** Complete 2026-04-24.

**Roadmap:** B 系列 22 项中，除 5C 推迟的 B9/B10/B12 外**全部落地**。

## Delivered

### 新模块 / 功能

- `hot-update/stats.ts` + tests (9) — `computeHotUpdateStats(db, input):
  StatsOutput` 纯函数，聚合 `hot_update_events` 支持 taskId / pipelineName /
  sinceMs / untilMs / actor 过滤
- `KernelService.queryHotUpdateStats(input)` thin delegator
- MCP tool `query_hot_update_stats`（external surface）—— tool 总数从
  combined 20→21、external 19→20
- `hot-update/end-to-end.test.ts` (3) — 覆盖全链路：
  - autoApprove safe → migrate idle → stats success=1
  - forward migrate → rollback → stats success=2 + rolled_back=1
  - INTERRUPT timeout → state preserved → stats failed=1

### 清理

- 删除 `migrate-task.test.ts` 中 9 个 A8 时代 `it.skip` test 以及 2 个空 describe 壳
  （F5 serial-per-task lock / A2.3.4 INTERRUPT broadcast）—— 等价覆盖已在
  migration-orchestrator.test.ts（5 个集成场景）+ rollback.test.ts（3 个）+
  本次 end-to-end.test.ts（3 个）
- 删除 `a2-3-5-live-migration.adversarial.test.ts` 整文件（2 个 skipped test）
  —— A2.3.5 的 INTERRUPT → summary-turn-wins 语义已在 agent-machine.test.ts
  覆盖；migration 端到端语义已在 orchestrator 覆盖

### 文档

- `docs/product-roadmap.md`：B22 / 5.17-5.20 / 修订历史 v1.7
- 本 handoff

## B 系列完成度（Stage 5 合计）

| 项 | 状态 | milestone |
|---|---|---|
| B1 propose_pipeline_change | ✅ | 5A |
| B2 update_registry_pipeline | ✅ | 5A |
| B3 dry-run + autoApprove | ✅ | 5A |
| B4 safe 范围 (prompt/reads/writes/budget) | ✅ promptOnly | 5A |
| B5 SSE wf.hotUpdatePending | 延期 Phase 6 | — |
| B6 migrateRunningTasks 参数 | ✅ | pre-5 |
| B7 impact 分析 | ✅ 结构性（cost/latency 延期 Phase 6） | 5A |
| B8 同步触发 | ✅ | 5B |
| B9 worktree 切换 | 推迟 5C | — |
| B10 graceful summary | 推迟 5C | — |
| B11 sibling stage 跑完 | ✅ | 5B |
| B12 single-session 摘要注入 | 推迟 5C | — |
| B13 parallel fine-grained | ✅ | 5B |
| B14 乐观锁 | ✅ | 5A |
| B15 删 stage 校验 | ✅ | 5A |
| B16 schema drift | ✅ | 5A |
| B17 foreach schema-compat | N/A (no foreach) | — |
| B18 AI 决定 retry_from | ✅ | 5A |
| B19 migration 失败兜底 | ✅ | 5B |
| B20 rollback 真实执行 | ✅ | 5B |
| B21 audit trail | ✅ | pre-5 + 5A 扩展 |
| B22 聚合指标 | ✅ | 5E |

**17/22 落地，3 项推迟 (B9/B10/B12 绑 5C checkpoint infra)，1 项 N/A (B17)，
1 项 Phase 6 (B5 UI)。**

## 测试计数

Stage 5E 后：
- 新增 12 tests（stats 9 + end-to-end 3）
- 删除 11 skipped tests + 352 line a2-3-5 整文件
- 净 +1 test file, 新 MCP tool 1 个

## 下一步推荐

1. **Phase 6 打磨**（roadmap §Phase 6）：每天使用 workflow-control、朋友试
   用、白皮书重写。无时间箱。这是 B 系列完成后的自然下一步。
2. **5C 独立 brainstorm**（如果 UX 需要）：依赖 checkpoint infra（git worktree
   + per-stage snapshot）+ AgentMachine summary-turn 状态 + tier1 摘要注入
   API。A2.3.3 INTERRUPT 硬切作为降级兜底已闭环；5C 是 UX 提升不是 blocker。
3. **业务层 pipeline 重构**：基于 Stage 5A/5B/5E 能力，让 `pipeline-generator`
   开始主动调 `propose_pipeline_change` + `autoApprove` 改进已有 pipeline。这
   是把 B 系列用起来的第一个生产场景。
