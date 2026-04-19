# kernel-next A2-A8 完成情况 + F1-F8 修复 + 下阶段计划

> Created: 2026-04-19, updated 2026-04-20 (F1-F8 done)
> Author: Opus 4.7 (与产品 owner 协作)
> Status: A2-A8 code-complete + **all F1-F8 follow-ups merged**
> Parent: `docs/kernel-next-terminal-design.md` §11.1

这个文档用来让下一个 session 直接恢复上下文。**先读 §0**（最新状态），其余章节是历史归档（F1-F8 前的 review 现场）。

新 session 读完本文档 §0 + `docs/kernel-next-terminal-design.md` §11 就能对齐。A2-A8 已验收，3 个 Critical + 5 个 Concerns 全部清零。

---

## 0. 2026-04-20 更新 — F1-F8 完成情况

### 0.1 本轮交付 (32021b5..HEAD 之前的 8 个 commit)

| Commit | Fix | 内容 | Δ tests |
|---|---|---|---|
| `37b6d08` | F1 | fanout 聚合落 port_values + tie-break 查询 | 0 (断言更新) |
| `81e7781` | F2 | A8 migrate 暴露到 MCP (propose rerunFrom/migrateRunningTasks + migrate_task tool) + REST POST /api/kernel/tasks/:taskId/migrate | +7 |
| `a04f8e6` | F3 | NO_ACTIVE_WIRE 结构化诊断 `context.failedWires[]`（upstream-not-written / guard-false / guard-threw） | +2 |
| `7dda2f0` | F4 | codegen 支持 §7.3 fanout wire 类型兼容（plain / from-fanout / to-fanout / both-fanout 四种变换） | +4 |
| `6247dc2` | F5 | migrateTask 进程级 serial-per-task lock + 失败写 status='failed' 审计 + MIGRATION_IN_PROGRESS/MIGRATION_FAILED 错误码 | +4 |
| `1b40b1d` | F6 | GATE_TARGET_SHARED 结构校验（同一 stage 被多 gate routing 时拒绝） | +2 |
| `32021b5` | F7 | docs: 对齐 INTERRUPT 语义 — 承认 summary turn 成功时 final status='done'，interruptArmed 留作 sidecar audit 区分 | 0 (docs-only) |
| `ec73b9a` | F8 | guard 表达式 word-boundary regex deny-list (require/import/process/globalThis/global/eval/Function/constructor/prototype/__proto__) | +10 |

**累计**: 3982 → 4010 (+28), 0 regression, tsc clean。

### 0.2 Reviewer 三个 Critical 的结论

- **Critical #1 (A8 surface gap)** → F2 修复 ✓
- **Critical #2 (fanout lineage 不入库)** → F1 修复 ✓
- **Critical #3 (NO_ACTIVE_WIRE 静态诊断)** → F3 修复 ✓

Reviewer 原 APPROVE_WITH_FIXES 的三条 blocker 全部消化，A 系列现在可以标 "done"。

### 0.3 Concerns 清理

- C1 (codegen fanout) → F4 ✓
- C2 (migrate 失败审计 + 锁) → F5 ✓
- C3 (gate target 冲突) → F6 ✓
- C4 (INTERRUPT 语义) → F7 选 option A 改文档 ✓
- C5 (guard-evaluator onError 无人调用) → F3 自然消化 ✓
- C6 (guard deny-list) → F8 ✓
- C7 (每请求 new KernelService) → not applicable，无需动 ✓

### 0.4 架构 debt 更新（原 §4）

1. **A2.3 是 A8 真正做 live migration 的前置** — 仍成立。当前 A8 只跑 DB 交易，"in-flight migration 中途 interrupt AgentMachine" 需要 A2.3 把 AgentMachine 作为 XState invoked child 嵌套进 stage region `executing` state。
2. **`createKernelMcp` 默认 combined** — 仍是 debt。F2 新增的 `migrate_task` 放在 EXTERNAL_TOOLS 集合里；后续做 flip-default 时不用再调整它。
3. **`runner.ts` 仍叠 workaround**：silent fanout runtime + log-scan NO_ACTIVE_WIRE 兜底。F3 改进了诊断质量，但运行机制没改。A2.3 时可考虑把 silent-fanout 改为 PortRuntime 上的 `writeAggregatePort()`；log-scan 可 retire（走结构化 diagnostic 事件）。
4. **`stage_attempts.status` 没 CHECK constraint** — 仍是 debt。F1 的 aggregate attempt 复用 'success' 状态，未新增状态值。下次 schema 改动时可一起加 CHECK。
5. **Fanout 绕过 CompositeStageExecutor** — 仍是 debt。F1 改动在 runner 层面加了 aggregate attempt，但仍用 silent runtime 路径；A2.3 重构时一并处理。
6. **（新）guard deny-list 硬编码在 guard-evaluator.ts** — F8 的 `DENIED_IDENTIFIERS` 是模块常量。如果将来需要每 pipeline 可配置（例如某些 pipeline 明确需要 `value.constructor`），需要改为 options 注入。当前单用户场景不需要。
7. **（新）fanout aggregate attempt 在 stage_attempts 里没有 `kind` 列标识** — F1 把 aggregate 写成普通 attempt（最高 idx）。`queryLineage` / `readLatestPort` 用 `attempt_idx DESC` tie-break 来挑它。这个约定没有 schema 层表达，未来 schema 改动时可加 `kind='aggregate'` 列。

### 0.5 下一大切片：A2.3（task #91 blocked 清除）

F1-F8 全清后，task #91 依赖解除。A2.3 目标：
- AgentMachine 作为 XState `invoke` 嵌入 stage region `executing` state
- stage region 的 `INTERRUPT` / `MIGRATION_REQUESTED` 事件能传给嵌套的 AgentMachine
- F2 埋下的 `migrate_task` runner 广播接口接上真正的 live-migration 路径
- F5 的 MIGRATION_IN_PROGRESS 锁配合 runner 的 dispatcher 可以在 stage boundary 真正 hand-off

推荐切片顺序（待下 session 进一步拆分）：
1. AgentMachine actor wrapper（executor.ts 接 XState spawnChild）
2. stage region 的 executing substate 替换为 invoke
3. INTERRUPT 事件穿透 + 测试
4. migrate_task → runner dispatcher 的广播
5. A8 live-migration adversarial test

### 0.6 开工前 checklist

- [ ] `git log --oneline -10` 应看到 `32021b5` 在顶部（F7 docs）
- [ ] `git status -s` 只有未追踪的 docs/superpowers 文件
- [ ] `cd apps/server && ./node_modules/.bin/tsc --noEmit` 干净
- [ ] `cd apps/server && ./node_modules/.bin/vitest run` 4010 passed / 5 skipped
- [ ] 本文档 §0 读完

---

## 下面是 2026-04-19 原始 review + 计划（历史归档）

以下内容保留用作审计；**F1-F8 已全部完成**，下节提到的"Critical 必须在标 done 前处理"已经失效。

---

这个文档用来让下一个 session 直接恢复上下文：
1. A2-A8 实际落地了什么
2. 独立 code reviewer 的 blocker / concern 清单
3. 下一步的执行顺序与每项切片建议

新 session 读完本文档 + `docs/kernel-next-terminal-design.md` §11 就能对齐。不要默认 claim "A-series 已验收"，见 §2/§3 critical issue。

---

## 1. 本轮交付 (HEAD~8..HEAD, 2026-04-19)

| Commit | Phase | 范围 | 测试增量 |
|---|---|---|---|
| `9ec0e25` | A2.1 | 纯 AgentMachine (6 state / 10 event) + SDK adapter | +26 |
| `71dc563` | A2.2 | 把 AgentMachine 接到 RealStageExecutor；引入 `queryFn` 注入点 | +3 |
| `cb3b721` | A3.1 | Wire guards (`new Function` eval) + NO_ACTIVE_WIRE 诊断 + stage meta 按 wire 存 guard | +15 |
| `4498dc2` | A3.2 | Gate routing exclusivity — 只有 gate 授权 + 上游 delivered 才激活 target | +2 |
| `3afb7eb` | A3.3 | 最小 fanout — sequential N attempts + 聚合 array（**lineage 有债，见 §2.2**） | +4 |
| `dd7a4be` | A4 | `get_task_status` MCP + REST，gated 状态 + pending question payload | +13 |
| `6c69f54` | A5 | lineage 在 parallel + fanout 场景的验证测试 | +3 |
| `8c4d7ad` | A6 | MCP external/internal surface 物理分离（external 不含 `write_port`） | +5 |
| `7f8c023` | A7 | tech-research 风格端到端集成测试 + 补齐 gate skipped-branch 机制 | +5 |
| `1b9efa0` | A8 | kernel 层 hot-update forward migration (propose/migrateTask + hot_update_events) | +9 |

**累计**: 3844 → 3982 测试（+138），0 regression，`tsc --noEmit` clean。

---

## 2. Critical — 必须在 A 系列标"done"前处理

这三条是 **已经写进 commit message 但实际不成立** 的能力，reviewer 指出是"广告不实"。优先级最高。

### 2.1 A8 migration 没有 MCP/REST 入口 (Reviewer critical #1)

**现状**:
- `KernelService.propose(args)` 支持 `rerunFrom` + `migrateRunningTasks`，`KernelService.migrateTask(taskId, proposalId)` 完整实现。
- `apps/server/src/kernel-next/mcp/server.ts:143-167` 里 `propose_pipeline_change` tool schema 只接受 `{ currentVersion, patch, actor }`，handler 没把 `rerunFrom` / `migrateRunningTasks` 传给 service。
- `migrate_task` 这个 tool **根本没注册**。也没有对应 REST route。

**后果**: design §10.1 / §10.5 "main Claude via MCP approves + migrates" 的路径在 external surface 上不存在。A8 目前只是 DB 层。

**修法**:
1. `propose_pipeline_change` input schema 加 `rerunFrom?: string`、`migrateRunningTasks?: z.union([z.literal("all"), z.literal("none"), z.array(z.string())])`，handler 透传。
2. 注册新 tool `migrate_task({ taskId, proposalId })`，handler 调 `kernel.migrateTask(...)`，成功时（可选）通过 `taskRegistry` 广播一个 migration 事件给 live runner —— **A2.3 落地前** runner 对此事件 no-op 即可。
3. 新建 REST route `POST /api/kernel/tasks/:taskId/migrate` body `{ proposalId }`，对齐 kernel-gates 的错误信封风格。
4. `server.test.ts` tool 数断言 13 → 14。
5. 新建 `routes/kernel-tasks.test.ts` 扩展（或 `kernel-migrate.test.ts`）覆盖 404/409/200 三种 HTTP 状态。

**约束**: 5 文件上限 —— `server.ts`, `kernel-tasks.ts`, `server.test.ts`, kernel-tasks 新测试, 可能 `index.ts`。刚好。

### 2.2 Fanout 聚合结果没有落到 `port_values` (Reviewer critical #2)

**现状**:
- `runner.ts:380-430` `runFanoutStage` 用一个 silent `PortRuntime`（inert dispatcher）跑每个元素的 executor。每个元素的 output 写入 `port_values`（per-element 行），但 **aggregated array 只通过 `liveDispatcher.send({type:'PORT_WRITTEN', ...})` 进入 machine context**。
- 聚合值没进 DB。`read_port(stage='F', port='doubled')` 最新行是 last element 的 scalar，不是 `T[]`。`query_lineage` 同样残。

**后果**:
- §1.3 "never regress already-executed information" 被实际打脸 —— 外部观察者（主 Claude、dashboard）看到的 fanout 值和运行时不一致。
- 这正是 fanout 测试能过的原因：测试只读 `result.portValues`（in-memory context），没读 DB。

**修法**:
1. `runFanoutStage` 聚合完成后，在 `liveDispatcher` 对应的真 `PortRuntime` 上开一个"aggregate attempt"（`startAttempt`），然后对每个 declared output 调 `writePort(attemptId, stageName, portName, array)`。这同时会 dispatch PORT_WRITTEN，所以手动 `liveDispatcher.send` 可以删掉 —— 一条 code path。
2. `stage_attempts` 的这个 aggregate attempt 的 `attempt_idx` 在该 stage 是 N+1（N 是 element 数），用一个专门的 marker field 或约定不需要 —— lineage 查询看 `stage_name + port_name + direction='out'` 即可。
3. 更新 `A5 lineage` / `A3.3 fanout` 测试：assertion 改成"最新 port_values row 的 value 是聚合数组"。

**权衡**: 这会让 fanout stage 的 `attempt_idx` 序列里多出一个 aggregate 行，和 §8.1 的数据模型兼容（`port_values.attempt_id` 仍指向合法 attempt）。替代方案是给 `port_values` 加 `kind='aggregate'` 列，但工程量更大。推荐走方案 1。

### 2.3 NO_ACTIVE_WIRE 诊断丢失 §6.2 要求的证据 (Reviewer critical #3)

**现状**:
- `runner.ts:136-138` 和 `:196-198` 两处都 emit 同一句静态 message：`"NO_ACTIVE_WIRE: every inbound wire to 'X' resolved false — stage cannot activate"`。
- `evaluateGuard` 在 compiler 里调用时 **没传 `onError`**，所以 runtime 异常（`value.foo.bar` 类型）被 silently coerce 为 false。AI 作者拿不到任何 hint。

**设计要求 §6.2**: "including the stage name, all inbound wires, and the port values that made each guard false"

**修法**:
1. Compiler 的 `wireDelivers` / `noDeliverableWire` 在 guard 求值失败时把 `{wire.from, wire.to, guardExpr, valuePreview, reason}` push 到一个 per-machine `context.guardFailures: GuardFailure[]`（新 context 字段）。
2. Runner 在扫 log 发现 `<stage>:error` 时，从 `context.guardFailures` 过滤该 stage 的失败 wire 列表，包装成 diagnostic `context`：
   ```ts
   stageErrors.push({
     stage,
     message: `NO_ACTIVE_WIRE: ...`,
     context: { failedWires: [...] },
   })
   ```
   需要 `RunResult.stageErrors` 条目加 optional `context` 字段。
3. `guard-evaluator.ts` 的 `onError` hook 保留（reviewer concern #5），compiler 真正用上。

---

## 3. Concerns — Reviewer 列出的次要问题，开工 A9/A-series 清零前要决定

| # | 问题 | 建议处理时机 |
|---|---|---|
| C1 | Codegen 不懂 fanout（`emit-ts.ts` 没实现 §7.3 的 `T[]→T` 特殊规则）。任何 fanout pipeline 过 tsc 都会挂。A7 用 `skipTypeCheck` 绕过。 | 在 §2.2 修完后立刻补，否则 production fanout 不可用。 |
| C2 | `migrateTask` 的事务包住 UPDATE + INSERT；失败时 ROLLBACK，没写 `status='failed'` 的审计行；也没 §10.2 的 `MIGRATION_IN_PROGRESS` lock。 | 和 §2.1 一起做 —— 失败路径应该先写 failed 事件再 rethrow。 |
| C3 | 多 gate routing target hazard —— 同一 stage 出现在两个 gate 的 routing 里，会同时 authorised + skipped。没有 validator 规则拒绝。 | 加一条 `GATE_TARGET_SHARED` 结构校验，或让 skip 谓词检查 `!authorized`。 |
| C4 | INTERRUPT 语义 drift：设计文档说 interrupt + summary turn → `status='interrupted'`；实现里如果 summary turn 产生 RESULT_SUCCESS，会 `status='done'`（测试已锁定）。上游丢失 interrupt 信号。 | 二选一：改文档（承认"干净的 summary turn 记成功"）或改机器（`interruptArmed` 时 final 强制 interrupted）。**需要与 owner 对齐后再动。** |
| C5 | `guard-evaluator` 的 `onError` 有 API 没调用方。 | §2.3 修完自然消化。 |
| C6 | `new Function` eval 经过 `submit_pipeline` 的 external MCP 进入。单用户本地可接受，但加一条正则 deny `require/import/process/globalThis/eval` 几乎无代价。 | 低优先级，单独一条小 commit。 |
| C7 | `kernel-tasks.ts` 每请求 new KernelService —— 和其他 route 一致，no-op。 | Not applicable。 |

---

## 4. Architectural debt（知情接受，后续 session 注意切入点）

1. **A2.3 是 A8 真正做 live migration 的前置**。当前 A8 只跑 DB 交易 —— "happy path" 的原意是"task 在 stage boundary 完成后被迁移"，不是"正在跑中被 interrupt"。A8 adversarial + live migration 要等 A2.3（AgentMachine 作为 XState invoked child 嵌套进 stage region 的 executing state）落地。
2. **`createKernelMcp` 默认 `surface: "combined"`**，14+ caller 还依赖。A6 只做了分离支持，没做迁移。后续一次把 demo/generator-real/sdk-probe 等改为显式 surface，然后 flip default 到 `"external"`，把 `"combined"` 变 deprecation alias。
3. **`runner.ts` 叠了 3 个 workaround**：`dispatched` set 兼做 seen-marker、log-scan 兜底 NO_ACTIVE_WIRE、silent dispatcher 处理 fanout。A2.3 落地时考虑把 silent-fanout 改成 PortRuntime 上一个 `writeAggregatePort()`，顺便 retire log-scan（§2.3 修完后 NO_ACTIVE_WIRE 可走结构化诊断而非 log 扫描）。
4. **`stage_attempts.status` 没 CHECK constraint**。A8 新增 `'superseded'`，没人把它约束住。下次 schema 改动时顺手加。
5. **Fanout 绕过 CompositeStageExecutor**。Composite 目前仍可用（因 runner 拿到的 `executor` 本身就是 Composite，Composite 内部按 type route），但语义上不干净。如果将来要加 `GateStageExecutor`，runner 的 fanout bypass 要重新审。

---

## 5. Next session 的执行顺序（推荐）

按依赖链 + 风险顺序：

```
F1. 先修 §2.2 (fanout lineage)            ~4 文件，含 runner + 2 tests + 可能 codegen
  └─ 这条修完才能信任 fanout 的 lineage；也简化 runner
F2. 修 §2.1 (MCP/REST surface for A8)    ~5 文件
  └─ 让 A8 真能被外部调用
F3. 修 §2.3 (NO_ACTIVE_WIRE 诊断)         ~4 文件 (compiler + runner + schema + test)
  └─ 消化 Concern C5
F4. 修 Concern C1 (codegen fanout §7.3)   ~2 文件 (emit-ts + test)，否则 fanout + tsc 仍破
F5. 修 Concern C2 (migrateTask failed audit + lock)
F6. 修 Concern C3 (多 gate target 冲突)
F7. 与 owner 对齐 C4 INTERRUPT 语义 → 改文档或改机器
F8. Concern C6 guard regex deny-list
```

每一步都遵守 CLAUDE.md 规则：
- ≤5 files per commit / phase
- commit 前跑 `./node_modules/.bin/tsc --noEmit` + `./node_modules/.bin/vitest run`
- 不回滚已经验证过的 executed information（§1.3）
- 不用 git 操作未经确认

F1-F3 完成后才能把 A 系列标 "done"。F1-F8 全部清零后进 A9 持续验证 + A2.3（TaskMachine nest）作为下一个大切片。

---

## 6. 新 session 快速恢复指南

**必读**:
1. 本文档（验收基线 + 待办）
2. `/Users/minghao/workflow-control/docs/kernel-next-terminal-design.md` §3, §4, §6, §9, §10, §11
3. `/Users/minghao/workflow-control/CLAUDE.md`（项目约定）+ 全局 `~/.claude/CLAUDE.md`（agent directives）

**关键入口点**:
- Runtime: `apps/server/src/kernel-next/runtime/{runner,agent-machine,sdk-adapter,real-executor,guard-evaluator}.ts`
- Compiler: `apps/server/src/kernel-next/compiler/ir-to-machine.ts`
- Kernel service: `apps/server/src/kernel-next/mcp/kernel.ts`
- MCP server: `apps/server/src/kernel-next/mcp/server.ts`
- REST routes: `apps/server/src/routes/kernel-{gates,tasks,proposals}.ts`

**基准测试**:
- 启动前 baseline: `3982 passed / 5 skipped`
- 跑法: `cd apps/server && ./node_modules/.bin/vitest run`

**开工前 checklist**:
- [ ] 读本文档 §2 critical 部分
- [ ] `git log --oneline -12` 确认停在 `1b9efa0`（A8）
- [ ] `git status -s` 确认 working tree 干净（未追踪的 docs/superpowers 文件无关）
- [ ] `./node_modules/.bin/tsc --noEmit` 干净
- [ ] `./node_modules/.bin/vitest run` 3982 passed

**不要做的事**:
- 不要合并 §2.1 + §2.2 + §2.3 到一个 commit —— 每个独立切片，独立 review。
- 不要在 A2.3 落地前给 `migrateTask` 加"中途 interrupt"逻辑 —— 语义上需要 AgentMachine nest。
- 不要改 A7 `a7-tech-research.test.ts` 用真实 SDK —— 按 owner 指示保持 mock。
- 不要在 §2.2 修好前新增任何依赖 `port_values` 里存在聚合数组的测试。

---

## 7. Verdict

Reviewer: **APPROVE_WITH_FIXES**

结论: A2-A8 的 state machine / runtime / DB 层面是对的；XState 组合、gate 路由独占、AgentMachine turn-level 语义都正确实现并有扎实测试。Critical 三条是外围接线（surface、lineage、诊断）的缺漏而非核心逻辑 bug。

下 session 开工优先级: §2.2 → §2.1 → §2.3 → Concerns → A2.3 大切片。
