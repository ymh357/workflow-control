# Stage 5B — Migration Execution Engine Design

**Goal:** 把 `migrateTask` 从"只改 DB"升级到"真正改动活跃 runner"。让 5A 接入
的 propose / autoApprove 链路能通过 kernel 直接启动可观察、可回滚、可并发
安全的热更新。覆盖 roadmap §7 的 B8（同步触发）/ B11（不相关 running stage
不中断）/ B13（parallel group 精细粒度）/ B19（migration 失败兜底）/ B20
（真实 rollback 执行）。

**Scope boundary：** 本 spec **不**做 5C 的 graceful summary turn、worktree
切换、single-session 摘要注入。INTERRUPT 硬切（A2.3.3 机制）作为唯一中止
手段。5D 的 foreach 语义亦不触及（kernel-next 目前无 foreach stage）。

---

## 1. 现状硬事实

### 1.1 migrateTask 当前状态（kernel.ts §885-1290）

- 读 proposal + 校验 approved + migrateRunning opt-in
- 记录 `runningBeforeSupersede`（当前 running 的 stage 名列表）
- 事务内：UPDATE stage_attempts.status='superseded'（`rerunFrom` 的**拓扑下游**
  即 `computeDownstream`）+ INSERT hot_update_events(success)
- **未做**：INTERRUPT 活跃 runner；启动新 version 的 runner；失败反向恢复
- 注释明说："caller is responsible for kicking off new stage_attempts on
  that version (A8 min scope does not wire the runner)"

### 1.2 taskRegistry 当前能力 (runtime/task-registry.ts)

```ts
class TaskRegistry {
  register(taskId, dispatcher)     // throws on double-register
  unregister(taskId)
  get(taskId): EventDispatcher | undefined
  size(), __clearForTest()
}
```

`EventDispatcher = { send(event: MachineEvent): void }`。**没有** termination 信号。
runner 在 run-final 时 `unregister`（runner.ts:327 / :543），外部看不到这个
事件。

### 1.3 runner 当前能力 (runtime/runner.ts)

- `runPipeline(opts: RunnerOptions, timeoutMs = 10_000): Promise<RunResult>`
- 接收 `opts.versionHash` / `opts.ir` —— 一次 run 一个 IR，不支持热替换
- A2.3.3：runner 收到 INTERRUPT 事件后 → `ac.abort()` → real-executor 桥接
  到 AgentMachine 的 INTERRUPT → AgentMachine 进入 done{status:"interrupted"}
- **没有** resumeFrom 机制（新 taskId 复用 + 从 rerunFromStage 开始）—— 现状
  是 runner 一律从 pipeline entry 开始

### 1.4 已有 hot-update 模块 (5A 交付)

- `computePipelineDiff` / `classifySafeRange` / `computeImpact` / `dryRunProposal`
- `topoDownstream`（runtime/topo-downstream.ts）— 拓扑序下游（Stage 5A
  impact 分析用）

### 1.5 已有 adversarial (a2-3-5-live-migration.adversarial.test.ts)

两个 case 验证 live migration 端到端：
- INTERRUPT 成功 + migrate success 审计行存在
- INTERRUPT 后 stage 报错 + migrate 仍写 success 审计（说明 migration DB tx
  与 agent interrupt 是解耦的）

这个测试是 A2.3.5 里程碑交付的，Stage 5B 不应破坏它。

---

## 2. 目标语义

### 2.1 migrateTask 端到端流程（新）

```
migrateTask(taskId, proposalId):

  [PRE-CHECK, existing]
  1. proposal exists + status='approved' + migrateRunning includes taskId
  2. proposed_version exists in pipeline_versions
  3. rerunFrom (if any) exists in proposedIR
  4. acquire per-task migration lock (migrationInProgress Map)

  [INTERRUPT-AND-WAIT, NEW]
  5. isRunning := taskRegistry.get(taskId) !== undefined
  6. if isRunning:
       a. taskRegistry sends INTERRUPT to dispatcher
       b. await termination promise (taskRegistry.awaitTermination(taskId, 30s))
       c. if timeout → audit MIGRATION_FAILED + release lock + return MIGRATION_INTERRUPT_TIMEOUT

  [SUPERSEDE, upgraded]
  7. compute `supersedeSet` via NEW computeWireTransitiveReaders(proposedIR, rerunFrom)
     — wire-based BFS, NOT topoDownstream. Excludes parallel siblings.
  8. snapshot pre-supersede status per attempt (needed for UN-supersede on rollback path)
  9. TX: UPDATE stage_attempts SET status='superseded' WHERE task_id=? AND stage_name IN supersedeSet
         + INSERT hot_update_events(success)

  [RESUME, NEW]
  10. resume := startPipelineRun(db, {taskId, versionHash: proposedVersion, resumeFrom: rerunFromStage})
  11. on failure:
        a. TX: UPDATE stage_attempts SET status=pre-supersede-status
               WHERE task_id=? AND stage_name IN supersedeSet
        b. audit hot_update_events(failed, diagnostic: resume error)
        c. release lock
        d. return MIGRATION_FAILED

  12. release lock
  13. return {ok: true, eventId, taskId, fromVersion, toVersion, supersededStages,
              resumedFrom: rerunFromStage, newRunnerStarted: true}
```

**关键变化 vs A8**：
- 新 step 5-6（INTERRUPT + await termination）
- step 7 改算法（wire 传递闭包，B13）
- 新 step 10-11（resume 启动 + 反向 supersede 兜底，B19）

### 2.2 rollback_hot_update 真实实体（替换 5A 骨架）

```
rollbackHotUpdate(taskId, toVersion, actor):

  1. 校验 toVersion ∈ task 的 hot_update_events 历史 (existing, 5A)
  2. load currentVersion (任务最近 stage_attempts 的 version_hash)
  3. load proposedIR := getPipelineIR(db, toVersion)
     load baseIR := getPipelineIR(db, currentVersion)
  4. compute divergenceStage := findEarliestDivergence(baseIR, proposedIR, wires)
     — 基于 computePipelineDiff 返回的 stages.modified + stages.added + stages.removed
       取其中**拓扑序最早**的 stage name。若完全相同，返回 null（空 diff）。
  5. 合成 synthetic proposal:
     baseVersion = currentVersion
     proposedVersion = toVersion
     rerunFrom = divergenceStage
     migrateRunning = "all"（意味着当前 taskId）
     status = "approved"
     actor = rollback actor
     diagnostic_json = {__kind: "rollback-v1", originTaskId: taskId, rolledTo: toVersion}
  6. INSERT synthetic pipeline_proposals row
  7. invoke migrateTask(taskId, synthetic.proposalId) — same pipeline
  8. return migrateTask's result + eventId
```

**语义**：rollback = "反向 forward migration"。统一使用 migrateTask 管道，确保
relevant 所有失败兜底 / INTERRUPT 等待 / 反向 supersede 行为一致。

### 2.3 computeWireTransitiveReaders —— B13 精细粒度

**输入**：`PipelineIR`, `rerunFromStage: string`
**输出**：`Set<string>` —— stages that must be superseded

**算法**：
```
seedSet = {rerunFromStage}
visited = {rerunFromStage}
queue = [rerunFromStage]

while queue non-empty:
  stage = queue.pop()
  # 找所有以 stage 为 from 的 wire，提取 to.stage
  for wire in ir.wires where wire.from.source === "stage"
                          && wire.from.stage === stage:
    if wire.to.stage not in visited:
      visited.add(wire.to.stage)
      queue.push(wire.to.stage)

return visited
```

**正确性**：只跟随 wire 边，不跟随拓扑序。Parallel sibling（虽然拓扑序在 rerunFrom
之后，但无 wire 依赖）**不** 入 visited。

**对比 topoDownstream（5A 用）**：
- topoDownstream 用拓扑序 + 祖先关系 —— 粗估 impact，**正确**用于"预估影响面"
- computeWireTransitiveReaders 用 wire 因果 —— **精确**用于"必须 supersede 的集合"

**两者都保留**：impact.ts 用 topoDownstream 作 impact.affectedStages（预估）；
migrateTask 用 computeWireTransitiveReaders 作实际 supersede 集。

### 2.4 startPipelineRun 的 resumeFrom 分支（NEW）

**当前行为**：seed external inputs + 从 entry stage 开始跑
**新行为**（taskId 已存在时）：

```
startPipelineRun({..., taskId: existing, versionHash: newHash, resumeFrom: stageName}):

  1. 校验 taskId 在 stage_attempts 表中有记录（否则回落 fresh run）
  2. 校验 taskRegistry.get(taskId) === undefined（前面 INTERRUPT 已完成）
  3. skip external input seeding（lineage 已存在）
  4. 调 runPipeline({... resumeFrom: stageName, skipSeed: true})
     runner 从 resumeFrom 开始，读 port_values 恢复上游数据
```

runner 内部：
- 不 seed external_input（检测 resumeFrom 参数时跳过）
- 起始 stage = resumeFrom（不是 ir.entry）
- `dispatched` Set 预填充 resumeFrom 之前的 stage 名称（避免重复 dispatch）—— 通过
  查询当前 `stage_attempts WHERE status='success' AND task_id=?` 来重建
- 每个新 attempt 的 `version_hash` = newHash（不是旧 hash）

### 2.5 taskRegistry.awaitTermination —— 新机制

```ts
interface TerminationReason {
  kind: "natural" | "interrupted" | "error" | "never_started";
  detail?: string;
}

class TaskRegistry {
  register(taskId, dispatcher): void
  registerTermination(taskId, promise: Promise<TerminationReason>): void    // NEW
  awaitTermination(taskId, timeoutMs): Promise<TerminationReason | "timeout"> // NEW
  unregister(taskId): void  // now resolves pending termination promise
  get(taskId), size(), __clearForTest()
}
```

**runner 集成**：
```ts
// In runPipeline, after taskRegistry.register:
let resolveTermination: (reason: TerminationReason) => void;
const terminationPromise = new Promise<TerminationReason>((r) => { resolveTermination = r; });
taskRegistry.registerTermination(opts.taskId, terminationPromise);

// At run-final (line 327 and :543):
// Called with reason derived from machine state:
//   - completed normally → { kind: "natural" }
//   - INTERRUPT path → { kind: "interrupted" }
//   - error/throw → { kind: "error", detail: msg }
resolveTermination({ kind: ... });
taskRegistry.unregister(opts.taskId);
```

**一致性约束**：
- `awaitTermination` 仅在 `register` 之后可调用；若 `get(taskId)===undefined`
  直接返回 `{kind: "never_started"}`
- `unregister` 必须先 resolve termination promise，再删 dispatcher（避免 pending
  awaitTermination 挂起）
- timeout 路径：调用方（migrateTask）自己 Promise.race，registry 不超时

### 2.6 Diagnostic codes 新增

- `MIGRATION_INTERRUPT_TIMEOUT` — INTERRUPT 后 30s 内 runner 没终止
- `MIGRATION_RESUME_FAILED` — supersede 成功但新 runner 启动失败（已反向 supersede）
- `ROLLBACK_EMPTY_DIFF` — rollback 目标 version 与当前 version IR 完全相同

---

## 3. 模块边界与文件划分

### 3.1 新模块

```
apps/server/src/kernel-next/hot-update/
  ├── wire-reachable.ts           — computeWireTransitiveReaders
  ├── wire-reachable.test.ts
  ├── divergence.ts                — findEarliestDivergence(baseIR, proposedIR)
  ├── divergence.test.ts
  ├── migration-orchestrator.ts   — 端到端协调（INTERRUPT + supersede + resume）
  ├── migration-orchestrator.test.ts
  ├── rollback.ts                  — rollback_hot_update 真实实现（合成 proposal + migrate）
  └── rollback.test.ts
```

### 3.2 修改的现有模块

- `runtime/task-registry.ts` —— 加 termination promise 机制
- `runtime/runner.ts` —— 注册 termination 信号；支持 resumeFrom 参数
- `runtime/start-pipeline-run.ts` —— resumeFrom 分支
- `mcp/kernel.ts` —— `migrateTask` 大重构（拆到 migration-orchestrator）
                    `rollbackHotUpdate` 骨架替换为真实实现
- `ir/schema.ts` —— 3 个新 Diagnostic codes
- `mcp/server.test.ts` —— 断言不变（MCP 表面 shape 不变）

### 3.3 保留不动

- `hot-update/diff.ts` / `safe-range.ts` / `impact.ts` / `dry-run.ts` —— 5A 交付
- `runtime/topo-downstream.ts` —— 继续被 impact.ts 使用
- MCP server.ts tool shapes —— `migrate_task` 和 `rollback_hot_update` 对外形状不变

---

## 4. 数据流

### 4.1 典型热更新成功路径

```
User/AI → propose_pipeline_change(autoApprove=true, safeRange=safe)
          ↓
          kernel-ts: dry-run + persist proposal status='approved' + autoApplied=true
          ↓
User/AI → migrate_task(taskId, proposalId)
          ↓
          migrateTask orchestrator:
            1. lock
            2. INTERRUPT + awaitTermination(30s) → interrupted
            3. computeWireTransitiveReaders → supersedeSet
            4. snapshot pre-status
            5. TX: supersede + audit success
            6. startPipelineRun(taskId, proposedVersion, resumeFrom)
            7. new runner registers + starts from resumeFrom
            8. unlock
          ↓
          return {ok, eventId, newRunnerStarted: true}
```

### 4.2 rollback 成功路径

```
User/AI → rollback_hot_update(taskId, toVersion)
          ↓
          rollback.ts:
            1. validate toVersion ∈ history
            2. load current + target IR
            3. find divergenceStage
            4. synthesize approved proposal
            5. invoke migrateTask(taskId, synthetic.proposalId)
          ↓
          (same as 4.1 from step 1 onward)
          ↓
          return {ok, eventId, rolledTo: toVersion, divergenceStage}
```

### 4.3 失败路径：INTERRUPT timeout

```
migrateTask:
  ... lock acquired ...
  isRunning=true
  INTERRUPT dispatched
  await 30s → timeout
  ↓
  audit hot_update_events(failed, diagnostic: "interrupt timeout")
  release lock
  return {ok:false, diagnostics: [MIGRATION_INTERRUPT_TIMEOUT]}
```

supersede **未执行**；runner 仍在跑旧 version —— 降级正确。

### 4.4 失败路径：resume 启动失败

```
migrateTask:
  ... INTERRUPT + supersede success ...
  startPipelineRun → throws
  ↓
  TX: UPDATE stage_attempts SET status=<pre-supersede-snapshot>
      WHERE task_id=? AND stage_name IN supersedeSet
  audit hot_update_events(failed, diagnostic: "resume failed: ...")
  release lock
  return {ok:false, diagnostics: [MIGRATION_RESUME_FAILED]}
```

task 恢复到 migration 前的状态（status 按快照回滚），但 lineage 仍完整。

---

## 5. 测试计划

### 5.1 wire-reachable 单测

```
it("returns just {start} when start has no downstream wires")
it("follows single-edge wire chain")
it("excludes parallel sibling (B13 key)")
it("handles diamond: sibling branches not included when rerunFrom is the fork root's direct child")
it("handles cycle-free DAG with shared downstream: downstream included once")
it("rerunFrom absent in IR: returns empty set")
```

### 5.2 divergence 单测

```
it("identical IRs return null")
it("removed stage: divergence = removed stage (earliest in topo order)")
it("modified stage: divergence = modified stage")
it("added stage: divergence = added stage (if no modified earlier)")
it("multiple changes: returns earliest in topo order")
```

### 5.3 task-registry termination 单测

```
it("awaitTermination returns never_started for unregistered taskId")
it("unregister resolves pending awaitTermination")
it("awaitTermination after unregister immediately returns natural/stored reason")
it("multiple concurrent awaitTermination on same taskId all resolve")
```

### 5.4 runner resumeFrom 单测

```
it("resumeFrom starts actor from specified stage, not entry")
it("resumeFrom skips external input seeding")
it("resumeFrom rehydrates dispatched set from stage_attempts success rows")
it("resumeFrom: new attempts carry new versionHash")
it("fresh run (no resumeFrom): unchanged behavior")
```

### 5.5 migration-orchestrator 集成测

```
it("task idle (no runner) → skip INTERRUPT, proceed to supersede + resume")
it("task running → INTERRUPT + wait termination + supersede + resume")
it("INTERRUPT timeout 30s → MIGRATION_INTERRUPT_TIMEOUT, no supersede, no resume")
it("resume failure → UN-supersede + MIGRATION_RESUME_FAILED")
it("parallel sibling stage keeps running (B13)")
it("migration writes __kind='proposal-success-v1' diag preserved (5A invariant)")
```

### 5.6 rollback 集成测

```
it("rollback to unknown version → VERSION_NOT_IN_HISTORY")
it("rollback to same version → ROLLBACK_EMPTY_DIFF")
it("rollback single-step forward migration → new hot_update_events row + task resumes from divergence")
it("rollback after two forward migrations → correctly jumps to target (not intermediate)")
it("rollback during running task: INTERRUPT + supersede + resume from divergence")
```

### 5.7 对抗性测试

```
it("concurrent migrateTask on same taskId: second gets MIGRATION_IN_PROGRESS")
it("concurrent migrateTask on different tasks: both succeed")
it("INTERRUPT fires during very early stage (resume from entry): works correctly")
it("supersede + resume when current running stage IS rerunFrom: new attempt supersedes old running")
it("rollback ping-pong: forward → rollback → forward → rollback, state remains consistent")
it("A2.3.5 adversarial tests still pass (no regression in existing live-migration behavior)")
```

### 5.8 runner 不变量验证

```
it("taskRegistry.awaitTermination completes with kind='natural' on normal run-final")
it("taskRegistry.awaitTermination completes with kind='interrupted' when INTERRUPT delivered")
it("taskRegistry.awaitTermination completes with kind='error' on runner throw")
```

---

## 6. 并发与锁

### 6.1 现有 per-task migration lock（保留）

`migrationInProgress: Map<taskId, {proposalId, acquiredAt}>` —— process-local Map，
同一 taskId 二次 migrate 返回 MIGRATION_IN_PROGRESS。

### 6.2 INTERRUPT + awaitTermination 的竞态

**场景**：INTERRUPT 刚发出，runner 即将 unregister；另一个外部调用者也在 send
事件到 dispatcher。
**保证**：dispatcher 内部有 `currentActor` ref；INTERRUPT 触发 abort → run-final
→ unregister；其间其他事件进入 dispatcher.send 会命中 currentActor（可能已
stopped）或 registry 已 unregister 后直接丢弃。**这是现有行为，5B 不改变。**

### 6.3 resume 启动前的 dispatcher 空窗

**场景**：旧 runner unregister 后、新 runner register 之前，外部调用
taskRegistry.get(taskId) 返回 undefined。
**5B 保证**：
- migrateTask 整段过程持有 migrationInProgress lock，外部并发 migrateTask 会被
  MIGRATION_IN_PROGRESS 拒绝
- answer_gate / write_port 等外部调用若在空窗期到达，taskRegistry.get 返回
  undefined → 调用方自行决定（通常返回 "task not running"）—— 这是现有语义
- 空窗时长 = supersede TX 时间 + startPipelineRun 启动时间，通常 <100ms

---

## 7. 审计 / 可观察性

### 7.1 hot_update_events 已有字段无变化

5A 已用 `__kind: "proposal-success-v1"` 扩展 diagnostic_json 语义；5B 新增：

- `__kind: "migration-executed-v1"` —— migrateTask 成功路径的 audit diag
  包含 `{ supersedeSet, resumeFromStage, interruptWaitMs, newRunnerStarted }`
- `__kind: "rollback-v1"` —— rollback 路径的 audit diag
  包含 `{ rolledTo, divergenceStage, syntheticProposalId }`

向下兼容：消费方以 `__kind` 分派；无 `__kind` 视为旧行。

### 7.2 SSE 事件

**不新增 SSE 事件。** 5A 已决定 B5 wf.hotUpdatePending 推迟到 Phase 6。
既有 `port_written` / `stage_started` / `run_final` 继续适用。migrate 本身
不广播 SSE —— 调用方（MCP / REST）同步拿到结果即可。

---

## 8. 不做的清单（显式 YAGNI）

- **Graceful summary turn**（B10）—— 5C
- **Worktree 切换**（B9）—— 5C 依赖 checkpoint infra
- **Single-session 摘要注入**（B12）—— 5C
- **Foreach 中途改子 pipeline**（B17）—— kernel-next 无 foreach stage
- **Cost / latency 数值预估**（B7 后半部分）—— 需历史 metrics
- **rollback 的跨 task scope**（多 task 同时 rollback 到不同 version）—— 5B
  只做 per-task rollback，批量由调用方循环
- **SSE wf.hotUpdatePending**（B5）—— Phase 6
- **聚合查询 helpers**（B22）—— 5E

---

## 9. 与 5A 的兼容性约束

- `pipeline_proposals.diagnostic_json` 的 `__kind="proposal-success-v1"` 结构
  **只读不改**。5B 不覆写它
- `dry_run_proposal` 行为不变 —— 仍是纯读
- `propose_pipeline_change(autoApprove)` 行为不变 —— 5A 只改 propose 持久化，
  不启动 migration；autoApplied=true 后仍需调用方显式 migrate_task 才真迁
- `rollback_hot_update` MCP 表面（输入输出 shape）不变；body 从骨架换成真实

---

## 10. 风险与开放问题

### 10.1 resume 的 dispatched Set 重建

runner 的 `dispatched` Set 是 "已 invoke 过 executor 的 stage" 的去重。
resume 时要预填充它避免重复 invoke 已 success 的 stage。

重建逻辑：`SELECT DISTINCT stage_name FROM stage_attempts WHERE task_id=? AND status='success'`。
**风险**：若某 stage 有多个 attempt（retry），success 的 attempt 的 stage_name
重复出现，Set 去重后只占一个条目 —— 正确。

### 10.2 INTERRUPT 后 agent 的 "1 轮总结" 被丢弃

A2.3.3 的 AgentMachine.INTERRUPT 逻辑实际允许 "从 dispatching_tool 进入
waiting_for_claude 的 summary turn"（看 agent-machine.test.ts:143-155）——
这个 summary turn 的输出会进入 `agent_execution_details` sidecar。
**5B 不改这个行为** —— 让它自然发生。30s timeout 内正常终止即可，不需要
显式配合。

### 10.3 resume 失败反向 supersede 的原子性

**问题**：supersede TX 已 commit，若反向 UPDATE 也在独立 TX，中间可能有窗口
让外部观察到 "半 superseded" 状态。
**缓解**：反向 UPDATE 也在单 TX 中完成。外部观察 stage_attempts 时在 TX
边界看一致视图。

### 10.4 rollback_hot_update 对 "不连续" 历史的处理

**场景**：task 经过 forward v1→v2→v3，然后 migrate 失败回到 v2，再 rollback
到 v1。此时 hot_update_events 包含：
```
v1→v2 success
v2→v3 success
v3→v2 rolled_back
```
rollback 到 v1 时 known set = {v1, v2, v3}，v1 在内，通过。divergence 基于
current (v2) 和 target (v1) 的 IR 计算，不看历史。**这是正确的**。

### 10.5 MAX_TOTAL_ATTEMPTS 与 resume

runner 有 `MAX_TOTAL_ATTEMPTS = 50` 防无限重试。resume 走 runPipeline，计数
从 0 开始 —— 每次 migration 有独立的 50 次预算。**这是 desired** —— 否则
多次 migration 会累加到耗尽。

---

## 11. 成功标准

Stage 5B 完成条件：

1. `taskRegistry.awaitTermination(taskId, timeoutMs)` 可用并正确报告
   natural / interrupted / error / never_started / timeout
2. `runPipeline` 支持 `resumeFrom: stageName`，跳过 external seed，从指定
   stage 开始；新 attempts 带新 versionHash
3. `migrateTask`：
   - task idle 时 → supersede + resume
   - task running 时 → INTERRUPT + await + supersede + resume
   - INTERRUPT 30s timeout → MIGRATION_INTERRUPT_TIMEOUT，无状态变化
   - resume 启动失败 → 反向 supersede + MIGRATION_RESUME_FAILED
4. `rollback_hot_update` 真实执行：
   - 合成 approved proposal + 调 migrateTask
   - 空 diff → ROLLBACK_EMPTY_DIFF
   - 历史外 version → VERSION_NOT_IN_HISTORY (5A 已有)
5. B13 精细粒度：parallel sibling 的 running attempt 在 migration 过程中
   不被 supersede（除非它通过 wire 依赖 rerunFrom 链路）
6. 现有 a2-3-5-live-migration.adversarial.test.ts 仍然 green（无回归）
7. `pnpm --filter server test` 全绿；`npx tsc --noEmit` 零错误
8. 新增测试数 ≥ 30；关键不变量都有覆盖
9. `docs/product-roadmap.md` §7.2-7.6 B8/B11/B13/B19/B20(真实)/B21 状态更新
10. 5A → 5B 合约（`__kind=proposal-success-v1` 可读取，`migrate_task` /
    `rollback_hot_update` MCP shape 不变）全部成立

---

## 12. 实现顺序（plan 的骨架）

1. **Task 1**：Diagnostic codes + types (`MigrationOutcome`, `TerminationReason`)
2. **Task 2**：`wire-reachable.ts` 纯函数 + 测试
3. **Task 3**：`divergence.ts` 纯函数 + 测试
4. **Task 4**：`task-registry.ts` termination 机制 + 测试
5. **Task 5**：`runner.ts` 集成 termination signal + 测试
6. **Task 6**：`runner.ts` + `start-pipeline-run.ts` resumeFrom 分支 + 测试
7. **Task 7**：`migration-orchestrator.ts` 主流程 + 测试（含失败兜底）
8. **Task 8**：重构 `KernelService.migrateTask` 委托给 orchestrator
9. **Task 9**：`rollback.ts` 真实实现 + 测试
10. **Task 10**：重构 `KernelService.rollbackHotUpdate` 委托给 rollback.ts
11. **Task 11**：对抗性测试 + A2.3.5 回归验证
12. **Task 12**：docs + handoff
13. **Task 13**：全量 verify
