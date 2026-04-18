## Agent 引擎

支持两种执行后端。在流水线级别设置默认值，
可按阶段覆盖。两者在 Web 和 Edge 模式下均可使用。

> **Claude (Agent SDK / CLI)**
> Web 模式：使用 `@anthropic-ai/claude-agent-sdk` 的异步迭代器 API。
> Edge 模式：通过 PTY 运行 `claude` CLI。
> - 子 Agent 支持（每个阶段可配置专用 Agent）
> - 沙箱模式（文件系统/网络隔离）
> - Hooks（中断检查、规格审计、安全防护）
> - 权限模式（default, bypassPermissions, plan 等）
> - 扩展推理（Web 模式）/ effort 级别（两种模式）

> **Gemini (CLI)**
> 两种模式均通过 `gemini` CLI 子进程运行。
> - 每个阶段独立的 MCP 配置
> - 审批模式（yolo, auto_edit, plan, default）
> - 通过 CLI 参数启用沙箱
> - 分析/审核阶段成本更低

> **提示：** 可以在一个流水线中混合使用引擎：用 Gemini 做分析（更便宜），
> 用 Claude 做实现（编码更强）。在特定阶段设置 `engine: gemini`。

## MCP 集成

MCP 服务器通过外部服务访问扩展 Agent 的能力。
在中央注册表中定义，按阶段选择性启用。

```yaml
# config/mcps/registry.yaml
notion:
  command: npx
  args: [-y, "@notionhq/notion-mcp-server"]
  env:
    OPENAPI_MCP_HEADERS:
      json:
        Authorization: "Bearer ${NOTION_TOKEN}"

context7:
  command: npx
  args: [-y, "@upstash/context7-mcp@latest"]
```

```yaml
# stage usage
- name: analyzing
  type: agent
  mcps: [notion, context7]    # Enable these MCPs for this stage
```

注入方式因后端而异：Claude SDK 通过 query 选项接收 MCP 配置；
Gemini 则获取一个针对该阶段生成的 `.gemini/settings.json`。
在 Edge 模式下，Runner 通过 `--mcp-config` 连接到服务器内置的 MCP 服务器。

## 配置界面

> **基础设施与健康检查**
> - 系统健康预检（OS、Node、MCPs、CLIs）
> - 系统设置编辑器（原始 YAML）
> - MCP 注册表配置
> - 沙箱设置（文件系统/网络隔离）

> **蓝图与智能**
> - 流水线 CRUD 可视化编辑器
> - 可视化编辑器 + 原始 YAML 双向同步
> - 全局提示词编辑（约束条件、CLAUDE.md、知识片段）
> - 实时验证，提供错误/警告反馈
> - AI 流水线生成（自然语言 -> YAML 配置）
