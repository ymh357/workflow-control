# A2.3 — AgentMachine nest under TaskMachine

> Created: 2026-04-20
> Author: Opus 4.7 (与产品 owner 协作)
> Status: PLAN — pending owner approval
> Parent: `docs/kernel-next-terminal-design.md` §4.5 / §10.5
> Predecessor: `docs/superpowers/plans/2026-04-20-kernel-next-f1-f8-done-handoff.md`
> Tracks: task #91

---

## 0. 一句话目标

把 `AgentMachine` 从独立 `createActor` 改造为 `TaskMachine` stage region `executing` 状态的 **XState invoked child**，让 stage region 能把 `INTERRUPT` / `MIGRATION_REQUESTED` 事件真正穿透到正在运行的 agent，最终让 A8 live migration（`migrateTask` → 运行中 agent 被 graceful interrupt → superseded + rerun）在 runner 层可达。

---

## 1. 现状（code-level facts, 2026-04-20）

### 1.1 现在的嵌套方式不是 XState invoke

`apps/server/src/kernel-next/runtime/real-executor.ts:221`:

```ts
const agentActor = createActor(createAgentMachine());
agentActor.start();
// ...
for await (const message of stream) {
  const events = adapter.translate(message as SdkMessageLike);
  for (const ev of events) agentActor.send(ev);
}
await waitFor(agentActor, (s) => s.status === "done", { timeout: 5_000 });
agentActor.stop();
```

AgentMachine 是 executor 内部私有 actor，**TaskMachine 看不到它**。结果：
- 外部没有任何办法往运行中的 agent 发 `INTERRUPT`
- `migrateTask` 只跑 DB superseded 交易（见 `kernel.ts:887-916`），根本没有向 runner 广播
- stage region 的 `executing` state 只是"执行占位"，没有 invoked child 语义

### 1.2 runner 只监听两个 stage 事件

`runner.ts` 只把 `substate === "executing"` 当作"该 dispatch executor 了"的信号；executor 执行完后通过 `writePort` → `PORT_WRITTEN` 让 machine 前进，或通过 `STAGE_FAILED` 宣告失败。没有"把事件转发给 agent"的通道。

### 1.3 migrateTask 不发事件

`kernel.ts:870-965` 的 `migrateTask`：
- 检查 proposal 状态
- 获取 §10.2 serial-per-task lock
- BEGIN tx → UPDATE stage_attempts SET status='superseded' → INSERT hot_update_events → COMMIT
- 没有任何 `taskRegistry.get(taskId)?.send({ type: 'MIGRATION_REQUESTED' })`

在 live task 上调 `migrateTask` 时，DB 状态变了但 runner 毫无感知，继续跑旧版本。A8 adversarial test（"task 运行中被 migrate"）因此不可写。

### 1.4 AgentMachine 支持 INTERRUPT，但只有测试能发

`agent-machine.ts` 本身完整处理 `INTERRUPT`（§4.2 matrix），但目前**只有 `agent-machine.test.ts` 手工 `actor.send({type:'INTERRUPT'})`**。real-executor 不暴露任何把外部 INTERRUPT 转进 agent actor 的方法。

### 1.5 debt 清单（handoff §0.4）哪些在 A2.3 自然解决

- **Debt #1（AgentMachine 非 invoked child）**：A2.3 本体
- **Debt #3（runner silent-fanout + log-scan 兜底）**：A2.3 期间把 `executing` 改 invoke 后，stage region 的 error 会走结构化 `STAGE_FAILED`（而非 log 扫描），log-scan 可 retire
- **Debt #5（fanout 绕过 CompositeStageExecutor）**：A2.3 的 invoke 统一后，fanout 可改走 `PortRuntime.writeAggregatePort()` 或 executor 层 aggregator，不再需要 runner 里的专用 silent-runtime 分支

Debt #2 / #4 / #6 / #7 不在本切片范围内（见 handoff §0.4 建议时机）。

---

## 2. 目标状态（A2.3 完成后）

### 2.1 行为目标

1. `TaskMachine` 的 agent stage region `executing` state 用 `invoke: { src: 'agentActor', input: {...} }` 嵌入 AgentMachine
2. stage region 收到 `INTERRUPT` / `MIGRATION_REQUESTED` 事件时，**自动 forward** 给 invoked child（XState `sendTo` / `forwardTo` action）
3. `migrateTask` 成功提交 DB 交易后，**广播** `MIGRATION_REQUESTED` 给 `taskRegistry.get(taskId)` 的 dispatcher
4. runner 收到 agent invoke 的 `onDone` / `onError` 时：
   - `onDone` + `status: "done"` → 允许下游 wire 推进（当前路径保留）
   - `onDone` + `status: "interrupted"` → stage region 进入"被 interrupted"final，runner 上报 stageError 含 `interruptedFrom`
   - `onError` → `STAGE_FAILED` 路径
5. `real-executor` **不再**独立 `createActor(AgentMachine)`；改为：executor 把 SDK 事件流 feed 给 stage region 提供的 adapter/dispatcher，由 XState actor 系统跑 AgentMachine

### 2.2 非目标（A2.3 不做）

- **不做** fanout stage 的 AgentMachine invoke（fanout 仍走 runner 专用路径；Debt #5 留到后续切片）
- **不做** worktree reset（§10.5 Step 4，涉及 git 集成，独立大切片）
- **不做** parallel group fine-grained migration（§10.5 Step 3，需要 wire compatibility 分析器）
- **不做** `MIGRATION_IN_PROGRESS` 冷锁持久化（进程级 Map 已够用）
- **不改** gate stage 的 executing 语义（gate 本来就没有 SDK 调用，不需要嵌套 agent）

---

## 3. 切片计划（5 步，每步独立 commit）

| 步 | Subject | 文件数 | 测试增量预估 |
|---|---|---|---|
| A2.3.1 | AgentMachine 纯化 + actor-logic wrapper | ≤4 | +3 |
| A2.3.2 | stage region `executing` → `invoke` | ≤5 | +4 |
| A2.3.3 | INTERRUPT 穿透 + 测试 | ≤4 | +5 |
| A2.3.4 | migrateTask 广播 MIGRATION_REQUESTED | ≤4 | +3 |
| A2.3.5 | A8 live-migration adversarial test | ≤3 | +2 |

每步独立 self-review + commit，符合 CLAUDE.md ≤5 文件规则。

---

### A2.3.1 — AgentMachine actor-logic wrapper

**目标**：让 `createAgentMachine()` 返回的对象能作为 XState `invoke.src` 被嵌套。同时修掉 real-executor 里的手工 createActor。

**改动**：
- `runtime/agent-machine.ts`: 保持 `createAgentMachine()` 签名不变（它本来就返回 `setup().createMachine()`），新增 `AgentMachineInput` 类型 + machine 的 `input` 字段读入 `{ sdkStream, adapter }`，用 `invoke: { src: fromPromise(streamToEvents) }` 把 SDK stream → events 的 for-await 消费做成 child actor，AgentMachine 本身只管状态图
- `runtime/sdk-adapter.ts`: 导出一个 `createStreamPump(stream, send)` helper（本来就在 real-executor 里，抽出来）
- `runtime/real-executor.ts`: 改成外部 actor 父 spawn 它；executor 接收 parent actor dispatcher，用 `spawnChild` 或 invoke 的 output 拿到最终 AgentMachineOutput

**交替方案**：保留 real-executor 独立 createActor，但额外暴露一个 `interrupt()` 方法让 runner 可以调。优点：改动小；缺点：语义不是真正的 XState invoke，INTERRUPT 无法参与 XState 的 actor 生命周期（例如"parent stopped → child cleanup"）。**不采纳**，因为 A2.3.2 要在 stage region 真正 invoke，这一步必须先做彻底。

**测试**：
- `agent-machine.test.ts` 现有测试保持通过
- 新增：用 `createActor(createAgentMachine(), { input })` 验证 input 正确传入，final output 正确

**Owner 决策（§6.2）附加任务 — POC**：A2.3.1 commit 之后、A2.3.2 开工之前，追加一个 POC 验证。产出 `apps/server/src/kernel-next/__poc__/invoke-probe.ts`（不计入测试套件，完成后可删除 / 或保留为 doc fixture）：
- 构造一个最小 parallel region（2 个 agent stage A / B 并行）
- 每个 stage `executing` 用 `invoke`，src 名字相同，通过 `provide({ actors })` 注入不同的 logic
- 验证 A / B 各自 output 正确，互不污染
- POC 通过 → 进 A2.3.2
- POC 失败 → 停下带结果讨论

**风险**：
- SDK stream 的 async iterator 如何接入 XState 的 actor model？XState v5 支持 `fromPromise` 和 `fromCallback`。stream 消费适合 `fromCallback`：回调签名 `({sendBack}) => { for await ... sendBack(event) }` 返回 cleanup。验证通过后再定稿
- AgentMachine 的 final `output` mapper（`output: ({context}) => ...`）在嵌套场景下通过 `invoke.onDone.actions` 可以拿到；需要实测

**回滚**：如果 XState invoke wrapper 比预期复杂，回退到"交替方案"，重排后续切片

---

### A2.3.2 — stage region `executing` → `invoke`

**目标**：`TaskMachine` 的 agent stage region 在 `executing` state 上挂 `invoke: { src: 'agentActor', input }`；runner 不再手工 dispatch executor，XState 自动 spawn。

**改动**：
- `compiler/ir-to-machine.ts`: agent stage region 的 `executing` state 添加 `invoke`。注意：`input` 需要 taskId / versionHash / stage / portValues，这些在 compile 时部分未知（portValues 是 runtime）。方案：compile 时产出 `invoke: { src: 'agentActor', input: ({context}) => ({...}) }`，runner 通过 `provide({ actors: { agentActor: ...logic } })` 在 createActor 时注入真正的 agent logic
- `runtime/runner.ts`: 
  - 删掉 `if (substate === "executing" && !dispatched)` 分支里的 `executor.executeStage(...)` 调用
  - 改成 `createActor(machine, { input, actors: { agentActor: executorLogic } })`
  - `executorLogic` 是一个 `fromPromise` actor，内部跑 `executor.executeStage(...)` + AgentMachine 管理
- `runtime/executor.ts`: 保留 `StageExecutor` 接口供 mock/real 用
- `runtime/mock-executor.ts`: 保持不变，仍被 executorLogic adapter 包装

**保留路径**：
- fanout、gate、script stage 仍走 runner 当前逻辑（不 invoke），因为它们不嵌 AgentMachine
- 只有 `type === "agent" && !fanout` 的 stage 改走 invoke

**测试**：
- `runner.test.ts` 全套保持绿
- 新增：一个 agent stage 内部触发 SDK `INTERRUPT`（mock stream 插入 interrupt 事件），验证 stage region 的 `onDone.output` 含 `status: "interrupted"`

**风险**：
- XState v5 `invoke` 的 input 解析时机 & actor scoped vs provided 之间的匹配，需要小 POC
- dispatched Set 当前既是"seen-marker"又是"防重复派发"，切换 invoke 后只有 fanout/gate/script 还需要它

**回滚**：若 invoke + provide 组合在 parallel region 里有意外行为，回退本步，退回到 A2.3.1 的外部 createActor + 手动 forward 路径（需要在 runner 维护 perStage child-actor map）

---

### A2.3.3 — INTERRUPT 穿透 + 测试

**目标**：外部（taskRegistry dispatcher）发 `INTERRUPT` 给 TaskMachine → stage region forward 给 invoked AgentMachine → AgentMachine 按 §4.2 matrix 终结。

**Owner 决策（§6.1）**：**stage-specific 路由**。事件 schema `{ type: "INTERRUPT"; stage: string }`，stage 必填。

**改动**：
- `compiler/ir-to-machine.ts`: 
  - `MachineEvent` 加 `| { type: "INTERRUPT"; stage: string }`
  - 每个 agent stage region 加 `on: INTERRUPT` 的 guard（`event.stage === stageName`）+ `sendTo` invoked child id
  - 非 agent stage（gate/script）region 不响应 INTERRUPT
- `runtime/agent-machine.ts`: 无改动（INTERRUPT 已支持）
- `runtime/runner.ts`: dispatcher forward 已经工作（taskRegistry → actor.send），无需改
- `runtime/task-registry.test.ts`: 补 INTERRUPT 用例（含 stage 参数）

**测试**：
- 新增 `runner.interrupt.test.ts`: 一个 agent stage 执行中，test 从 taskRegistry 拿 dispatcher 发 `{type:'INTERRUPT'}`，验证：
  - `result.stageErrors[0].context?.interruptedFrom === 'waiting_for_claude'`（或按 §4.2 matrix）
  - `finalState === 'failed'` 或 `'completed'`（取决于 summary turn 结果）
- `agent-machine.test.ts` 新增 nested 场景：invoke 父 machine 发 INTERRUPT，子 agent 收到

**风险**：
- `sendTo` + invoked child ID 的解析，不同 spawn 方式（invoke vs spawnChild）API 不同
- Stage 特定的 INTERRUPT 路由（仅 interrupt 某个 stage 而不是整 task）在 XState parallel region 里需要 `stage` 参数进 guard

**回滚**：若 XState forward 语义在 parallel region 有坑，降级为 taskRegistry 额外维护 `taskId -> stageName -> agentActor` 的次级 map，runner 在 register 时补登记

---

### A2.3.4 — migrateTask 广播 INTERRUPT

**目标**：`migrateTask` 成功提交 DB 交易后，向 `taskRegistry.get(taskId)` 的 dispatcher 为每个 running stage 发一个 `INTERRUPT { stage }` 事件。

**Owner 决策（§6.1）**：事件直接是 `INTERRUPT`，不需要 `MIGRATION_REQUESTED` 中间层。

**改动**：
- `compiler/ir-to-machine.ts`: `MachineEvent` 已在 A2.3.3 加了 `INTERRUPT`，本切片无改动
- `mcp/kernel.ts`: `migrateTask` 在 `return { ok: true, eventId, ... }` 前：
  1. 查 `stage_attempts` 里 `task_id=? AND status='running'` 的所有 stage_name（parallel 场景可能多行）
  2. 对每个 running stage 发一个 INTERRUPT：
  ```ts
  const dispatcher = taskRegistry.get(taskId);
  if (dispatcher) {
    const runningRows = this.db.prepare(
      `SELECT DISTINCT stage_name FROM stage_attempts
       WHERE task_id = ? AND status = 'running'`
    ).all(taskId) as Array<{ stage_name: string }>;
    for (const row of runningRows) {
      dispatcher.send({ type: "INTERRUPT", stage: row.stage_name });
    }
  }
  ```
  说明：直接发 INTERRUPT 而非 MIGRATION_REQUESTED → INTERRUPT 翻译，减一层事件。MIGRATION_REQUESTED 概念保留在文档层但不落到事件总线（YAGNI）。
- `mcp/kernel.test.ts`: 补测 — migrateTask 调用时，如果 taskRegistry 里有 live dispatcher，应收到 MIGRATION_REQUESTED

**注意**：
- 向 dispatcher 发事件后**不等待** agent 真正终结；`migrateTask` 的 DB 交易已经完成，superseded 已落
- "等 agent 真正停下来再 rerun" 是 A2.3.5 的事
- 如果 taskRegistry 没有 dispatcher（task 不在本进程 / 已 stop），广播 no-op；不影响 migrateTask 返回值

**风险**：
- taskRegistry 的 dispatcher 可能在 migrateTask return 之前就 unregister 了（race）；此时 send 无效果但不抛错（EventDispatcher.send 本身是 fire-and-forget）

---

### A2.3.5 — A8 live-migration adversarial test

**目标**：写一个 e2e 测试证明"task A 运行中，外部 migrateTask → agent 收到 INTERRUPT → agent 按 §4.2 终结 → runner 上报 stage interrupted → DB 里 stage_attempt 是 superseded"的完整链路。

**改动**：
- `kernel-next/mcp/migrate-task.test.ts`: 新增 adversarial case（或新建 `migrate-task.adversarial.test.ts`）
- 测试形态：
  1. 启动一个 2-stage pipeline，stage1 用 mock SDK stream，第一个 tool_result 后**不发** RESULT_SUCCESS
  2. 跑 runner；stage1 进入 `waiting_for_claude`
  3. 从外部调 `kernel.migrateTask(taskId, proposalId)`
  4. Mock SDK 在收到 INTERRUPT 信号后，发 RESULT_SUCCESS（模拟 summary turn 成功）
  5. 断言：
     - migrateTask 返回 `{ok: true}` + hot_update_events 有 `status='success'`
     - `stage_attempts.status='superseded'`（如果 stage1 在 rerunFrom 的 downstream）
     - runner 的 RunResult 包含 stage1 的 interrupted 状态

**风险**：
- Mock SDK stream 需要能"等外部信号再发消息"；可以用 Promise + `for await` 内部监听 AbortController 实现
- 测试 timing 需要小心，不能引入 flaky sleep；建议用 `waitFor(actor, ...)` 而非定时 delay

**成功标准**：adversarial test 跑 100 次 0 flake（可以用 `vitest --run --repeat=100` 验证）

---

## 4. 验收标准（整个 A2.3）

- [ ] 5 步各自独立 commit，每次 tsc clean + test green
- [ ] 累计测试 4010 → 4027+（+17 预估）
- [ ] 无 regression（原 A1-A8 所有测试保持绿）
- [ ] `real-executor.ts` 不再 `createActor(createAgentMachine())`
- [ ] `runner.ts` fanout/gate/script 分支保留；agent invoke 分支新增；log-scan NO_ACTIVE_WIRE 路径**保留**（Debt #3 retire 留到后续切片；本切片只做 invoke 本体）
- [ ] `migrateTask` 向 live runner 广播 MIGRATION_REQUESTED
- [ ] e2e adversarial test 证明链路通

---

## 5. 架构 debt 影响

### 本切片自然解决

- Debt #1（AgentMachine 非 invoked child）：完全消化

### 本切片部分推进但未完成

- Debt #3（runner silent-fanout + log-scan 兜底）：**log-scan 保留**（fanout/gate 仍需要），下个切片（A3 或 A2.4）retire
- Debt #5（fanout 绕过 CompositeStageExecutor）：本切片不动

### 本切片不涉及

- Debt #2、#4、#6、#7 保持原状

---

## 6. Owner 决策记录（2026-04-20 已敲定）

1. **A2.3.3 INTERRUPT 粒度**：**stage-specific 路由**
   - 事件 schema: `{ type: "INTERRUPT"; stage: string }`
   - migrateTask 在广播 MIGRATION_REQUESTED 时必须带上具体 stage（= task 当前正在 executing 的那个 agent stage）
   - runner 的 forward 逻辑按 stage 名匹配 invoked child
   - 影响：A2.3.4 需要在 migrateTask 里先查 task 当前 executing stage（读 stage_attempts 最新 running 行）；若有多个 running stage（parallel），全部发 INTERRUPT
2. **A2.3.2 invoke 失败回滚策略**：**先 POC 30min 再定**
   - A2.3.1 完成后，追加一个无 commit 的 POC 脚本（或 `kernel-next/__poc__/invoke-probe.ts`）验证 parallel region + provide(actors) + invoke output 的行为
   - POC 通过（能跑通 2 个并行 agent stage 的 invoke + 各自 output 正确分发）→ 进 A2.3.2
   - POC 失败 → 带数据回来讨论，考虑降级方案
3. **A2.3.5 mock SDK stream**：**测试内联 async generator**
   - `migrate-task.adversarial.test.ts` 内直接写 async generator + 一个 `Deferred<void>` 作为"等 INTERRUPT 的闸门"
   - 不抽 test helper（YAGNI）；若后续 adversarial test 确实复用，再重构

---

## 7. 开工前 checklist

- [ ] 本文档读完，owner approve §6 三个决策点
- [ ] `git status -s` 只有未追踪的 docs/superpowers 文件
- [ ] baseline `cd apps/server && ./node_modules/.bin/vitest run` = 4010 passed
- [ ] 新建 branch 或在 main 直接推进（由 owner 决定）

---

## 8. 不要做的事

- 不要在 A2.3.1 之前触碰 `real-executor.ts` —— AgentMachine wrapper 先纯化
- 不要在 A2.3.5 adversarial test 之前修改 Debt #3（log-scan retire）—— 会把测试噪音带进同一 commit
- 不要合并任何两个切片到单 commit —— 每步 self-review + independent ship
- 不要改 A7 `a7-tech-research.test.ts` —— owner 已指示保持 mock
