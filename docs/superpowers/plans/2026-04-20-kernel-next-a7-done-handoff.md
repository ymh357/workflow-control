# kernel-next A7 — 完成情况 + 下一步候选

> Created: 2026-04-20
> Author: Opus 4.7 (与产品 owner 协作)
> Status: **A7 最低要求已满足**（diamond-real + smoke-test 均端到端跑通，真实 Claude Haiku）
> Parent: `docs/kernel-next-terminal-design.md` §11.1 A7
> Predecessors:
> - `docs/superpowers/plans/2026-04-20-kernel-next-sse-observability-done.md`（SSE 观察层）
> - `docs/superpowers/plans/2026-04-20-kernel-next-a2-3-done-handoff.md`（A2.3 AgentMachine nest）

读完 §0 就能恢复上下文。其余章节是补充。

---

## 0. 2026-04-20 — A7 阶段交付

### 0.1 本轮 commits

| Commit | 内容 | Δ tests |
|---|---|---|
| `5e942aa` | A7.1 `diamond-real` 接入 `POST /api/kernel/tasks/run`，注册真实 Claude SDK 执行路径；body 支持 model/maxTurns/maxBudgetUsd 覆盖 | +2 |
| `2e68d93` | A7.2 Bug 1：MCP `write_port` 复用 caller PortRuntime，修复 real-executor 路径下 SSE `port_written` 事件缺失 | +1 |
| `1538f56` | A7.3 Bug 2：stream-pump 容忍 SDK 末尾 throw（result_success 之后 child process exit code 1），保留 actor 终态 | +2 |
| `2e7ee3b` | A7.4 smoke-test legacy builtin 接入：手工 IR + FsPromptResolver + field→port 映射 | +5 |

**累计**：4054 → 4062 (+8)，tsc 干净，0 回归。

### 0.2 §11.1 A7 acceptance 状态

设计文档原文：
> "One non-trivial real pipeline runs end-to-end on kernel-next — tech-research or equivalent (one of the three preserved builtins per roadmap §4)"

**判定**：**最低要求已满足**。

- **diamond-real**：4 stage（A→{B,C}→D），真实 Haiku 调用，~43s 跑完，SSE 链路完整，dashboard 实时显示 stage/port 状态
- **smoke-test**：legacy builtin 在 kernel-next 下跑通，~30s 完成，证明 legacy YAML → kernel-next IR 可手工迁移，FsPromptResolver 复用 legacy prompts 不需改

tech-research（更大的目标）**未做**；见 §1.1。

### 0.3 在跑的过程中发现并修复的两个 edge case

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| Bug 1 | dashboard stage_* 事件有，但 0 个 port_written | `createKernelMcp` 的 write_port handler 构造**独立** PortRuntime，不携带 runner 的 `onPortWritten` 钩子 | `createKernelMcp` 加 `portRuntime?` 选项；provided 时复用 runner runtime |
| Bug 2 | A stage 写成 `status='error'` 但 DB port 已正确写入；finalState='failed' 但业务成功 | Claude Agent SDK 的 async iterator 在 `result: success` 之后子进程退出非 0 会在末尾 throw，real-executor 当 stage 失败 | stream-pump 分离 iterator throw 与 adapter throw；iterator throw 后仍 await `waitForFinal`，让 actor 终态决定判定 |

两个都**预期 A7 会浮现**（真实 SDK 行为 ≠ mock），都是精确修复没绕行。

### 0.4 架构新增（A7 引入）

1. **生产入口** `POST /api/kernel/tasks/run`（`src/routes/kernel-run.ts`）
   - body: `{pipeline: string; taskId?; model?; maxTurns?; maxBudgetUsd?}`
   - 返回 202 + `{ok, taskId, versionHash}`
   - 后台 `runPipeline` 注入 singleton broadcaster
   - 当前 4 个注册项：`diamond` (mock), `diamond-slow` (mock+sleep), `diamond-real` (真实), `smoke-test` (真实 + FsPromptResolver)

2. **FsPromptResolver**（`src/kernel-next/runtime/fs-prompt-resolver.ts`）
   - 实现 `PromptResolver`，按 `<rootDir>/<promptRef>.md` 读文件
   - 未缓存（spike 简洁），5 unit tests

3. **legacy builtin 适配器** (`src/kernel-next/builtins/smoke-test.ts`)
   - 手写 IR + `smokeTestPromptRoot()` 路径 helper
   - 映射规则文档化：`store_schema.entry.fields.f` → `stage.outputs` port；`reads: entry` → 每个 field 一条 wire

4. **MCP portRuntime 选项**（`src/kernel-next/mcp/server.ts`）
   - `createKernelMcp(db, { portRuntime })` 让 MCP handler 复用 caller runtime
   - 保留 `writePortDispatcher` 向后兼容

5. **stream-pump 错误语义细化**（`src/kernel-next/runtime/stream-pump.ts`）
   - Adapter/send throw 立即冒泡（代码缺陷）
   - Iterator throw 捕获后仍等 `waitForFinal`（SDK 进程退出不代表业务失败）

### 0.5 开工前 checklist（继任 session）

- [ ] `git log --oneline -10` 最顶应是 `2e7ee3b A7.4 ...`
- [ ] `git status -s` 只有未追踪的 docs/superpowers 文件
- [ ] `cd apps/server && ./node_modules/.bin/tsc --noEmit` 干净
- [ ] `cd apps/web && ./node_modules/.bin/tsc --noEmit` 干净
- [ ] `cd apps/server && ./node_modules/.bin/vitest run` 4062 passed / 5 skipped
- [ ] 本文档 §0 读完
- [ ] SSE handoff §1.1/§1.2 + A2.3 handoff §0 作为背景

---

## 1. 下一阶段候选

### 1.1 A7 继续：tech-research-collector 接入

真正的 A7 验收样本是 tech-research。当前 smoke-test 只证了最小可行路径。接 tech-research-collector 会暴露新挑战：

| 挑战 | 当前状态 |
|---|---|
| `store_schema.targetSources.fields.*` 共 9 个字段（string / string[] / number 混合）| 今次 smoke-test 只覆盖 string；大多已通过 kernel-next `type: string[]` 支持，但 number 要验 |
| `runtime.reads.pipelineConfig: pipelineConfig` + `reads.projectContext: projectContext` | 这两个是 **legacy injected_context**（由 pipeline runner 预填入 store），kernel-next 没有等价概念。需要决策："pipelineConfig" 视作 entry-stage 自产的 port，还是通过 POST body 注入的"initial portValues"？ |
| Effort `high` + `thinking: enabled` + `max_turns: 35` + `max_budget_usd: 2` | kernel-next `RealStageExecutor` 不 surface `effort` / `thinking`，需要扩或忽略 |
| 输出规模大（9 fields，一些是长数组）| SSE `valuePreview` 被截到 200 bytes，影响 dashboard 可读性但不影响 DB 落盘 |

估算：1-2 个切片，需要你决策 `injected_context` 怎么映射。

### 1.2 YAML → kernel-next IR 自动转换器

smoke-test 证明了手工映射规则正确。把规则编译成代码就是 converter。5 个现有 builtin + 未来所有的：

- 规则：上面 §0.4 §3 的"映射规则文档化"
- 形态：`src/kernel-next/builtins/yaml-to-ir.ts`（读 YAML / 产 IR / 附带 FsPromptResolver 构造参数）
- 前置：pipeline-generator MCP surface 可能依赖这个

估算：2-4 个切片。先做 §1.1 一两个真实 builtin 暴露 converter 需要处理的 edge case。

### 1.3 §10.5 deep live-migration

A2.3.5 验证了单 stage；parallel group fine-grained / worktree reset / 跨版本 attempt 未实现。**有实际多 proposal 场景时再做**。2-3 周。

### 1.4 Dashboard UX 打磨

Slice 5 的 minimal demo 已证明链路可见。要做的：
- mermaid/xyflow 画 pipeline 拓扑图，实时染色
- port value 完整查看（跳转 read_port / query_lineage API）
- Agent thinking / tool_use 可视化（需要扩 SSE schema）
- 列出历史 task（/api/kernel-next/tasks 列表 API）

每条都中等切片。没有强驱动时不做——当前 minimal demo 对开发足够。

### 1.5 pipeline-generator MCP surface

让 main Claude 在对话中 MCP 生成 + submit pipeline，而非 CLI 脚本。涉及 prompt 工程 + 新 MCP tools。中大型。依赖 §1.2 的 converter 作为 "验证生成是否落到 kernel-next IR"。

---

## 2. 需要 owner 决策的事

A7 完成后没有硬阻塞。**下阶段进入前建议对齐**：

1. **继续 A7（§1.1 tech-research）还是换方向**？tech-research 是设计原意，但 smoke-test 已技术上证明路径；如果没有生产驱动，可延后。
2. **要不要做 YAML 转换器（§1.2）**？如果 §1.1 多接几个 builtin，ROI 开始正向。
3. **dashboard UX（§1.4）**是否重要？取决于你会不会在浏览器里调试真实 pipeline。

---

## 3. 架构不变量（A7 未动，仍然成立）

沿用 CLAUDE.md、F1-F8 handoff、A2.3 handoff、SSE handoff 记录的规则。本轮新增：

- **runner 仍无隐式依赖**：broadcaster/executor/promptResolver 都是 optional，不做默认 singleton
- **MCP `write_port` 优先复用 caller PortRuntime**：让 observability hook 穿透整条执行链
- **stream-pump 的错误责任分离**：iterator / adapter 不同类错误采用不同策略
- **legacy builtin 迁移是手工映射，不做隐式自动转换**：保持每条映射可追溯
- **prompts 是文件，不 inline 到 IR**：pipeline 内容与 IR 结构解耦，未来 hot-update prompts 不触发 IR 版本变化（但这需要 resolver 缓存策略配套，目前未实现）

---

## 4. 代码入口点（A7 修改范围）

| 模块 | 角色 |
|---|---|
| `routes/kernel-run.ts` | POST /api/kernel/tasks/run — 4 个 pipeline 注册项 |
| `routes/kernel-run.test.ts` | +2 override/validation 测试 + smoke-test 在 known 列表断言 |
| `kernel-next/sse/singleton.ts` | singleton broadcaster（A7 未改，kernel-run 消费它） |
| `kernel-next/runtime/fs-prompt-resolver.ts` | 新文件 + 5 unit tests |
| `kernel-next/runtime/stream-pump.ts` | A7.3 修复 + 2 新测试 |
| `kernel-next/runtime/real-executor.ts` | mcpServerFactory 签名扩第二参数 `portRuntime` |
| `kernel-next/mcp/server.ts` | 新选项 `portRuntime`；write_port handler 优先复用 |
| `kernel-next/mcp/server.test.ts` | +1 portRuntime 复用回归测试 |
| `kernel-next/builtins/smoke-test.ts` | 新文件：手工 IR + prompts root helper |
| `kernel-next/demo/diamond-real.ts` | 更新 factory 签名以匹配新 mcpServerFactory |

### 4.1 测试

- `kernel-next/runtime/fs-prompt-resolver.test.ts` — 5 unit
- `kernel-next/runtime/stream-pump.test.ts` — +2 new (iterator late throw, iterator crash)
- `kernel-next/mcp/server.test.ts` — +1 portRuntime reuse
- `routes/kernel-run.test.ts` — 已存在 + smoke-test 在 known 列表断言

---

## 5. 浏览器端验证记录（两次）

### 5.1 diamond-real（A7.2/A7.3 修复后）

- TaskId: `bug-fix-verify-1776657022`
- POST body: `{"pipeline":"diamond-real"}`
- 时长：~43s
- 事件序列：task_state idle→running→completed；4 × stage_executing；4 × stage_done；4 × port_written（A.x=42, B.y="B saw 42", C.z="C saw 42", D.final="b:B saw 42 | c:C saw 42"）；run_final(completed, stageErrors=[])
- 时间戳反映拓扑：A 串行 → B∥C 并行 → D

### 5.2 smoke-test（A7.4 后）

- TaskId: `smoke-1776665937`
- POST body: `{"pipeline":"smoke-test"}`
- 时长：~30s（2 stage，串行）
- 事件：task_state idle→running→completed；2 × stage_executing；2 × stage_done；3 × port_written（greet.subject, greet.note, echoBack.message）；run_final(completed)
- 特殊：agent 按 prompt 里的 error handling 处理 "empty task text" — subject="unknown"，note="Empty or unreadable task text received." — 证明 fail-safe 路径 ok

---

## 6. Verdict

A7 **最低要求达标**。

4 commits（`5e942aa`..`2e7ee3b`），+8 tests (4062 total)，tsc 干净，0 回归。两次真实 SDK 端到端验证均通过。第一个 legacy builtin 在 kernel-next 下跑通，映射规则经实战验证。

下阶段空间完全开放。推荐沿 §1.1 继续接 tech-research，或沿 §1.4 打磨 dashboard——取决于你下一步的真实需求方向。
