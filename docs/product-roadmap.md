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
| Gemini 引擎 | **冷冻保留** | 代码不删、测试不删、不再加新功能、不为其重构。白皮书/README 明确 unsupported |
| Codex 引擎 | **冷冻保留** | 同上 |
| Edge Runner | **冷冻** | 个人工具不需要分发执行 |
| Slack Bridge | **完全删除** | slack-cli-bridge 独立 app 删除，所有相关依赖、测试、文档清理 |
| Registry / 发布系统 | **保留并打磨** | 支持跨用户 pipeline / fragment 共享；严格隔离本地路径、用户名、环境变量等机器特定信息，使用 `$WORKTREE_PATH` / `$USER_HOME` 占位符 |
| Single-session 模式 | **保留并重点打磨** | 主力使用方式。B 系列热更新必须把 single-session 作为一等公民处理 |
| 架构白皮书（zh + en） | **暂停维护** | 等 A/B 完全落地后重写。期间 README 指明"文档滞后" |
| 内置 pipeline | **大瘦身** | 只保留：`pipeline-generator`、`tech-research`、`web3-tech-research`。其他（包括 `linear-dev-cycle`）删除 |

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
8. Scratch pad 快照 + PreCompact 触发点（single-session 主用场景关键）

**保留策略**：永久保留，手动清理

**清理后门**：CLI 工具 `workflow prune-execution-records --task-id=X` / `--older-than=30d`

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

---

### 6.4 A4：调试工具（MCP 工具集）

**预估工作量**：持续迭代，MVP 3 个月

**依赖**：A1 + A2 + A3 全部完成

**工具集合**（待详细设计）：
- `analyze_task_failure(taskId)`：AI 读执行记录，给出诊断
- `propose_pipeline_fix(taskId, diagnosis)`：AI 基于诊断给出 pipeline 改动建议
- `dry_run_stage(pipelineVersion, stageName, storeState)`：不跑整 pipeline 试单 stage
- `compare_runs(taskId_a, taskId_b)`：两次执行的结构化对比
- `replay_stage(taskId, stageName, attempt)`：重放某 stage 的具体 attempt

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
| B1 | **统一 MCP 工具 `propose_pipeline_update`**：人（Web UI → 后端 → MCP）和 AI 都用这个入口 |
| B2 | **Registry 文件独立入口 `update_registry_pipeline`**：人直接改 YAML 文件 + AI 调这个 MCP（不跑 task 时改模板） |
| B3 | **Dry-run + Auto-approve**：AI 调 propose → 系统算 diff + migration plan + impact → safe 范围内 auto apply，范围外 block 等 confirm |
| B4 | **Safe 范围默认**：只改 prompt / reads / writes / budget 四项。结构性改动（加/删 stage、改路由、改 parallel 结构）一律要 confirm |
| B5 | **Confirm UI**：Web dashboard，复用现有 human_confirm 的 SSE + UI 机制，新增 SSE 事件 `wf.hotUpdatePending` |

### 7.3 Migration 控制

| # | 决策 |
|---|---|
| B6 | **propose 参数 `migrateRunningTasks`**：`'all'` \| `'none'` \| `[taskId...]`，显式指定 |
| B7 | **Dry-run 输出含 impact 分析**：列出每个活跃 task 的迁移成本预估、cost 增量、延迟预估 |
| B8 | **同步触发**：propose apply 时同步触发所有指定 task 的 graceful stop + migration |

### 7.4 中止与恢复

| # | 决策 |
|---|---|
| B9 | **Worktree 切换**：git reset 到改动 stage 的 checkpoint + 旧 diff 写进 StageMemory 作参考 |
| B10 | **Session 中止**：Graceful——给 agent 1 轮写总结再停。预期延迟 10-60s |
| B11 | **不相关的 running stage**：让它跑完，后续 stage 用新 pipeline 定义 |
| B12 | **Single-session 热更新**：开新 session。旧对话历史以摘要形式注入新 session 的 tier1 |
| B13 | **Parallel group 热改**：**精细粒度**（B 起上来就实现）——只中止被改的 child，sibling 继续跑。group-level staged writes 与新 child writes 协调合并 |

### 7.5 一致性约束

| # | 决策 |
|---|---|
| B14 | **乐观锁**：propose 时必须带当前 pipeline 版本 hash，不匹配 reject with CONFLICT |
| B15 | **删 stage**：允许，但前提是无下游 reads 引用它的 writes。校验规则：删 stage 后，其 writes 在旧版本中无被引用 |
| B16 | **结构性 schema drift**：必须原子地一起改，否则在 propose 阶段 reject |
| B17 | **Foreach 中途改子 pipeline**：强制新旧子 pipeline 的 outputs schema 兼容。已跑 item 保留，剩余 item 用新子 pipeline，append 到同一 collect_to |
| B18 | **AI 决定 retry_from**：dry-run 返回 impact 分析给 AI → AI 根据分析结果在 propose 参数内显式声明 `rerun_from: stage_1` 或 `null` |

### 7.6 兜底与审计

| # | 决策 |
|---|---|
| B19 | **Migration 失败兜底**：回滚到上一版本继续跑 + 显示错误给 AI/用户 |
| B20 | **用户回滚**：提供 `rollback_hot_update(taskId, toVersion)` MCP 工具。和 audit trail 联动 |
| B21 | **Audit trail**：独立的 `hot_update_events` 表，字段包含 timestamp / actor (user/AI) / fromVersion / toVersion / diff / migration plan / 成功失败 / 每个受影响 task 的结果 |
| B22 | **聚合指标**：hot_update_events 可聚合查询 AI 热更新次数、成功率、回滚率。用于识别"哪个 pipeline 被 AI 频繁改 = 本身设计有问题"|

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
| 0.4 | 删多余内置 pipeline：~~只保留 `pipeline-generator` / `tech-research` / `web3-tech-research`~~ → 实际只保留了 `pipeline-generator`；`tech-research` 和 `web3-tech-research` 尚未实现 | 1 天 | cut | ⚠️ 部分（见下） |
| 0.5 | 更新 README + CLAUDE.md：反映新定位（本地单用户、Claude-first、AI 代写） | 0.5-1 天 | cut | ✅ 已完成 |
| 0.6 | 新增 `task_triage` 内置 pipeline：~~定义 triage stage type、`skip_triage` 豁免字段、server 路由接入~~ → 重新定义为"系统级路由"，移出 Phase 0，见 Phase 0 补做议题 | 1 周 | build | ❌ 未做（已重定义） |

**Phase 0 里程碑**：仓库瘦 30%+，~~3 个保留 pipeline 都带 triage（或显式豁免）~~，地基干净。

#### Phase 0 补做议题（2026-04-18 决策 → 2026-04-19 D5 终判）

在推进 Tier 1 补丁时发现 Phase 0.6 从未落地。经 Review B → Tier 1 评估后决定：

- **0.4 补做**：实现 / 移植 `tech-research` 和 `web3-tech-research` 两个内置 pipeline。没有多个 pipeline，系统级路由无处可路由。
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

---

### Phase 4：A4 调试工具链 MCP（持续 3 个月，MVP 1 个月）

**目标**：给 AI 足够工具形成"任务失败 → 分析 → 修改 → 验证"闭环。

#### MVP（第一个月，must-have）

| Step | 动作 | 时间 |
|---|---|---|
| 4.1 | `analyze_task_failure(taskId)`：AI 读记录生成诊断报告 | 1-2 周 |
| 4.2 | `get_stage_execution_record(taskId, stageName, attempt)`：精确查单次执行 | 3-4 天 |
| 4.3 | `diff_executions(recordId_a, recordId_b)`：两次执行对比 | 3-4 天 |

#### Phase 4 延展（第二个月起，should-have）

| Step | 动作 |
|---|---|
| 4.4 | `dry_run_stage(pipelineHash, stageName, storeOverride)` |
| 4.5 | `list_task_records(taskId)` |

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
| 5.17 | `rollback_hot_update(taskId, toVersion)` MCP |
| 5.18 | `hot_update_events` 表 + 聚合查询 |
| 5.19 | 删除老 UPDATE_CONFIG handler、事件、测试 |
| 5.20 | 整体集成测试 + 文档 |

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
- Single-session：保留并重点打磨（主力使用方式）
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
- B12 Single-session：开新 session + 摘要注入
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
