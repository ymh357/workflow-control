# Stage 5A — Propose 链路完整化 Design

**Goal:** 把 kernel-next 的 `propose_pipeline_change` 从 "只持久化一行 pending
proposal" 升级到 "AI 可以用的完整 propose 闭环"。覆盖 roadmap B1 / B2 / B3
(Dry-run + Auto-approve) / B4 (Safe 范围) / B7 (Dry-run impact) / B14 (乐观锁)
/ B15 (删 stage 校验) / B16 (schema drift 原子校验) / B17 (Foreach schema 兼
容) 八项。

**Scope boundary：** 本 spec 不涉及 5B Migration 执行引擎、5C 中止与切换、
5D Parallel group 精细粒度、5E 收尾（rollback / 聚合查询 / 老 handler 清
理）。Runner 侧改动仅限 "迁移后如何让 runner 知道新 baseVersion"，真实
interrupt / worktree migration 留 5B。

---

## 1. 现状硬事实

| B 项 | 现状 (grep 验证) | Gap |
|---|---|---|
| B1 `propose_pipeline_update` | `propose_pipeline_change` MCP 已存在。`patch.ts` 150 行，支持 add_stage / remove_stage / add_wire / remove_wire / update_port_type / update_stage_config | 未实现 dry-run、impact、auto-approve |
| B2 `update_registry_pipeline` | 无 | 全缺 |
| B3 Dry-run + Auto-approve | grep `dry_run\|autoApprove\|auto_approve` 零命中 | 全缺 |
| B4 Safe 范围 | grep `safeRange\|safe_range` 零命中 | 全缺；当前 propose 默认 autoApplied=false 要求人工 approve |
| B7 Dry-run impact | 无 | 全缺 |
| B14 乐观锁 | `propose(currentVersion, patch, ...)` — `currentVersion` 即乐观锁，不匹配时 reject | ✅ 已有 |
| B15 删 stage | patch.ts remove_stage 级联删 wire | ✅ patch-level ok，但**无 "已完成 stage 下游是否引用其 writes" 的校验** |
| B16 Schema drift 原子 | patch 本身原子应用 + 最终一次 validate | ✅ patch 内部原子；但未校验 "runtime 已有 port_values 与新 IR 冲突" |
| B17 Foreach 中途改 | 无 foreach stage 类型 —— kernel-next 目前只有 agent / script / gate | N/A，但需 spec 明确 "未来如加 foreach 必须 schema-compat 校验" 的 hook |

现有 `propose_pipeline_change` 语义：
```
propose(currentVersion, patch, actor?, rerunFrom?, migrateRunningTasks?) →
  { ok, proposalId, proposedVersion, autoApplied: false } |
  { ok: false, diagnostics }
```
链路：`applyPatch → validateStructural → validateDag → validateTypes →
emitPipelineModule → pipelineVersionHash → 写 pipeline_proposals 行`。

---

## 2. 目标语义

### 2.1 新增 MCP `dry_run_proposal`

唯读工具。AI 先调这个观察影响，再决定是否真的 `propose_pipeline_change`。

**输入：**
```
{
  currentVersion: string,       // 乐观锁，必须匹配当前活跃 version
  patch: IRPatch,
  rerunFrom?: string | null,    // optional；null = 纯 forward
  migrateRunningTasks?: "all" | "none" | string[],
}
```

**输出（成功时）：**
```
{
  ok: true,
  diff: PipelineDiff,                 // §3
  impact: Impact,                     // §4
  safeRange: SafeRangeVerdict,        // §5
  wouldAutoApprove: boolean,          // safeRange.verdict === "safe" 且无 impact 阻塞
  proposedVersion: string,            // 纯函数式计算，不入库
}
```

**输出（失败时）：**
```
{
  ok: false,
  diagnostics: Diagnostic[],
}
```

**关键约束：**
- **不写任何行。** 不 INSERT pipeline_proposals，不 INSERT pipeline_versions
  （`proposedVersion` 只是 hash 计算结果，入库由 propose 真正执行时负责）
- **幂等、无副作用。** 多次调用不产生 drift
- 乐观锁校验失败时返回 `CONFLICT` diagnostic，**不**返回 diff / impact

### 2.2 升级 MCP `propose_pipeline_change`

保留原参数，新增：
```
{
  ... (原参数),
  autoApprove?: boolean,   // 默认 false。true 时：
                            //   - safeRange.verdict === "safe" → 自动 approve
                            //   - safeRange.verdict === "unsafe" → 忽略 autoApprove，返回 pending
}
```

**行为变化：**
- Propose 内部首先内部调用 dry-run 计算 `diff + impact + safeRange`
- 把 `diff + impact + safeRange` 序列化进 `pipeline_proposals.diagnostic_json`
  （现已存在字段，原用途 "validate errors on failure path"——我们扩展它的语义，
  见 §6）
- `autoApprove=true` 且 `safeRange.verdict==="safe"` 时：同事务 INSERT proposal
  + UPDATE status='approved'，返回 `{ ok:true, proposalId, proposedVersion,
    autoApplied: true, diff, impact, safeRange }`
- 其他情况：仍然 `autoApplied: false`，等外部 `approve_proposal`

### 2.3 新增 MCP `update_registry_pipeline` (B2)

**范围限定：** 这个工具修改 **Registry 文件系统层** 的 pipeline 定义，**不**
触发任何活跃 task 的迁移。语义：AI / 人手直接改"模板"。

**输入：**
```
{
  pipelineName: string,    // registry 目录下的 pipeline 名
  newIR: PipelineIR,       // 完整 IR（不是 patch，因为没有 "当前 registry 版本" 乐观锁的意义）
  actor?: string,
}
```

**行为：**
- `validateStructural → validateDag → validateTypes → emitPipelineModule`
- 成功：
  - 覆写 `apps/server/src/builtin-pipelines/{name}/pipeline.ir.json`
  - 写新 `pipeline_versions` 行（insertPipelineVersion）
  - 返回 `{ ok:true, versionHash, path }`
- 失败：返回 `{ ok:false, diagnostics }`
- **不**写 `pipeline_proposals`，**不**触发 migrate

**与 `submit_pipeline` 的区别：**
`submit_pipeline` 把新版本塞进 DB，不改 registry 文件。`update_registry_pipeline`
还额外覆写磁盘 IR 文件，让下次 `run_pipeline` by name 读到新版本。
Registry 文件是 "默认入口"，所以需要独立工具。

### 2.4 新增 MCP `rollback_hot_update` (部分 B20)

**范围限定：** 仅暴露接口、写 audit；**不**执行真正的状态回滚（状态回滚需要
5B migration 执行引擎 + worktree 支持）。接口先到位是为了 audit trail 闭
环，避免 5B 反复改 MCP 表面。

**输入：**
```
{
  taskId: string,
  toVersion: string,     // 目标版本 hash
  actor?: string,
}
```

**行为（本 spec 范围）：**
- 校验 `toVersion` 是 `hot_update_events` 里此 taskId 的历史 `from_version`
  或 `to_version` 之一（否则 `VERSION_NOT_IN_HISTORY`）
- 写一行 `hot_update_events(status='rolled_back', from_version=current,
  to_version, actor, proposal_id=null, rerun_from_stage=null)`
- 返回 `{ ok:true, eventId, diagnostic: "接口占位；真实回滚由 5B 提供" }`

**5B 交接：** 5B 把真实 supersede + DB 事务 + runner 唤起 挂到现有接口上；
MCP 形状不变。

---

## 3. PipelineDiff 结构

```typescript
interface PipelineDiff {
  stages: {
    added:    StageIR[];                                   // 新 stage 完整定义
    removed:  { name: string; stage: StageIR }[];          // 被删 stage 定义
    modified: StageDiff[];                                 // 下述
  };
  wires: {
    added:   Wire[];
    removed: Wire[];
    // wire 没有 "modified" —— 改 from/to 等同 remove + add
  };
  routing: {
    gateRoutingChanged: { stageName: string; before: GateRouting; after: GateRouting }[];
    rejectRollbackChanged: { stageName: string; before: RejectRollback | null; after: RejectRollback | null }[];
  };
  // B18 meta：标记此 diff 属于 "safe 只改 prompt/reads/writes/budget" 四类中的哪一类
  // 每个 StageDiff 有 category；这里汇总全 patch 的 union。
  categoryUnion: ("promptOnly" | "portsOnly" | "budgetOnly" | "structural")[];
}

interface StageDiff {
  stageName: string;
  type: "agent" | "script" | "gate";
  changes: {
    promptRef?:   { before: string; after: string };
    moduleId?:    { before: string; after: string };
    question?:    { before: Question; after: Question };
    inputs?:      { added: Port[]; removed: Port[]; typeChanged: PortTypeChange[] };
    outputs?:     { added: Port[]; removed: Port[]; typeChanged: PortTypeChange[] };
    // future: budget?: { before, after }
  };
  category: "promptOnly" | "portsOnly" | "budgetOnly" | "structural";
}
```

**diff 计算算法：** 纯函数 `computePipelineDiff(baseIR, proposedIR):
PipelineDiff`。实现：
1. 按 name key，分三组：仅 base / 仅 proposed / 两边都有
2. 仅 base = `stages.removed`；仅 proposed = `stages.added`
3. 两边都有的，逐字段比较 → `stages.modified`
4. Wires 按 (from, to, port) 四元组 key，类似处理
5. `category` 推断规则：
   - stages.added / stages.removed 非空 → 涉及的 StageDiff 标 `structural`
   - StageDiff.changes 仅含 `promptRef` → `promptOnly`
   - StageDiff.changes 含 inputs / outputs 变化且变化是**纯增加 input port（reads 扩展）
     或纯删除无引用的 output**→ `portsOnly`
   - 其他 → `structural`

---

## 4. Impact 分析（B7）

```typescript
interface Impact {
  activeTasks: TaskImpact[];
  newSubmissionsOk: boolean;      // 新 task 用 proposedVersion 能否正常启动
  schemaDriftIssues: SchemaDriftIssue[];
}

interface TaskImpact {
  taskId: string;
  currentStage: string | null;       // 当前正在 running 的 stage，或 null（idle）
  affectedStages: string[];          // 在 proposed IR 下会被 superseded 的 stages（∈ rerunFrom 的下游 ∪ 被 removed 的 stage）
  resumable: boolean;                // 能否靠 rerunFrom 继续；false 时必须 reject
  blockingReasons: string[];         // resumable=false 时的原因
}

interface SchemaDriftIssue {
  kind: "port_type_change_with_live_values"
      | "removed_stage_with_downstream_readers"
      | "removed_output_with_active_consumers";
  stageName: string;
  portName?: string;
  details: string;
}
```

**计算方式：**

1. **活跃 task 定位：** 查询所有满足 `EXISTS(SELECT 1 FROM stage_attempts WHERE
   task_id = t AND version_hash = currentVersion AND status IN ('running',
   'pending'))` 的 taskId
2. **currentStage：** 每个 task 取最新 attempt 的 stage_name
3. **affectedStages：** 在 proposed IR 下调用 `computeDownstream(proposedIR,
   rerunFrom)` ∪ `stages.removed.map(s=>s.name)`
4. **resumable：**
   - 若 currentStage ∈ stages.removed → `resumable=false`,
     blockingReasons += "current stage removed"
   - 若任何 已完成 stage 的 output port 在 proposed 被删且该 port 有下游 reader →
     `resumable=false`, blockingReasons += ...
   - 否则 `resumable=true`
5. **schemaDriftIssues：** 扫 port_values 表，对每个 port_type_change：
   - 如果该 (stage, port) 在当前 DB 有 port_values 行且新 type 不兼容旧 value →
     `port_type_change_with_live_values`
   - 其他类比

**"schema-compat" 判断：** 在本 spec 使用"结构相等"—— JSON schema 结构严格一致算
兼容，任何 property 变化都算不兼容。未来可升级到 "proposed schema 是 base 的超
集" 判断，但 5A 先保守。

---

## 5. Safe 范围判定（B4）

```typescript
interface SafeRangeVerdict {
  verdict: "safe" | "unsafe";
  category: "promptOnly" | "portsOnly" | "budgetOnly" | "structural";
  reasons: string[];       // unsafe 时给出人话说明
}
```

**决策表：**

| diff 包含 | safe? | 原因 |
|---|---|---|
| stages.added / stages.removed 任一非空 | unsafe (structural) | "新增/删除 stage 是结构性改动" |
| wires.added / wires.removed 任一非空 | unsafe (structural) | "新增/删除 wire 是结构性改动" |
| routing.gateRoutingChanged 或 rejectRollbackChanged 非空 | unsafe (structural) | "改 routing 是结构性改动" |
| StageDiff.changes 含 inputs/outputs 变化 | unsafe (structural) | "改 port schema 是结构性改动"（可 B17 放宽） |
| StageDiff.changes 仅含 promptRef | safe (promptOnly) | |
| StageDiff.changes 仅含 moduleId | unsafe (structural) | "改 script module 可能影响输出 schema" |
| StageDiff.changes 仅含 question | unsafe (structural) | "改 gate 问题影响路由" |
| StageDiff.changes 仅含 budget | safe (budgetOnly) | 未来字段 |
| impact.schemaDriftIssues 非空 | 一律 unsafe | "runtime 数据与新 schema 冲突" |
| impact.activeTasks[].resumable === false 任一 | 一律 unsafe | "会 block 活跃 task" |

**"safe" 的意义：** `propose(autoApprove=true)` 可自动 approve + 自动
migrate（migrateRunningTasks 参数仍然生效，决定影响哪些 task）。

**"unsafe" 的意义：** 必须经人工 `approve_proposal`，且 AI 在 dry-run 能看到
reasons 决定是否继续。

---

## 6. diagnostic_json 语义扩展

当前 `pipeline_proposals.diagnostic_json`：
- 成功路径：NULL
- 失败路径：validate errors 的 JSON 数组

本 spec 改为：
- 成功路径：`{ diff, impact, safeRange }` JSON 对象（"审批档案"）
- 失败路径：不变（errors 数组）

**schema versioning：** 顶层加 `"__kind": "proposal-success-v1"` 或
`"__kind": "validate-errors"`，reader 以 `__kind` 分派解析。迁移兼容：旧行
无 `__kind`，视为 `validate-errors`。

---

## 7. Pipeline IR 格式无破坏性变化

- 不新增 stage type
- 不新增 wire 字段
- `versionHash` 算法不变
- `pipeline_proposals` / `hot_update_events` 表结构不变（只扩展
  `diagnostic_json` 的 JSON 形状）
- **新增一张表：** 暂不需要；所有新数据都可入既有表

---

## 8. SSE 事件 —— B5 `wf.hotUpdatePending` 暂不实现

- 本项目是本地单人 CLI 工具，dashboard 层极简
- 保留 audit trail（hot_update_events）已足够观察
- Phase 6 如需 dashboard 化再补

---

## 9. 模块边界与文件划分

```
apps/server/src/kernel-next/hot-update/
  ├── diff.ts              — computePipelineDiff 纯函数
  ├── diff.test.ts
  ├── impact.ts            — computeImpact（需要 db 句柄）
  ├── impact.test.ts
  ├── safe-range.ts        — classifyDiff / safeRangeVerdict 纯函数
  ├── safe-range.test.ts
  ├── dry-run.ts           — orchestrates diff + impact + safeRange；纯读
  └── dry-run.test.ts
```

`kernel.ts` 扩展：
- `propose()` 内部先调 `dryRun()` 拿 verdict，再根据 `autoApprove` 分派
- 新增 `dryRunProposal()` 方法（对应 MCP 工具）
- 新增 `updateRegistryPipeline()` 方法
- 新增 `rollbackHotUpdate()` 方法（骨架）

`server.ts` 扩展：
- 新增 `dry_run_proposal` tool 注册（EXTERNAL surface）
- 新增 `update_registry_pipeline` tool 注册（EXTERNAL）
- 新增 `rollback_hot_update` tool 注册（EXTERNAL）
- `propose_pipeline_change` 参数加 `autoApprove`

---

## 10. 测试计划

### 10.1 diff 单测

- added-only 补一个 stage
- removed-only 删一个 stage + 级联删 wire
- modified promptOnly
- modified portsOnly (input 加一个)
- modified structural (output 删除)
- categoryUnion 合并
- 空 patch → 空 diff（categoryUnion=[]）

### 10.2 safe-range 单测

- promptOnly → safe
- portsOnly (input added) → unsafe (保守)
- structural → unsafe
- 空 diff → safe（category 为空）
- 有 schemaDriftIssues → unsafe 覆盖 promptOnly

### 10.3 impact 单测

- 无活跃 task → activeTasks=[]
- 一个 running task，stage 不在 affected → resumable=true
- 一个 running task，currentStage 在 removed 里 → resumable=false
- port_type_change 且 port_values 存在冲突 → schemaDriftIssues
- port_values 类型兼容 → 无 issue

### 10.4 dry-run 集成测（不写 DB）

- 运行前后查 `SELECT COUNT(*) FROM pipeline_proposals` 保持不变
- 运行前后查 `SELECT COUNT(*) FROM pipeline_versions` 保持不变
- 乐观锁失败 → `CONFLICT` diagnostic，不返回 diff

### 10.5 propose autoApprove=true 路径

- safeRange=safe + autoApprove=true → 返回 `autoApplied: true`，DB 里
  pipeline_proposals 行 status='approved'
- safeRange=unsafe + autoApprove=true → 返回 `autoApplied: false`，status='pending'
- autoApprove=false（默认）→ 永远 status='pending'

### 10.6 update_registry_pipeline

- valid IR → 磁盘文件被覆写 + pipeline_versions 有新行
- invalid IR → 磁盘文件不动 + 错误诊断
- 并发调用同一 pipelineName → 最后写赢（本地单人，无锁）

### 10.7 rollback_hot_update 骨架

- taskId 无迁移历史 → `VERSION_NOT_IN_HISTORY`
- taskId 有历史且 toVersion ∈ 历史 → 写 audit 行 + 返回 `{ ok, eventId,
  diagnostic: "接口占位..." }`

### 10.8 对抗性测试

- dry-run 大 patch（50 个 add_stage）→ 性能合理（<100ms）
- dry-run 并发调用 100 次 → 无竞态、无 DB 变动
- propose autoApprove=true 触发边界竞态：两个 AI 同时 autoApprove 不同 patch
  → 乐观锁必定 reject 一方

---

## 11. 与 5B 的交接面

5B 将：
- 用 `dryRun()` 的 `impact.activeTasks` 驱动真正的 graceful interrupt + worktree
  migration
- 用 `safeRangeVerdict` 决定是否需要人工批准（5A 已提供，5B 消费）
- 用 `rollback_hot_update` 骨架挂真实状态回滚

5A 交付后 5B 的改动面：主要在 `runtime/` 而非 `hot-update/`。本 spec 设计
已保证 `hot-update/` 模块在 5B 无需大改。

---

## 12. 风险与开放问题

### 12.1 "Schema 兼容" 的严格等价判断过保守

B17 Foreach 场景要求 "兼容即可"。本 spec 初版用严格等价判断，会把某些实
际安全的改动 (比如 port 加一个 optional 字段) 判成 unsafe。**缓解：** 先
严格，有具体需求时再基于 JSON Schema subset 判断升级。

### 12.2 `update_registry_pipeline` 的 "registry 目录" 路径硬编码

当前硬编码 `apps/server/src/builtin-pipelines/{name}/pipeline.ir.json`。
**缓解：** 接受硬编码；registry 结构短期不变。未来如引入 external registry
再重构。

### 12.3 无法在 dry-run 阶段真的保证 propose 与 dry-run 输出完全一致

dry-run 是无锁读；propose 是加锁写。两者之间 DB 状态可能变化（新 task
启动、port_values 变化）。**缓解：** Impact 是 "best-effort advisory"，
AI 应知道 dry-run 到 propose 之间有窗口。文档要显式说明。

### 12.4 `safeRange="safe"` 但 impact.activeTasks 非空时的行为

promptOnly 改动 + 有活跃 task → safe=true，autoApprove 会自动迁移。**这是
预期行为**，因为 promptOnly 改动对运行中的 task 只影响下次 stage 的 prompt
内容，不破坏 lineage。rerunFrom 由 AI 显式指定。

### 12.5 乐观锁粒度

`currentVersion` 是全局 pipeline 版本，不是 task 级。**预期**：两个 AI 同时
propose 不同 patch 到同一 version，第二个必然 CONFLICT。这是正确行为，让
AI 看到 conflict 后重新 dry-run。

---

## 13. 不做的清单（显式 YAGNI）

- **SSE 事件 `wf.hotUpdatePending`**（B5）：本地工具无 dashboard 紧迫性
- **Auto-approve 的跨流程批准队列**：MCP 同步返回 `autoApplied: true` 即可
- **Impact 的 cost / latency 预估**：需要历史 metrics，5A 无数据基础；只输
  出结构性影响，不估算数值
- **Diff 的 "可视化" 输出格式**：JSON 即可，AI 能读
- **Patch 反向（inverse patch）生成**：5B rollback 真要回滚时再做
- **`update_registry_pipeline` 的 "版本历史"**：覆盖即可，registry 是模板
  不是审计对象

---

## 14. 成功标准

Stage 5A 完成条件：

1. `dry_run_proposal` MCP 可用，返回 `{ diff, impact, safeRange,
   wouldAutoApprove, proposedVersion }`，**零 DB 写入**
2. `propose_pipeline_change` 支持 `autoApprove` 参数；safe 改动在同事务内
   approve；unsafe 仍然 pending
3. `update_registry_pipeline` MCP 可用，覆写 registry 文件 + 写 pipeline_versions
4. `rollback_hot_update` MCP 骨架可用（写 audit 行，返回占位 diagnostic）
5. `PipelineDiff / Impact / SafeRangeVerdict` 三层纯函数各自有独立单测覆盖
6. 对抗性测试：并发 dry-run 无 DB 变动；autoApprove 乐观锁竞态正确
7. `pnpm --filter server test` 全绿
8. `pnpm --filter server tsc --noEmit` 零错误
9. `docs/product-roadmap.md` §7.2-7.5 表格中 B1/B2/B3/B4/B7/B14/B15/B16/B17
   状态更新

Runner 侧改动推迟到 5B。
