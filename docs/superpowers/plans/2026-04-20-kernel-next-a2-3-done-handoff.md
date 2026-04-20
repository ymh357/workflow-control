# kernel-next A2.3 AgentMachine nest — 完成情况 + 下阶段候选

> Created: 2026-04-20
> Author: Opus 4.7 (与产品 owner 协作)
> Status: A2.3 **code-complete**（5 切片全部合并）
> Parent: `docs/kernel-next-terminal-design.md` §4, §10.5
> Predecessor: `docs/superpowers/plans/2026-04-20-kernel-next-a2-3-agentmachine-nest.md`（plan）

这个文档让下一个 session 直接恢复 A2.3 之后的上下文。**先读 §0**，其余章节是补充说明与选项分析。

读完本文档 + plan 原件的 §1（现状对照）就能对齐 A2.3 的全貌。

---

## 0. 2026-04-20 更新 — A2.3 完成情况

### 0.1 本轮交付 (8fb0c67..295f74c, 7 个 commit)

| Commit | 切片 | 内容 | Δ tests |
|---|---|---|---|
| `8fb0c67` | plan | A2.3 切片计划 + owner 决策记录 | 0 (docs-only) |
| `34f4b5c` | A2.3.1 | AgentMachine `input` wiring + stream-pump 抽取 | +6 |
| `3ae3e65` | POC | XState invoke + parallel region + provide(actors) 可行性验证 | POC-only（不入测试套件） |
| `44b63b5` | A2.3.2 | stage region `executing` → XState invoke（fromPromise 渐进版） | +2 |
| `cf8bf9f` | A2.3.3 | INTERRUPT 穿透 via AbortSignal bridge；fromPromise → fromCallback | +4 |
| `5de2ff5` | A2.3.4 | migrateTask 成功后广播 INTERRUPT{stage} 到 live runner | +3 |
| `295f74c` | A2.3.5 | live-migration 端到端 adversarial test（pausable mock SDK stream） | +2 |

**累计**：4010 → 4027 (+17)，plan 估算 +17，完全吻合。0 regression，tsc clean。

### 0.2 Owner 决策（plan §6）结局

| # | 决策点 | 选择 | 结果 |
|---|---|---|---|
| §6.1 | INTERRUPT 粒度 | stage-specific 路由 | `INTERRUPT{stage}` 事件，runner 层按 guard `event.stage === my` forward |
| §6.2 | invoke 失败回滚 | 先 POC 30min | POC 全绿，直接进 A2.3.2，无需降级 |
| §6.3 | mock SDK 设计 | 测试内联 async generator | `a2-3-5-live-migration.adversarial.test.ts` 内联 Deferred-pattern gate |

### 0.3 最终架构：外部干预链路

```
caller  ── svc.migrateTask(taskId, proposalId)
  ↓
[DB] supersede tx commits (stage_attempts.status = 'superseded')
  ↓
[DB] hot_update_events row inserted (status='success')
  ↓
taskRegistry.get(taskId).send({type:'INTERRUPT', stage:<running stage>})
  ↓ (for each pre-migration running stage, snapshotted before supersede)
TaskMachine root event bus  ← 可观测，可测试
  ↓
region N's executing.on.INTERRUPT { guard: event.stage === N }
  ↓ (sendTo('N_exec', {type:'INTERRUPT'}))
fromCallback(invoke) receive() → AbortController.abort()
  ↓
executor.executeStage's signal (optional ExecuteStageArgs.signal)
  ↓
RealStageExecutor: signal.addEventListener('abort') 
  → agentActor.send({type:'INTERRUPT'})
  ↓
AgentMachine §4.2 matrix（arm-on-waiting / defer-on-tool-loop / 
  summary-turn-wins / interrupted-on-error）
  ↓
stage region reaches `done` via allOutboundPresent (always guard)
  ↓
TaskMachine → completed（或 failed，依 stage 结果）
```

**每一跳都是结构化事件或 signal**：没有轮询、没有 race-prone 假设。`taskRegistry`、`TaskMachine`、`fromCallback`、`AbortSignal`、`agentActor` 都可以独立 unit-test。

### 0.4 §4.2 matrix 端到端验证（A2.3.5）

两个 adversarial 场景（`mcp/a2-3-5-live-migration.adversarial.test.ts`）：

| 场景 | INTERRUPT 触发时机 | 后续事件 | 预期 | 实际 |
|---|---|---|---|---|
| summary-turn-wins | waiting_for_claude | RESULT_SUCCESS | status='done', port writes legitimate | ✓ |
| summary-turn-error | waiting_for_claude | RESULT_ERROR | finalState='failed', stageError 含 SDK 诊断 | ✓ |

### 0.5 Debt 状态更新（原 `2026-04-20-kernel-next-f1-f8-done-handoff.md` §0.4）

1. **Debt #1（AgentMachine 非 invoked child）**：**已降级为非阻塞**
   - 渐进方案下 executor 仍内部起 agentActor，但 A2.3.3 的 AbortSignal bridge 证明 full nesting 不是必需的
   - 真·嵌套仍可做（POC 已验证可行），但不阻塞任何下游工作；如果以后需要"parent 停 → child 自动 cleanup"的 XState 生命周期绑定，再做
2. **Debt #2（`createKernelMcp` 默认 combined）**：未动，仍是独立可择时机处理
3. **Debt #3（runner silent-fanout + log-scan 兜底）**：部分推进但未 retire
   - log-scan 仍保留（`runner.ts:166-175`），用于捕获 parallel onDone 同步 fire 的 NO_ACTIVE_WIRE
   - silent-fanout 仍保留（`runFanoutStage` 专用路径）
   - A2.3 没触碰这条；仍是独立切片
4. **Debt #4（`stage_attempts.status` 无 CHECK constraint）**：未动
5. **Debt #5（Fanout 绕过 CompositeStageExecutor）**：未动
6. **Debt #6（guard deny-list 硬编码）**：未动
7. **Debt #7（fanout aggregate attempt 无 `kind` 列）**：未动

### 0.6 开工前 checklist（继任 session）

- [ ] `git log --oneline -10` 最顶应是 `295f74c A2.3.5 ...`（这条 handoff commit 之上）
- [ ] `git status -s` 只有未追踪的 docs/superpowers 文件
- [ ] `cd apps/server && ./node_modules/.bin/tsc --noEmit` 干净
- [ ] `cd apps/server && ./node_modules/.bin/vitest run` 4027 passed / 5 skipped
- [ ] 本文档 §0 读完
- [ ] plan 原件 (`2026-04-20-kernel-next-a2-3-agentmachine-nest.md`) §6 决策记录读完

---

## 1. 下一阶段候选（择一进入）

A2.3 是 kernel-next `docs/kernel-next-terminal-design.md` §11.1 roadmap 里的一个大块。A2.3 完成后，**没有任何外部阻塞依赖**。候选方向：

### 1.1 Debt retire 系列（小切片组，低风险）

按优先级：

| # | Debt | 估算 | 价值 |
|---|---|---|---|
| #3 | log-scan NO_ACTIVE_WIRE retire | ≤3 文件 | 消除 fragile 文本匹配，改走结构化 diagnostic |
| #5 | fanout 走 CompositeStageExecutor | ≤5 文件 | 移除 runner 里的 silent-fanout 专用路径 |
| #2 | `createKernelMcp` flip default 到 external | ≤4 文件 | 安全边界收窄 |
| #4+#7 | schema migration：加 `CHECK` 约束 + `kind` 列 | ≤3 文件 | 搭车成本低，未来 schema 演进更安全 |

每条都是独立可 ship 的小切片，不需要 plan 文档，直接 brainstorm + 实施。

### 1.2 A9 持续验证（中型切片）

设计文档 §11.1 的 acceptance checklist 里 A9 专指"在真实使用中跑多遍、观察 AgentMachine 行为"。目前所有验证都在 mock SDK 下做。A9 的形态可能是：
- 在本地跑一个小 pipeline（譬如 tech-research builtin）通过 real Claude Agent SDK
- 观察 AgentMachine 是否按 §4.2 matrix 运作
- 修复 adapter / state 图中任何实战中发现的 edge case

预估：不确定，取决于实战发现。典型 3-5 个小 fix 切片 + 一次设计文档 update。

### 1.3 §10.5 live-migration 深化（大切片）

A2.3.5 adversarial test 验证了单 stage 的 live migration。§10.5 还有未实现部分：
- **Step 3** fine-grained parallel group migration（"5 children: 2 done, 2 running, 1 unstarted, 1 patched"）
- **Step 4** worktree reset（git 集成，涉及 `git reset --hard` 到 checkpoint）
- **Step 5** 跨 version 的 stage_attempts 交叉（旧版 attempt 和新版 attempt 并存）

这需要 a) 新的 compiler pass 做 per-stage version binding，b) git 集成层，c) 更复杂的 runner 生命周期管理。估算至少 2-3 周。**建议先走 1.1 或 1.2**，除非有具体生产场景需求。

### 1.4 其他方向（依 owner 优先级）

- **SSE 观察层**：把 TaskMachine state 通过 SSE 广播给 dashboard，实现"外部可观测 pipeline 执行"
- **pipeline-generator MCP surface**：让 main Claude 真正通过 MCP 生成 pipeline，而非本地脚本
- **registry 拓展**：让 pipeline YAML + 配套 prompt 可以跨机器分享（design §11.2）

---

## 2. 需要 owner 决策的事

A2.3 完成后没有硬性阻塞。**下阶段进入前建议对齐**：

1. **先清 debt 还是先推 feature**？Debt retire 是低风险系列，feature (A9 / §10.5) 有真实场景价值但估算大
2. **A9 要不要做**？如果当前没有生产运行计划，A9 的价值较低（mock 已经覆盖大部分 state matrix）
3. **§10.5 深化**：是否有 concrete 驱动场景（例如"主 Claude 多次 propose 同一 task 的修改"），如果没有可以延后

---

## 3. 架构不变量（A2.3 未动，仍然成立）

沿用 `CLAUDE.md`、F1-F8 handoff、A2.3 plan 记录的规则，核心：

- **Task.pipelineSnapshot** 捕获创建时的 pipeline 状态 —— migrate 改变 `stage_attempts.status` 但不动历史 attempt 的 `version_hash`
- **stage.reads/writes** 是唯一 legit 跨 stage 数据流
- Store 写入是 stage 终态；re-run 覆盖自己的 writes 但不删除 prior stages
- pipeline version = 规范化 IR 的 content hash
- **§1.3 invariant**（lineage 不倒流）：migrateTask 只改 `stage_attempts.status`，不动 `port_values` —— A2.3.5 已加断言

---

## 4. 代码入口点（A2.3 修改范围）

| 模块 | 角色 |
|---|---|
| `runtime/agent-machine.ts` | AgentMachine + `AgentMachineInput` 类型（A2.3.1） |
| `runtime/stream-pump.ts` | SDK stream → actor 的 pump helper（A2.3.1 抽取） |
| `runtime/real-executor.ts` | signal → agentActor INTERRUPT bridge（A2.3.3） |
| `runtime/executor.ts` | `ExecuteStageArgs.signal?` 接口（A2.3.3） |
| `runtime/runner.ts` | fromCallback + AbortController 桥接（A2.3.2 + A2.3.3） |
| `compiler/ir-to-machine.ts` | invoke + INTERRUPT event + sendTo forward（A2.3.2 + A2.3.3） |
| `mcp/kernel.ts` | migrateTask broadcast INTERRUPT（A2.3.4） |

POC 脚本：`apps/server/src/kernel-next/__poc__/invoke-probe.ts`（可删除或保留作文档 fixture）

测试：
- `runtime/agent-machine.test.ts` — +3 input correlation 测试
- `runtime/stream-pump.test.ts` — +3 pump unit 测试
- `runtime/runner.test.ts` — +4 invoke + INTERRUPT 测试
- `runtime/real-executor.test.ts` — +2 signal bridge 测试
- `mcp/migrate-task.test.ts` — +3 broadcast 测试
- `mcp/a2-3-5-live-migration.adversarial.test.ts` — +2 e2e 测试（新文件）

---

## 5. 新 session 快速恢复指南

**必读**:
1. 本文档 §0
2. `docs/superpowers/plans/2026-04-20-kernel-next-a2-3-agentmachine-nest.md` §6（owner 决策记录）
3. `docs/kernel-next-terminal-design.md` §4（AgentMachine 语义）+ §10.5（live migration）
4. `docs/superpowers/plans/2026-04-20-kernel-next-f1-f8-done-handoff.md` §0（F1-F8 + debt 清单原版）

**关键入口点**：见 §4。

**基准测试**:
- Baseline 前 A2.3: `4010 passed / 5 skipped`
- Baseline 后 A2.3: `4027 passed / 5 skipped`
- 跑法: `cd apps/server && ./node_modules/.bin/vitest run`

**不要做的事**:
- **不要**把 AgentMachine 改成真·invoked child 除非有新需求 —— 信号桥方案已证明够用
- **不要**动 `runner.ts` 的 log-scan NO_ACTIVE_WIRE 兜底（Debt #3），除非同时做结构化 diagnostic 的替代路径
- **不要**在 mock executor 里加 signal 处理逻辑 —— mock 设计就是 "ignore signal，立即返回"
- **不要**合并多个 Debt retire 到一个 commit —— 继续按 ≤5 文件 / 独立 self-review 的节奏

---

## 6. Verdict

A2.3 **AgentMachine nest — done**。

5 切片全部合并、测试计数与 plan 估算吻合、Debt #1 从"阻塞"降级为"非必要"、§4.2 matrix 端到端验证通过。kernel-next 现在具备完整的外部干预链路（live migration、外部 cancel、未来的超时 kill 全部走这条）。

下 session 的选择权完全开放，推荐按 §1 的顺序评估。
