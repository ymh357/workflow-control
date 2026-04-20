# stage_error reason surfacing + converter spec tidy — Completion Handoff

Date: 2026-04-22
Branch: main
Scope: 2a + 2b from the 2026-04-21 followup planning session (the
two items remaining after followup #1–#3)

---

## 1. 概述

Followup milestone #1 在 runner 内部把 stage_error 的进入路径分成了
`no_active_wire` 和 `executor_failed` 两条 reason，并按 reason 分派不
同的 message 文本。这一轮把"内部区分"暴露到 SSE schema 和 Dashboard
两个消费面，同时把 2a（sub-pipeline 结构性限制）写进 converter spec。

| # | 任务 | Commit |
|---|------|--------|
| 2a | converter spec §10 R3 标 Resolved + 新增 R4 sub-pipeline 限制 | `e0fa487` |
| 2b-1 | SSE `StageErrorData` 加 optional `reason`，runner 两处 publish 带 reason | `bb158bd` |
| 2b-2 | Dashboard 按 reason 渲染 wire/exec badge | `92f98b0` |

3 个 commit，0 regression。

## 2. Task 2a — converter spec 收尾

**问题**：R3（Dashboard `__external__` 渲染成 fake stage）在 followup
#2 已经修好，但 spec 仍把它挂在 §1 non-goals 和 §10 Known Risks 里。
另外 web3-research-writer 属于 sub-pipeline（无 `injected_context` 声
明，期待从父 pipeline 的 foreach 拿数据），单独跑会 NO_ACTIVE_WIRE —
这个限制 followup handoff §8 提过一句，但 spec 正文没有。

**修法**：`docs/superpowers/specs/2026-04-20-legacy-yaml-converter-design.md`
- §10.1 R3 追加 "Resolved 2026-04-21" 注记，说明 Seed Inputs section
  已上线
- §10.1 新增 R4 段，完整描述 sub-pipeline 限制：
  - 触发条件（无 injected_context、依赖父流的 foreach）
  - 失败表征（HTTP 202 但 run 立刻到 NO_ACTIVE_WIRE）
  - 解锁路径（等 converter 支持 foreach / sub-pipeline 后自然可用）
- §10.3 deferred 列表：Seed band 条目划掉并标 Done，新增 sub-pipeline
  条目

**无代码改动**。commit `e0fa487`。

## 3. Task 2b-1 — SSE schema + runner

**问题**：`MachineContext.finalizedStages[].reason` 在 runner 内部用来
分派两套 stage_error 文本，但 SSE `StageErrorData` 只有 `message /
context`。Dashboard 想区分两种失败必须 regex-match "NO_ACTIVE_WIRE"，
脆弱且语义耦合到文本。

**修法**：
- `apps/server/src/kernel-next/sse/types.ts`：`StageErrorData` 加
  `reason?: "no_active_wire" | "executor_failed"`（optional 保持向后
  兼容；consumer 对缺省按 no_active_wire 处理，对齐 runner 的兜底约
  定）
- `apps/server/src/kernel-next/runtime/runner.ts`：两处 `publish({
  type: "stage_error", ... })` 在 data 里显式写 reason
- `apps/server/src/kernel-next/runtime/runner.test.ts`：followup #1 加
  的两个 reason differentiation 测试补 `expect(errData.reason).toBe(
  "no_active_wire" | "executor_failed")`

**测试**：4132 passed / 5 skipped / 0 failed。tsc clean。commit
`bb158bd`。

## 4. Task 2b-2 — Dashboard badge

**问题**：`page.tsx` 错误格子只渲染 message 字符串，用户得读整行才能
判断是 wire 掉了还是 agent 挂了。

**修法**：`apps/web/src/app/kernel-next/[taskId]/page.tsx`
- `StageRow` 加 optional `errorReason?: StageErrorReason`
- `stage_error` handler 读 `data.reason` 写入 row
- 错误格子上方加 `<ErrorReasonBadge reason={row.errorReason} />`：
  - `executor_failed` → 红色 "exec" badge（bg-red-100 / text-red-800）
  - `no_active_wire` 或缺省 → 琥珀色 "wire" badge（bg-amber-100 / text-amber-800）
  - `title` 属性挂完整 reason 说明便于 hover 查看

**视觉对比**：
```
Before:  [ stage_name | error | attempt_id | NO_ACTIVE_WIRE: every inbound wire ... ]
After:   [ stage_name | error | attempt_id | [WIRE] NO_ACTIVE_WIRE: every inbound wire ... ]
         [ X          | error | a7f3      | [EXEC] turn limit exhausted: agent produced ... ]
```

**验证**：pnpm build 通过（Turbopack 21.9s compile + static pages ok）。
commit `92f98b0`。

## 5. 测试 delta

起点：4132 passed / 5 skipped（followup milestone 终点）
终点：**4132 passed / 5 skipped / 0 failed**

测试数量不变，只给既有的 2 个 reason differentiation 测试加 SSE 断言
（+4 expect 行，不计入 test count）。

apps/server 的 tsc 全程 clean。apps/web 的 `pnpm build` pass。

## 6. 决策记录

- **reason 为何 optional 而不是 required**：runner 从 followup #1 开始
  就保证三条 error 进入路径都写 reason。但把字段做 required 会锁死
  schema，后续若引入新路径（例如 compensation）又得改 data layer。
  optional + "absence = no_active_wire" 的兜底规则和 runner 内部约定
  一致，扩展成本低。
- **UI badge 文案选 wire/exec 而不是 no-wire/failed**：3-4 字母大写
  badge 在密集表格里不抢视线。title 里挂完整 reason 给需要的人看。
  颜色上 wire 选琥珀（结构性、可重试）、exec 选红色（执行态失败、
  往往要看 agent 日志）。
- **StageErrorReason 类型定义在前端而非从 server types 导入**：web 和
  server 目前没有共享 types 包（legacy 约定）。手写 union 字面量和
  server schema 同步维护，变更时两边一起改。未来如果引入共享 SSE
  client 包再统一。

## 7. 后续候选

从 followup §8 的清单继续：

- **#4**（最大债务）：converter 扩 parallel + script + retry → 解锁
  pipeline-generator；需先开 brainstorm（XState parallel region 怎么
  映射 YAML parallel block、foreach 怎么和 fanout 合并、human_confirm
  怎么转 gate stage 等）
- **#5**：pipeline-generator MCP surface（依赖 #4）
- 可选：web3-research-writer 在 #4 之后随 foreach 支持自然接入

无本轮新增候选。

---

**本轮小清理完结。** 下次起步读 §7。
