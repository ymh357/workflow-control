# Workflow Control: Product Roadmap

> Version 1.0 | 2026-04-18
> 本文档是 workflow-control 产品化的 north star。所有后续实施 session 以此为准。
> 本文为活文档，随实施推进可修订；修订须标注日期与理由。

---

## 目录

1. [产品定位与目标](#1-产品定位与目标)
2. [核心架构诊断](#2-核心架构诊断)
3. [战略决策](#3-战略决策)
4. [瘦身清单](#4-瘦身清单)
5. [场景判断机制](#5-场景判断机制)
6. [A 系列：基础设施](#6-a-系列基础设施)
7. [B 系列：真热更新](#7-b-系列真热更新)
8. [开发原则](#8-开发原则)
9. [成熟度指标](#9-成熟度指标)
10. [实施顺序](#10-实施顺序)
11. [决策索引](#11-决策索引)

---

## 1. 产品定位与目标

### 1.1 产品形态

- **本地运行、单用户产品**：一台 server 进程服务一个用户
- **作者即用户**：主要打磨者本人是主要使用者
- **AI-mediated DSL**：YAML pipeline 由 AI 代写代调，用户（含作者本人）不需手写 YAML
- **可共享的配置**：pipeline / fragments / skills 可跨用户共享，需严格隔离本地路径与环境特定信息

### 1.2 产品目标

打磨成成熟可用的产品。成熟度定义见 §9。

### 1.3 明确不做的事

- 不做 SaaS、不做托管
- 不做多租户、多用户认证
- 不做企业合规、不做审计追溯（仅做产品迭代所需的审计）
- 不做 YAML 可视化编辑器（YAML 由 AI 代写）
- 不做 Gemini / Codex / Edge Runner 的新功能

---

## 2. 核心架构诊断

### 2.1 方向对的地方

- XState 作为编排骨架
- YAML DSL + AI 代写代调
- Pipeline 结构保持静态（仅运行时路由选择 + 数据驱动 foreach）
- Git-native worktree 隔离
- 本地单用户定位

### 2.2 两个隐患

**隐患 1：缺少"适用场景边界"**
- 没有机制判断"这个任务适不适合走 pipeline"
- 会导致用户在短任务上浪费 pipeline 开销，得出"不如直接用 Claude Code"的错误结论

**隐患 2："AI 代写代调"缺乏基础设施**
- AI 看不到真实执行记录（没有 ExecutionRecord）
- AI 看不到 pipeline 历史版本（没有版本化）
- AI 不知道 store 字段的形状（没有 schema）
- AI 没有调试工具（没有 dry_run / replay / diff）

### 2.3 "运行时动态调整"的精确定义

- **层级 1（运行时路由选择）**：已有，合理，可靠（llm_decision、condition、on_approve_to 等）
- **层级 2（数据驱动 foreach）**：已有，合理
- **层级 3（配置热更新）**：当前是半拉子，B 系列彻底重做
- **层级 4（运行时生成新 stage）**：不做

### 2.4 "必然好于 Claude Code"的边界

仅在满足以下至少三条的任务上成立：
- 长任务、多阶段、多分支、需要 gate、需要成本控制、需要并行、需要可重放

且前提是 pipeline 设计正确（A/B 系列解决这个前提）。

---

## 3. 战略决策

| ID | 决策 |
|---|---|
| S1 | **先 A 后 B**，严格串行。A 完全完成才动 B |
| S2 | **立即瘦身**。在 A/B 新工作量之前执行 |
| S3 | **AI 自动判断场景 fit**。落在每个 pipeline 开头，不 fit 时 early exit |

---

## 4. 瘦身清单

| 模块 | 处理 | 说明 |
|---|---|---|
| Gemini 引擎 | **已退役 2026-04-24** | Stage 4a 删除，kernel-next 不再支持 |
| Codex 引擎 | **已退役 2026-04-24** | Stage 4a 删除，kernel-next 不再支持 |
| Edge Runner | **已退役 2026-04-24** | Stage 4a 删除 |
| Slack Bridge | **完全删除** (已退役 Phase 0) | slack-cli-bridge 独立 app 删除，所有相关依赖、测试、文档清理 |
| Registry / 发布系统 | **保留并打磨** | 支持跨用户 pipeline / fragment 共享；严格隔离本地路径、用户名、环境变量等机器特定信息，使用 `$WORKTREE_PATH` / `$USER_HOME` 占位符 |
| Single-session 模式 | **TODO / 暂未回补 2026-04-24** | kernel-next 当前仅 multi-session（Stage 4a 删除了 legacy SessionManager）。Terminal design §2.5 原文是"multi-session default; single-session kept as a path if proven simpler" —— 即 **保留作为回补路径**，不是永久退役。2026-04-22 (d4c23ff) 文档 cleanup 时被过度改写为"已退役"，实为 roadmap 错误。决策流程：先做 multi-session 优化（prompt caching + read_port MCP）并跑 benchmark；若 token 成本 vs legacy R1 的 3-5x 差距可缩到 ≤1.5x 则保持 multi-session-only；否则回补 single-session（预估 4-8 周，含 SessionActor + AgentMachine 重构 + IR session_group 扩展 + migration 双模式适配）。完整评估：2026-04-24 session 记录。相关：B10 / B12 与此决策绑定。|
| 架构白皮书（zh + en） | **暂停维护** | 等 A/B 完全落地后重写。期间 README 指明"文档滞后" |
| 内置 pipeline | **大瘦身** | 只保留：`pipeline-generator`、`tech-research`、`web3-tech-research`。其他（包括 `linear-dev-cycle`）删除 |
| Converter (legacy YAML → IR) | **已退役 2026-04-24（Stage 4b）** | 4 个 builtin 改用 pipeline.ir.json canonical form |

---

## 5. 场景判断机制 ~~（作废，2026-04-19 D5 决策）~~

> **本节整体作废**。triage-as-system-router 方案不再实施——pipeline-generator
> 在 task 创建路径上已覆盖"这个 task 该走哪个 pipeline"的职责，多套一层
> llm_decision 只增成本不增价值。保留本节文字作为历史记录，不作为实施目标。
> 详见 Phase 0 补做议题的 0.6 终判。

### ~~5.1 触发方式~~

- ~~系统强制要求每个 pipeline 的第一个 stage 是 `triage` 类型~~
- ~~允许 pipeline 在顶层声明 `skip_triage: true` 显式豁免~~
- ~~`pipeline-validator` 在构建期检查：未声明 skip_triage 的 pipeline 第一个 stage 必须是 triage~~

### ~~5.2 载体~~

- ~~新增内置 pipeline `task_triage`~~
- ~~Server 在 task 路由时先跑 task_triage~~

### ~~5.3 实现~~

- ~~底层机制：`llm_decision` + Sonnet 中等~~

### ~~5.4 豁免~~

- ~~`skip_triage: true` 的 pipeline：跳过 triage~~

---

## 6. A 系列：基础设施

**实施顺序**：A1 → A2 → A3 → A4，严格串行。

### 6.1 A1：执行记录（ExecutionRecord / StageMemory）

**预估工作量**：3-4 周

**存储后端**：SQLite 新表 `execution_records`

**字段全量**（8 项全记录）：

1. 完整 system prompt（agent 实际看到的组装后内容，包含 fragment 激活、invariants、output schema）
2. Tier1 context + reads 的具体值（readsSnapshot）
3. 所有 tool calls + results
4. Agent 所有 text 输出 + thinking 内容
5. Parsed writes vs 实际 commit writes（区分"agent 说要写什么"和"实际写进了什么"）
6. Cost / token / duration / model / session_id
7. Worktree diff（stage 启动前 vs 结束后的 git diff）
8. Scratch pad 快照 + PreCompact 触发点（原为 single-session 场景关键；single-session 目前未回补，参见 §4 行 105 TODO。multi-session 下等价物 **已落地 2026-04-24 Phase 4.5 T1**：`agent_execution_details.compact_events_json` 新列；每次 SDK 的 `compact_boundary` 事件记录 `{ trigger, preTokens, startedAt, endedAt }`。源头是 SDK adapter 已有的 `COMPACT_STARTED` / `COMPACT_ENDED` 事件，real-executor 映射到 writer.appendCompactEvent / completeCompactEvent）

**保留策略**：永久保留，手动清理

**清理后门**：CLI 工具 `prune-kernel-records prune --task-id=X` / `--older-than=30d`（legacy 同名 CLI 已在 Stage 6 删除；kernel-next 版运行在 kernel-next.db 上，清理 `stage_attempts` + `agent_execution_details` + `script_execution_details` + `stage_checkpoints` + `port_values` + `gate_queue` + `migration_hints`，`hot_update_events` 作为审计记录保留）

**StageMemory 多 attempt 策略**：全部保留（一个 stage 可能多次 attempt，全入库）

**与 SSE 的关系**：SSE 保留用作实时 UI，同步写入执行记录（从同一数据源 fanout）

**与 snapshot 的关系**：snapshot 只存 XState context，执行记录存所有衍生过程数据

**Store 历史快照**：存在 `execution_records.readsSnapshot` 字段内，不单独建表

**Termination reason 枚举**：
- `natural_completion`
- `interrupted_by_hot_update`
- `interrupted_by_user`
- `error_exceeded_retries`
- `superseded_by_retry`
- `superseded_by_hot_update`

**Status (2026-04-24 Phase 4.5 Step 1 + Tier 4)**: kernel-next-adapted
A1 nearly complete. Sidecar tables in kernel-next.db:
- `agent_execution_details` (Stage 6) — per-agent-attempt prompt + tool
  calls + agent stream + cost + lifecycle
- `script_execution_details` (Phase 4.5 Tier 4, 2026-04-24) — per-script-
  attempt module_id + inputs/outputs snapshot + error + duration +
  termination_reason. Parallel schema + writer shape to the agent
  sidecar. Pre-provisioned `stdout` / `stderr` / `exit_code` columns
  reserved for future executor modes (ctx.logger, child_process.spawn)
  — current TS-function ScriptModule leaves them NULL.
**A1 field #7 (worktree diff) landed in Phase 4.5 Step 1**:
new `stage_checkpoints` table FK'd to stage_attempts records
`before_sha` / `after_sha` / cached `diff_text` using
scratch-index snapshot (no ref mutation, includes untracked). Fire-and-forget capture
via PortRuntime AttemptHooks; awaited before run_final.
**A1 field #8 (compact events) landed in Phase 4.5 T1 (2026-04-24)**:
new `compact_events_json` column on `agent_execution_details` records
`{trigger, preTokens, startedAt, endedAt}` per SDK compact_boundary;
writer API `appendCompactEvent` / `completeCompactEvent` wired into
real-executor via adapter events. Single-session scratch-pad
capture is absorbed by `single-session 回补` (§4 line 105 TODO).
Legacy `workflow.db.execution_records` table + `lib/execution-record/`
module deleted in Stage 6.

---

### 6.2 A2：Pipeline 版本化

**预估工作量**：2 周

**版本号生成**：内容 hash
- 算法：parse YAML → 对象 → 递归排序 key → JSON.stringify → SHA256
- **深 hash**：pipeline 引用的所有 fragment 内容一起计入 hash（fragment 改 = pipeline 版本变）
- 忽略注释和空格

**Task 与 pipeline 版本的绑定**：
- Task 创建时 snapshot pipeline 完整 config 到 task 存储
- **Snapshot 语义**：存"当前正在使用的 pipeline 完整 config"，每次 migrate 时覆盖更新
- **Snapshot 自含**：Task.json 不依赖 registry 即可 replay（朋友拿到 task.json 能独立 replay）
- 历史中间版本从 audit trail 重建

**保存位置**：扩展 `{data_dir}/tasks/:id.json`，添加 `pipelineSnapshot` 字段

**版本清理**：永久保留，手动清理（与执行记录对齐）

---

### 6.3 A3：Store Schema

**预估工作量**：4-6 周

**表达形式**：Pipeline YAML 顶层 `store_schema` 字段（扩展现有字段）

**Drift 检测**：Pipeline 构建时 error（最严）
- validatePipelineLogic 拒绝构建 drift 的 pipeline
- 早发现，防止发布坏 pipeline

**结构性 drift 处理**：
- 如"stage_4 改为并行组 → 下游 stage_5 reads 不兼容"这类情况
- **必须原子地一起改**：一次 propose 必须同时修改 stage_4 结构和 stage_5 reads，否则 reject
- 不允许"分两次提交"的渐进式破坏兼容性

**迁移内置 pipeline**：
- A3 落地时把 `pipeline-generator`、`tech-research`、`web3-tech-research` 改为带 store_schema 的版本
- 作为范例和测试用例

**Status (2026-04-24 Phase 4.5 Tier 3)**: **IR 层 + validator 层已落地**（commit `397ff4c`）：
- `PipelineIR.store_schema` 可选顶层字段（zod `StoreSchemaSchema`）
- 每个 entry 结构：`{ type: string; description?: string; produced_by: { stage, port } }`
- 新 validator `validateStoreSchema`，三个 drift code：
  `STORE_SCHEMA_STAGE_MISSING` / `STORE_SCHEMA_PORT_MISSING` / `STORE_SCHEMA_TYPE_MISMATCH`
- 已挂到 `KernelService.validate`（`submit_pipeline` 走通这条链）和 `dryRunProposal`（propose_pipeline_change + dry_run）
- Deep TS 等价延 defer 到 tsc（与 port.type 一致）
- **4 个 builtin pipeline 已迁移 store_schema** (Phase 4.5 T5, 2026-04-24)：smoke-test (3 entries) / tech-research-collector (8) / tech-research-writer (5) / pipeline-generator (24)。采用机械镜像策略（每个 stage output → 一个 store_schema entry），type 从 port 直接复制以满足 STORE_SCHEMA_TYPE_MISMATCH 规则；不走 pipeline-generator 真 API 重生成路径以保留历代手工调优。

---

### 6.4 A4：调试工具（MCP 工具集）

**预估工作量**：持续迭代，MVP 3 个月

**依赖**：A1 + A2 + A3 全部完成

**工具集合**（待详细设计）：
- `analyze_task_failure(taskId)`：AI 读执行记录，给出诊断 ✅ Phase 4 (debug-queries)
- `propose_pipeline_fix(taskId, aiPatch?)`：基于诊断给出 pipeline 改动建议 ✅ Phase 4.5 T6 (2026-04-24) AI-driven patch synthesis 完成。两层架构：
  - **Rule-based 层**（默认，`aiPatch=false`）：对 analyzeTaskFailure 的每条 hint 产 severity-tagged suggestion（kind ∈ {stuck_open / error_status / error_in_stream / interrupted / superseded / zero_attempts}），每个包含 description + rationale。target stage 不在当前 IR 的 suggestion 自动过滤。
  - **AI-driven 层**（`aiPatch=true`）：`proposePipelineFixWithAi` 对每个非 info suggestion 调 `AiPatchSynthesizer.synthesize` 并行产 IRPatch。生产实现 `createClaudeSdkPatchSynthesizer` 走 Claude SDK 单次 query()，返回 `{ops: [{op:'update_stage_config', stage, configPatch:{promptRef}}]}` 或 `NO_PATCH`。Safe-range gate：只接受 `update_stage_config`（roadmap §7.2 B4）。当前 iteration 只允许 configPatch 改 promptRef；其他 safe-range 字段（budget/reads/writes）留待未来扩展。Synth 错误/null/非 safe-range 时 suggestion 照常 ship 无 patch。
- `dry_run_stage(pipelineVersion, stageName, inputs)`：不跑整 pipeline 试单 stage ✅ Phase 4.5 Tier3（新 `debug/dry-run-stage.ts` + MCP tool；合成 task_id=`dry_run-<uuid>`，attempt kind='dry_run'；inputs 按 port name 平铺提供；inert dispatcher，不触发任何 XState machine；preflight: PIPELINE_VERSION_NOT_FOUND / STAGE_NOT_FOUND / STAGE_NOT_DRY_RUNNABLE（gate）/ MISSING_INPUT / EXECUTOR_THREW）
- `compare_runs(taskId_a, taskId_b)`：两次执行的结构化对比 ✅ Phase 4.5 T3 (2026-04-24)。新 `mcp/compare-runs.ts` + MCP external tool。per-stage 对比 cost / token / duration delta、prompt-content-hash 是否变化、tool-call 计数及 name-set 差异、compact-event 计数、termination_reason。选择每 stage 最后一个 kind∈{regular, fanout_aggregate, replay, dry_run} 的 attempt。script stage 对应 null delta（无 AED）。`diff_runs` 保留作 port-output-level 的快速对比。
- `replay_stage(attemptId)`：重放某 stage 的具体 attempt ✅ Phase 4.5 Tier2（新 `debug/replay-stage.ts` 核心 + MCP tool；新 attempt kind='replay' + replayed_from_attempt_id；inputs 从 lineage reads 重建；源 attempt 不被修改；仅支持 regular agent/script 的 attempt）

**设计原则**：这些工具都给 AI 用，让 AI 形成"任务失败 → 分析 → 修改 → 验证"的闭环

---

## 7. B 系列：真热更新

**前提**：A 系列完全完成才动 B

### 7.1 核心语义

**热更新的本质**：修改 Registry 中的 pipeline 文件（影响新 task 默认行为），同时可选地把**指定的**正在跑的 task 迁移到新版本。

**不是**：直接修改某个正在跑的 task 的本地 pipeline。

### 7.2 入口与审批

| # | 决策 |
|---|---|
| B1 | **统一 MCP 工具 `propose_pipeline_update`**：人（Web UI → 后端 → MCP）和 AI 都用这个入口 ✅ 5A（作为 `propose_pipeline_change`） |
| B2 | **Registry 文件独立入口 `update_registry_pipeline`**：人直接改 YAML 文件 + AI 调这个 MCP（不跑 task 时改模板） ✅ 5A |
| B3 | **Dry-run + Auto-approve**：AI 调 propose → 系统算 diff + migration plan + impact → safe 范围内 auto apply，范围外 block 等 confirm ✅ 5A（`dry_run_proposal` + `propose_pipeline_change(autoApprove)`） |
| B4 | **Safe 范围默认**：只改 prompt / reads / writes / budget 四项。结构性改动（加/删 stage、改路由、改 parallel 结构）一律要 confirm ✅ 5A（promptOnly 已识别；portsOnly/budgetOnly 类别预留） |
| B5 | **Confirm UI**：Web dashboard，复用现有 human_confirm 的 SSE + UI 机制，新增 SSE 事件 `wf.hotUpdatePending` —— 延期 Phase 6（本地单人工具无 dashboard 紧迫性） |

### 7.3 Migration 控制

| # | 决策 |
|---|---|
| B6 | **propose 参数 `migrateRunningTasks`**：`'all'` \| `'none'` \| `[taskId...]`，显式指定 ✅ 已有 |
| B7 | **Dry-run 输出含 impact 分析**：列出每个活跃 task 的迁移成本预估、cost 增量、延迟预估 ✅ 5A（结构性 impact + resumability；cost/latency 数值预估延期，需历史 metrics） |
| B8 | **同步触发**：propose apply 时同步触发所有指定 task 的 graceful stop + migration ✅ 5B（INTERRUPT + `awaitTermination` 硬切；graceful summary turn 在 5C 前用 INTERRUPT 兜底） |

### 7.4 中止与恢复

| # | 决策 |
|---|---|
| B9 | **Worktree 切换**：git reset 到改动 stage 的 checkpoint + 旧 diff 写进 StageMemory 作参考 ⚠️ 部分落地 Phase 4.5 Tier2：新 `migration_hints` 表捕捉被 supersede attempt 的 diff，RealStageExecutor consume 后注入新 attempt system prompt 作为"Migration note" advisory。**完整 B9 (git reset --hard before_sha)** 延后 —— 需要先补 task-worktree 独占 ownership 契约（Phase 5C worktree 生命周期）后再做，否则多 task 共享 workdir 时 reset 不安全 |
| B10 | **Session 中止**：Graceful——给 agent 1 轮写总结再停。预期延迟 10-60s |
| B11 | **不相关的 running stage**：让它跑完，后续 stage 用新 pipeline 定义 ✅ 5B（`computeWireTransitiveReaders` 只 supersede 有 wire 依赖的 stage；sibling attempt 不受影响） |
| B12 | **Single-session 热更新**：开新 session。旧对话历史以摘要形式注入新 session 的 tier1 —— 依赖 single-session 回补（§4 行 105 TODO）。Multi-session 架构下不适用（每个 stage 本就是新 session）；等价能力由 port-level summary handoff 提供（agent 被 interrupt 前写 summary 到指定 port，下游 stage 读该 port），待 single-session 决策后细化 |
| B13 | **Parallel group 热改**：**精细粒度**（B 起上来就实现）——只中止被改的 child，sibling 继续跑。group-level staged writes 与新 child writes 协调合并 ✅ 5B（`wire-reachable.ts` BFS，diamondIR 对抗测试证明 A fork 的 sibling branch 不被 supersede） |

### 7.5 一致性约束

| # | 决策 |
|---|---|
| B14 | **乐观锁**：propose 时必须带当前 pipeline 版本 hash，不匹配 reject with CONFLICT ✅ 5A（dry-run + propose 路径均在 baseVersion 缺失时返回 CONFLICT） |
| B15 | **删 stage**：允许，但前提是无下游 reads 引用它的 writes。校验规则：删 stage 后，其 writes 在旧版本中无被引用 ✅ 5A（`impact.ts` 判定 `removed_stage_with_downstream_readers` 与 `resumable=false` 触发 blockingReason） |
| B16 | **结构性 schema drift**：必须原子地一起改，否则在 propose 阶段 reject ✅ 5A（`port_type_change_with_live_values` 在 dry-run impact 中暴露，safeRange 降为 unsafe） |
| B17 | **Foreach 中途改子 pipeline**：强制新旧子 pipeline 的 outputs schema 兼容。已跑 item 保留，剩余 item 用新子 pipeline，append 到同一 collect_to ✅ 完整落地 Phase 4.5 T2+T7 (2026-04-25)。kernel-next 的"数据驱动 foreach" 对应 `fanout`（schema.ts:49 + AttemptKind fanout_element/fanout_aggregate）。migration-orchestrator 保留 `kind='fanout_element' AND status='success'` 的 attempts，只 supersede 未完成 element + aggregate + 其他 regular attempt（T2）。`stage_attempts.fanout_element_idx INTEGER` 列记录 0-based element 索引（CHECK 约束保证 fanout_element 行必有 idx；T7 完整版）；orchestrateFanoutStage 在循环开始前查 `(task_id, stage_name)` 已 success 的 idx 集合，跳过这些索引并把它们的 port 输出塞进聚合数组 —— 新 runner 不再为已保留的 element 开冗余 attempt。schema 兼容强制由 validateTypes / validateStoreSchema 统一覆盖。|
| B18 | **AI 决定 retry_from**：dry-run 返回 impact 分析给 AI → AI 根据分析结果在 propose 参数内显式声明 `rerun_from: stage_1` 或 `null` ✅ 5A（dry-run 返回 `impact.activeTasks[].affectedStages`；`propose.rerunFrom` 已有） |

### 7.6 兜底与审计

| # | 决策 |
|---|---|
| B19 | **Migration 失败兜底**：回滚到上一版本继续跑 + 显示错误给 AI/用户 ✅ 5B（INTERRUPT timeout → 零状态变化；supersede TX 失败 → 事务回滚；resume 失败 → 反向 supersede 恢复 pre-migration status；所有路径写 status='failed' 审计行） |
| B20 | **用户回滚**：提供 `rollback_hot_update(taskId, toVersion)` MCP 工具。和 audit trail 联动 ✅ 5B（`executeRollback` 合成 approved proposal → `executeMigration`；支持跨多版本跳跃回滚；写 status='rolled_back' 审计行） |
| B21 | **Audit trail**：独立的 `hot_update_events` 表，字段包含 timestamp / actor (user/AI) / fromVersion / toVersion / diff / migration plan / 成功失败 / 每个受影响 task 的结果 ✅ 已有；5A 扩展 `pipeline_proposals.diagnostic_json` 为 `__kind=proposal-success-v1` 携带 diff+impact+safeRange |
| B22 | **聚合指标**：hot_update_events 可聚合查询 AI 热更新次数、成功率、回滚率。用于识别"哪个 pipeline 被 AI 频繁改 = 本身设计有问题" ✅ 5E（`query_hot_update_stats` MCP 返回 total / success / failed / rolled_back / byPipelineName / byActor / topChurn） |

### 7.7 递归边界

**场景**：AI 在 pipeline-generator 里跑，AI 想改 pipeline-generator 本身。

**处理**：
- propose 改 registry 文件 **不** 影响当前正在跑的 generator task（除非 migrateRunningTasks 显式指定包含当前 task_id）
- 当前 task 用的是已 snapshot 到 task.json 的 pipelineSnapshot，registry 文件变化与其解耦
- 若 AI 明确想改自身正在跑的 pipeline：必须在 migrateRunningTasks 里显式 opt-in

### 7.8 老 UPDATE_CONFIG 清理

- B 系列完成后，彻底删除 `machine.ts:112` 的 UPDATE_CONFIG handler
- 相关测试、类型定义一并清理

---

## 8. 开发原则

### 8.1 不保 Backward Compatibility

- 研发期数据从头
- 旧 task 归档到另一个目录，无法操作
- 不为旧数据写 migration 脚本
- 每次大改动后 `rm -rf {data_dir}` 重新开始

### 8.2 文档策略

- 白皮书暂停维护（见 §4）
- 本 roadmap 是活文档，实施中发现新决策或修正回填
- 每次 A/B 阶段完成后，更新本文档对应小节的状态

### 8.3 测试策略

- 保持现有测试规模（15+ 类静态校验 + 对抗性测试）
- A/B 新模块必须同等对抗性测试
- 不为冷冻模块增加测试

### 8.4 Pipeline 共享的隔离原则

- Pipeline 包中严禁出现本机绝对路径、用户名、特定环境变量
- 使用 `$WORKTREE_PATH` / `$USER_HOME` / `$REGISTRY_ROOT` 等占位符
- 安装时自动替换
- registry-service 构建期做静态扫描拒绝违规 pipeline

---

## 9. 成熟度指标

产品成熟度定义为同时达到以下四条：

| # | 指标 |
|---|---|
| M1 | 你自己 95% 的 AI 编码流程能用 workflow-control 完成 |
| M2 | 身边 3-5 个开发者持续使用并给反馈 |
| M3 | Pipeline 成功率 > 90%（跑了多少个 task，最终 completed 的比例） |
| M4 | AI 在 workflow-control 上的热更新成功率较高（AI 提议的热更新不需用户 reject / 回滚） |

---

## 10. 实施顺序（渐进式执行方案）

### 指导原则

- **每一步都能独立发布**：每个 Step 完成后系统仍可用。可随时中断。
- **先 cut，后 build**：删代码/冷冻代码优先，新功能建在干净地基上。
- **数据结构先设计、再实现、再暴露**：新模块先写 types + 接口 + 单测，跑通再接主流程，最后再对 AI/UI 开放。
- **前一步为后一步开门，但不预支**：当前 Step 的数据结构不堵死后续 Step 的路，但不提前实现未来需求。
- **主路径优先，边界 case 后置**：主路径+基本错误兜底=可 ship；极端并发、罕见错误路径留到专项。
- **作者就是金丝雀**：每个 Step 完成后立即在自己日常流程里用起来。用不起来的说明设计错了，回头改。

### 工作流约定

- **Commit 策略**：每个 Step 结束时做一次 commit，用户验收
- **分支**：直接在 main 上做（工具只作者和少数人用，main 即主线）
- **决策边界**：medium-low 风险由实施者自行决，high 风险打断问用户
- **Feature flag**：引入新行为时加 flag，默认关；稳定后再默认开

---

### Phase 0：战略瘦身（约 2 周）

**目标**：清理噪音，让 A/B 在干净代码基础上开始。

| Step | 动作 | 时间 | 性质 | 状态 |
|---|---|---|---|---|
| 0.1 | 删 Slack Bridge：`apps/slack-cli-bridge/`、所有 `slack_*` SSE 事件、相关依赖 | 2-3 天 | cut | ✅ 已完成 |
| 0.2 | 冷冻 Edge Runner：`apps/server/src/edge/` 加 `@deprecated`，文档标 unsupported，不删代码 | 0.5 天 | cut | ✅ 已完成 |
| 0.3 | 冷冻 Gemini/Codex：`agent/gemini-executor.ts`、`agent/codex-executor.ts` 加 `@deprecated`，engine field validator 改 warning | 0.5 天 | cut | ✅ 已完成 |
| 0.4 | 删多余内置 pipeline：~~只保留 `pipeline-generator` / `tech-research` / `web3-tech-research`~~ → 实际只保留了 `pipeline-generator`；`tech-research` 已 bootstrap（手写），`web3-tech-research` 待 pipeline-generator 生成 | 1 天 | cut | ⚠️ 部分（tech-research ✅，web3-tech-research 未做） |
| 0.5 | 更新 README + CLAUDE.md：反映新定位（本地单用户、Claude-first、AI 代写） | 0.5-1 天 | cut | ✅ 已完成 |
| 0.6 | 新增 `task_triage` 内置 pipeline：~~定义 triage stage type、`skip_triage` 豁免字段、server 路由接入~~ → 重新定义为"系统级路由"，移出 Phase 0，见 Phase 0 补做议题 | 1 周 | build | ❌ 未做（已重定义） |

**Phase 0 里程碑**：仓库瘦 30%+，~~3 个保留 pipeline 都带 triage（或显式豁免）~~，地基干净。

#### Phase 0 补做议题（2026-04-18 决策 → 2026-04-19 D5 终判）

在推进 Tier 1 补丁时发现 Phase 0.6 从未落地。经 Review B → Tier 1 评估后决定：

- **0.4 补做**：实现 / 移植 `tech-research` 和 `web3-tech-research` 两个内置 pipeline。没有多个 pipeline，系统级路由无处可路由。
  - 设计稿：`docs/builtin-pipelines-design.md`（stage 骨架、store_schema、gate 设计、生成方式）。
  - `builtin-installer.ts` 已改为目录扫描（`discoverBuiltinPipelines`），后续新 pipeline 放入 `src/builtin-pipelines/<name>/` 即自动装载，无需改代码。
  - 当前 builtin（5 个通过 validator，CI 锁定于 `src/lib/builtin-pipelines.test.ts`）：`pipeline-generator`、`smoke-test`（新增最小 2-stage 样本）、`tech-research-collector`、`tech-research-writer`、`web3-research-writer`。
  - **待办（单独 session）**：从 `config/pipelines/` 搬来的 `tech-research` 和 `web3-tech-research` 顶层 pipeline 缺 `store_schema`（Phase 3.6 后成为 structural error），含约 30 个 stage writes 需要反推 schema 字段。补完后重新搬进 builtin。
- **0.6 终判（D5，2026-04-19）**：**永不实施**。pipeline-generator 是本项目**唯一**的路由层，与 §1.1 "AI 写 DSL，人不写" 的定位对齐。让系统再套一层 llm_decision 去判断 pipeline 适配度，只会与 pipeline-generator 的生成逻辑形成职责重复；而且 "task 不 fit 任何已有 pipeline" 的正确响应不是 "建议 Claude Code"，而是**让 pipeline-generator 现场生成一个新 pipeline**。triage-as-system-router 从路线图移除。

**为什么不做**：
1. 单用户本地工具不需要 gatekeeper——用户每次起 task 时自己知道该跑哪个 pipeline，或该让 pipeline-generator 生成新的。
2. 多一层 llm_decision 多一次网络往返 + 多一份 prompt 要维护，ROI 不成立。
3. 原议题解决的 "不同 task 配不同 pipeline" 需求，已由 pipeline-generator 在 task 创建路径上解决。

**0.4 仍保留**：有多个内置 pipeline 供 pipeline-generator 参考 / 用户显式挑选仍有价值，但作为独立议题推进，不再绑在 triage 框架下。

---

### Phase 1：A1 执行记录（约 3-4 周）

**目标**：每次 stage 执行留下完整可查询记录。

| Step | 动作 | 时间 |
|---|---|---|
| 1.1 | 设计 `ExecutionRecord` 数据结构 + SQLite DDL + 设计文档 | 2-3 天 |
| 1.2 | 实现 `ExecutionRecordWriter`（流式追加、异步落盘、崩溃安全）+ 单测 | 2-3 天 |
| 1.3 | 接入 `runAgent` / `runAgentSingleSession`（双写 SSE + 记录，feature flag `ENABLE_EXECUTION_RECORD` 默认关） | 3-4 天 |
| 1.4 | Worktree diff 捕获（stage 边界 git diff，大 diff 截断） | 2-3 天 |
| 1.5 | Scratch pad + PreCompact 事件捕获 | 2-3 天 |
| 1.6 | CLI 清理工具 `workflow prune-execution-records` | 1-2 天 |
| 1.7 | 默认启用（flag 改 true），自己跑几天观察 | 观察期 |

**Phase 1 里程碑**：能用 SQL 查询任意历史执行；为 A2 提供 "记录 pipeline hash" 位点。

---

### Phase 2：A2 Pipeline 版本化（约 2 周）

**目标**：每个 pipeline 有不可变版本号，每个 task 绑定具体版本。

| Step | 动作 | 时间 |
|---|---|---|
| 2.1 | Canonical hash 算法（parse YAML → 排序 key → JSON.stringify → SHA256）+ 单测 | 2 天 |
| 2.2 | Fragment 深 hash：被引用 fragment 内容一起计入 hash | 2 天 |
| 2.3 | Task `pipelineSnapshot` 字段写入，`tasks/:id.json` 自含，不依赖 registry 即可 replay | 2-3 天 |
| 2.4 | `ExecutionRecord` 绑定 `pipelineVersionHash` | 0.5 天 |
| 2.5 | SQLite `pipeline_versions` 表 + 查询 API | 2 天 |

**Phase 2 里程碑**：能回答"此 task 当时跑的 pipeline 长什么样"；两个 pipeline 版本可 diff。

---

### Phase 3：A3 Store Schema（约 4-6 周）

**目标**：Store 从"任意 dict"变成"类型化 KV"，tier1 注入简化。

#### Stage 3A：Schema 表达 + 校验（约 2-3 周）

| Step | 动作 | 时间 |
|---|---|---|
| 3.1 | 设计 `store_schema` YAML 语法（可能触发 AskUserQuestion 子决策） | 3-4 天 |
| 3.2 | 实现 parser + validator + 单测 | 3-4 天 |
| 3.3 | Pipeline validator 接入 schema drift 检查（writes/reads 必须声明且匹配） | 3 天 |
| 3.4 | 保留的 3 个内置 pipeline 迁移到 `store_schema` | 3-4 天 |

#### Stage 3B：Runtime 类型强制（约 2-3 周）

| Step | 动作 | 时间 |
|---|---|---|
| 3.5 | Store 写入运行时校验（shape 不符阻止写入 + stage 标失败） | 3-4 天 |
| 3.6 | Tier1 context 基于 schema 重写（去掉 5 级 fallback，只展示 reads 涉及字段） | 1 周 |
| 3.7 | Tier1 质量回归测试（token 数下降 20%+、输出质量不退步） | 2-3 天 |

**Phase 3 里程碑**：AI 写 pipeline 时看得到 store shape；tier1 token 成本下降。

**2026-04-19 进度更新**：
- ✅ 3.1 / 3.2 设计 + parser + validator（commit `5ad7dff` 前已完成）
- ✅ 3.3-hard（D1）：validator warn→error + 强制 store_schema（commit `78ce67e`）
- ✅ 3.5（D2）：agent 输出的 shape 校验 + retry feedback（commit `76ee9cc`）
- ✅ 3.7（部分）：`context-builder.baseline.test.ts` 锁 token 数与结构契约
- ✅ 3.6（schema-driven tier1 重写）：`schema-renderer.ts` 纯函数 +
  `buildTier1Context(..., storeSchema)` 注入 + 删 legacy 路径 B +
  删 `stage.outputs` 字段。实测 tier1 token 下降见下表。
- ⏸ 3.4 等 Phase 0 补做

**Phase 3.6 tier1 token 实测（with vs without storeSchema）**：

| scenario | without | with | delta |
|---|---:|---:|---:|
| small scalar entry | 62 | 54 | -13% |
| markdown-heavy entry | 131 | 118 | -10% |
| object[] entry | 319 | 163 | **-49%** |
| string[] entry | 62 | 47 | -24% |
| subpath read | 40 | 40 | 0%（故意 bypass） |

测试锁位：`context-builder.3.6-measurement.test.ts`。未来任何回归
（delta 降到更差）会直接失败。object[] 是最大红利来源（JSON 每项字段
都要 key 引号 + 转义），markdown 在长内容场景红利更大，scalar/string[]
稳定小幅改进。subpath reads 故意不走 schema——schema 描述根 entry，
sub-path 选择的字段不在 schema 直接定义的范围内。

---

### Phase 4：A4 调试工具链 MCP（持续 3 个月，MVP 1 个月）

**目标**：给 AI 足够工具形成"任务失败 → 分析 → 修改 → 验证"闭环。

#### MVP（第一个月，must-have）— ✅ DONE

MVP 实施采用 **MCP + CLI 双前端 + 共享 core** 架构（AI 主力场景）：
- Core：`apps/server/src/lib/debug-queries.ts`（纯查询函数，14 测试）
- MCP 壳：`apps/server/src/lib/debug-mcp.ts`（`__debug__` SDK MCP，workflow 内 agent 自诊断用，9 测试）
- CLI 壳：`apps/server/src/cli/debug.ts`（analyze/record/diff 子命令，默认 --json，10 测试）

| Step | 动作 | 状态 |
|---|---|---|
| 4.1 | `analyze_task_failure(taskId)`：AI 读记录生成诊断报告 | ✅ |
| 4.2 | `get_stage_execution_record(taskId, stageName, attempt)`：精确查单次执行 | ✅ |
| 4.3 | `diff_executions(recordId_a, recordId_b)`：两次执行对比 | ✅ |

#### Phase 4 延展（第二个月起，should-have）

| Step | 动作 | 状态 |
|---|---|---|
| 4.4 | `dry_run_stage(pipelineHash, stageName, storeOverride)` | 未做（Phase 6 再评） |
| 4.5 | `list_task_records(taskId)` | ✅ |

#### Phase 4 收尾（第三个月+，nice-to-have）

| Step | 动作 |
|---|---|
| 4.6 | `replay_stage(taskId, stageName, attempt)` |
| 4.7 | `suggest_pipeline_fix(taskId)` |

**Phase 4 里程碑**：调试一个失败 task 不再需要 `cat snapshot.json | jq`；AI 能自己读记录改 pipeline。

---

### Phase 5：B 系列真热更新（约 3-4 个月）

**前提**：A 完整完成，Phase 4 MVP 至少完成 4.1-4.3。

#### Stage 5A：Propose 基础设施（约 3 周）

| Step | 动作 |
|---|---|
| 5.1 | `propose_pipeline_update` MCP 工具骨架（参数校验、乐观锁） |
| 5.2 | Pipeline diff 算法（PipelineDiff 结构：added/removed/modified/routing） |
| 5.3 | Impact 分析（基于 store schema 判断已完成 stage 是否受影响） |
| 5.4 | Dry-run 输出组装（diff + impact + migration plan + 活跃 task 成本预估） |
| 5.5 | 乐观锁冲突检测（版本 hash 不匹配 reject with CONFLICT） |

#### Stage 5B：Migration Plan 算法（约 3 周）

| Step | 动作 |
|---|---|
| 5.6 | Safe 范围识别（只改 prompt/reads/writes/budget） |
| 5.7 | 非 safe 改动的 migration plan 生成 |
| 5.8 | Migration plan 执行引擎 |
| 5.9 | 失败回滚机制（回退到 apply 前 task 状态） |

#### Stage 5C：中止与切换（约 3 周）

| Step | 动作 |
|---|---|
| 5.10 | Graceful session 中止（给 agent 1 轮写总结，10-60s 预期） |
| 5.11 | XState snapshot 重建机制（migrated snapshot → new actor） |
| 5.12 | Worktree migration（reset 到 checkpoint + 旧 diff 写入 StageMemory） |
| 5.13 | Single-session 新 session 创建 + 摘要注入 |

#### Stage 5D：Parallel group 精细粒度（约 3 周）

| Step | 动作 |
|---|---|
| 5.14 | Parallel group 内单 child 中止协议 |
| 5.15 | group-level staged writes 与新 child writes 协调合并 |
| 5.16 | 大量对抗性测试 |

#### Stage 5E：收尾（约 2 周）

| Step | 动作 |
|---|---|
| 5.17 | `rollback_hot_update(taskId, toVersion)` MCP ✅ 5A 骨架 / 5B 真实执行 |
| 5.18 | `hot_update_events` 表 + 聚合查询 ✅ 5E（`query_hot_update_stats`） |
| 5.19 | 删除老 UPDATE_CONFIG handler、事件、测试 ✅ N/A（legacy engine 4a 退役时已连带删除） |
| 5.20 | 整体集成测试 + 文档 ✅ 5E（`hot-update/end-to-end.test.ts` + 7 handoff 文档） |

**Phase 5 里程碑**：AI 能在跑任务过程中修改后续 pipeline，已执行信息作为参考保留。

---

### Phase 6：打磨期（持续）

**目标**：达成 §9 成熟度指标 M1-M4。

**动作**：
- 每天使用 workflow-control 完成自己的 AI 编码流程
- 朋友试用收集反馈
- 按需迭代、修 bug、补功能
- 白皮书重写（基于最终架构）

无时间箱，直到 M1-M4 达成。

---

### 时间线总览

| Phase | 内容 | 时间 |
|---|---|---|
| 0 | 瘦身 | 2 周 |
| 1 | A1 执行记录 | 3-4 周 |
| 2 | A2 版本化 | 2 周 |
| 3 | A3 Store Schema | 4-6 周 |
| 4 | A4 调试工具（MVP） | 1 个月 |
| 5 | B 热更新 | 3-4 个月 |
| 6 | 打磨 | 持续 |
| **总计** | 到 Phase 5 完成 | **6-8 个月全职** |

### 随时中断机制

- Step 之间可停止，不留半成品
- Phase 之间可切换（做完 Phase 1 可跳 Phase 4 做一部分，不推荐但可行）
- Feature flag 让新功能可随时关闭

### 信心度评估

| Phase | 信心度 | 说明 |
|---|---|---|
| 0 | 高 | 主要是删代码 |
| 1 | 高 | 数据结构清晰，有 SSE 作参考 |
| 2 | 高 | Hash 化是成熟技术 |
| 3 | 中 | Schema 设计是开放问题，可能回炉 |
| 4 | 中 | 依赖 A1-A3 质量，会在实践中调整 |
| 5 | 低 | 最复杂，A 完成后再精确规划 |

---

## 11. 决策索引

本 session 所有决策的速查表。

### 战略（S 系列）

- S1：先 A 后 B，严格串行
- S2：立即瘦身
- S3：AI 自动判断场景 fit

### 瘦身

- Gemini/Codex：冷冻保留
- Edge Runner：冷冻
- Slack Bridge：完全删除
- Registry：保留并打磨（严格隔离本地路径）
- Single-session：TODO / 暂未回补 —— 见 §4 行 105 修正说明；2026-04-24 评估决议先做 multi-session 优化 + benchmark 再决策
- 白皮书：暂停维护
- 内置 pipeline：只保留 3 个（pipeline-generator / tech-research / web3-tech-research）

### A 系列

- A1 存储：SQLite 新表 `execution_records`
- A1 保留：永久 + 手动清理后门
- A1 字段：8 项全量（prompt / tier1 / tool calls / text / thinking / parsed vs commit writes / cost / worktree diff / scratch pad）
- A1 多 attempt：全部保留
- A1 与 SSE：SSE 保留 + 同步写入执行记录
- A2 版本号：内容 hash（parse → 排序 key → JSON.stringify → SHA256）
- A2 深 hash：包含所有引用的 fragment
- A2 Task 绑定：创建时 snapshot 完整 config，migrate 时覆盖
- A2 自含：task.json 不依赖 registry 即可 replay
- A3 Schema 位置：Pipeline YAML 顶层 store_schema
- A3 Drift 检测：构建时 error
- A3 结构性 drift：必须原子一起改

### B 系列

- B1 入口：统一 `propose_pipeline_update` MCP
- B2 Registry 入口：`update_registry_pipeline` MCP
- B3 审批：dry-run + auto-approve
- B4 Safe 范围：只改 prompt / reads / writes / budget
- B5 Confirm UI：Web dashboard + SSE 事件 `wf.hotUpdatePending`
- B6 Migration 控制：`migrateRunningTasks` 参数
- B7 Dry-run：含 impact 分析 + 每个活跃 task 成本预估
- B8 时机：propose apply 时同步触发
- B9 Worktree：git reset + 旧 diff 入 mem
- B10 Session 中止：Graceful，10-60s 延迟
- B11 不相关 stage：跑完再切换
- B12 Single-session：依赖 single-session 回补（§4 行 105 TODO）；multi-session 架构下等价实现是 port-level summary handoff —— 延后至 single-session 决策后确定
- B13 Parallel group：精细粒度（B 起步即实现）
- B14 并发：乐观锁（版本 hash）
- B15 删 stage：无下游引用时允许
- B16 结构性 drift：原子一起改
- B17 Foreach 中途改：强制 schema 兼容
- B18 retry_from：AI 基于 impact 分析显式声明
- B19 兜底：回滚上一版本 + 显示错误
- B20 回滚：`rollback_hot_update`
- B21 Audit：`hot_update_events` 表
- B22 聚合：识别 pipeline 设计问题

### 场景判断 ~~（作废，D5）~~

- 不再实施系统级 triage。pipeline-generator 是唯一路由层。
- 见 §5 与 Phase 0 补做议题 0.6 终判。

### 开发原则

- 不保 backward compatibility
- 旧 task 归档无法操作
- Pipeline 共享严格路径隔离
- 成熟度 4 指标（见 §9）

---

## 修订历史

| 日期 | 版本 | 修改内容 |
|---|---|---|
| 2026-04-18 | 1.0 | 首版。本 session 决策全量落盘 |
| 2026-04-24 | 1.2 | Stage 4a 完成：legacy engine + Edge Runner + Gemini/Codex + 相关路由和 Web 页面退役。kernel-next 成为唯一引擎。|
| 2026-04-24 | 1.3 | Stage 4b 完成：converter 删除，4 个 builtin 固化为 pipeline.ir.json。kernel-next 作为唯一引擎 + 唯一 pipeline 表达形式。 |
| 2026-04-24 | 1.4 | Stage 6 完成：kernel-next sidecar (agent_execution_details) 落地；legacy execution-record 模块删除。AI 自诊断数据源对齐。|
| 2026-04-24 | 1.5 | Stage 5A 完成：propose 链路完整化（`dry_run_proposal` / `update_registry_pipeline` / `rollback_hot_update` 骨架 / `propose_pipeline_change.autoApprove`）。B1/B2/B3/B4/B7/B14/B15/B16/B18/B20/B21 项均已落地；5B migration 执行引擎 / 5C 中止与切换 / 5D parallel fine-grained 待后续 milestone。|
| 2026-04-24 | 1.6 | Stage 5B 完成：migration execution engine（`executeMigration` INTERRUPT + supersede + resume + reverse-supersede；`executeRollback` 合成 proposal + 复用 orchestrator；`wire-reachable.ts` 实现 B13 精细粒度）。B8/B11/B13/B19/B20 真实执行全部落地。5C 中止与恢复（graceful summary turn / worktree / single-session 摘要注入）留待后续；核心 B 系列 22 项已完成 17 项。|
| 2026-04-24 | 1.7 | Stage 5E 完成：B22 聚合查询（`query_hot_update_stats` MCP + `computeHotUpdateStats` 纯函数，支持 byPipelineName / byActor / topChurn / 时间窗 filter）；清理 11 个 A8 时代 skipped tests（9 migrate-task + 2 a2-3-5 整文件）；3 个端到端集成测试覆盖 autoApprove→migrate / forward→rollback / INTERRUPT timeout。B 系列 22 项除 5C 推迟的 B9/B10/B12 外全部落地。|
| 2026-04-24 | 1.8 | Phase 4.5 Tier 4 完成 (Task 34)：`script_execution_details` sidecar 表 + writer + ScriptStageExecutor 集成 + prune-kernel-records CLI 扩展（script sidecar + migration_hints 两张表加入删除链）。A1 script stage 诊断数据与 agent stage 对齐，结构平行；未来 child_process-style script 执行模式的 stdout/stderr/exit_code 列已预埋。|
| 2026-04-24 | 1.9 | Phase 4.5 Tier 3 - A3 Store Schema 核心 (Task 31)：`PipelineIR.store_schema` 可选顶层 data dictionary；新 validator `validateStoreSchema` 构建时 reject 三类 drift（STORE_SCHEMA_STAGE_MISSING / STORE_SCHEMA_PORT_MISSING / STORE_SCHEMA_TYPE_MISMATCH），挂入 submit_pipeline + dry_run_proposal 两条验证链。4 个 builtin 的 store_schema 迁移仍需 AI via pipeline-generator 单独完成。|
| 2026-04-24 | 1.10 | Phase 4.5 Tier 3 - A4 dry_run_stage (Task 33)：新 `debug/dry-run-stage.ts` 模块 + MCP external tool。单 stage 探测：合成 task_id=`dry_run-<uuid>`，attempt kind='dry_run'，inert dispatcher（不影响任何运行中 machine）。仅支持 agent / script stage；gate 被拒绝 STAGE_NOT_DRY_RUNNABLE。所有声明的 input 必须提供（MISSING_INPUT）。MCP tool 数量：combined 22→23，external 21→22。|
| 2026-04-24 | 1.11 | Phase 4.5 Tier 3 - A4 propose_pipeline_fix (Task 32)：新 `debug/propose-pipeline-fix.ts` 模块 + MCP external tool。对 analyzeTaskFailure 的每条 hint 产 severity-tagged suggestion（6 种 kind），包含 description + rationale；proposedPatch 字段预留给 AI-driven 补丁生成（需真 API；后续工作）。target stage 不在当前 IR 的 suggestion 被过滤。MCP tool 数量：combined 23→24，external 22→23。|
