# Workflow Control: 技术架构白皮书

> Version 1.0 | 2026-04-14

---

## 目录

1. [概述](#1-概述)
2. [系统总览](#2-系统总览)
3. [架构拓扑](#3-架构拓扑)
4. [工作流引擎核心](#4-工作流引擎核心)
5. [Stage 类型体系](#5-stage-类型体系)
6. [数据流与 Store 模型](#6-数据流与-store-模型)
7. [Prompt 工程架构](#7-prompt-工程架构)
8. [执行模式](#8-执行模式)
9. [错误处理与恢复](#9-错误处理与恢复)
10. [Human-in-the-Loop](#10-human-in-the-loop)
11. [Pipeline DSL 与校验](#11-pipeline-dsl-与校验)
12. [可观测性与实时事件流](#12-可观测性与实时事件流)
13. [持久化与状态恢复](#13-持久化与状态恢复)
14. [Registry 与扩展体系](#14-registry-与扩展体系)
15. [安全模型](#15-安全模型)
16. [已知缺陷与客观评估](#16-已知缺陷与客观评估)
17. [与同类方案的对比](#17-与同类方案的对比)
18. [结论](#18-结论)

---

## 1. 概述

Workflow Control 是一套 AI Agent 编排系统，通过形式化状态机协调 LLM Agent（Claude、Gemini、Codex）完成多阶段 Pipeline。系统的核心论点是：**AI 工作流编排本质上是一个状态机问题** —— 采用经过验证的形式化状态管理框架（XState v5），比临时拼凑的编排逻辑能带来更高的可靠性、可调试性和可恢复性。

系统能力：

- **声明式 Pipeline 定义**：通过 YAML DSL 支持 7 种 Stage 类型
- **多引擎 Agent 执行**：单个 Pipeline 内混合使用 Claude、Gemini、Codex
- **形式化状态转换**：基于 XState v5 状态机，事件类型完整
- **Human-in-the-Loop 门控**：集成 Slack 通知与反馈路由
- **Git 原生隔离**：通过 worktree 实现并行和 foreach 的执行隔离
- **阶段级成本预算**：每个 Stage 独立设定预算上限并自动执行
- **Edge 执行**：支持将 Agent 执行分发到编排器进程之外

---

## 2. 系统总览

### 2.1 Monorepo 结构

```
workflow-control/
├── apps/
│   ├── server/           # Hono REST API + XState v5 工作流引擎
│   ├── web/              # Next.js 16 控制面板 (React 19)
│   └── slack-cli-bridge/ # Slack Socket Mode 集成
├── packages/
│   └── shared/           # TypeScript 类型契约 (Zod v4 校验)
├── registry/             # Pipeline/Skill/Hook/Fragment 包仓库
├── docs/                 # 架构文档
└── scripts/              # 工具脚本
```

### 2.2 技术栈

| 层 | 技术 | 选型理由 |
|---|------|---------|
| 工作流引擎 | XState v5.28 | 形式化状态机，类型化事件，可序列化快照 |
| HTTP 服务器 | Hono 4.12 | 轻量、边缘兼容、TypeScript 原生 |
| Agent SDK | @anthropic-ai/claude-agent-sdk 0.2.x | 会话持久化、工具调用、流式传输 |
| 终端 I/O | node-pty 1.1 | 伪终端，用于 CLI Agent 执行 |
| 校验 | Zod v4.3 | Pipeline 配置的运行时 Schema 校验 |
| 数据库 | SQLite (WAL 模式) | SSE 历史、待处理问题、Edge 执行槽位 |
| 前端 | Next.js 16 + React 19 | SSE 驱动的实时更新控制面板 |
| DAG 可视化 | @xyflow/react 12 + dagre | 交互式 Pipeline 图渲染 |
| 日志 | Pino 10.3 | 结构化 JSON 日志，按任务隔离 |
| 包管理 | pnpm workspaces | Monorepo 依赖管理 |

---

## 3. 架构拓扑

```
┌──────────────────────────────────────────────────────────┐
│                     Web 控制面板                          │
│              (Next.js 16, React 19, SSE)                 │
│   ┌──────────┐ ┌──────────────┐ ┌────────────────────┐   │
│   │ 任务列表 │ │ 任务监控器   │ │ Pipeline 编辑器    │   │
│   │ (SSE)    │ │ (SSE 事件流) │ │ (Monaco + Mermaid) │   │
│   └────┬─────┘ └──────┬───────┘ └────────┬───────────┘   │
└────────┼──────────────┼─────────────────┼────────────────┘
         │              │                 │
    ┌────▼──────────────▼─────────────────▼────────────────┐
    │                  Hono REST API                        │
    │    /api/tasks  /api/tasks/:id/events  /api/config     │
    ├──────────────────────────────────────────────────────┤
    │              工作流引擎 (XState v5)                    │
    │  ┌──────────┐ ┌────────────┐ ┌───────────────────┐   │
    │  │ Machine  │ │ Pipeline   │ │ State Builders    │   │
    │  │ Factory  │ │ Builder    │ │ (按 Stage 类型)   │   │
    │  └────┬─────┘ └──────┬─────┘ └────────┬──────────┘   │
    │       │              │                │              │
    │  ┌────▼──────────────▼────────────────▼──────────┐   │
    │  │              Actor 注册表                       │   │
    │  │  runAgent | runScript | runEdgeAgent           │   │
    │  │  runPipelineCall | runForeach | runLlmDecision │   │
    │  └──────────────────┬────────────────────────────┘   │
    ├─────────────────────┼────────────────────────────────┤
    │  ┌──────────────────▼────────────────────────────┐   │
    │  │              执行层                             │   │
    │  │  ┌──────────┐ ┌─────────┐ ┌───────────────┐   │   │
    │  │  │ Claude   │ │ Gemini  │ │ Codex         │   │   │
    │  │  │ Agent SDK│ │ CLI/pty │ │ CLI/pty       │   │   │
    │  │  └──────────┘ └─────────┘ └───────────────┘   │   │
    │  └───────────────────────────────────────────────┘   │
    ├──────────────────────────────────────────────────────┤
    │  ┌──────────────┐ ┌──────────┐ ┌────────────────┐   │
    │  │ SSE 管理器   │ │ SQLite   │ │ Git Checkpoint │   │
    │  │ (按任务隔离) │ │ (WAL)    │ │ (回滚补偿)     │   │
    │  └──────────────┘ └──────────┘ └────────────────┘   │
    └──────────────────────────────────────────────────────┘
         │
    ┌────▼─────────────────────────────────────────────────┐
    │                   MCP 服务器 (:3001)                  │
    │   trigger_task | get_stage_context | submit_result    │
    │   confirm_gate | get_task_status | report_progress    │
    └────┬─────────────────────────────────────────────────┘
         │
    ┌────▼─────────────────────────────────────────────────┐
    │                   Edge Runner                         │
    │   每 Stage 独立 pty 会话                              │
    │   转录同步 (JSONL -> SSE 事件)                        │
    │   基于 Hook 的中断检测                                │
    └──────────────────────────────────────────────────────┘
```

---

## 4. 工作流引擎核心

### 4.1 XState v5 作为基础

每个任务都是一个独立的 XState v5 状态机实例。Pipeline YAML 在任务创建时通过 `createWorkflowMachine(pipeline)` 编译为状态机定义。此编译过程是确定性的 —— 相同的 Pipeline 配置总是产生相同的状态机结构。

**状态机生命周期：**

```
idle -> [stages...] -> completed
  |                      ^
  +---- error -----------+
  +---- blocked --(RETRY/RESUME)--> [stage]
  +---- cancelled --(RESUME)--> [stage]
```

**根级全局事件：**
- `CANCEL`：从任意非终态转换到 `cancelled`
- `INTERRUPT`：转换到 `blocked`，携带原因并取消 Agent
- `UPDATE_CONFIG`：热更新 Pipeline 配置，无需重启
- `RETRY` / `RETRY_FROM`：从 `blocked` 状态恢复
- `SYNC_RETRY`：使用已有 session ID 恢复
- `RESUME`：从 `cancelled` 状态恢复

### 4.2 Context 模型

```typescript
interface WorkflowContext {
  taskId: string;
  taskText?: string;
  status: string;                              // 当前状态名
  store: Record<string, any>;                  // 共享数据仓库
  worktreePath?: string;                       // Git worktree 目录
  branch?: string;                             // Git 分支名
  retryCount: number;                          // 全局重试计数
  stageRetryCount: Record<string, number>;     // 按 Stage 的重试计数
  stageSessionIds: Record<string, string>;     // Claude 会话 ID
  stageCheckpoints: Record<string, StageCheckpoint>;  // Git HEAD 快照
  totalCostUsd?: number;                       // 累计成本
  totalTokenUsage?: TokenUsage;                // Token 计数器
  config?: {
    pipelineName: string;
    pipeline: PipelineConfig;
    prompts: { system, fragments, globalConstraints, ... };
    skills: string[];
    mcps: string[];
  };
}
```

### 4.3 状态机编译

`pipeline-builder.ts` 中的 `buildPipelineStates()` 将 Pipeline YAML 转换为 XState 状态定义：

1. **线性 Stage** 编译为顺序状态，自动转换
2. **并行组** 编译为 XState `type: "parallel"` 状态，含并发区域
3. **`depends_on` 声明** 通过拓扑排序转换为并行层级
4. **路由目标**（`on_reject_to`、`on_approve_to`、`back_to`）编译为守卫条件转换

`derivePipelineLists()` 预计算哪些 Stage 可重试和可恢复，生成 `blocked` 和 `cancelled` 状态中 `RETRY`/`RETRY_FROM`/`RESUME` 事件的守卫数组。

### 4.4 Actor 注册表

每种 Stage 类型映射到一个注册的 XState Actor（被调用服务）：

| Stage 类型 | Actor | 执行模型 |
|-----------|-------|---------|
| `agent` | `runAgent` / `runEdgeAgent` | Claude Agent SDK 或 pty 启动的 CLI |
| `script` | `runScript` | 确定性 TypeScript 函数 |
| `human_confirm` | （无 —— 等待事件） | 暂停直到 `CONFIRM`/`REJECT` |
| `condition` | （内联守卫求值） | 同步表达式求值 |
| `pipeline` | `runPipelineCall` | 嵌套 XState 状态机 |
| `foreach` | `runForeach` | 迭代式子 Pipeline 调用 |
| `llm_decision` | `runLlmDecision` | 单次 Claude API 调用（非 Agent SDK） |

---

## 5. Stage 类型体系

### 5.1 Agent Stage

主要 Stage 类型。使用分层 Prompt 调用 LLM Agent，通过 MCP 提供工具访问，并进行结构化输出校验。

**关键配置字段：**
```yaml
- name: implement
  type: agent
  engine: claude              # claude | gemini | codex
  model: claude-opus-4        # 可选模型覆盖
  max_budget_usd: 2.00        # 成本上限
  max_turns: 50               # 工具调用轮次上限
  thinking: true              # 启用扩展思考
  effort: high                # 思考深度级别
  interactive: true           # 允许执行中提问
  permission_mode: auto       # auto | plan | bypassPermissions
  mcps: [github, filesystem]  # 附加的 MCP 服务器
  runtime:
    system_prompt: implement  # Prompt 文件引用
    reads:
      plan: store.implementation_plan
      context: store.gathered_context
    writes:
      - key: implementation_result
        strategy: replace
      - key: code_changes
        strategy: append
    verify_commands:
      - command: "npx tsc --noEmit"
        policy: must_pass
    retry:
      max_retries: 2
      back_to: planning       # QA 反馈路由目标
    compensation:
      strategy: git_reset     # 失败时回滚
```

**执行流程：**
1. 通过 `prompt-builder.ts` 构建 6 层 Prompt
2. 从声明的 `reads` 构建 Tier 1 上下文
3. 启动 Claude Agent SDK 会话（或恢复已有会话）
4. 流式传输工具调用事件到 SSE
5. 从 Agent 响应中解析结构化输出
6. 对照声明的 `writes` 校验输出
7. 执行 `verify_commands`（如配置）
8. 将写策略应用到 Store

### 5.2 Script Stage

无 LLM 参与的确定性自动化。包含 6 个内置脚本和用户自定义脚本。

**内置脚本：**
| 脚本 | 用途 |
|------|-----|
| `git-worktree` | 创建隔离的 worktree + 分支 |
| `create-branch` | 最简分支创建 |
| `build-gate` | TypeScript/Lint 校验门控 |
| `pr-creation` | GitHub PR 自动化 |
| `notion-sync` | Notion 页面状态更新 |
| `persist-pipeline` | 带 Git 集成的状态持久化 |

### 5.3 Human Confirm（门控）Stage

暂停执行直到人工审批。支持 Slack 通知和反馈路由。

```yaml
- name: review_gate
  type: human_confirm
  runtime:
    notify:
      type: slack
      template: "Review needed for {{store.pr_url}}"
    on_approve_to: deploy        # 批准后下一个 Stage
    on_reject_to: implement      # 拒绝后路由目标
    max_feedback_loops: 3        # 最大拒绝-实现循环次数
```

**事件处理：**
- `CONFIRM` -> 转换到 `on_approve_to`（或下一个顺序 Stage）
- `REJECT` -> 转换到 `on_reject_to`（或 error）
- `REJECT_WITH_FEEDBACK` -> 存储反馈，携带上下文路由到 `on_reject_to`

### 5.4 Condition Stage

基于表达式的分支，使用 `expr-eval` 库对 Store 值求值。

```yaml
- name: check_complexity
  type: condition
  runtime:
    reads:
      analysis: store.analysis_result
    branches:
      - when: "analysis.complexity > 8"
        to: deep_review
      - when: "analysis.has_tests == false"
        to: add_tests
      - default: true
        to: quick_review
```

### 5.5 LLM Decision Stage

LLM 驱动的路由，用于表达式求值无法覆盖的细粒度决策。

```yaml
- name: route_approach
  type: llm_decision
  runtime:
    prompt: "Given this codebase analysis, which approach is best?"
    reads:
      analysis: store.codebase_analysis
    choices:
      - id: refactor
        description: "Major refactoring needed"
        goto: refactor_stage
      - id: patch
        description: "Simple patch sufficient"
        goto: patch_stage
    default_choice: patch
```

使用单次 Claude Sonnet API 调用（非 Agent SDK），实现快速低成本决策。

### 5.6 Pipeline Call Stage

将子 Pipeline 作为嵌套工作流调用。

```yaml
- name: run_sub_workflow
  type: pipeline
  runtime:
    pipeline_name: code-review-pipeline
    reads:
      code_changes: store.implementation_result
    writes:
      - key: review_result
```

数据流向：父级 `reads` -> 子 Pipeline 初始 Store；子 Pipeline `writes` -> 父级 Store。

### 5.7 Foreach Stage

遍历数组，支持按项目进行 worktree 隔离。

```yaml
- name: process_files
  type: foreach
  runtime:
    items: store.file_list
    item_var: current_file
    pipeline_name: process-single-file
    isolation: worktree          # 每项获得独立 git worktree
    max_concurrency: 3           # 最多 3 项并行
    collect_to: processed_results
    item_writes: [result, changes]
    on_item_error: continue      # 单项失败不中断整个 foreach
    reads:
      config: store.processing_config
```

**隔离模式：**
- `shared`：所有项共享同一工作目录（仅顺序执行）
- `worktree`：每项获得独立的 git worktree + 分支；分支保留用于后续集成

---

## 6. 数据流与 Store 模型

### 6.1 Store 架构

Store 是工作流 Context 上的扁平键值字典（`Record<string, any>`），在所有 Stage 间共享。Stage 显式声明数据依赖：

```
reads: { alias: "store.path.to.value" }       -> 输入声明
writes: [{ key: "field", strategy: "..." }]    -> 输出声明
```

### 6.2 写策略

| 策略 | 行为 | 适用场景 |
|------|-----|---------|
| `replace` | 覆盖整个值 | 默认；单生产者字段 |
| `append` | 数组拼接 | 多生产者聚合 |
| `merge` | 浅层对象合并 | 增量属性添加 |

### 6.3 分层上下文注入

上下文通过两个层级交付给 Agent，以管理 Token 预算：

**Tier 1（系统 Prompt 注入）：**
- Token 预算：约 8000 tokens（可配置）
- 包含声明的 `reads` 值
- 压缩级联：
  1. 完整内联 JSON（如果 <= 8000 字符且在预算内）
  2. 语义摘要（LLM 生成，缓存）
  3. 机械摘要（Store 中的 `field.__summary`）
  4. 字段预览（前 5 个字段 + 截断指示器）
  5. 概要视图（前 20 个字段，每个值截断到 80 字符）

**Tier 2（按需 MCP）：**
- 通过 `get_store_value(key)` MCP 工具获取
- 无 Token 预算限制
- 返回完整 JSON
- 在 Agent Prompt 中列为"其他可用上下文"

### 6.4 并行写安全

在并行组内，直接写 Store 会产生竞态。系统使用**暂存写入**：

1. 每个并行子 Stage 将写入缓冲到 `parallelStagedWrites[stageName]`
2. 组完成时，所有暂存写入原子性合并到 `store`
3. YAML 级校验：组内重叠的写键必须使用 `append`/`merge` 策略
4. 禁止兄弟 Stage 读取兄弟的写入（Pipeline 解析时校验）

### 6.5 恢复优化

重试/恢复时，系统避免重新注入未变化的上下文：

1. 在 Stage 启动时用 `stableHash()` 捕获每个读值的哈希
2. 存储在 `stageCheckpoints[stageName].readsSnapshot`
3. 重试时，比较当前哈希与快照
4. 未变化的读值渲染为"Context unchanged"并提示 `get_store_value()`

---

## 7. Prompt 工程架构

### 7.1 六层 Prompt 层级

`buildSystemAppendPrompt()` 从六个层级组装 Agent 的系统 Prompt：

```
+------------------------------------------+
| 第 1 层: 全局约束                         |  跨所有 Stage 的行为规则
+------------------------------------------+
| 第 2 层: 项目规则                         |  CLAUDE.md / GEMINI.md / CODEX.md
+------------------------------------------+
| 第 3 层: Stage 系统 Prompt               |  Stage 特定指令
+------------------------------------------+
| 第 4 层: 知识碎片                         |  关键词匹配的领域知识
+------------------------------------------+
| 第 5 层: 输出 Schema                      |  自动生成的 JSON 格式规范
+------------------------------------------+
| 第 6 层: Step Prompts                     |  条件性能力指令
+------------------------------------------+
```

### 7.2 知识碎片系统

碎片是可复用的知识单元，基于以下条件注入 Prompt：
- **关键词匹配**：碎片元数据声明关键词；与 Stage 名称和 reads 进行匹配
- **Stage 名称匹配**：直接名称关联
- **Always-on 标志**：注入到每个 Agent Stage

这使得领域知识（API 规范、编码标准、架构决策）能够自动呈现给 Agent，而不污染单个 Stage 的 Prompt。

### 7.3 输出 Schema 自动生成

Agent Stage 通过 `outputs` 字段声明结构化输出：

```yaml
outputs:
  implementation_result:
    type: object
    fields:
      - key: files_changed
        type: array
        description: "List of modified file paths"
      - key: summary
        type: string
        description: "Brief description of changes"
```

系统在系统 Prompt 中自动生成 JSON 格式指令，包含字段描述、类型和必填/可选指示。Agent 的响应在写入 Store 前会被解析并对照此 Schema 校验。

---

## 8. 执行模式

### 8.1 本地执行（默认）

编排器服务器直接调用 Agent：
- Claude：通过 `@anthropic-ai/claude-agent-sdk`（进程内，流式）
- Gemini/Codex：通过 `node-pty` 伪终端启动 CLI 工具

### 8.2 Edge 执行

将 Agent 执行与编排器解耦。Edge Runner 是一个独立进程：

1. 连接到 `:3001/mcp` 的 MCP 服务器
2. 通过 `list_available_stages` 轮询待处理的工作
3. 通过 `get_stage_context` 获取完整的 Stage 上下文
4. 在 pty 中启动隔离的 Claude/Gemini 会话
5. 通过 `report_progress` 流式传输转录事件到服务器
6. 通过 `submit_stage_result` 提交结果（带 nonce 校验）

**基于 Nonce 的并发控制：** 每个 Stage 执行槽位分配一个 nonce。如果任务在 Edge Agent 运行时被重试，旧 nonce 失效 —— 防止过期结果被接受。

**基于 Hook 的中断：** Edge Agent 在每次工具调用前通过 `PreToolUse` Hook 检查 `/api/edge/{taskId}/check-interrupt`。如果被中断，Hook 终止工具调用。

### 8.3 混合执行

单个 Pipeline 可以混合引擎和执行模式：

```yaml
stages:
  - name: cheap_analysis
    type: agent
    engine: gemini                  # 使用 Gemini 降低分析成本
    execution_mode: edge            # 在 Edge Worker 上运行
  - name: critical_implementation
    type: agent
    engine: claude                  # 使用 Claude 处理复杂实现
    execution_mode: auto            # 本地运行
```

---

## 9. 错误处理与恢复

### 9.1 按 Stage 重试

```
Stage 错误 -> 超过 MAX_STAGE_RETRIES (2)?
  |-- 否 -> 带反馈恢复（如有会话）或重启 Stage
  +-- 是 -> 转换到 blocked 状态
```

`handleStageError()` 中的重试逻辑：
- **会话恢复**：如果存在 Claude session ID，带反馈消息重试
- **全新启动**：如果没有会话，从头启动 Stage
- **升级**：超过最大重试次数后，转换到 `blocked` 等待人工干预

### 9.2 QA 反馈路由

`retry.back_to` 字段支持自动化 QA 循环：

```
implement -> qa_review -> (发现阻碍) -> implement (携带反馈)
                        -> (通过) -> next_stage
```

QA Stage 检测输出中的失败模式（如 `{ passed: false, blockers: [...] }`），路由回源 Stage 并将结构化反馈注入 Agent 上下文。

### 9.3 验证命令

执行后校验脚本：

```yaml
verify_commands:
  - command: "npx tsc --noEmit"
    policy: must_pass       # must_pass | warn | skip
  - command: "npx eslint . --quiet"
    policy: warn
```

- `must_pass`：验证失败触发重试（最多 `verify_max_retries` 次）
- `warn`：记录警告，继续执行
- `skip`：不执行

### 9.4 Git 补偿

Stage 可以声明失败时的补偿策略：

```yaml
compensation:
  strategy: git_reset    # git_reset | git_stash | none
```

每个 Stage 执行前，Git checkpoint 捕获 `HEAD`。出错时：
- `git_reset`：硬重置到 Stage 开始前的提交
- `git_stash`：暂存未提交的更改
- `none`：不清理

### 9.5 状态恢复层级

```
1. 自动重试（按 Stage，最多 MAX_STAGE_RETRIES 次）
   | 超出
2. blocked 状态（人工可 RETRY / RETRY_FROM / CANCEL）
   | 人工操作
3. RETRY: 恢复最后一个 Stage，保持会话连续性
   RETRY_FROM: 跳转到任意可重试 Stage（带补偿）
   CANCEL -> cancelled 状态 -> RESUME: 从最后一个 Stage 恢复
```

---

## 10. Human-in-the-Loop

### 10.1 门控 Stage 流程

```
Pipeline -> human_confirm Stage
  |-- SSE 事件到控制面板
  |-- Slack 通知（如配置）
  +-- 等待人工操作
       |-- CONFIRM -> on_approve_to（或下一 Stage）
       |-- REJECT -> on_reject_to（或 error）
       +-- REJECT_WITH_FEEDBACK -> 携带上下文路由到 on_reject_to
```

### 10.2 交互式 Agent 模式

`interactive: true` 的 Agent Stage 可以在执行中提问：

1. Agent 调用 `AskUserQuestion` 工具
2. 问题存储在 SQLite `pending_questions` 表
3. SSE 事件广播到控制面板
4. 发送 Slack 通知（如配置）
5. 用户通过控制面板或 Slack 回答
6. 答案注入回 Agent 会话

### 10.3 Slack 集成

- **协议**：通过 `@slack/bolt` + `@slack/socket-mode` 的 Socket Mode
- **能力**：审批/拒绝交互按钮，带 Stage 上下文的通知格式化
- **架构**：Monorepo 中的独立 `slack-cli-bridge` 应用

---

## 11. Pipeline DSL 与校验

### 11.1 YAML Schema

```yaml
name: my-pipeline
engine: claude                        # 默认引擎
display:
  title_path: store.ticket_title      # 从 Store 动态获取任务标题
  completion_summary_path: store.pr_url

stages:
  # 线性 Stage
  - name: analysis
    type: agent
    runtime: { ... }

  # 并行组 (fork/join)
  - parallel:
      name: gather_context
      stages:
        - name: gather_notion
          type: agent
          runtime: { ... }
        - name: gather_figma
          type: agent
          runtime: { ... }

  # 条件路由
  - name: route
    type: condition
    runtime:
      branches:
        - when: "expr"
          to: target
        - default: true
          to: fallback
```

### 11.2 静态校验

`validatePipelineLogic()` 执行编译时检查：

1. **数据流**：每个 `reads` 键必须引用前序 Stage 的 `writes`
2. **路由目标**：`on_reject_to`、`on_approve_to`、`back_to`、condition `to` 必须引用已有 Stage
3. **并行安全**：并行组内禁止 `human_confirm`；禁止重叠的 `replace` 写入；禁止兄弟交叉读取
4. **环检测**：对 `depends_on` 图进行 DFS
5. **输出一致性**：`writes` 键必须有对应的 `outputs` 条目
6. **Prompt 对齐**：系统 Prompt 内容对照 `permission_mode` 和 `disallowed_tools` 校验
7. **MCP 校验**：引用的 MCP 对照注册表检查
8. **Foreach 校验**：验证必填字段（`items`、`item_var`、`pipeline_name`）

### 11.3 互斥性

`depends_on`（DAG 语法）与 `parallel` 组互斥。使用 `depends_on` 时，`transformDagToParallelGroups()` 执行拓扑排序，自动将每个依赖层级转换为并行组。

---

## 12. 可观测性与实时事件流

### 12.1 SSE 架构

`SSEManager` 是管理按任务隔离事件流的单例：

- **按任务状态**：活跃连接、内存历史（每任务最后 500 条消息）、编程式监听器
- **持久化**：SQLite `sse_messages` 表（7 天保留期）
- **重连**：优先从内存历史重放；内存为空时回退到数据库
- **保活**：30 秒心跳注释

### 12.2 事件类型

| 事件类型 | 内容 | 生产者 |
|---------|------|-------|
| `status` | Stage/任务状态变更 | 状态机转换 |
| `stage_change` | Stage 转换通知 | 状态机 |
| `agent_text` | Agent 输出文本 | 流处理器 |
| `agent_tool_use` | 工具调用详情 | 流处理器 |
| `agent_tool_result` | 工具执行结果 | 流处理器 |
| `agent_thinking` | 扩展思考内容 | 流处理器 |
| `cost_update` | 成本累计 | Stage 完成时 |
| `question` | 门控问题 | Gate Stage 进入时 |
| `error` | 错误消息 | 错误处理器 |
| `agent_red_flag` | 安全标记检测 | 红旗扫描器 |

### 12.3 成本追踪

- 按 Stage：从 Agent 结果流中提取 `costUsd`
- 全局：`totalCostUsd` 跨所有已完成 Stage 累计
- Token 细分：`inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheCreationTokens`
- 按模型：`StageTokenUsage.modelBreakdown` 用于多模型 Pipeline
- SSE 广播：每次 Stage 完成时发送 `wf.costUpdate` 事件

---

## 13. 持久化与状态恢复

### 13.1 快照模型

每个任务的 XState 快照持久化为带版本的 JSON 文件：

```
{data_dir}/tasks/{taskId}.json
-> { version: 1, snapshot: { ... } }
```

- **原子写入**：临时文件 + 重命名，防止损坏
- **刷新触发器**：每次 Stage 完成、用户操作（确认/拒绝/重试）
- **启动恢复**：加载所有已持久化的任务 ID；按需懒加载快照

### 13.2 数据库 Schema

SQLite WAL 模式，位于 `{data_dir}/workflow.db`：

| 表 | 用途 | 保留期 |
|---|------|-------|
| `sse_messages` | 事件流历史 | 7 天（可配置） |
| `pending_questions` | 活跃的人工问题 | 直到回答/取消 |
| `edge_slots` | Edge 执行槽位 | 活跃任务生命周期 |

### 13.3 Git 状态检查点

```typescript
interface StageCheckpoint {
  gitHead?: string;        // Stage 前的 git rev-parse HEAD
  startedAt: string;       // ISO 时间戳
  readsSnapshot?: Record<string, string>;  // 读值的哈希
}
```

在每次 Stage 执行前捕获。用于：
- 补偿（出错时 git reset）
- 恢复优化（跳过未变化的 reads）

---

## 14. Registry 与扩展体系

### 14.1 包类型

| 类型 | 用途 | 格式 |
|-----|------|-----|
| Pipeline | 工作流定义 | YAML + Prompt .md 文件 |
| Skill | 可复用的 Prompt 指令 | Markdown |
| Hook | Stage 前/后脚本 | TypeScript |
| Fragment | 知识注入单元 | 带关键词元数据的 Markdown |
| Script | 自定义 Stage 执行器 | TypeScript 模块 |

### 14.2 Registry 服务

- 本地存储在 `registry/` 目录，带清单文件
- 首次安装时引导默认包集
- 发布/安装工作流，用于跨项目共享 Pipeline
- CLI 工具：`registry:build`（构建索引）、`registry:bootstrap`（安装默认包）

### 14.3 AI 驱动的 Pipeline 生成

内置 `pipeline-generator` Pipeline 从自然语言描述创建新 Pipeline：

```
用户描述 -> analysis -> parallel(gen-skeleton, gen-prompts) -> prompt-refinement -> persist
```

1. **分析**：澄清歧义，产出 `stageContracts`（命名的唯一真实来源）
2. **骨架生成**：将 contracts 转换为 YAML 结构
3. **Prompt 生成**：按 Stage 编写 Prompt，对齐约束
4. **精炼**：增强 Prompt 的清晰度和错误处理
5. **持久化**：校验并写入 Registry

---

## 15. 安全模型

### 15.1 Agent 权限模式

| 模式 | 能力 |
|-----|------|
| `auto` | 完整工具访问，使用标准 Claude 权限 |
| `plan` | 只读；禁止文件写入、Bash、工具调用 |
| `bypassPermissions` | 所有工具无需确认即可使用 |

### 15.2 MCP 工具范围限定

每个 Stage 通过 `mcps: [...]` 声明所需的 MCP 服务器。仅声明的 MCP 附加到 Agent 会话，限制每个 Stage 的工具表面积。

### 15.3 已知安全缺口

- 任务控制端点缺乏认证中间件
- Edge Runner 通过未加密的 HTTP 通信（localhost 上无 TLS）
- MCP 工具调用无速率限制
- Worktree 路径可通过 Pipeline 配置由用户控制

---

## 16. 已知缺陷与客观评估

> 以下所有缺陷均经过源码逐行验证，确认为真实存在的问题。

### 16.1 架构弱点

#### 单进程瓶颈
编排器作为单个 Node.js 进程运行。无水平扩展、无进程集群、无分布式状态。对于运行 50+ 并发 Pipeline 的团队，这是一个硬性上限。Edge Runner 通过卸载 Agent 执行部分缓解了此问题，但状态机协调仍然是中心化的。

**严重程度：企业级使用为高；个人/小团队使用可接受。**

#### SQLite 作为唯一数据库
SQLite 对于单写入者工作负载表现优秀，但存在根本限制：
- 无远程访问（仅限本地文件）
- 高 SSE 吞吐下的写争用
- 除文件复制外无复制或备份策略
- WAL 模式有所帮助但无法消除单写入者约束

**严重程度：中等。当前规模下足够，但阻碍多服务器部署。**

#### 无认证与授权
REST API 和 MCP 服务器完全开放。localhost 上的任何进程都可以：
- 创建和取消任务
- 提交 Stage 结果
- 读取所有 Store 数据
- 修改 Pipeline 配置

**严重程度：任何共享或生产环境下为高。**

#### 内存绑定的 SSE 历史
SSE 管理器在内存中保存每任务最后 500 条消息，100 个任务时触发 LRU 淘汰。持续高负载下，内存压力线性增长。SQLite 回退存在但在重连时引入延迟。

**严重程度：低至中等。100 任务的 LRU 上限合理，但不可在不修改代码的情况下配置。**

### 16.2 工作流引擎 Bug

#### 环检测遗漏门控路由边
在 `pipeline-validator.ts` 中，环检测器仅对 `depends_on` 边进行 DFS（第 136-158 行）。在 `pipeline-builder.ts` 中，存在单独的 `back_to` 环检测器（第 390-414 行）。两个校验器都没有构建包含 `on_approve_to` / `on_reject_to` 边的图。类似 `gate1 --on_approve_to--> stage2 --> gate2 --on_reject_to--> gate1` 的 Pipeline 能通过所有校验，但在运行时产生无限循环。

**影响：复杂门控路由的 Pipeline 可能产生无限循环。严重程度：中等。**

#### 重试计数日志 Off-by-One
在 `helpers.ts`（第 208-231 行）中，`handleStageError` 函数的 action 数组调用 `assign({ retryCount: context.retryCount + 1 })` 后跟 `emit()` 和读取 `context.retryCount` 的日志。在 XState 中，数组中的 action 在 assign 生效前执行，因此日志/发射的值始终是递增前的值。第一次重试日志显示"attempt 0"而非"attempt 1"。

**影响：调试时日志输出具有误导性；无功能影响。严重程度：低。**

#### Pipeline 递归调用无保护
在 `pipeline-executor.ts` 中，`runPipelineCall` 函数通过 `createTaskDraft` 创建子任务，但没有深度追踪、父任务 ID 链校验或循环依赖检测。直接或间接调用自身的 Pipeline 可能创建无限递归。

**影响：通过无限子 Pipeline 生成导致资源耗尽。严重程度：中等。**

### 16.3 设计限制

#### 不支持条件性并行组
并行组在 YAML 中是静态定义的。无法根据运行时状态有条件地包含/排除并行子 Stage。需要根据条件执行的 Stage 必须在并行组前使用 `condition` Stage。

**变通方案：拆分为 condition + 两个独立的并行组。**

#### 并行组内无跨 Stage 数据依赖
并行组内的兄弟 Stage 无法读取彼此的写入。这是设计使然（暂存写入在组完成时原子性合并），但阻止了并发 Stage 间的增量数据共享。

**变通方案：组后 Stage 可以合并并行输出。**

#### Gemini 成本追踪未实现
Gemini CLI 不报告成本数据（代码中有明确的 TODO 注释：`// TODO: Gemini CLI may not report cost`）。Gemini Stage 的 `totalCostUsd` 始终为 0，导致混合引擎 Pipeline 的成本核算不完整。

**影响：Gemini Stage 的预算执行不生效。**

#### Edge Runner 转录解析脆弱
转录同步依赖在 Claude 特定目录路径（`~/.claude/projects/<normalized-cwd>/`）中查找最新的 `.jsonl` 文件。存在多个脆弱点：(1) 路径规范化将 `/` 替换为 `-`，可能产生冲突（如 `/a/b` 和 `/a-b` 都规范化为 `a-b`）；(2) 转录文件路径在首次发现后绑定且永不更新 —— 如果 Claude CLI 在会话中创建新文件，Runner 继续读取旧文件；(3) 所有错误被静默吞没（`catch { /* non-critical */ }`），使故障不可见。

**影响：Claude 更新或路径冲突时，Edge Runner 可观测性静默中断。严重程度：中等。**

#### Store 运行时无类型
尽管有 YAML 输出 Schema，Store 在运行时是 `Record<string, any>`。没有运行时类型强制 —— Stage 可以向任意键写入任意形状。Schema 校验仅检查声明键的*存在性*，不检查*形状*。

**影响：下游 Stage 可能收到意外的数据形状，导致静默失败。**

### 16.4 运维缺口

#### 无指标与告警
无 Prometheus/OpenTelemetry 集成。无健康检查端点。无任务失败、成本超支或系统错误的告警。可观测性仅限于 SSE 事件流和 Pino 日志。

**严重程度：中等。开发使用可接受；阻碍生产部署。**

#### 无备份与灾难恢复
任务快照是本地 JSON 文件。SQLite 是本地文件。无自动备份、无时间点恢复、无数据导出。

**严重程度：低至中等。Git 状态部分缓解此问题（代码变更可通过分支恢复）。**

#### 优雅停机缺少 Agent Drain
服务器处理了 `SIGTERM`/`SIGINT`，正确关闭 HTTP 服务器、清扫定时器、Slack 应用和数据库。但没有为活跃 Agent 会话设置 drain 期 —— 运行中的 Agent 在停机时被立即终止。任务可以在重启后从 `blocked` 状态恢复，但进行中的工作丢失。

**严重程度：低。现有恢复机制足以覆盖此缺口。**

---

## 17. 与同类方案的对比

### 17.1 vs. LangGraph

| 维度 | Workflow Control | LangGraph |
|-----|-----------------|-----------|
| 状态机 | XState v5（形式化、类型化） | 自定义图运行器 |
| 语言 | TypeScript | Python |
| Agent SDK | Claude/Gemini/Codex 原生 | LangChain 抽象 |
| 持久化 | JSON 快照 + SQLite | Checkpointer（可插拔） |
| Human-in-loop | 一等公民 Gate Stage + Slack | 中断机制 |
| 成本控制 | 按 Stage 预算 | 需手动实现 |
| Edge 执行 | 内置 Edge Runner | 不可用 |
| Pipeline DSL | YAML（无代码） | Python 代码 |

**核心差异化：** Workflow Control 的 YAML DSL 使非程序员也能定义 Pipeline，而 LangGraph 每个工作流都需要 Python 代码。

### 17.2 vs. Temporal

| 维度 | Workflow Control | Temporal |
|-----|-----------------|----------|
| 定位 | AI Agent 编排 | 通用工作流编排 |
| 规模 | 单进程 | 分布式，水平可扩展 |
| 持久性 | JSON 文件 + SQLite | 事件溯源，生产级 |
| 学习曲线 | YAML 配置 | SDK + 服务器部署 |
| AI 原生 | 是（Prompt 分层、Token 追踪、成本预算） | 否（通用 Activity） |
| 成熟度 | 早期阶段 | 经过生产验证 |

**核心差异化：** Workflow Control 是为 AI Agent 量身打造的；Temporal 是通用工作流引擎，用于 AI 场景需要大量定制开发。

### 17.3 vs. Claude Code 原生

| 维度 | Workflow Control | Claude Code（独立使用） |
|-----|-----------------|------------------------|
| 多阶段 | 形式化 Pipeline Stage | 单会话 |
| 成本控制 | 按 Stage 预算 | 仅会话级 |
| 人工门控 | 结构化审批流 | 手动中断 |
| 多引擎 | Claude + Gemini + Codex | 仅 Claude |
| 持久化 | 跨重启恢复 | 会话绑定 |
| 并行执行 | Fork/Join 带隔离 | 仅顺序执行 |

**核心差异化：** Workflow Control 在 Claude Code 作为单 Agent 工具的基础上，增加了编排、门控和多引擎支持。

---

## 18. 结论

Workflow Control 代表了一种深思熟虑的 AI Agent 编排方式，优先考虑**形式化正确性**（XState）、**声明式配置**（YAML DSL）和**人工监督**（Gate Stage），而非原始可扩展性。其架构做出了明确的赌注：

**正在验证成功的赌注：**
- XState v5 作为状态机基础，提供了真正的可调试性和状态恢复能力
- 分层上下文系统（Tier 1 预算 + Tier 2 按需获取）优雅地管理 Token 成本
- YAML Pipeline DSL 配合静态校验在执行前捕获错误
- Edge Runner 架构干净地分离了编排与执行
- Git 原生的 worktree 隔离是代码生产工作流的自然匹配

**携带风险的赌注：**
- 单进程架构限制了超出个人/小团队使用的扩展
- SQLite 作为唯一持久化层阻止分布式部署
- 无类型的运行时 Store 依赖约定而非强制
- Edge Runner 转录解析依赖未公开文档的 Claude 内部实现

系统适合 1-5 人开发团队编排带人工监督的复杂 AI 工作流。对于更大规模的企业部署，单进程瓶颈、缺乏认证、以及运维工具（指标、告警、备份）的缺失是阻碍，需要大量的工程投入来弥合。

代码库展现了较高的工程质量 —— 广泛的测试覆盖（包括对抗性测试）、完整的类型契约、深思熟虑的错误处理。仅 Pipeline 校验器就覆盖了 15+ 类静态检查。但"对单用户正确工作"和"大规模可靠运行"之间的差距仍然很大，项目的架构需要根本性的变化（分布式状态、真正的数据库、认证层）才能跨越这一鸿沟。

---

*本文档反映 2026-04-14 代码库状态。所有声明均基于源码逐行分析，缺陷章节经过完整验证。*
