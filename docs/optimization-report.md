# workflow-control 优化报告

> 基于 Claude Code (v2.1.88) 内部架构分析，对 workflow-control 的全面优化建议。
> 生成日期：2026-04-03

---

## 目录

1. [Prompt Cache 分层 — 降低 API 成本](#1-prompt-cache-分层--降低-api-成本)
2. [Context Window 精细化管理 — 提升 Agent 执行质量](#2-context-window-精细化管理--提升-agent-执行质量)
3. [Store Reader 大值 Preview 机制 — 防止 Context 溢出](#3-store-reader-大值-preview-机制--防止-context-溢出)
4. [Edge MCP 认证 — 安全性基础保障](#4-edge-mcp-认证--安全性基础保障)
5. [Nonce 生成强化 — 防止 Slot 篡改](#5-nonce-生成强化--防止-slot-篡改)
6. [Parallel Group 真正并行 — 缩短 Pipeline 执行时间](#6-parallel-group-真正并行--缩短-pipeline-执行时间)
7. [Fork Cache 共享 — Parallel Stage 复用 Prompt 前缀](#7-fork-cache-共享--parallel-stage-复用-prompt-前缀)
8. [Tool Deferred Loading — 减少 System Prompt 体积](#8-tool-deferred-loading--减少-system-prompt-体积)
9. [Stage Lifecycle Hook 体系 — 扩展性与安全性](#9-stage-lifecycle-hook-体系--扩展性与安全性)
10. [Pipeline-Level 权限策略 — 沙箱真正生效](#10-pipeline-level-权限策略--沙箱真正生效)
11. [Stage Auto-Checkpoint — 长任务可靠性](#11-stage-auto-checkpoint--长任务可靠性)
12. [Output Validation 严格化 — 数据质量保障](#12-output-validation-严格化--数据质量保障)
13. [qaRetryCount 持久化 — 重试计数修复](#13-qaretrycount-持久化--重试计数修复)
14. [SSE 连接泄漏防护 — 资源可靠性](#14-sse-连接泄漏防护--资源可靠性)
15. [跨 Stage Compact Summary — 长 Pipeline 记忆传递](#15-跨-stage-compact-summary--长-pipeline-记忆传递)

---

## 1. Prompt Cache 分层 — 降低 API 成本

### 是什么

Claude API 支持 `cache_control` 标记，将 system prompt 分为 **全局可缓存区** 和 **动态区**。缓存命中后输入 token 成本降至原来的 10%。Claude Code 用一个 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 把 system prompt 一分为二：边界之前是跨会话可复用的静态内容（global scope, 1h TTL），边界之后是会话级动态内容（不缓存）。

**Claude Code 实现**（`restored-src/src/services/api/claude.ts:358-435`）：
- `splitSysPromptPrefix()` 将 system prompt 拆为 3-4 个 `TextBlockParam`
- 静态块 → `cache_control: { type: 'ephemeral', scope: 'global', ttl: '1h' }`
- 动态块 → 无 `cache_control`
- Tool schemas 单独加 `cache_control: { type: 'ephemeral' }`

### 为什么

workflow-control 的 `stage-executor.ts` 每次调用 Claude SDK `query()` 都是全新 session，没有利用任何 `cache_control` 机制。同一 pipeline 内多个 agent stage 共享大量不变内容：

- 全局约束（`buildSystemAppendPrompt()` 的输出）
- 知识片段（knowledge fragments）
- Pipeline 元信息
- Tool schemas

以一个 10-stage 的 pipeline 为例，如果每个 stage 的 system prompt 有 8000 tokens 的不变前缀，10 次全量发送 = 80,000 input tokens。加 cache 后 = 8,000 (首次) + 9 × 800 (缓存命中) ≈ 15,200 tokens，**节省约 81%**。

### 怎么做

**修改 `apps/server/src/agent/stage-executor.ts`**：

1. 将 `buildSystemAppendPrompt()` 的输出分为两段：
   - **Static prefix**: 全局约束、知识片段、pipeline description（跨 stage 不变）
   - **Dynamic suffix**: Tier 1 context、stage-specific instructions（每 stage 不同）

2. 在调用 `query()` 时传入 `systemPrompt` 为带 `cache_control` 标记的分块数组：
   ```typescript
   const systemBlocks = [
     { type: "text", text: staticPrefix, cache_control: { type: "ephemeral" } },
     { type: "text", text: dynamicSuffix },
   ];
   ```

3. Tool schemas 的 cache 由 Claude SDK 自行处理（已内置），无需额外操作。

**修改 `apps/server/src/agent/context-builder.ts`**：
- `buildTier1Context()` 返回值增加一个 `isStatic` 标记区分可缓存/不可缓存部分。

**影响范围**：`stage-executor.ts`, `context-builder.ts`, `query-options-builder.ts`

---

## 2. Context Window 精细化管理 — 提升 Agent 执行质量

### 是什么

Claude Code 用三级压缩策略管理 context window：
- **L0 Content Replacement**：tool result > 50K chars → 持久化到磁盘，替换为 2KB preview + 文件路径引用（零 API 成本）
- **L1 Microcompact**：时间衰减清理旧 tool result（`TIME_BASED_MC_CLEARED_MESSAGE`），保留最近 N 条
- **L2 Full Compact**：总 token 距阈值 13K 时触发完整摘要

关键常量（`restored-src/src/constants/toolLimits.ts`）：
- `DEFAULT_MAX_RESULT_SIZE_CHARS = 50,000`（单工具结果上限）
- `MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200,000`（单轮所有工具结果总上限）
- `PREVIEW_SIZE_BYTES = 2,000`（preview 大小）

### 为什么

workflow-control 的 `context-builder.ts:8-10` 用极其粗糙的 token 估算：

```typescript
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}
```

问题：
1. **中文 token 效率约 2 chars/token**，4 chars/token 的估算会让中文内容的实际 token 数被低估 ~50%，导致超预算注入
2. **总预算仅 4000 tokens**（`context-builder.ts:12`），但大 store 值（如 implement 阶段的代码输出）轻松超过 10K tokens
3. **超预算降级策略**（`context-builder.ts:65-74`）只保留 20 个字段各 80 chars，信息损失严重
4. **无 aggregate budget**：多个 reads 的总量没有上限检查

### 怎么做

**Phase 1: 改进 token 估算**

替换 `estimateTokens()` 为双语感知估算：
```typescript
function estimateTokens(s: string): number {
  // CJK characters ~2 chars/token, Latin ~4 chars/token
  let cjkCount = 0;
  for (const ch of s) {
    if (ch.charCodeAt(0) > 0x2E80) cjkCount++;
  }
  const latinCount = s.length - cjkCount;
  return Math.ceil(cjkCount / 2 + latinCount / 4);
}
```

**Phase 2: 分级注入策略**

借鉴 Claude Code 的 L0 Content Replacement，当 store 值超过阈值时不做暴力截断，而是返回 preview + 引用：

```typescript
const MAX_INLINE_CHARS = 8_000; // ~2000 tokens
if (serialized.length > MAX_INLINE_CHARS) {
  const preview = serialized.slice(0, 2000);
  parts.push(`## ${label} (preview, ${serialized.length} chars total)\n${preview}\n...\n> Use get_store_value("${storePath}") for full content`);
} else {
  parts.push(`## ${label}\n${serialized}`);
}
```

**Phase 3: 总预算上限**

增加 aggregate budget（如 16,000 tokens），当累计超出时停止注入更多 reads，剩余全部降级为 Tier 2 引用。

**影响范围**：`context-builder.ts`

---

## 3. Store Reader 大值 Preview 机制 — 防止 Context 溢出

### 是什么

当 agent 通过 `get_store_value` MCP tool 读取 store 数据时，当前实现在 50KB 处做硬截断。Claude Code 的做法是在截断时生成一个 **结构化 preview**：保留前 2KB 内容，在最后一个换行处切割（避免截断 JSON 中间），并附上完整大小信息。

**Claude Code 实现**（`restored-src/src/utils/toolResultStorage.ts:339-356`）：
```typescript
export function generatePreview(content: string, maxBytes: number) {
  const truncated = content.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf('\n');
  const cutPoint = lastNewline > maxBytes * 0.5 ? lastNewline : maxBytes;
  return { preview: content.slice(0, cutPoint), hasMore: true };
}
```

### 为什么

当前 `store-reader-mcp.ts:70-74` 的截断逻辑：

```typescript
if (serialized.length > MAX_VALUE_BYTES) {
  serialized = serialized.slice(0, MAX_VALUE_BYTES) +
    `\n\n... [truncated — value is ${serialized.length} bytes, showing first ${MAX_VALUE_BYTES}]`;
}
```

问题：
1. **50KB 直接 slice 可能截断 JSON 结构**，agent 拿到的是不完整 JSON，无法 parse
2. **没有结构化 preview**：agent 看到一大坨截断文本，不知道哪些字段存在
3. **缺少分页/子路径读取能力**：agent 只能拿 50KB，即使只需要其中一个字段

### 怎么做

**改进 `apps/server/src/lib/store-reader-mcp.ts`**：

1. **在换行符处截断**（避免破坏 JSON）：
   ```typescript
   const truncated = serialized.slice(0, MAX_VALUE_BYTES);
   const lastNewline = truncated.lastIndexOf('\n');
   const cutPoint = lastNewline > MAX_VALUE_BYTES * 0.5 ? lastNewline : MAX_VALUE_BYTES;
   serialized = serialized.slice(0, cutPoint);
   ```

2. **对 object/array 类型，截断时返回结构摘要**：
   ```typescript
   if (typeof value === 'object' && serialized.length > MAX_VALUE_BYTES) {
     const keys = Object.keys(value);
     const summary = `Object with ${keys.length} keys: [${keys.join(', ')}]\nUse dot notation (e.g., "${path}.${keys[0]}") to read specific fields.`;
     serialized = summary + '\n\n--- Preview ---\n' + serialized.slice(0, 2000);
   }
   ```

3. **支持子路径读取**：`get_store_value("analysis.plan")` 已支持，确保文档中提示 agent 使用 dot notation 深入读取子字段而非整个 object。

**影响范围**：`store-reader-mcp.ts`

---

## 4. Edge MCP 认证 — 安全性基础保障

### 是什么

Edge MCP server 暴露了 9 个工具（`trigger_task`, `submit_stage_result`, `get_store_value` 等），任何能连接到 MCP server 的客户端都可以无限制地执行任何操作。Claude Code 的权限系统有 10 步管道（`restored-src/src/utils/permissions/permissions.ts:1158-1307`），包含 deny rules、tool-level checkPermissions、safety path 免疫 bypass 等层层防护。

### 为什么

当前 `mcp-server.ts` 完全没有认证机制：

- 任何人可以调用 `trigger_task` 创建任意 pipeline 任务
- 任何人可以调用 `submit_stage_result` 提交任意结果，只需知道 taskId + stageName
- `get_store_value` 可读取任意 task 的 store 数据（可能含敏感信息如 API token、代码片段）
- 唯一的"验证"是 nonce 匹配（`registry.ts:100-103`），但 nonce 通过 `list_available_stages` 公开返回

审计报告（`__audit__/security-audit.test.ts`）已标注此问题为 **Critical**。

### 怎么做

**方案：Task-Scoped Token 认证**

1. **Token 生成**：`trigger_task` 时生成 `taskToken = crypto.randomUUID()`，返回给调用者
2. **Token 验证**：所有后续 MCP 调用（`get_stage_context`, `submit_stage_result`, `get_store_value` 等）要求附带 `taskToken` 参数
3. **Token 存储**：在 `WorkflowContext` 中持久化（随 XState snapshot 一起保存）

```typescript
// trigger_task 返回
return { taskId, taskToken: context.taskToken, ... };

// submit_stage_result 校验
if (taskToken !== getTaskToken(taskId)) {
  return textResult({ error: "Invalid task token" }, true);
}
```

4. **向后兼容**：`taskToken` 参数在过渡期设为可选，缺失时降级为当前行为并输出 warning

**影响范围**：`mcp-server.ts`, `edge/registry.ts`, `machine/types.ts`（WorkflowContext 增加 taskToken 字段）

---

## 5. Nonce 生成强化 — 防止 Slot 篡改

### 是什么

Edge slot 用 nonce 防止过期 submission 覆盖新 slot。Claude Code 使用 `crypto.randomUUID()` 生成不可预测的 ID。

### 为什么

当前 `edge/registry.ts:74` 的 nonce 生成：

```typescript
const nonce = `${Date.now()}-${++nonceCounter}`;
```

问题：
1. **可预测**：知道当前时间即可猜测 nonce（`timestamp-N`，N 从 1 递增）
2. **Counter 全局共享**：所有 task/stage 共享同一个 `nonceCounter`，可通过观测其他 slot 推断下一个值
3. **与认证缺失叠加**：在没有 auth 的情况下，可预测的 nonce 等于没有 nonce

### 怎么做

```typescript
import { randomUUID } from "crypto";

// registry.ts line 74
const nonce = randomUUID();
```

一行改动，无兼容性问题。Nonce 仅用于字符串等值比较，无格式依赖。

**影响范围**：`edge/registry.ts`（1 行）

---

## 6. Parallel Group 真正并行 — 缩短 Pipeline 执行时间

### 是什么

Claude Code 的 `StreamingToolExecutor`（`restored-src/src/services/tools/StreamingToolExecutor.ts`）实现了真正的工具并行执行：concurrent-safe 工具可以同时运行，non-concurrent 工具独占执行。fork subagent 允许多个子 agent 同时工作。

### 为什么

workflow-control 的 parallel group 在 edge 模式下存在瓶颈：

1. 每个子 stage 创建一个独立的 edge slot（`state-builders.ts`）
2. Edge agent（Claude Code）通过 `list_available_stages` 逐个 pickup slot
3. **单个 Claude Code 实例一次只能处理一个 stage**——它必须完成当前 stage 并 submit 后才能 pickup 下一个
4. 结果：parallel group 中 3 个 stage 串行执行，完全没有并行加速

### 怎么做

**方案 A：多 Agent 并行 Pickup**

修改 edge agent 协议（`mcp-server.ts` + workflow skill），允许 Claude Code 用 fork subagent 同时处理多个 slot：

1. `list_available_stages` 增加 `parallelGroup` 字段，标识哪些 stages 属于同一组
2. Edge agent skill（`.claude/skills/workflow.md`）增加规则：
   - 如果可用 stages 属于同一 parallelGroup，用 Agent tool 并行启动多个 subagent
   - 每个 subagent 独立 `get_stage_context` → execute → `submit_stage_result`
3. 确保 slot listener 支持并发 resolve

**方案 B：Server-Side 并行 + Edge Hybrid**

对 parallel group 中的子 stages，让 server 同时为每个子 stage 创建 slot，但也同时启动 server-side agent（如果 execution_mode=any）。第一个完成的胜出。

**推荐方案 A**，实现更简单，且复用了 Claude Code 已有的 fork subagent 能力。

**影响范围**：`mcp-server.ts`（增加 parallelGroup 字段）, workflow skill prompt

---

## 7. Fork Cache 共享 — Parallel Stage 复用 Prompt 前缀

### 是什么

Claude Code 的 fork subagent（`restored-src/src/tools/AgentTool/forkSubagent.ts:107-169`）通过以下机制共享 prompt cache：

1. 所有 fork children 使用 byte-identical 的 `FORK_PLACEHOLDER_RESULT` 作为工具结果占位符
2. 父进程的完整 system prompt 通过 `override.systemPrompt` 传给子进程（而非重新构建，避免任何偏差）
3. 只有最后的 directive text block 在每个 child 中不同
4. `ContentReplacementState` 被 clone 给每个 child，保证大 tool result 的 persist 决策一致

结果：N 个 fork children 共享同一个 prompt cache prefix，只有首次调用付全价。

### 为什么

workflow-control 的 parallel group 中的 agent stages 完全独立构建 context：

1. 每个子 stage 调用 `buildTier1Context()` 独立构建 Tier 1 context
2. 每个子 stage 调用 `buildSystemAppendPrompt()` 独立构建 system prompt
3. 即使这些 stage 共享相同的全局约束和知识片段，也无法利用 cache

### 怎么做

**当并行 stage 使用 server-side execution 时**：

1. 预计算 parallel group 的共享 prompt prefix（全局约束 + 知识片段 + pipeline 描述）
2. 首个子 stage 执行后，cache 已建立
3. 后续子 stage 使用相同的 prefix bytes（确保 `buildSystemAppendPrompt()` 输出确定性 — 避免 timestamp 等动态元素进入前缀）

**当使用 edge execution 时**：

1. `get_stage_context` 返回时标注 `sharedPrefix` 字段
2. Edge agent 识别后，在 fork subagent 时复用同一 system prompt prefix
3. 这需要 edge agent skill 的配合（提示它复用 prompt）

**影响范围**：`context-builder.ts`（分离 static/dynamic 输出）, `stage-executor.ts`（并行 stage prompt 复用）, `mcp-server.ts`（增加 sharedPrefix 字段）

---

## 8. Tool Deferred Loading — 减少 System Prompt 体积

### 是什么

Claude Code 默认不加载所有工具的 schema，而是通过 `ToolSearch` 工具按需查找（`restored-src/src/tools/` 目录下 44+ tools 中大部分是 deferred）。只有核心工具（`alwaysLoad: true`）如 Read, Edit, Write, Bash, Grep, Glob 等始终加载。MCP 工具也是延迟加载的。

这显著减少了 system prompt 中的 tool schema 体积（每个工具 schema 约 200-500 tokens）。

### 为什么

workflow-control 的 stage 声明 `mcps: ["linear", "gitlab", "notion"]` 后，所有 MCP server 的所有工具 schema 被全量注入。一个典型的 MCP server 暴露 10-20 个工具，3 个 MCP = 30-60 个工具 schema ≈ 10,000-15,000 tokens。

对于一个只需要用 `linear.getIssue()` 的 stage，加载 linear 的全部 20 个工具 schema 是浪费。

### 怎么做

**Pipeline YAML 扩展**：

```yaml
stages:
  - name: fetchTicket
    runtime:
      mcps:
        - name: linear
          primary_tools: [getIssue, searchIssues]   # 全量加载
          available_tools: "*"                        # 可按需搜索
```

**实现**：

1. `stage-executor.ts` 在构建 MCP 配置时，只加载 `primary_tools` 列出的 schema
2. 其余工具通过一个 lightweight "tool directory" 描述（名称 + 一句话描述）告知 agent
3. Agent 需要时可调用一个新工具 `search_mcp_tools(query)` 获取完整 schema

**简化方案（更低成本）**：

如果不想改 pipeline schema，可以在 `buildQueryOptions()` 中加一个 `maxToolSchemas` 参数，当 tool 数量超过阈值（如 30）时自动将非核心工具降级为 deferred 描述。

**影响范围**：`stage-executor.ts`, 可选 `pipeline-types.ts`

---

## 9. Stage Lifecycle Hook 体系 — 扩展性与安全性

### 是什么

Claude Code 有 25 种 hook 事件（`restored-src/src/types/hooks.ts`），覆盖了从 session 初始化到工具执行到权限拦截的完整生命周期：

- `PreToolUse`：在工具执行前拦截，可 block/allow/modify input
- `PostToolUse`：在工具执行后转换输出
- `PermissionRequest`：hook 自行决定 allow/deny
- `FileChanged`：文件变更时触发
- `SessionStart/End`：会话开始/结束时清理

每个 hook 支持 4 种类型：command (shell), prompt (model injection), http (webhook), agent (subagent)。

### 为什么

workflow-control 目前只有 2 个 hook 实现（`executor-hooks.ts`）：

1. `createAskUserQuestionInterceptor`：拦截 AskUserQuestion 工具
2. `createSpecAuditHook`：审计 Write/Edit 操作是否在 spec 范围内

缺失的关键 hook 场景：

- **pre-stage**：在 stage 开始前执行准备工作（如：设置环境变量、预热 MCP 连接）
- **post-stage**：在 stage 完成后执行清理（如：清理临时文件、发送通知）
- **on-error**：stage 失败时的错误处理逻辑（如：回滚 git 操作）
- **tool-level 路径限制**：阻止 Write 到 `node_modules/` 或 `.env` 等敏感路径
- **动态 prompt injection**：根据当前 branch 或 repo 注入特定的编码规范

### 怎么做

**Phase 1：扩展 hook 事件类型**

在 `config/hooks/` 支持 YAML 定义的 hook：

```yaml
# config/hooks/pre-stage.yaml
event: pre-stage
match:
  stage_type: agent
  pipeline: "*"
hooks:
  - type: command
    command: "echo 'Starting stage ${STAGE_NAME}'"
  - type: http
    url: "https://hooks.slack.com/..."
    method: POST
    body: { text: "Stage ${STAGE_NAME} started for task ${TASK_ID}" }
```

**Phase 2：利用 Claude SDK hook 回调**

在 `stage-executor.ts` 的 `buildQueryOptions()` 中注入更多 PreToolUse hooks：

```typescript
// Path-based write restriction
hooks.PreToolUse.push({
  matcher: ["Write", "Edit"],
  hooks: [createPathRestrictionHook(sandbox.allow_write)]
});

// Sensitive file protection
hooks.PreToolUse.push({
  matcher: ["Write", "Edit", "Bash"],
  hooks: [createSensitiveFileHook([".env", ".git/", "node_modules/"])]
});
```

**Phase 3：Pipeline YAML 中声明 stage hooks**

```yaml
stages:
  - name: implement
    hooks:
      pre: [setup-env]
      post: [cleanup-worktree]
      on_error: [rollback-branch]
```

**影响范围**：`executor-hooks.ts`（新增 hook 函数）, `stage-executor.ts`（注入 hooks）, 可选 pipeline-types 扩展

---

## 10. Pipeline-Level 权限策略 — 沙箱真正生效

### 是什么

Claude Code 的权限系统（`restored-src/src/utils/permissions/permissions.ts:1158-1307`）有 10 步管道，其中 "safety path" 检查（Step 1g）**免疫 bypassPermissions 模式**——即使在最宽松的模式下，对 `.git/`, `.claude/`, `.vscode/` 等路径的写操作仍需确认。

### 为什么

workflow-control 的权限控制现状：

1. `stage-executor.ts:71` 默认 `permission_mode: "bypassPermissions"`
2. `system-settings.yaml` 中的 `sandbox.allow_write: ["/"]` 没有 enforcement 机制
3. Pipeline YAML 可声明 `permission_mode: plan`（只读），但无法做更细粒度的控制
4. Agent 在 bypassPermissions 模式下可以写任何文件，包括 `.git/config`、`/etc/hosts` 等

审计报告（`__audit__/security-audit.test.ts`）标注：sandbox restrictions insufficient。

### 怎么做

1. **Pipeline-level 权限声明**：

```yaml
# pipeline.yaml
security:
  max_permission_mode: acceptEdits    # 此 pipeline 的最高权限
  deny_paths: [".git/", ".env", "/etc/"]
  allow_write_paths: ["src/", "tests/", "docs/"]
```

2. **Stage-level 覆盖约束**：

```yaml
stages:
  - name: implement
    runtime:
      permission_mode: acceptEdits    # 不能超过 pipeline 的 max
```

3. **在 `stage-executor.ts` 中执行约束**：

```typescript
const effectiveMode = Math.min(
  permissionLevel(pipeline.security?.max_permission_mode ?? "bypassPermissions"),
  permissionLevel(stageConfig.permission_mode ?? "bypassPermissions")
);
```

4. **Safety path hook**：借鉴 Claude Code 的 Step 1g，在 PreToolUse hook 中检查路径：

```typescript
function createPathRestrictionHook(denyPaths: string[]) {
  return async (input: HookInput) => {
    const filePath = input.tool_input.file_path ?? input.tool_input.command;
    if (denyPaths.some(p => filePath?.includes(p))) {
      return { decision: "block", reason: `Path ${filePath} is restricted` };
    }
    return { decision: "approve" };
  };
}
```

**影响范围**：`stage-executor.ts`, `executor-hooks.ts`, `pipeline-types.ts`

---

## 11. Stage Auto-Checkpoint — 长任务可靠性

### 是什么

Claude Code 的 auto-compact（`restored-src/src/services/compact/autoCompact.ts:241-351`）在 context window 接近满时触发压缩，并有 circuit breaker（3 次连续失败后停止重试）。session 状态可通过 JSONL transcript 恢复。

### 为什么

workflow-control 的 agent stage 执行是原子的：要么成功返回完整结果，要么失败。对于复杂的 `implement` 阶段（可能执行 30+ turns），问题是：

1. **中途失败丢失所有进度**：如果 agent 在第 25 turn 时网络中断或超时，之前的 25 turns 工作全部浪费
2. **无中间状态可恢复**：XState snapshot 只记录"当前在哪个 stage"，不记录 stage 内部进度
3. **max_budget_usd 触发时没有 graceful shutdown**：预算耗尽直接终止，无法保存部分结果

### 怎么做

1. **SDK 级进度回调**：利用 Claude SDK 的 streaming 回调，在每个 tool call 完成后检查是否需要 checkpoint

2. **Checkpoint 到 store**：

```typescript
// stage-executor.ts 中
const onToolResult = (toolName: string, result: unknown) => {
  checkpointCount++;
  if (checkpointCount % 5 === 0) { // 每 5 个 tool call checkpoint 一次
    const partialResult = collectPartialOutput(messages);
    storeCheckpoint(taskId, stageName, partialResult);
  }
};
```

3. **Resume from checkpoint**：Stage 重新执行时，检查是否有 checkpoint：

```typescript
const checkpoint = loadCheckpoint(taskId, stageName);
if (checkpoint) {
  // 注入 checkpoint 作为 context，让 agent 知道之前做了什么
  tier1Context += `\n## Previous Progress (checkpoint)\n${JSON.stringify(checkpoint)}`;
}
```

4. **Budget-aware graceful shutdown**：在 budget 接近上限（80%）时，给 agent 注入指令要求它总结当前进度并输出部分结果。

**影响范围**：`stage-executor.ts`, `state-builders.ts`（增加 checkpoint 存取逻辑）

---

## 12. Output Validation 严格化 — 数据质量保障

### 是什么

当 agent stage 完成时，`state-builders.ts:71-82` 的 guard 检查输出是否包含 `runtime.writes` 声明的字段。当前使用"至少一个字段存在"的语义判断。

### 为什么

当前验证逻辑（`mcp-server.ts:89-107`）：

```typescript
// "At least one field present" semantics
const presentFields = writes.filter(f => parsed[f] !== undefined);
if (presentFields.length === 0) return { valid: false, ... };
```

问题：
1. 如果 stage 声明 `writes: [plan, fileList, techStack]`，agent 只输出 `plan` 就会通过验证
2. 下游 stage 的 `reads` 引用 `fileList` 时会得到 `undefined`，导致运行时错误
3. "Missing some fields" 和 "missing all fields" 被同等对待

### 怎么做

1. **区分 required / optional 字段**：

```yaml
outputs:
  plan:
    type: markdown
    required: true      # 必须存在
  fileList:
    type: object[]
    required: true
  techStack:
    type: string
    required: false     # 缺失时不 retry
```

2. **修改验证逻辑**：

```typescript
const requiredFields = writes.filter(f => outputSchema?.[f]?.required !== false);
const missingRequired = requiredFields.filter(f => parsed[f] === undefined);
if (missingRequired.length > 0) {
  return { valid: false, missingFields: missingRequired };
}
```

3. **向后兼容**：默认所有字段 `required: true`（保持当前行为但更严格）；pipeline 作者可显式标记 `required: false`。

**影响范围**：`state-builders.ts`, `mcp-server.ts`（validateStageOutput 函数）, `pipeline-types.ts`（outputs schema 增加 required 字段）

---

## 13. qaRetryCount 持久化 — 重试计数修复

### 是什么

`qaRetryCount` 控制 back_to 重试循环的次数上限。当 QA stage 输出 `passed: false` 时，pipeline 路由回 `back_to` 指定的 stage，并递增 `qaRetryCount`。

### 为什么

审计报告（`__audit__/logic-audit.test.ts:78`）指出的问题：

- `state-builders.ts:242` 在正常完成时将 `qaRetryCount` 重置为 0
- 这意味着如果 stage B 的 back_to 指向 stage A，A 重新执行后正常完成时 counter 被重置
- 然后 B 再次 fail 时，counter 又从 0 开始
- **实际效果**：`max_retries: 2` 可能变成无限重试（A 完成 reset → B fail → A 完成 reset → B fail → ...）

### 怎么做

1. **只在 stage 自身不是 back_to target 时 reset counter**：

```typescript
// state-builders.ts line 242 改为：
qaRetryCount: isTargetOfBackTo(stageName, pipeline) ? context.qaRetryCount : 0,
```

2. **或者将 counter 绑定到 (source, target) stage pair**：

```typescript
// WorkflowContext 中
qaRetryCounts: Record<string, number>; // key: `${backToStage}→${currentStage}`
```

这样每对 source-target 有独立的 counter，不会因正常完成而重置。

**影响范围**：`state-builders.ts`, `machine/types.ts`（WorkflowContext）

---

## 14. SSE 连接泄漏防护 — 资源可靠性

### 是什么

SSE manager（`sse/manager.ts`）管理每个 task 的实时事件推送连接。

### 为什么

`manager.ts` 存在的泄漏风险：

1. **Heartbeat 定时器泄漏**（`manager.ts:66-74`）：如果 `controller.enqueue()` 抛出异常并且该异常不是 write error（如 TypeError），`clearInterval` 不会执行
2. **Connection 对象残留**：`removeClosedConnections()`（`manager.ts:213-223`）只在 `pushMessage` 时调用，如果 task 不再有消息推送，closed connections 永远留在内存
3. **Listener 累积**（`manager.ts:187-194`）：`addListener()` 注册的回调没有被 `closeStream()` 清理
4. **MAX_CONNECTIONS_PER_TASK = 10** 虽然限制了单 task 泄漏，但多 task 场景下仍可累积

### 怎么做

1. **Heartbeat 增加全局 catch**：

```typescript
conn.heartbeat = setInterval(() => {
  if (conn.closed) { clearInterval(conn.heartbeat); return; }
  try {
    controller.enqueue(encoder.encode(": heartbeat\n\n"));
  } catch (e) {
    conn.closed = true;
    clearInterval(conn.heartbeat);
  }
}, 30_000);
```
（当前已有 try-catch，确认覆盖所有异常类型即可）

2. **定期清理 closed connections**：

```typescript
// 每 60 秒扫描一次，不依赖 pushMessage 触发
setInterval(() => {
  for (const [taskId, conns] of this.connections) {
    const active = conns.filter(c => !c.closed);
    if (active.length === 0) this.connections.delete(taskId);
    else this.connections.set(taskId, active);
  }
}, 60_000);
```

3. **closeStream 时清理 listeners**：

```typescript
closeStream(taskId: string) {
  // ... existing close logic ...
  this.listeners.delete(taskId);  // 新增
}
```

**影响范围**：`sse/manager.ts`

---

## 15. 跨 Stage Compact Summary — 长 Pipeline 记忆传递

### 是什么

Claude Code 的 L2 Full Compact（`restored-src/src/services/compact/compact.ts:300-400`）在 context window 即将满时，用一个 forked agent 将整个对话历史压缩为结构化摘要，同时保留最近 5 个文件的完整内容。

### 为什么

workflow-control 中每个 stage 是独立 session，没有跨 session 的"记忆"问题。但 **stage 间的记忆传递** 存在类似挑战：

1. Stage A（如 `planImplementation`）输出一个 5000-word 的详细计划
2. Stage B（如 `implement`）只能通过 Tier 1 reads 看到被截断的 4000-token 版本，或通过 Tier 2 按需读取
3. 如果 pipeline 有 10+ stages，后期 stage 的 Tier 1 context 中充斥着大量前序输出的摘要碎片，信噪比下降

### 怎么做

1. **Stage 输出自动生成 compact summary**：

在 `state-builders.ts` 的 `onDone` handler 中，当 stage 输出超过阈值时，自动生成摘要：

```typescript
if (JSON.stringify(result).length > 8000) {
  context.store[`${stageName}.__summary`] = generateCompactSummary(result);
}
```

2. **Tier 1 reads 优先使用 summary**：

在 `context-builder.ts` 中，当 reads 指向一个大 store 值时，优先使用 `.__summary` 版本：

```typescript
const summaryKey = `${topKey}.__summary`;
if (context.store[summaryKey] && estimateTokens(fullValue) > INLINE_THRESHOLD) {
  // 使用 summary + Tier 2 引用
  addPart(`## ${label} (summary)\n${context.store[summaryKey]}\n> Full content: get_store_value("${storePath}")`);
} else {
  addPart(`## ${label}\n${fullValue}`);
}
```

3. **Summary 生成方式**：
   - 简单方案：取 object 的 top-level keys + 每个值的前 200 chars
   - 高级方案：用一个轻量 LLM call（haiku）生成结构化摘要

**影响范围**：`state-builders.ts`, `context-builder.ts`

---

## 优先级矩阵

| # | 优化点 | 优先级 | 复杂度 | 预期收益 |
|---|--------|--------|--------|----------|
| 1 | Prompt Cache 分层 | P0 | 中 | API 成本降低 40-60% |
| 2 | Context 精细化管理 | P0 | 低 | Agent 执行质量提升 |
| 3 | Store Reader Preview | P1 | 低 | 防止 context 溢出 |
| 4 | Edge MCP 认证 | P1 | 中 | 安全基础保障 |
| 5 | Nonce 强化 | P1 | 极低 | 防篡改 |
| 6 | Parallel 真正并行 | P1 | 高 | Pipeline 执行加速 2-5x |
| 7 | Fork Cache 共享 | P2 | 高 | 并行 stage 降本 |
| 8 | Tool Deferred Loading | P2 | 中 | 减少 prompt 10K+ tokens |
| 9 | Lifecycle Hook 体系 | P2 | 中 | 扩展性与安全性 |
| 10 | 权限策略 Enforcement | P2 | 中 | 沙箱真正生效 |
| 11 | Auto-Checkpoint | P2 | 高 | 长任务可靠性 |
| 12 | Output 验证严格化 | P3 | 低 | 数据质量 |
| 13 | qaRetryCount 修复 | P3 | 低 | 正确性 bug 修复 |
| 14 | SSE 泄漏防护 | P3 | 低 | 资源可靠性 |
| 15 | 跨 Stage Compact | P3 | 中 | 长 pipeline 信噪比 |

---

## 推荐实施路径

**第一批（Quick Wins，1-2 天）**：#2 Context 精细化、#3 Store Reader Preview、#5 Nonce 强化、#13 qaRetryCount 修复、#14 SSE 泄漏防护

**第二批（核心降本，3-5 天）**：#1 Prompt Cache 分层、#4 Edge MCP 认证、#12 Output 验证严格化

**第三批（架构升级，1-2 周）**：#6 Parallel 真正并行、#8 Tool Deferred Loading、#9 Hook 体系、#10 权限策略

**第四批（高级优化）**：#7 Fork Cache 共享、#11 Auto-Checkpoint、#15 跨 Stage Compact
