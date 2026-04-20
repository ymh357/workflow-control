# Kernel-next Follow-up #1-#3 Completion Handoff

Date: 2026-04-21
Branch: main
Scope: legacy-yaml-converter milestone 之后的 4 个 follow-up 任务

---

## 1. 概述

Legacy YAML converter milestone 结束后发现 4 个值得立即清理的债务/改进项：

| # | 任务 | Commit |
|---|------|--------|
| #1 | 修 stage_error SSE message bug（NO_ACTIVE_WIRE 误用于所有 error final） | `3cbcb38` |
| #2 | Dashboard 把 seed 拆成独立 Seed Inputs 区块 | `9c7d904` |
| #3a | `claude_md` 从 fatal 降为 LEGACY_FIELD_IGNORED warning | `a04a380` |
| #3b | 抽 `registerLegacyPipeline` helper | `27369d2` |
| #3c | 用 helper 注册 tech-research-writer + E2E 验证 | `e12c671` |

5 个 commit，0 regression。

## 2. Task #1 — stage_error reason 分辨

**问题**：kernel-next runner 对任何 stage region 进 `error` final 都 emit SSE `stage_error` 带 message `"NO_ACTIVE_WIRE: every inbound wire to '<stage>' resolved false — stage cannot activate"`。但实际 error final 有 3-5 条进入路径（`noDeliverableWire` / `waiting.STAGE_FAILED` / `executing.STAGE_FAILED` / `waiting.always` 的 `noDeliverableWire` / `GATE_ANSWERED` 第 3 分支）。agent 失败场景下 message 完全误导。

**修法**：`MachineContext.finalizedStages` 元素加 optional `reason: "no_active_wire" | "executor_failed"`。compiler 在每条进入 `error` final 的 transition 的 `actions: assign(...)` 里显式标 reason（把原来的状态级 `error.entry` assign 删掉，改成 transition-side assign）。runner 3 个消费点都按 reason 分派：
- `no_active_wire` → 继续调 `buildNoActiveWireError`（保留 failedWires 结构化 context）
- `executor_failed` → 从既有的 `stageErrors` 数组里取真实 executor message（runner.ts:313 的 `result.error`）

**测试**：runner.test.ts 新增 `describe("runPipeline stage_error reason differentiation")`：2 个测试覆盖两条路径。既有 SSE Slice 2 测试仍全绿（用的是 no_active_wire 路径，默认 reason 未破坏）。

**SSE schema**：不动。`StageErrorData.message` 保持 string，context optional。

## 3. Task #2 — Dashboard Seed Inputs 区块

**问题**：runner 对 externalInputs seed 发 `port_written` 时 `stage="__external__"`。Dashboard 按 stageName 聚合，让 seed 混进 stages 表，显示成一个名为 `__external__` 的"假 stage"。

**修法**：`apps/web/src/app/kernel-next/[taskId]/page.tsx`
- 新增 `seedPorts: Map<portName, { value, timestamp }>` state
- `port_written` handler 分流：`stage === "__external__"` → setSeedPorts；其他 → 照常
- stages 表 + ports feed 都过滤 `__external__`
- UI 层加顶部 Seed Inputs 折叠区（stages 表上方），空时不渲染

**无服务端改动**：SSE schema / runner 行为都不碰。commit `9c7d904` 只动 page.tsx。

## 4. Task #3a — claude_md 降级

**问题**：converter 原把 pipeline-level `claude_md: { global: <path> }` 标 fatal UNSUPPORTED_FEATURE。tech-research-writer / web3-research-writer 都声明 `claude_md: { global: global-constraints.md }`，因此永远不能转换。

**决策**：spec §5.7 里 claude_md 条目的 fatal 基调被 2026-04-21 决策覆盖——agent 失去 global 约束是质量下降（非功能失败），可接受。

**修法**：
- `legacy-yaml.ts` Stage 6 追加 `if ("claude_md" in legacy)` → push `LEGACY_FIELD_IGNORED` warning
- spec §5.7 claude_md 条目改为 warning，保留原 rationale 作历史注
- 既有 `map-stages.ts:19` 的 stage-level `IGNORED_FIELDS` 列表已含 `claude_md`（兜底 stage 内嵌的边缘用法）

**验收**：tech-research-writer / web3-research-writer 的 convertLegacyYaml 都能返回 ok。tech-research-writer 进一步接入 HTTP route（#3c）。web3-research-writer 仍缺 injected_context 声明（是 foreach sub-pipeline），单跑依然失败——这是结构性限制，与 claude_md 无关。

## 5. Task #3b — registerLegacyPipeline helper

**问题**：tech-research-collector 在 pipelineRegistry 里占 ~30 行（readFileSync + convertLegacyYaml + 30-line executorFactory）。再加 tech-research-writer 就是 60 行重复。

**修法**：`apps/server/src/routes/kernel-run.ts` 加 helper：
```ts
interface LegacyPipelineRegistrationOpts {
  pipelineDir: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
}
function registerLegacyPipeline(opts): () => PipelineRegistration
```

helper 顶层一次性 readFileSync + convertLegacyYaml（把 ir / promptRoot 闭包捕获），返回的 factory 每次 POST 只构造 RealStageExecutor。

**行为变化点（记入 commit message）**：conversion 从"每次 POST 跑"变成"module load 时一次跑"。builtin YAML 是受控静态资源，零风险；未来如果引入动态加载路径需留意。

**调用点**：
```ts
"tech-research-collector": registerLegacyPipeline({ pipelineDir: "tech-research-collector" }),
```

一行。

## 6. Task #3c — tech-research-writer 接入

**注册**：用 helper 一行加进 pipelineRegistry。13 个 injected_context 自动变成 externalInputs，POST body 需传 13 个 seedValues key。

**测试**：
- UNKNOWN_PIPELINE 测试的 `known[]` 断言含 `tech-research-writer` ✓
- body shape 测试带 13 个 seedValues key，预期 202 ✓

**E2E 验证**：见本文末尾 §9。

## 7. 测试 delta

起点（legacy-yaml-converter 结束）：4128 passed / 5 skipped  
终点（本轮结束）：**4132 passed / 5 skipped / 0 failed**

新增测试（+4）：
- Task #1: runner.test.ts +2 (stage_error reason 的 NO_ACTIVE_WIRE vs executor_failed 两条路径)
- Task #3a: legacy-yaml.test.ts +1 (pipeline-level claude_md → warning)
- Task #3c: kernel-run.test.ts +1 (tech-research-writer body shape with 13 seedValues)

tsc 全程 clean。apps/web 的 `pnpm build` pass（Task #2）。

## 8. 后续候选（来自前一 milestone §7，减本轮已做）

- ~~#1 修 stage_error message bug~~ ✅
- ~~#2 Dashboard Seed band~~ ✅
- ~~#3 接 tech-research-writer~~ ✅
- **#4**：converter 扩 parallel + script + retry → 解锁 pipeline-generator
- **#5**：pipeline-generator MCP surface（依赖 #4）
- 可选：deep live-migration（#1.3，仍 defer until multi-proposal driver exists）
- web3-research-writer 是 sub-pipeline，无 injected_context 声明，单独跑不了——等 #4 有了 foreach 支持时随 web3-tech-research 主流程一并接入

## 9. E2E 验证记录

**Task #3c tech-research-writer E2E**（2026-04-21 09:31-09:32 UTC，~51 秒跑完）：

- taskId: `trw-e2e-1776677497`
- POST `/api/kernel/tasks/run`: 202, versionHash `fc203faeb89a3345997d485bc5cdcd7b439c0d4059fa101543c17eed02c0f5fc`
- Body: pipeline=tech-research-writer, 13 seedValues keys, maxTurns=30, maxBudgetUsd=2.0
- SSE 事件（通过 `/api/kernel-next/tasks/<id>/stream` 订阅）：
  - `task_state × 3`：idle → running → completed
  - `stage_executing × 1`：writeDeliverable
  - `port_written × 18`：13 seed + 5 agent outputs（deliverableId / filePath / wordCount / sourcesLinked / verificationRefsCount）
  - `stage_done × 1`：writeDeliverable
  - `stage_error × 0`
  - `run_final: { finalState: "completed", stageErrors: [] }`
- Claude SDK real executor 跑通，agent 完整产出 5 个 output。

## 10. Dev DB gotcha（延续上个 handoff §4）

`initKernelNextSchema` 用 `CREATE TABLE IF NOT EXISTS`，老 db CHECK 约束会保留。本轮 E2E 前仍需清 db：
```bash
rm -f /tmp/workflow-control-data/kernel-next.db /tmp/workflow-control-data/kernel-next.db-shm /tmp/workflow-control-data/kernel-next.db-wal
```
（注意：还有 `.db-shm` 和 `.db-wal`，三个都要删，否则 SQLite 拒绝重建 schema。）

---

**本轮 followup milestone 完结。** 下次起步读 §8 候选。

