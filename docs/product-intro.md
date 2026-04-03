# Workflow Control 产品介绍

> 给 AI 编码 Agent 加上流水线——让它按步骤做事、每一步你都能看见和控制。

---

## What — 这是什么

你已经在用 Claude Code 或 Gemini CLI 写代码了。它们很强，但本质上是"你说一句，它做一件事"的单轮对话。

Workflow Control 做的事情是：**在 Agent 外面包一层流水线**。你用 YAML 定义"先做什么、再做什么"，引擎负责按顺序驱动 Agent 执行每一步，在你指定的节点暂停等审批，同时把每一步的进度、成本、Agent 的思考过程实时推送到一个 Web Dashboard。

打个比方：如果 Claude Code 是一个能力很强的员工，Workflow Control 就是给这个员工写了一套 SOP。没有 SOP 时，你口头交代一件大事，他做到哪算哪；有了 SOP，每一步有明确的输入输出，关键节点要你签字确认，出了问题可以从断点恢复。

### 它能做什么（和不能做什么）

**能做的：**
- 把"分析需求 -> 技术设计 -> 写代码 -> 跑构建 -> code review -> 创建 PR"这样的多步骤任务编排成自动化流水线
- 每个步骤独立设置预算上限，关键步骤前暂停等你审批
- 任务出错时从断点恢复，之前的工作成果不丢失
- 实时 Dashboard 监控 Agent 在干什么、花了多少钱
- 同一个流水线可以混用 Claude 和 Gemini（比如分析用 Gemini 省钱，实现用 Claude 保质量）

**现阶段的局限：**
- 流水线系统还在迭代中，内置的几个流水线模板是可用的起点，但不一定适合所有场景——你大概率需要根据自己的项目调整
- 不是银弹，小任务（改个组件、修个 bug）直接用 CLI 更快

### 核心架构

```
apps/
  server/           Hono API (:3001) + XState v5 工作流引擎 + Agent SDK
    config/
      pipelines/    流水线 YAML 定义 + 每阶段 prompt
      mcps/         MCP 服务注册
      prompts/      知识片段 + 全局约束
  web/              Next.js 16 Dashboard (:3000) — 任务管理、实时监控、配置编辑
packages/
  shared/           TypeScript 类型契约（Task、SSEMessage、API 接口）
```

- **Server**：Hono REST API + XState v5 状态机（从 YAML 动态生成）。Claude Agent SDK 和 Gemini CLI 作为执行后端。SQLite 存消息历史，JSON 文件存任务快照。
- **Dashboard**：Next.js + React 19 + Tailwind v4。SSE 驱动实时消息流。Monaco 编辑器改流水线配置，Mermaid 渲染流水线图。
- **Shared**：TypeScript 类型定义，Server 和 Web 共用。

### 两种执行模式

**Web 模式（Dashboard）**

Server 在进程内通过 Claude Agent SDK 或 Gemini CLI 子进程执行 Agent 阶段。

- SSE 实时推送到 Dashboard，你在浏览器里看
- 支持所有流水线选项（model、effort、thinking、budget、sub-agents 等）
- 适合：不想盯着终端、团队需要可见性、长任务过夜跑

**Edge 模式（终端）**

Edge Runner 在本地终端通过 PTY 启动 Claude/Gemini CLI，你可以直接跟 Agent 交互。

- 键盘直接输入，像正常用 CLI 一样
- 适合：调试流水线、交互式编码、本地开发

两种模式共享同一套流水线定义和数据存储。可以在 Dashboard 创建任务然后从终端接入，也可以反过来。

### 支持的引擎

- **Claude**：Web 模式用 `@anthropic-ai/claude-agent-sdk`；Edge 模式用 `claude` CLI
- **Gemini**：两种模式都用 `gemini` CLI 子进程

支持**混合引擎**——同一个流水线中，每个阶段可以独立指定 `claude` 或 `gemini`。`test-mixed` 流水线就是一个混合引擎的示例。

---

## Why — 为什么需要

### 直接用 CLI 做大任务的问题

改一个组件、修一个 bug，直接用 CLI 完全够了。但当任务变大——分析需求、技术设计、实现多个文件、跑构建、code review、创建 PR——单次终端对话的局限就暴露出来了：

| 问题 | 直接用 CLI | Workflow Control |
|---|---|---|
| **没有结构** | 单次会话，做到哪算哪 | 流水线阶段强制执行顺序，每步有明确的输入和输出 |
| **成本失控** | 全局 budget，用超了才知道 | 每阶段独立 budget 上限 + 人工审批门控 |
| **故障不可恢复** | 会话崩了从头来 | 状态持久化，从故障点精确重试，之前的成果全保留 |
| **不可观测** | 终端输出刷过去就没了 | SSE 实时推送 Dashboard，按类型/阶段过滤，成本明细 |
| **不可复现** | 取决于你当时打了什么字 | YAML 流水线 + 版本化 prompt = 每次跑同样的流程 |
| **工具集成零散** | 每次手动配 MCP | MCP 注册一次，按阶段选择性启用 |

### 具体怎么解决

**流水线阶段**：把大任务拆成多个有序步骤。每个步骤有明确的职责——有的让 AI 做事，有的跑自动化脚本，有的暂停等你审批。

**每阶段预算上限 + 人工门控**：你可以给每个 AI 阶段设独立的美元上限。在关键节点插入人工审批——你不点确认，流程不会往下走。

**持久化快照 + 故障重试**：每个状态变更都写 JSON 快照。Agent 阶段出错，任务进入 `blocked` 状态——你检查错误，修复问题，点 retry，从失败的阶段继续。

**SSE 实时 Dashboard**：Agent 的每条文本、工具调用、思考过程、成本变动都实时推送。

**YAML + Markdown 配置**：流水线是 YAML 文件，prompt 是 Markdown 文件，全在 Git 里管理。改流水线改 YAML，改 prompt 改 Markdown，不用动代码。

---

## How — 怎么用

### 流水线系统（Pipeline System）

#### 三种阶段类型

一个流水线由多个**阶段（stage）**组成，每个阶段是以下三种类型之一：

| 类型 | 干什么 | 举例 |
|---|---|---|
| `agent` | AI Agent 执行任务——读代码、写代码、做分析、生成文档 | 分析需求、技术设计、写代码、code review |
| `script` | 运行确定性的自动化脚本——不涉及 AI，结果可预测 | 创建 git 分支、跑构建、创建 PR |
| `human_confirm` | 暂停流水线，等人审批——批准继续、驳回回退 | 审批分析结果、审批技术设计 |

#### 数据流：阶段之间怎么传递信息

阶段之间通过一个叫 `store` 的中央数据仓库交换信息。每个阶段必须显式声明它要读什么（`reads`）和写什么（`writes`）：

```
阶段 A (agent)         writes: [analysis]      -> store.analysis = { title, risks, ... }
阶段 B (human_confirm) 用户看到 analysis 内容，决定批准或驳回
阶段 C (agent)         reads: { plan: analysis.plan } -> Agent 拿到 plan 作为上下文
阶段 D (script)        reads: { branch: analysis.branchName } -> 脚本拿到分支名去创建分支
```

这种设计的好处：每个阶段只看到它需要的数据，不会因为前面阶段的冗余输出浪费 token。

#### 一个典型的流水线长什么样

下面是一个**通用的功能开发流水线结构**（你可以根据自己的需求增减阶段）：

```
[agent] 分析需求        输入：用户描述 / Notion 链接
                        输出：结构化分析（标题、优先级、风险、受影响文件）
    |
[human_confirm] 审批    你检查分析结果，批准或驳回（驳回回到分析）
    |
[script] 创建分支       自动从分析结果生成分支名并创建
    |
[agent] 技术设计        读取分析结果，输出技术方案
    |
[human_confirm] 审批    你检查技术方案
    |
[agent] 写代码          读取分析 + 技术方案，实现代码
                        可以委派子 Agent 并行实现多个文件
    |
[script] 构建验证       跑 build / test，失败则回退到写代码阶段重试
    |
[agent] 质量检查        安全审查 + 代码质量对照
    |
[script] 创建 PR        通过 gh CLI 创建 GitHub PR
    |
完成                    PR 链接存在 store 里
```

注意：这只是一个结构示例。实际的流水线模板还在持续迭代中，你完全可以自己定义阶段数量和顺序。

#### YAML 配置示例

以下展示几个不同类型阶段的 YAML 写法，让你了解配置长什么样：

```yaml
# agent 阶段：让 AI 分析需求
- name: analyzing
  type: agent
  runtime:
    engine: llm             # AI 引擎执行
    system_prompt: analysis  # 对应 prompts/system/analysis.md
    writes:
      - analysis             # 输出写入 store.analysis
  outputs:                   # 定义输出结构（Agent 会按这个格式输出 JSON）
    analysis:
      type: object
      fields:
        - { key: title, type: string }
        - { key: risks, type: "string[]" }
        - { key: summary, type: markdown }
  max_turns: 30              # Agent 最多执行 30 轮工具调用
  max_budget_usd: 2          # 本阶段最多花 $2
  mcps: [notion]             # 本阶段启用 Notion MCP

# human_confirm 阶段：等人审批
- name: awaitingConfirm
  type: human_confirm
  runtime:
    engine: human_gate
    on_reject_to: analyzing  # 驳回则回到分析阶段

# script 阶段：跑构建验证
- name: buildGate
  type: script
  runtime:
    engine: script
    script_id: build_gate
    reads:
      worktreePath: worktreePath.worktreePath
    retry:
      max_retries: 1         # 失败重试 1 次
      back_to: implementing  # 重试时回退到实现阶段

# agent 阶段：支持子 Agent 并行
- name: implementing
  type: agent
  runtime:
    engine: llm
    system_prompt: implementation
    writes: [implementedFiles]
    reads:                   # 从 store 读取前序阶段的输出
      analysis: analysis
      techContext: techContext
    agents:                  # 子 Agent 定义
      file-implementer:
        description: Implements a single file
        model: sonnet        # 用较便宜的模型
        tools: [Read, Write, Edit, Bash]
        maxTurns: 30
  max_budget_usd: 8
```

#### Sub-agents：让主 Agent 委派子任务

`agent` 阶段可以定义子 Agent。主 Agent 负责协调全局，把具体工作（比如实现某个文件、跑测试）委派给子 Agent。子 Agent 各自有独立的模型、工具权限和 turn 限制——可以用便宜的模型做简单工作。

#### 知识片段（Fragment）：给 Agent 注入项目知识

知识片段是 Markdown 文件，存在 `config/prompts/fragments/` 目录下。它们的作用是：**把你的项目约定和领域知识告诉 Agent**。

比如你的项目有一套 React 编码规范，你可以写成一个 fragment：

```markdown
---
id: react-patterns
keywords: [react, component, hook]
stages: [implementing, reviewing]
always: false
priority: 10
---

- Use functional components with arrow functions
- Prefer composition over inheritance
- Custom hooks must start with "use" prefix
```

引擎会根据 frontmatter 中的 `keywords` 和 `stages` 决定何时注入这段知识：
- `stages: [implementing, reviewing]` 表示只在实现和 review 阶段注入
- `keywords: [react, component, hook]` 表示只在任务内容匹配到这些关键词时注入
- `always: true` 的片段会在所有阶段无条件注入

这样做的好处是：Agent 只在需要的时候收到相关知识，不会在不相关的阶段浪费 token。

---

### Prompt 架构

Agent 每次执行时收到的系统 prompt 不是一整块文本，而是由 6 层自动组装而成（从全局到局部）：

| 层级 | 作用域 | 来源 | 举例 |
|---|---|---|---|
| Global Constraints | 所有流水线的所有阶段 | `prompts/global-constraints.md` | "永远用 TypeScript"、"不要道歉" |
| Project Rules | 所有流水线的所有阶段 | `claude-md/global.md` | "用 pnpm"、"遵循既有模式" |
| Stage Prompt | 当前阶段 | `prompts/system/{stage}.md` | 该阶段的具体目标和指令 |
| Knowledge Fragments | 按条件匹配的阶段 | `prompts/fragments/*.md` | 项目编码规范、领域知识（见上文） |
| Output Schema | 当前阶段 | 从 YAML `outputs` 配置自动生成 | 告诉 Agent 输出什么 JSON 结构 |
| Step Prompts | 当前阶段 | YAML `available_steps` 配置 | 根据启用的能力注入条件指令（如"启用了 Figma 步骤时，先提取设计 token"） |

这种分层意味着：改 Global Constraints 影响所有地方；改 Stage Prompt 只影响一个阶段；新增 Fragment 按条件注入。不需要改代码。

#### 上下文分级：控制 token 用量

Agent 执行时，并不是把所有历史数据一股脑塞进 prompt。上下文被分成两级：

**Tier 1 — 直接注入 prompt（约 500 tokens）**

从当前阶段的 `reads` 配置中提取的紧凑摘要。具体来说：
- 任务基本信息（ID、描述、当前分支）
- `reads` 中声明的 store 值（数组截取前 5 项，长字符串截断到 300 字符）
- 未被 `reads` 引用的 store key 只列出名称，不展开内容

这是 Agent "开箱就能看到"的信息。

**Tier 2 — 写入文件，Agent 按需读取（不占 prompt token）**

完整的 store 数据和知识片段被写入工作目录的 `.workflow/` 文件夹：
- `.workflow/knowledge/*.md` — 全部知识片段的原始内容
- `.workflow/<store-key>` — store 中每个 key 的完整数据

Agent 的 Tier 1 上下文中会提示"还有哪些文件可以读"，Agent 需要详细信息时自己去读文件。这样不读就不花 token。

---

### 任务生命周期

#### 状态流转

```
idle -> [stage 1] -> [stage 2] -> ... -> [stage N] -> completed
             |                              |
          blocked (Agent 出错) <------------+
             | retry
          [从失败阶段恢复]

          cancelled (你主动取消) -> resume -> [从上次阶段恢复]
```

| 状态 | 含义 | 你能做什么 |
|---|---|---|
| idle | 已创建未启动 | 点 Launch 开始 |
| 运行中 | Agent / Script / 审批门控 正在执行 | 监控、发消息给 Agent（interrupt）、取消 |
| blocked | Agent 阶段出错 | 检查错误，修复后 retry 或 sync-retry |
| cancelled | 你主动取消 | resume 从上次活跃阶段恢复 |
| completed | 所有阶段完成 | 查看结果 |

关键设计：`blocked` 和 `cancelled` 都是**可恢复的**。累积的 store 数据全部保留。

**Sync Retry**：如果 Agent 的输出 90% 正确，你手动修完剩下的问题，然后 sync-retry——Agent 会检查当前文件状态，基于你的修改继续工作，而不是从头来。

#### 持久化

每次状态变更写 JSON 快照到磁盘。服务器重启时扫描快照文件，重建状态机。正在执行的阶段降级为 `blocked`（安全起见不自动重新执行），你手动 retry 继续。

#### SSE 实时流

| 事件类型 | 内容 |
|---|---|
| `agent_text` | Agent 输出的文本 |
| `agent_tool_use` | Agent 调用了什么工具、传了什么参数 |
| `agent_thinking` | Agent 的思考过程（extended thinking） |
| `cost_update` | 成本变动（总成本、阶段成本） |
| `stage_change` | 阶段切换 |
| `question` | Agent 提问，等你回答 |
| `error` | 错误信息 |

#### 人机交互点

| 交互 | 什么时候发生 | 怎么操作 |
|---|---|---|
| 审批门控 | 流水线到达 `human_confirm` 阶段 | Dashboard 或 Edge 终端中批准/驳回/附反馈 |
| Agent 提问 | Agent 遇到不确定的事情 | 在问题面板输入答案 |
| Interrupt | Agent 执行期间任何时候 | 发消息给 Agent 重定向它的行为 |
| Retry / Sync Retry | 任务 blocked | 重跑失败阶段，或让 Agent 先检查你的手动修改 |
| Cancel & Resume | 任何时候 | 取消保留状态，之后可恢复 |
| Slack 交互 | 流水线到达 `human_confirm` 或 blocked | Slack 中直接审批/驳回/回答问题/发消息 |

### Slack 集成

支持通过 Slack 进行双向交互，无需打开 Dashboard 即可操作任务。

#### 通知与操作

所有 `human_confirm` 门控自动发送 Slack 通知。通知消息带有交互按钮（需要配置 Socket Mode）：

| 场景 | Slack 中的操作 |
|---|---|
| Gate 审批 | 点击 Approve / Reject / Reject with Feedback |
| Agent 提问（有选项） | 点击选项按钮 |
| Agent 提问（无选项） | 点击 Answer 按钮，弹窗输入 |
| 任务 blocked | 点击 Send Message 按钮，弹窗输入 |
| 阶段完成 / 任务完成 / 取消 | 纯信息通知 |

按钮点击后原消息自动更新为操作结果（如 "Approved by user"），避免重复操作。

#### 配置

在 `system-settings.yaml` 中配置（支持 `${ENV_VAR}` 插值）：

```yaml
slack:
  bot_token: ${SLACK_BOT_TOKEN}
  notify_channel_id: ${SLACK_NOTIFY_CHANNEL_ID}
  signing_secret: ${SLACK_SIGNING_SECRET}
  app_token: ${SLACK_APP_TOKEN}        # Socket Mode 需要
```

- **无 `app_token`**：纯文本通知，无交互按钮
- **有 `app_token`**：Socket Mode 连接，通知带交互按钮，支持在 Slack 内直接操作

Socket Mode 不需要公网 URL，本地运行即可。

Dashboard Config 页面的 Health tab 可查看 Slack 连接状态。

---

### 配置包管理（Registry / Store）

配置包是打包好的流水线、知识片段、脚本等，可以通过 CLI 或 Web UI 安装和管理。

#### 包类型

| 类型 | 是什么 |
|---|---|
| pipeline | 流水线定义（YAML + 对应的 prompt 文件） |
| fragment | 知识片段（Markdown 文件，注入 Agent prompt） |
| skill | Agent 技能定义 |
| hook | 钩子（如写文件后自动格式化） |
| script | 自动化脚本（如创建分支、跑构建） |

#### CLI 命令

```bash
pnpm --filter server registry search [query] --type=pipeline   # 搜索
pnpm --filter server registry install <name>                    # 安装
pnpm --filter server registry update [name]                     # 更新
pnpm --filter server registry list                              # 列出已安装
pnpm --filter server registry outdated                          # 检查可更新
pnpm --filter server registry uninstall <name>                  # 卸载
pnpm --filter server registry publish <directory>               # 发布
```

#### Web UI

Dashboard 的 Store 页面（`/registry`）提供图形化界面。你也可以在 Config 页面创建流水线，然后在 Store 页面发布到远程注册表。

#### Bootstrap

新 clone 项目后，跑一次 bootstrap 安装默认配置包：

```bash
pnpm registry:bootstrap
```

---

### Edge Runner

#### 工作原理

```
Edge Runner (终端)  --HTTP-->  Hono Server (管理任务状态)
      | PTY 启动                        |
Claude/Gemini CLI  --MCP-->  workflow-control MCP Server
      |                                 |
      +---transcript sync--->  SSE push to Dashboard
```

Runner 通过 HTTP 与 Server 通信，用 PTY 启动 CLI 进程。CLI 通过 MCP 协议连回 Server 获取阶段指令和提交结果。所有 transcript 同步回 Server，Dashboard 保持更新。

#### 使用方式

```bash
# 新建任务并执行
pnpm edge -- --trigger "Add dark mode toggle" --pipeline claude-text

# 指定引擎
pnpm edge -- --trigger "Refactor auth module" --pipeline test-mixed --engine gemini

# 接入已有任务
pnpm edge -- <task-id>
```

#### Command Mode（Ctrl+\）

| 按键 | 动作 |
|---|---|
| c | 取消任务 |
| p | 暂停退出（保留状态，之后重新接入） |
| m | 给 Agent 发消息（interrupt） |
| q | 返回 Agent |

审批门控到达时，终端切换到交互提示：`a` 批准、`r` 驳回、`f` 反馈。门控也可以在 Dashboard 侧操作。

---

### Dashboard

#### 任务列表

实时状态更新，显示任务标题、当前阶段、状态、累计成本。

#### 任务详情

- **Workflow Tab**：实时消息流——Agent 文本、工具调用、思考过程。顶部阶段时间线。支持按类型、阶段、关键词过滤。
- **Summary Tab**：任务各阶段的输出数据，按 output schema 渲染成可读格式。
- **Agent Config Tab**：当前任务使用的流水线配置快照。支持在运行中修改 prompt 或 budget（Interrupt unlock 模式）。

#### Config 页面

- 流水线可视化编辑器 + 原始 YAML 双向同步
- AI 生成流水线（自然语言描述 -> YAML 配置）
- 全局 prompt 编辑
- MCP 注册表配置
- 系统健康检查 + Slack 通知状态

#### 国际化

支持英文和中文切换。

---

### Quick Start

#### 前置条件

| 依赖 | 版本 | 备注 |
|---|---|---|
| Node.js | >= 20 | 需要内置 `node:sqlite` 模块 |
| pnpm | 任意 | `npm install -g pnpm` |
| gh CLI | 任意 | GitHub 操作需要，`gh auth login` 认证 |
| Claude Code 或 Gemini CLI | 任意 | 至少一个在 PATH 上 |
| Slack App | 可选 | Socket Mode 双向交互需要 Bot Token + App Token |

#### 安装步骤

```bash
# 1. 克隆项目
git clone https://github.com/ymh357/workflow-control.git
cd workflow-control

# 2. 安装依赖
pnpm install

# 3. 构建 registry 索引（从 registry/ 目录生成 index.json）
pnpm registry:build

# 4. 安装默认配置包到 config/（流水线、prompt、脚本等）
pnpm registry:bootstrap

# 5. 交互式配置（MCP servers、环境变量、健康检查）
pnpm setup

# 6. 启动
pnpm dev    # Server (:3001) + Dashboard (:3000)
```

> `system-settings.yaml` 支持 `${ENV_VAR}` 环境变量插值。敏感值（token、密钥）应放在 `.env.local` 中，不要直接写在 YAML 里。项目提供 `system-settings.yaml.example` 作为配置模板。

> Registry 仓库（配置包源）：https://github.com/ymh357/workflow-control-registry

#### 第一个任务

**通过 Dashboard：**

打开 `http://localhost:3000`，输入任务描述（或粘贴 Notion URL），选择一个流水线，点 Create。任务会自动开始执行。

**通过 Edge Runner：**

```bash
pnpm edge -- --trigger "给登录页面加暗色模式切换" --pipeline claude-text
```

#### 健康检查

Config 页面有健康面板，验证 Node.js 版本、CLI 可用性、MCP 连通性等。如果有问题会提示你怎么修。

---

### 技术细节

#### 技术栈

| 层 | 技术 |
|---|---|
| Server 框架 | Hono |
| 状态机 | XState v5 |
| Agent SDK | @anthropic-ai/claude-agent-sdk |
| 终端执行 | node-pty |
| 数据库 | node:sqlite（Node.js 内置） |
| Dashboard | Next.js 16 + React 19 + Tailwind v4 |
| 代码编辑器 | Monaco |
| 国际化 | next-intl |
| 流水线可视化 | Mermaid |

#### MCP 集成

MCP 服务在 `config/mcps/registry.yaml` 集中注册，在流水线中按阶段选择性启用：

```yaml
# config/mcps/registry.yaml — 注册 MCP 服务
notion:
  command: npx
  args: [-y, "@notionhq/notion-mcp-server"]
  env:
    OPENAPI_MCP_HEADERS:
      json:
        Authorization: "Bearer ${NOTION_TOKEN}"
```

```yaml
# pipeline.yaml — 在某个阶段启用
- name: analyzing
  mcps: [notion, context7]
```

#### 内置脚本

| Script ID | 用途 |
|---|---|
| `create_branch` | 从分析结果创建 git 分支 |
| `git_worktree` | 创建隔离的 git worktree |
| `build_gate` | 运行构建/测试验证 |
| `pr_creation` | 通过 gh CLI 创建 GitHub PR |
| `notion_sync` | 同步任务状态到 Notion |

---

### API 端点速览

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/tasks` | 创建任务 |
| POST | `/api/tasks/:id/launch` | 启动任务 |
| GET | `/api/tasks` | 列出所有任务 |
| GET | `/api/tasks/:id` | 任务详情 |
| POST | `/api/tasks/:id/confirm` | 批准审批门控 |
| POST | `/api/tasks/:id/reject` | 驳回审批门控 |
| POST | `/api/tasks/:id/answer` | 回答 Agent 问题 |
| POST | `/api/tasks/:id/retry` | 重试 blocked 任务 |
| POST | `/api/tasks/:id/cancel` | 取消任务 |
| POST | `/api/tasks/:id/resume` | 恢复取消的任务 |
| GET | `/api/stream/:id` | SSE 事件流 |
| GET | `/api/stream/tasks` | 全局任务列表 SSE |
| POST | `/api/config/pipelines/generate` | AI 生成流水线 |
| GET/PUT | `/api/config/*` | 配置管理 |

---

### 自定义流水线

1. 在 Dashboard Config 页面新建，或复制一个现有流水线目录（`config/pipelines/xxx/`）
2. 编辑 `pipeline.yaml`：增减阶段、调整路由逻辑、修改预算
3. 编辑 `prompts/system/{stage}.md`：调整每个阶段给 Agent 的指令
4. （可选）新增知识片段：在 `config/prompts/fragments/` 下写 Markdown
5. 或者使用 AI 生成：Config 页面点击 "AI Generate"，输入自然语言描述，自动生成完整流水线配置
6. Config 页面有实时校验，YAML 格式错误或引用缺失会立即提示

#### 成本控制

每个 `agent` 阶段可以设 `max_budget_usd`，超出后阶段自动停止。成本在 Dashboard 实时可见，每个阶段独立追踪。你可以根据任务复杂度灵活调整。

#### Web 模式 vs Edge 模式怎么选

| 场景 | 推荐 |
|---|---|
| 不想盯着终端，让它自己跑 | Web |
| 调试流水线或 prompt | Edge |
| 需要跟 Agent 对话（交互式编码） | Edge |
| 过夜跑长任务 | Web |
| 团队都能看到进度 | Web |

两种模式可以混用。
