# Phase 6 — Usage Log

真实任务执行记录。按 §9 M1-M4 成熟度指标驱动。

**M1**: 自己 95% AI 编码流程能用 workflow-control 完成
**M2**: 3-5 个开发者持续使用
**M3**: Pipeline 成功率 > 90%（completed / total）
**M4**: 热更新成功率高（AI 提议的热更新不需 reject / 回滚）

---

## 运行台账

| # | 日期 | 任务描述 | Pipeline | taskId | 状态 | 耗时 | 发现的 bug | 备注 |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-04-23 | 空 seed 首跑 smoke-test | smoke-test | smoke-test-1776877365350-d4192d2a | API 返回 completed（**实际 timeout**） | 33s agent / 10s timeout | P6-1, P6-2 | 只跑了 greet；echoBack 从未启动；getTaskStatus 谎报 completed |

## 成熟度快照

- **M3 分子/分母**: 0 / 1（首跑就暴露 bug；task 实际未完成）
- **M4 热更新总数 / reject + rollback 次数**: 0 / 0
- **覆盖的 builtin**: 1 部分 / 4 (`pipeline-generator`, **`smoke-test` ❌ bug**, `tech-research-collector`, `tech-research-writer`)

## Bug 清单

按发现时间倒序。每条给出：发现场景 / 根因 / 修复 commit / 回归测试。

### P6-1 — getTaskStatus 把"只跑了一部分 stage"误判为 completed

**发现时间**：2026-04-23，首次 Phase 6 真实跑 smoke-test
**taskId**：smoke-test-1776877365350-d4192d2a
**现象**：HTTP `GET /api/kernel/tasks/:taskId/status` 返回 `status=completed`，但 DB 里 `stage_attempts` 只有 `greet` 一行（success）；`echoBack` 从未被 create。
**根因**：`KernelService.getTaskStatus` (`kernel-next/mcp/kernel.ts:1003-1018`) 只基于 stage_attempts latest 派生状态 —— "有 success 的 greet + 没有任何 running/error = completed"。但 IR 里还有 echoBack 这个声明但未到达的 stage。没有 task-level 权威 final 记录。
**影响**：API 对调用方撒谎。更严重：如果 runPipeline 因 timeout/异常退出，DB 残留"前几个 stage success"，从调用方看就是成功完成。
**关联 bug**：同次运行暴露 P6-2（默认 timeout 太短）；两者叠加才让这个 bug 显现出来。
**修复**：待设计（需要一张 task_finals 表或等价的权威终态信号）
**回归测试**：smoke-test.linear-two-stage.test.ts（已证明 mock runPipeline 下两 stage 都能跑，所以 bug 只在"runPipeline 异常退出后 status 端点"路径）

### P6-2 — runPipeline 默认 10s timeout 对真实 agent 不可用

**发现时间**：2026-04-23
**根因**：`runPipeline(opts, timeoutMs = 10_000)` (`runner.ts:213`) 默认 10s。HTTP 入口 start-pipeline-run 没传 timeoutMs，所以走默认。真实 Claude Agent SDK 一次对话常见 30-120s。
**现象**：greet 单独跑了 33s → runner throws `runPipeline timeout after 10000ms` → start-pipeline-run catch 试图发 synthetic run_final=failed，但 **DB 的 stage_attempts 已经被 port-runtime 标为 success**（因为 executor 实际返回了）。
**影响**：任何真实 agent pipeline 都会在默认路径下超时。
**修复**：方向是"默认超时必须远大于 agent 单轮"；或改成显式必填；或不在 runner 层设默认。需要决策。
**回归测试**：待加。

---
