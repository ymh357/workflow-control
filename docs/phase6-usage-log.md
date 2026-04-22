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
| 2 | 2026-04-23 | 修完 P6-1 P6-2 后 smoke-test 干净重跑 | smoke-test | smoke-test-1776879763943-0d93c5ef | completed ✅ | 26s，2 stage 真跑完 | P6-4 | task_finals=completed/natural；cost $0.073；但 prompt 期望 "task text" 而 IR 无 externalInputs，agent 走 fallback 路径输出"unknown"——设计层契约不一致 |
| 3 | 2026-04-23 | 研究 zod（TypeScript validation 库）| Tech Research Collector | `Tech Research Collector-1776879895803-4a4424cd` | completed ✅ | 170s agent，$0.294 | P6-5, P6-6 | 真实有用的报告：19 sources 尝试 / 12 成功 / Zod 42.5k stars；taskId 含空格（URL 不友好）；HTTP `name` 要传 IR 显示名而非目录名 |

## 成熟度快照

- **M3 分子/分母**: 2 / 3（第 1 跑 bug；第 2-3 跑 completed）
- **M4 热更新总数 / reject + rollback 次数**: 0 / 0
- **覆盖的 builtin**: 2 / 4 （✅ `smoke-test`, ✅ `Tech Research Collector`, `Tech Research Writer` pending, `Pipeline Generator` pending）

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

### P6-3 — pipeline 在 server cwd 下写 `.workflow/` 污染工作区（已消除误解）

**更新 2026-04-23**：不是测试残留。是 tech-research-collector 第一个 stage 的 prompt 指定 `reportPath=".workflow/primary-sources-<target>.md"`，agent 用 `Write` 工具把报告写到 **server 进程 cwd（apps/server/）的 .workflow/**。smoke-test 那次的 `.workflow/primary-sources-unknown.md` 是空 seed 下 agent prompt 被强行走 collector 风格的副作用。
**根因**：agent 有 FS 写权限 + prompt 让它把 reportPath 当实际路径用。不是污染仓库，是 agent 按 prompt 的契约完成工作；但这些文件不该进 git。
**修复思路**：加 `.gitignore` 条目（`**/.workflow/`）+ 让 cwd 指向 `{data_dir}/workspaces/<taskId>/` 而非 server cwd；后者是 Phase 5C worktree 接入的自然扩展。先加 gitignore 堵血路。

### P6-4 — smoke-test prompt 与 IR 契约不一致

**现象**：`greet.md` 说"Read the user's task text"，但 smoke-test IR 无 `externalInputs`，所以没有渠道把 task text 给 agent。agent 执行时读不到 → 按 fallback 输出 "Empty or unreadable task text received."。
**根因**：smoke-test IR 停留在"echo back 能运行"这一级验证，没设计真实用户输入通路。
**修复**：给 smoke-test IR 加 `externalInputs: [{ name: "task_text", type: "string" }]` 和对应 wire 到 greet.inputs。低优先级——这只是 builtin pipeline 自身的完整性问题，不阻塞系统功能。

### P6-5 — HTTP `run` 要求传 IR 显示名而非目录标识

**现象**：`POST /api/kernel/tasks/run { name: "tech-research-collector" }` 返回 `UNKNOWN_PIPELINE`；必须传 `"Tech Research Collector"`（IR.name）。
**根因**：`start-pipeline-run` 按 `pipeline_versions.pipeline_name` 查找，而 `seedBuiltinPipelineByName` 调用 `svc.submit(loaded.ir, ...)` 把 IR.name 作为 pipeline_name 写入。目录名 vs 显示名不对应。
**修复**：两条路，任选—— (a) 统一用目录名作为 pipeline_name（改 IR.name 或另加字段）； (b) 允许 `run` 按模糊 match（目录名/IR.name 都认）。先采 (a)：IR.name = 目录名是唯一 SSO 原则。

### P6-6 — taskId 默认含空格（URL 编码障碍）

**现象**：`Tech Research Collector-1776879895803-4a4424cd` 这种 taskId 在 HTTP path 里要 URL-encode；SSE URL 更麻烦。
**根因**：`startPipelineRun` 合成 taskId = `${pipelineName}-${ts}-${rand}`。pipelineName 有空格时 taskId 就坏了。
**修复**：合成时 slugify pipelineName（`/[^a-zA-Z0-9-]/g -> '-'`）。与 P6-5 根治方案（IR.name 保持目录标识）重合：两问题一并解决。

### P6-2 — runPipeline 默认 10s timeout 对真实 agent 不可用

**发现时间**：2026-04-23
**根因**：`runPipeline(opts, timeoutMs = 10_000)` (`runner.ts:213`) 默认 10s。HTTP 入口 start-pipeline-run 没传 timeoutMs，所以走默认。真实 Claude Agent SDK 一次对话常见 30-120s。
**现象**：greet 单独跑了 33s → runner throws `runPipeline timeout after 10000ms` → start-pipeline-run catch 试图发 synthetic run_final=failed，但 **DB 的 stage_attempts 已经被 port-runtime 标为 success**（因为 executor 实际返回了）。
**影响**：任何真实 agent pipeline 都会在默认路径下超时。
**修复**：方向是"默认超时必须远大于 agent 单轮"；或改成显式必填；或不在 runner 层设默认。需要决策。
**回归测试**：待加。

---
