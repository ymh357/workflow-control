# Workflow Control 产品介绍

> 给 AI 编码 Agent 加上流水线 —— 让它按步骤做事、每一步你都能看见和控制。
>
> Version 2.0 · 2026-05-03（kernel-next era）。本文是给用户看的产品
> 介绍；想看技术架构请读 [`whitepaper-zh.md`](./whitepaper-zh.md)。

---

## What — 这是什么

你已经在用 Claude Code 写代码了。它很强，但本质上是"你说一句，它
做一件事"的单轮对话。任务一长就丢状态：会话 compact、笔记本休眠、
进程重启 —— 之前几小时的工作全没了。

Workflow Control 做的事情是：**在 Agent 外面包一层流水线**。一个
内置的 `pipeline-generator` 把你的需求翻译成一条 typed Pipeline IR，
内核驱动 IR 一步步跑（agent 调 Claude SDK、script 跑进程内代码、gate
卡你审批、fanout 并行循环），把每一步的进度、成本、agent 思考过程实时
推到 Web Dashboard。**所有状态持久化到本地 SQLite**——重启不丢、可
断点续跑、可中途改流水线。

打个比方：如果 Claude Code 是一个能干的员工，Workflow Control 就是
给他写了一套 SOP。没 SOP 时你交代一件大事他做到哪算哪；有了 SOP，
每一步明确输入输出、关键节点要你签字、出问题可以从断点恢复。

### 它能做什么

- 把"分析需求 → 技术设计 → 写代码 → 跑构建 → review → 出 PR"这种
  多步骤任务编成自动化流水线
- 每个步骤设独立预算上限，关键步骤前停下等你签字
- 任务出错从断点恢复，前面的工作不丢
- **跑到一半发现流水线设计错了**：不用从头来 —— `pipeline-modifier`
  生成补丁，你审批，内核把活着的任务迁移到新版本（hot-update）
- 实时 Dashboard 监控每个 agent 在干什么、花了多少钱
- 直接导出 / 导入 `pipeline.ir.json` 在用户之间分享 pipeline
  （legacy YAML registry 已于 2026-05-04 退役；新 IR-based 共享
  通道在 roadmap 上但未上线）

### 它**不**做什么

- 不是多用户 SaaS，不是团队审批平台
- 不是通用编排器（不要拿它跑 cron）
- 不是 Claude Code 的壳；工作流引擎本身才是产品
- 当前只支持 Claude（Gemini / Codex 已于 2026-04-24 退役）

---

## Why — 为什么需要

### 直接用 CLI 跑大任务的三个问题

1. **状态丢失**。Claude Code 把所有上下文放在一个 chat buffer 里。
   任务跑几小时，你睡一觉、笔记本休眠、SDK 子进程重启 —— 之前的工
   作几乎全丢。
2. **流水线第一遍写不对**。复杂任务的步骤设计需要迭代。在无状态
   系统里"发现错了"等于"从头再来"，前面 16 个 stage 的钱都白花。
3. **一个会话装不下**。长 context 撑爆 SDK 的 token budget；分多
   会话又会丢跨会话状态。

### Workflow Control 怎么解决

| 问题 | 方案 |
|---|---|
| 状态丢失 | 每个 stage 的输出按 `attempt_id` 持久化到 SQLite。重启后从最后持久化的状态继续。**Boot resumability** 自动接活。 |
| 流水线错了要重头 | **Hot-update**：propose 补丁 → 看 diff → migrate 跑着的任务到新 IR。已完成的 stage 保留为 lineage，只重跑受影响的部分。 |
| 一个会话装不下 | 多 stage 自动分段；可选 `single-session` 模式让相邻 stage 通过 SDK `options.resume` 共享对话。 |

---

## How — 怎么用

### 1. 安装与启动

```bash
# 1. 安装依赖
pnpm install

# 2. 启动（开发模式）
pnpm dev    # Server (:3001) + Dashboard (:3000)
```

**最小依赖**：Node.js >= 22.5（`node:sqlite` 要求），Claude CLI（runtime
跑 agent 的 SDK 子进程）。

可选：`gh` CLI（如果你的流水线要操作 GitHub）。

环境变量、token、API key 都通过 **MCP catalog**（dashboard 的
`/kernel-next/mcp-catalog` 页面）加密保存到本地 SQLite，不进 git。

### 2. 起一个任务

打开 dashboard `http://localhost:3000`：

| 想做什么 | 点哪 |
|---|---|
| 看现有 pipeline | `/kernel-next/pipelines` |
| 启动一个任务 | `/`（Launch hub）→ 选 pipeline → 填外部输入 → Launch |
| 看任务跑得怎么样 | `/kernel-next/[taskId]`（实时 SSE） |
| 回答 gate（审批） | 任务详情页里的 GateCard |
| 取消任务 | 任务详情页 "Cancel" 按钮 |
| 改 pipeline | 任务详情页 "Modify pipeline" → 启动 pipeline-modifier |
| 审/批 hot-update | `/kernel-next/proposals` |

每个 user journey 也有对应 MCP tool（详见 whitepaper §4.2 共 35 个工具），
让其他 Claude 实例能驱动这个内核。

### 3. 自己写一条 pipeline

**推荐路径：让 AI 写**。在 dashboard / Claude Code 调用
`pipeline-generator` builtin，描述任务，几分钟拿到一条合法 IR：

```
"我想做一个研究 pipeline：拿到主题后先列研究维度，
人审批维度，然后并行抓官方文档生成证据，最后综合写报告。"
```

`pipeline-generator` 输出经 validator 校验、版本化注册的 Pipeline IR。

**手写也行但麻烦**。validator 对 wire 类型、gate 路由都查得严，
human-friendly 程度不高。dogfood-11 / dogfood-12 都是手工写 IR
通过 `submit_pipeline` over MCP 上线的，但个人体验不如让 AI 写。

### 4. 流水线核心概念

四种 stage：

| Stage type | 干什么 |
|---|---|
| `agent` | 跑一个 Claude SDK 会话，按 prompt 生成输出 |
| `script` | 进程内 TypeScript 函数（builtin registry 注册的或 inline source） |
| `gate` | 阻塞等人/AI 回答；支持 reject 触发回滚到上游 |
| `fanout`（修饰 agent / script） | 对一个数组的每个元素并行跑 |

数据流通过 **wire**：每条数据是一个从生产者输出端口到消费者输入端
口的 typed wire，不存在共享 blackboard。

### 5. 长任务的可恢复性

```
你启动 task → 内核跑了 8 个 stage → SIGTERM（你 Ctrl-C / 系统重启）
↓
graceful-shutdown 落 task_finals(reason='interrupted') + supersede running attempts
↓
（过了几分钟 / 几小时 / 几天）
↓
server 启动 → boot-resumability 扫所有未终结 task → 从最后 success
stage 接着跑 → 之前 8 个 stage 的输出都在 port_values 里
```

具体的不变量、Bug 16/80/81 的修复细节都在
[`whitepaper-zh.md`](./whitepaper-zh.md) §3.6。

---

## 适合谁

- **建议尝试**：有反复的多步骤 AI 任务（研究 / 投资 / 报告 / 多文件
  重构 / 数据管线），希望任务能跑几小时还能 resume + 中途改设计
- **暂时不要试**：单次小任务（改个组件、修个 bug）—— 直接 Claude
  Code 更快；多人协作场景 —— 这个产品定位明确不做

---

## 参考

- 技术架构：[`whitepaper-zh.md`](./whitepaper-zh.md) ·
  [可视化](./whitepaper-visuals-zh.md)
- 路线图：[`product-roadmap.md`](./product-roadmap.md)
- 核心代码：
  - 内核：`apps/server/src/kernel-next/`
  - Web：`apps/web/src/app/`
- 历史白皮书（**已 archived**，描述退役的 legacy engine）：
  `architecture-whitepaper-zh.md`、`architecture-visual.md`
