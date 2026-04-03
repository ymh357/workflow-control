# Workflow Control

配置驱动的自主 Agent 工作流引擎。
它将复杂的工程任务拆解为可编排、可观测、可恢复的流水线阶段
——由 AI Agent、自动化脚本和人工检查点协同执行。

> **配置驱动**
> 流水线就是 YAML 文件。添加阶段、调整模型、设定预算、
> 改变路由——无需修改代码。编辑一个文件即可上线新工作流。

> **可观测**
> 每一次 Agent 思考、工具调用和费用变动都通过 SSE 实时推送到仪表盘。
> 你能清楚看到 Agent 正在做什么，以及花了多少钱。

> **可恢复**
> 任务在服务器重启后依然保留。失败时任务进入
> `blocked` 状态——你可以检查、修复、重试，不会丢失已完成的工作。

## 两种执行模式

> **Web 模式（仪表盘）**
> 服务器通过 Claude Agent SDK 或 Gemini CLI 子进程在进程内运行 Agent 阶段。
> - 完整的 SSE 流式推送到仪表盘
> - 支持所有流水线选项（model, effort, thinking, max_turns, budget, sub-agents）
> - 适用于：无人值守编排、团队协作可视化

> **Edge 模式（终端）**
> Edge Runner 通过 PTY 在本地启动 Claude/Gemini CLI 进程。提供交互式终端访问。
> - 直接与 Agent 进行键盘交互
> - 命令模式：取消、暂停、发送消息
> - 流水线选项：model, effort, permission_mode, debug, disallowed_tools, agents
> - 适用于：调试、交互式会话、本地开发

两种模式共享相同的流水线定义、状态机和数据存储。
你可以从仪表盘启动任务，然后在终端重新接入；
也可以通过 CLI 触发，然后在网页上监控。

## 为什么不直接使用 Claude Code / Gemini CLI？

| | 直接使用 CLI | Workflow Control |
|---|---|---|
| 结构化 | 单次会话，自由形式。 | 流水线阶段强制执行顺序，定义明确的输入和输出。 |
| 成本控制 | 全局预算，听天由命。 | 按阶段设置预算上限。昂贵阶段前设置人工审批。实时费用追踪。 |
| 故障恢复 | 会话中断，从头再来。 | 状态持久化。从精确的故障点重试，保留完整的上下文。 |
| 可视化 | 终端输出一闪而过。 | SSE 驱动的仪表盘，支持消息过滤、阶段时间线和费用明细。 |
| 可复现性 | 取决于你输入了什么。 | YAML 流水线 + 版本化提示词 = 每次都是相同的流程。 |
| 工具集成 | 每次会话手动配置 MCP。 | MCP 注册表统一配置，按阶段选择性启用。 |

## 快速开始

### 前置要求

| 要求 | 版本 | 说明 |
|---|---|---|
| Node.js | >= 20 | node:sqlite 需要 |
| pnpm | 任意 | npm install -g pnpm |
| gh CLI | 任意 | 通过 gh auth login 完成认证 |
| Claude Code 或 Gemini CLI | 任意 | 至少一个在 PATH 中 |
| Slack App | 可选 | Bot Token + App Token 用于 Slack 交互式通知 |

### 安装

```bash
# terminal
git clone <repo-url> && cd workflow-control
pnpm install
pnpm setup        # Interactive: MCPs, .env.local, preflight
pnpm dev          # Server (:3001) + Dashboard (:3000)
```

### 创建第一个任务

> **通过仪表盘**
> 打开 `http://localhost:3000`，输入任务描述，
> 选择流水线，点击创建。任务会自动开始执行。

> **通过 Edge Runner**
> ```
> pnpm edge -- --trigger "Your task" \
>   --pipeline pipeline-generator
> ```
