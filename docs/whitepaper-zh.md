# Workflow Control —— 技术白皮书

> Version 2.0 · 2026-05-03 · kernel-next era
>
> 本文是 [`whitepaper.md`](./whitepaper.md) 的中文版（同版本同结构）。
> 取代 `architecture-whitepaper-zh.md`（已 archived 2026-04-24，描述
> 已退役的 legacy engine）。

---

## 摘要

Workflow Control 是一个**本地、单用户**的工作流引擎，专门用来跑那些
"一个 Claude Code 会话装不下"的 AI 编码任务。它存在于 **Claude Code**
（一次单轮对话很强，但任务跑几个小时就丢状态）和 **Temporal/Airflow**
（编排确定性服务很强，但从来没考虑 LLM agent 那种需要反馈循环、需要
中途改 prompt、需要人工 gate 审批的场景）之间的空白地带。

产品有两条不可妥协的不变量：

1. **可被打断仍可复现。** 一个跑了 75 分钟、横跨 20 个 stage 的任务，
   `pkill node`、`tsx watch` 因文件改动重启、合上笔记本盖、服务端
   崩溃都不能让已经完成的工作丢失。
2. **运行中可热更新。** 用户跑到 25 步流水线的第 17 步发现方向不对
   时，必须能**修 prompt 或加新 stage 而不重启任务**，并且不丢前 16
   步成果。

本文阐述 *做什么*、*为什么这样设计*、内核 *怎样* 真正做到这两条不
变量。

---

## 第一部分 —— What

### 1.1 一段话讲完产品

用户用自然语言描述一个多步骤 AI 任务。一个内置的 `pipeline-generator`
（它本身就是一条 workflow）输出带类型的 **Pipeline IR**——里面有
stages、ports、wires、gates。用户（或者一个自动化脚本）以这条 Pipeline IR
为基础启动一个 **Task**。内核驱动这条任务穿过它的各个 stage——`agent`
stage 跑 Claude SDK 会话、`script` stage 跑进程内脚本、`fanout` stage
做并行循环、`gate` stage 阻塞等待人审——每一次 attempt、每一次端口写
入、每一美元成本都被记到 SQLite 里。Web dashboard 实时显示进度；
CLI / MCP 接口允许其他 Claude 实例驱动同一个内核。

如果内核中途重启，**boot resumability** 会从最后持久化的状态把任务
拉起来继续跑。如果用户想中途改流水线，**hot-update** 让一个 `pipeline-modifier`
提交补丁，用户审批后内核把跑着的任务迁移到新 IR，**只重跑受影响的
stage**。

### 1.2 它**不是**什么

roadmap 明确写了非目标（CLAUDE.md "What this project is not"）：

| 不是 | 为什么 |
|---|---|
| 多租户 SaaS | 每个 server 进程对应一个用户。没有 auth，没有租户隔离。 |
| 团队审批 / 调度平台 | 人工 gate 是给单个用户的，不是给跨团队 review 用的。 |
| 通用编排器 | DSL、executor 模型、审计日志全是为 AI agent 设计的。别拿它跑 cron。 |
| Claude Code 的壳 | 工作流引擎本身才是产品。Claude Code 只是众多执行面之一。 |
| 多引擎 | 2026-04-24 起仅支持 Claude。Gemini/Codex 已退役。 |

这些非目标是**承重梁**：正因为有这些，设计才能忽略 auth、网络分区、
跨用户车队的 DB 多版本迁移，以及通用编排器无法回避的绝大多数运维
复杂度。

**执行单用户、共享跨用户**。这个区别很重要：每个 Task 只跑在一个
用户的本地 SQLite + 文件系统上，但 Pipeline、skill、fragment、hook、
script、MCP server entry 都可以**发布**到一个共享 registry（见 §4.1
`/registry`），被另一个用户安装。边界是"不存在两个用户共享同一个
跑着的任务或 in-flight state"，而不是"不存在跨用户 artefact 流动"。

### 1.3 三个 surface

同一个内核被三个独立 surface 共用：

| Surface | 用途 |
|---|---|
| **HTTP REST + SSE** at `:3001` | Web dashboard、dogfood 脚本、curl |
| **MCP over HTTP** at `:3001/api/mcp` | 外部 Claude Code 会话、Cursor、Codex CLI |
| **CLI**（`pnpm tsx src/cli/...`） | Registry 安装/发布、prune-records |

三者都调用同一个 `KernelService` + 同一个 SQLite 数据库。不存在独立
的 "API 层"——surface 是 service 层之上的薄适配器。

---

## 第二部分 —— Why

### 2.1 为什么需要一个内核？

三个真实问题把这个产品挤出"直接用 Claude Code 就行"的舒适区：

#### 问题 1：长任务丢状态

一个真实的研究任务——"研究 Node 22 TypeScript monorepo 下 ESM/CommonJS
互操作并写一篇一万字的报告"——跑了 75 分钟，横跨 20 个 stage，包含 3
个 fanout 循环（合计 30+ Claude 会话）。在 Claude Code REPL 里用户
得：

- 自己记着每个子任务跑到哪了
- Claude 上下文 compact 时手动重新拼上下文重发 prompt
- 笔记本休眠或 `tsx watch` 重启就什么都没了

把状态**交给内核**而不是放在 chat buffer 里，任务才能扛住重启。每个
stage 的输出按 `attempt_id` 持久化到 `port_values`；resume 查的是
DB，不是内存。

#### 问题 2：流水线第一遍写出来通常是错的

Claude 给一个新的研究主题生成流水线，第一版基本不对。用户跑到第 17
步才发现 framing axis 跑偏了，或者缺一步验证，或者综合 prompt 太
泛。无状态系统下唯一办法是从头来——前 16 步的昂贵工作全丢。

支持**结构化热更新**（提议补丁、审 diff、迁移在跑任务）的内核让用户
"向前修复"。roadmap 的 B 系列（§7）整段就是为这个：B9 worktree
重置、B10 graceful summary turn、B17 fanout element 保留等。**热
更新这条路就是产品本身**，不是附加功能。

#### 问题 3：一个 Claude 会话太小

即便有 cache，单个 SDK 对话也有 context budget。多 stage 流水线把
工作切成 SDK 撑得住的小段，同时通过 `port_values` + 可选的
`single-session` 模式（让相邻 stage 通过 SDK `options.resume` 共享
会话）保留跨段状态。

### 2.2 为什么是这些具体设计？

| 决策 | 备选 | 为什么这个赢 |
|---|---|---|
| **IR 是 canonical，不是 YAML** | YAML 作为 canonical | YAML 空白/键序变化不应改 `version_hash`；canonical IR + `pipelineVersionHash({ir, prompts})` 解决这个。 |
| **AI 写 IR，从不让人写** | 手写 DSL | 流水线作者是稀缺人才。pipeline-generator 本身就是一条 workflow；用户用自然语言描述任务，拿到合法 IR。 |
| **kernel-next + XState v5** | 自造事件循环 | XState 的 parallel-region 语义跟独立 stage 一一映射；INTERRUPT 传播、retry-rebuild、gate-rejection 全是原生 state machine 操作，而不是临时 flag。 |
| **保留 lineage，不删除重写** | retry 时清空旧行 | 一次跑了 25 秒的 attempt 是真实工作。跨越 retry / 热更新 / rollback，每个旧 `success` 行都保留（migration 才会翻 `superseded` 标记，reject-rollback 不动它）。半年后还可以审计。 |
| **SQLite，不是 Postgres/SQS** | 服务端 DB | 单用户。SQLite 处理 2400 个测试 55 秒 + 全部并发 runtime 路径都游刃有余。WAL 给我们断电持久。零运维。 |
| **只支持 Claude** | 多引擎 | 每个引擎都有自己的子 bug；跨引擎语义偏差盖过收益。Stage 4a 退役。 |

### 2.3 为什么 reject-rollback 不是删除？

很微妙但定义产品：用户拒绝一个 gate 后，被指向的上游 stage 重跑，
但旧的 `stage_attempts` 行**仍然 status='success'**。新的运行新增
`attempt_idx=2,3,...` 行。**Lineage 是并集，不是替换。** 这条不变量
跟"热更新可审计"是同一个：旧版本的工作是 *证据*，不是垃圾。

只有 **migration** 才用 `status='superseded'`（B17），因为 migration
的明确含义就是"这个 attempt 跑在已经废弃的流水线版本上"。reject-rollback
不是 migration；它是"内容不对，但 attempt 发生过"。

这条经过几轮 dogfood 反复推敲，详细背景见
`handoff-dogfood-bug16.md` § "Lineage preservation is the design choice"。

---

## 第三部分 —— How

### 3.1 架构拓扑

```
┌─────────────────────────────────────────────────────────────────┐
│                         Surfaces                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Web (Next.js)│  │ MCP HTTP     │  │ CLI (registry,       │   │
│  │  /kernel-next │  │ /api/mcp     │  │ prune-records)       │   │
│  └───────┬──────┘  └───────┬──────┘  └──────────┬───────────┘   │
│          │ REST + SSE       │ JSON-RPC 2.0      │ direct invoke  │
│          ▼                  ▼                   ▼                │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                   Hono HTTP server                        │   │
│  │  /api/kernel/*   /api/registry/*   /api/mcp              │   │
│  └──────────────────────────┬───────────────────────────────┘   │
│                             │                                    │
│                             ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │             KernelService (mcp/kernel.ts)                 │   │
│  │  submit / propose / approve / migrate / rollback / cancel │   │
│  │  answer_gate / provide_secrets / list*                    │   │
│  └──────────┬─────────────────────┬─────────────────────────┘   │
│             │                     │                              │
│             ▼                     ▼                              │
│  ┌────────────────────┐  ┌────────────────────────────────┐     │
│  │  SQLite DB         │  │  Runner                         │     │
│  │  pipeline_versions │  │  ┌──────────────────────────┐  │     │
│  │  stage_attempts    │  │  │ XState 根 machine        │  │     │
│  │  port_values       │  │  │  ┌─────────┐ ┌─────────┐ │  │     │
│  │  gate_queue        │  │  │  │ stage A │ │ stage B │ │  │     │
│  │  task_finals       │  │  │  │ region  │ │ region  │ │  │     │
│  │  hot_update_events │  │  │  └─────────┘ └─────────┘ │  │     │
│  │  task_worktrees    │  │  └──────┬───────────────────┘  │     │
│  │  task_env_values   │  │         │                       │     │
│  │  ...               │  │         ▼                       │     │
│  └────────────────────┘  │  ┌──────────────────────────┐  │     │
│                          │  │ StageExecutor            │  │     │
│                          │  │  ├ RealStageExecutor     │  │     │
│                          │  │  │  └ Claude SDK         │  │     │
│                          │  │  ├ ScriptStageExecutor   │  │     │
│                          │  │  └ orchestrateFanout     │  │     │
│                          │  └──────────────────────────┘  │     │
│                          └──────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 IR —— 一条 Pipeline 真正的样子

`PipelineIR` 是一个由 `ir/schema.ts`（zod）校验的 JSON 文档，形如：

```jsonc
{
  "name": "my-investigation",
  "externalInputs": [
    { "name": "topic", "type": "string" }
  ],
  "stages": [
    {
      "name": "topicFraming",
      "type": "agent",                       // 或 "script" | "gate"
      "inputs":  [{ "name": "topic", "type": "string" }],
      "outputs": [{ "name": "axes", "type": "string[]" }],
      "config": { "promptRef": "topicFraming", "model": "claude-..." }
    },
    {
      "name": "framingGate",
      "type": "gate",
      "inputs":  [{ "name": "axes", "type": "string[]" }],
      "outputs": [],                         // gate 的 __gate_feedback__ 是隐含的
      "config": {
        "question": { "text": "Approve framing?", "options": [
          { "value": "approve" }, { "value": "reject" }
        ] },
        "routing":  { "routes": { "approve": "tutorialAuthoring",
                                  "reject":  "topicFraming" } }
      }
    }
    // ...
  ],
  "wires": [
    { "from": { "source": "external", "port": "topic" },
      "to":   { "stage": "topicFraming", "port": "topic" } },
    { "from": { "source": "stage", "stage": "topicFraming", "port": "axes" },
      "to":   { "stage": "framingGate", "port": "axes" } }
  ]
}
```

三件事值得注意：

1. **wire，不是隐式共享状态。** stage 不会去摸一个共享 blackboard；
   每条 cross-stage 数据流都是从一个生产者输出端口到一个消费者输入
   端口的带类型 wire。`wireDelivers` 同时检查源是否就绪
   （`wireSettled`）和任何条件 guard 是否通过。
2. **Gate 路由可以多目标。** `reject: ["A", "B"]` 表示 reject 这个
   gate 时把 A 和 B 一起回滚，加上 gate 自己，加上 gate-feedback
   wire 下游的所有东西。`validator/structural.ts` 校验所有目标都是
   gate 的祖先（rollback 语义）。
3. **`version_hash` 包含 prompts。** 两条只有 prompt 内容不同的流水
   线产生不同版本。这就是为什么 `propose_pipeline_change(prompts: { foo: "new content" })`
   即便 ops 为空也能产生一个有意义的 `proposedVersion`。

### 3.3 IR → XState 编译

`compiler/ir-to-machine.ts:compileIRToMachine` 把 IR 编译成 XState
`createMachine(...)` 调用。每个 stage 变成一个 **parallel region**，
拥有 `idle | waiting | executing | done | error` 子状态。Wire 变成
`waiting → executing` 转移上的 guard：当且仅当 stage **所有入边都
settled + deliverable** 时才进入 `executing`。

```
                 ┌─────┐
                 │idle │  (machine 启动时短暂经过)
                 └──┬──┘
                    │ always (entry guard)
                    ▼
              ┌──────────┐
              │ waiting  │
              └──┬───┬───┘
                 │   │  always: 所有入边 wireDelivers
                 │   │  AND (gate-routed → authorized)
                 │   ▼
                 │  ┌────────────┐
                 │  │ executing  │
                 │  └──┬─────────┘
                 │     │ PORT_WRITTEN: 全部输出已就绪
                 │     ▼
                 │  ┌──────┐
                 │  │ done │  (final)
                 │  └──────┘
                 │
                 │ STAGE_FAILED: 命中本 stage
                 ▼
              ┌──────┐
              │error │  (final)
              └──────┘
```

根 machine 处理跨切关注点：

- `PORT_WRITTEN { key, value }` → 更新 `context.portValues`，触发
  每个 region guard 重新求值。
- `GATE_ANSWERED { gateId, stageName, answer, targetStage }` → 路由
  到 gate 的 region，转 `done`，按需把 `targetStage(s)` 加进
  `gateAuthorizedTargets`。
- `GATE_REJECTED` → 被 `dispatcher.send`（不是直接到 actor）拦截，
  让 runner 构造 "rollback" 裁决，从 `persistentPortValues` 里 prune
  受影响 stage，下个迭代重建 actor。
- `INTERRUPT { stage? }` → 转发给该 stage 的 invoke child；如果
  `stage` 未指定，广播给每个 executing region；fanout stage 还会通过
  并行的 `fanoutInterruptController` abort（Bug 81 fix，dogfood-13）。

### 3.4 Runner 主循环

`runtime/runner.ts:runPipeline` 是外层驱动：

```pseudo
loop {
  verdict = await runOneAttempt()
  switch verdict {
    case "natural":   break             // 跑到 sink stage
    case "retry":     prune backToStage 下游的 ports
                      bump retryCounts[stage]
                      continue           // 重建 actor
    case "rollback":  drop affectedStages 的 persistentPortValues
                      给每个 affected gate 重新 seed gate-feedback ""
                      记录 rejectFromGates[fromGate]
                      continue           // 重建 actor
    case "interrupted": break            // 外部 INTERRUPT 投递
  }
}
record task_finals
unregister from taskRegistry
delete task_env_values  (P3.6 contract)
```

巧妙之处：`runOneAttempt` 不是简单 `await actor.start()` —— 它装一
个 inspector 监听每次 snapshot 寻找 retry / reject 信号，并维护一个
独立的 executor-promises 数组容纳那些跑在 actor 生命周期外的 fanout
stage。三种信号任一到达，都会显式构造 verdict，外层循环执行正确的
重建。

### 3.5 Hot-update —— 迁移故事

`propose → approve → migrate → rollback` 的具体调用轨迹：

1. **Propose.** `KernelService.propose({ currentVersion, patch, prompts, rerunFrom, autoApprove })`：
   - 对照 `currentVersion` 的 IR 校验 patch（`ir/patch.ts:applyPatch`）。
   - 用 canonical 算 proposed `version_hash`（IR + prompts）。
   - 在 `pipeline_proposals` 写一行 `status='pending'`（如果 autoApprove
     + verdict `safe` 则直接 `'approved'`）。
   - 返回 `{ proposalId, proposedVersion, diff, impact, safeRange }`。
2. **Approve.**（autoApprove 在线；手动审批走单独的 `approveProposal`。）
3. **Migrate.** `migrateTask(taskId, proposalId)` →
   `hot-update/migration-orchestrator.ts:executeMigration`：
   - 拿 per-task lock（`MIGRATION_IN_PROGRESS` 表示别人持有）。
   - 如果 **任何非 gate stage 在跑** 才发 INTERRUPT 给 live runner
     （Bug 80 fix，dogfood-10：纯 gate-running 时跳过，因为 gate.executing
     根本没注册 INTERRUPT handler）。
   - 算 `supersedeSet = computeWireTransitiveReaders(ir, rerunFrom)`
     —— 从 rerun 点出发顺 wire 能到的全部 stage。
   - snapshot pre-supersede 状态用于反向回滚。
   - 一个事务里：把受影响的 `stage_attempts` 标 `superseded`（保留
     `kind='fanout_element' AND status='success'` —— B17），关掉所有
     指向被 supersede attempt 的开放 `gate_queue` 行。
   - 可选的 `git reset --hard before_sha`（B9 full）。
   - 调 `startPipelineRun({ resumeFrom: rerunFrom })` 起一个跑新版的
     新 runner。
   - startRunner 失败的话 → 反向 supersede（按 snapshot 还原状态）+
     audit `failed/RESUME_FAILED`。
4. **Rollback.** 如果用户后悔了 migrate，调
   `rollbackHotUpdate({ taskId, toVersion })`：
   - 计算逆向 patch（正向 patch 的反向）。
   - 把 migrate flow 重跑一遍，把 `toVersion` 当成新目标。
   - audit 写一条新的 `hot_update_events` 行，`kind='rollback'`。

### 3.6 可恢复性不变量

重启长什么样：

```
SIGTERM ───► graceful-shutdown.reconcileRunningAttempts:
              UPDATE stage_attempts SET status='superseded'
                WHERE status='running'
              UPDATE gate_queue ...
              writeTaskFinals(...) for each interrupted task
                with reason='interrupted'
            taskRegistry.interruptAll(deadline)
            await all runners terminate or timeout

(server 关掉，过段时间重启)

server boot ─► bootResumability:
              for each task NOT in task_finals:
                resolve last live state from stage_attempts
                if any stage is in 'running' → orphan;
                  classifyOrphan() 决定是 resume 还是 finalise (failed)
                if pipeline 在 fanout 中段 → 保留 fanout_element
                  successes (B17), 只跑缺失的几个 idx
              startPipelineRun({ resumeFrom: <recovered point> })
```

这条路径保留三个关键不变量：

1. **不会双倍烧 Anthropic 的钱。** 已经写过端口的 stage 不会重跑；
   恢复后的 runner 在 `stage_attempts.status='success'` 找到它就把
   region 短路到 `done`。
2. **Reject-rollback 扛得住重启。** `gate_feedback` 端口被持久化；
   重启后重建的 machine 看到的 feedback 跟 prompt 上游重跑那次完全
   一致。（Bug 16 —— dogfood-5/6 —— 修的就是这个缝隙。）
3. **Fanout 部分状态扛得住重启。** 14/16 元素已完成，重启后只跑
   2 个缺失的。（B17 / handoff-dogfood-2026-05-02 Bug 15 覆盖
   migration 变体。）

---

## 第四部分 —— 可见的产品

### 4.1 Web UI surface map

```
/                               ← Launch hub：所有 pipeline + 启动对话框
/kernel-next                    ← 任务列表
/kernel-next/[taskId]           ← 实时任务详情（SSE、gates、attempts、audit、DAG）
/kernel-next/pipelines          ← Pipeline 浏览
/kernel-next/pipelines/[name]   ← Pipeline IR 查看 + 版本历史
/kernel-next/proposals          ← 热更新提议（approve / reject / migrate）
/kernel-next/attempts/[id]      ← 单 attempt 深挖（lineage, diff, sidecar）
/kernel-next/mcp-catalog        ← MCP server 库（加密 secrets）
/registry                       ← 跨用户 package registry（浏览 + 安装）
```

### 4.2 MCP surface

外部 Claude 会话通过 MCP 工具访问内核。external surface 暴露 **34 个
工具**（`/api/mcp` 上 `tools/list` 提取），按域分组。还有一个 runner
内部专用工具（`write_port`）从不暴露给外部 surface：

**Pipeline 创作与执行**

```
  submit_pipeline(ir, prompts)            — 注册新 IR
  validate_pipeline(ir)                   — dry-run 校验，不持久化
  describe_pipeline({ taskId | versionHash }) — 取一个版本的 IR + prompts
  get_pipeline_definition(name)           — 从 registry / fs 取
  run_pipeline({ name | versionHash, ... }) — 启动一个任务
  start_pipeline_generator(taskDescription) — 便捷启动入口
  wait_pipeline_result(taskId, ...)       — 阻塞到终态
```

**任务控制与观察**

```
  get_task_status(taskId)                 — 完整状态快照
  cancel_task(taskId, reason?)            — INTERRUPT + finalise
  retry_task(taskId, fromStage?)          — 从最早失败点重试
  wait_for_task_event(taskId, predicate)  — 异步事件等待
  list_gates(taskId?)                     — 已开 / 已答 gate
  answer_gate(gateId, answer, comment?)   — 回答人工 gate
  provide_task_secrets(taskId, secrets, persistAs?) — 解锁 secret_pending
```

**热更新**

```
  propose_pipeline_change(...)            — 发出一个提议
  dry_run_proposal(...)                   — 看 diff/impact 但不落地
  list_proposals(status?)                 — pending / approved / rejected
  approve_proposal(proposalId)
  reject_proposal(proposalId, reason?)
  migrate_task(taskId, proposalId)        — 把 proposal 应用到运行中任务
  rollback_hot_update(taskId, toVersion)  — 撤销一次成功 migration
  update_registry_pipeline(...)           — bump 已注册 pipeline 版本
  query_hot_update_stats(...)             — Stage 5E 聚合统计
```

**Lineage 与调试**

```
  read_port(taskId, stage, port)          — 读最新 port_value
  query_lineage(taskId, ...)              — 完整审计 / 解释链
  diff_runs(taskA, taskB)                 — side-by-side diff
  compare_runs(...)                       — 多轴对比
  replay_stage(taskId, stage)             — 单 stage 隔离重跑
  dry_run_stage(...)                      — 用合成输入试一个 stage
  propose_pipeline_fix(taskId, failedStage) — 失败驱动的 modifier 快捷入口
```

**Registry / catalog**

```
  recommend_mcp_servers(query)            — Phase-1 supply-chain helper
  get_mcp_catalog_entry(serverName)       — 按名取 manifest
  add_mcp_catalog_entry(entry)            — 本地 catalog 修改
```

**管理**

```
  prune_records({ taskId | olderThan })   — DB 清理
```

**Runner 内部（不暴露给外部 surface）**

```
  write_port(attemptId, port, value)      — 内核通过 PortRuntime 写输出
```

每个工具返回 `{ ok: true, ... } | { ok: false, diagnostics: [...] }`
形状，code 结构化——跟 REST API 一样的 envelope。

external (34) vs internal (1) 的拆分由 `kernel-next/mcp/server.ts`
的 `createKernelMcp({ surface })` 强制——HTTP `/api/mcp` 默认
`surface: "external"`，而内核自己的 runner 给每个 agent attempt
启一个 combined-surface server 暴露 `write_port`。

### 4.3 关键 DB 表（注释版）

`kernel-next.db` 共 20 张应用表，按用途分组：

**Pipeline 定义（按内容寻址）**

| 表 | 存的是 |
|---|---|
| `pipeline_versions` | `(version_hash, pipeline_name, ir_json, ts_source, parent_hash, created_at)` —— 每条提交过的 IR |
| `stages` | `ir_json.stages` 的归一化镜像，每 (version_hash, stage_name) 一行；让 lineage 查询不必解 JSON 就能 join |
| `ports` | stage 输入/输出端口的归一化镜像，每 (version_hash, stage_name, port_name, direction) 一行 |
| `wires` | `ir_json.wires` 的归一化镜像，每 wire 一行；反向查询（"谁读 X？"）变成 O(index) |
| `prompt_contents` | 内容寻址 prompt 正文存储（每个独立 content_hash 一行） |
| `pipeline_prompt_refs` | (version_hash, promptRef) → content_hash 映射 |
| `pipeline_proposals` | `(proposal_id, status, base_version, proposed_version, patch_json, ...)` |

**任务运行时状态**

| 表 | 存的是 |
|---|---|
| `stage_attempts` | 一行一次 attempt：`(attempt_id, task_id, version_hash, stage_name, attempt_idx, status, kind, fanout_element_idx, started_at, ended_at)` |
| `port_values` | Lineage 行：`(value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)` |
| `gate_queue` | gate-stage 进入时一行：`(gate_id, task_id, attempt_id, question_json, answer, answered_at)` |
| `secret_gate_queue` | 单任务 secret-pending 状态：`(secret_gate_id, task_id, stage_name, required_keys, resolved_at)` |
| `task_finals` | 终态：`(task_id, version_hash, final_state, reason, detail, ended_at)` |
| `task_worktrees` | Worktree 拥有关系：`(task_id, workdir, status, allocated_at)` |
| `task_env_values` | 明文 env values；任务终结后自动删除（P3.6） |
| `stage_checkpoints` | B9 reset 用的 stage 前 git SHA |

**Per-attempt sidecar 数据**

| 表 | 存的是 |
|---|---|
| `agent_execution_details` | 单 agent attempt 的 token 用量、cost、compact 事件、cache 统计 |
| `script_execution_details` | 单 script attempt 的终止原因、错误、运行时长 |

**Hot-update 审计与 advisory**

| 表 | 存的是 |
|---|---|
| `hot_update_events` | 审计：`(event_id, task_id, from_version, to_version, status, started_at, finished_at, diagnostic_json)` |
| `migration_hints` | Hot-update 后继 attempt 的 advisory diff（B9-A） |

**跨任务缓存与供应链**

| 表 | 存的是 |
|---|---|
| `tutorial_cache` | 跨任务 tutorial 复用（D1）：键是 (subject_domain, slug)；像 web3-tech-research 这类 pipeline 在重生成昂贵 tutorial 前先读它 |
| `mcp_servers` + `mcp_secrets` | MCP catalog，加密 at rest |

完整 schema：`apps/server/src/kernel-next/ir/sql.ts`（约 600 行，含
索引和 schema-evolution clean-slate 迁移逻辑）。`stages`/`ports`/`wires`
镜像表跟 `pipeline_versions` 在同一个事务里原子写入。

---

## 第五部分 —— 可见的测试 surface

产品由测试**定义**，跟代码一样多。2,374 个 server 测试 + 66 个 web
测试 + 65 个 registry-service 测试覆盖了用户真正依赖的契约：

| 测试套 | 钉死什么 |
|---|---|
| `runner.test.ts` | Stage 区域转移、retry、gate-routed 授权 |
| `runner.reject-rollback.test.ts` | 单目标 + 多目标 rollback（Bug 28） |
| `runner.cross-region-cancel.test.ts` | STAGE_CANCELLED 传播 |
| `runner-fanout.*.test.ts` | 并发、retry、超时、secret-pending、INTERRUPT（Bug 81） |
| `migration-orchestrator.test.ts` | INTERRUPT 超时、idle-at-gate skip（Bug 80）、reverse-supersede、B13 sibling 保护 |
| `real-executor.test.ts` | Claude SDK 适配、abort、限流、cancel、resume、MCP 状态 |
| `validator/*.test.ts` | 类型兼容、store schema、结构性规则 |
| `compiler/ir-to-machine.test.ts` | IR → machine 编译、多目标 rollback 编译 |
| `kernel.test.ts` (KernelService) | submit、propose、approve、migrate、rollback、cancel、answer、provide_secrets |
| `services/registry-service*.test.ts` | install、uninstall、update、publish、依赖闭包 |

每条 fix commit 都带对应回归测试。dogfood 链条（`dogfood-2026-04-28/handoff-final.md` →
`handoff-dogfood-11-12-13.md`）用真 LLM 端到端走过每条用户路径。

---

## 第六部分 —— 诚实的限制

1. **本地专用**。没 auth、没远程多用户、没跨用户审计链。如果你要
   团队工作流工具，这不是。
2. **依赖 Claude SDK**。Anthropic SDK 多稳，我们就多稳。SDK 故障、
   限流、breaking change 都直接砸到我们。我们已经修过 SDK 状态检测
   （Bug 11）、compact 事件统计（Phase 4.5 T1）、stderr 噪音过滤，
   但敌对 SDK 回归会破坏这个产品。
3. **还没有 prompt cache 策略**。Prompt caching 在 SDK 层工作（1.18
   - 1.19 修订观测到真实流水线 60-91% cache 命中），但我们**不依据
   它做规划**——没有"single-session 决策门"用 cache 数据来选段形状。
4. **手写 IR 受支持但很麻烦**。dogfood-13 阶段的两条 pipeline
   （dogfood-11 多目标 rollback、dogfood-12 fanout）就是手工写
   IR 通过 `submit_pipeline` over MCP 提交、端到端跑通的——所以契
   约本身没坏。但 validator 对 port-type 字符串、wire 形状、gate-
   routing 目标的祖先关系都查得很严，人手写 IR 会反复触发那些
   guardrail。pipeline-generator 路径的存在就是让人只用自然语言
   描述任务；驱动它的那些 prompt 本身就是产品的大半价值。任何
   non-trivial pipeline 都建议走 generator。

---

## 第七部分 —— 入口指南

- **入门**：`docs/product-intro.md`（面向用户）
- **权威设计**：`docs/kernel-next-terminal-design.md`
- **Roadmap（活文档）**：`docs/product-roadmap.md`
- **最近 dogfood 链条**：`docs/superpowers/dogfood-2026-04-28/handoff-*.md`
- **代码入口**：
  - HTTP：`apps/server/src/index.ts`
  - 内核：`apps/server/src/kernel-next/mcp/kernel.ts`
  - Runner：`apps/server/src/kernel-next/runtime/runner.ts`
  - 编译器：`apps/server/src/kernel-next/compiler/ir-to-machine.ts`
  - 热更新：`apps/server/src/kernel-next/hot-update/migration-orchestrator.ts`
  - Web：`apps/web/src/app/`

---

**白皮书 v2.0 完。**

更新本文需要 header bump version 并在相关章节下加段落说明改了什么、
为什么。Legacy `architecture-whitepaper-zh.md` 仅作历史保留——不要
更新。
