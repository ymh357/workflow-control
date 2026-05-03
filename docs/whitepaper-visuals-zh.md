# Workflow Control —— 白皮书可视化

> Version 2.0 · 2026-05-03 · 配套 [`whitepaper-zh.md`](./whitepaper-zh.md)
>
> 取代 `architecture-visual.md`（已 archived 2026-04-24）。
>
> 英文版：[`whitepaper-visuals.md`](./whitepaper-visuals.md)。

本文是 v2.0 白皮书的**视觉伙伴**。下面每张图都通过 GitHub
markdown + Mermaid 渲染。每张图配上对应白皮书章节，配合阅读。

---

## §1. 系统拓扑

> 白皮书 §3.1。

```mermaid
flowchart TB
  subgraph SURFACES["Surfaces (单用户、无 auth)"]
    WEB["Web (Next.js)<br/>:3000"]
    MCP_CLIENT["MCP 客户端<br/>(其他 Claude Code、<br/>Cursor、Codex)"]
    CLI["CLI<br/>(registry, prune)"]
  end

  subgraph HONO["Hono server (:3001)"]
    direction LR
    REST["/api/kernel/* REST"]
    SSE["/api/kernel-next/<br/>tasks/:id/stream SSE"]
    MCP_HTTP["/api/mcp<br/>JSON-RPC 2.0"]
    REGAPI["/api/registry/*"]
  end

  subgraph CORE["服务层"]
    KSVC["KernelService"]
    REGSVC["RegistryService"]
  end

  subgraph STATE["持久化状态"]
    DB[("kernel-next.db<br/>(SQLite WAL)")]
    LOCK[/".wfctl-registry.lock"/]
  end

  subgraph RUNTIME["Runtime"]
    RUNNER["Runner<br/>(每任务一个)"]
    MACHINE["XState v5 根 machine<br/>(每个 stage 一个 parallel region)"]
    EXEC["StageExecutor<br/>(real / script / fanout)"]
    SDK["Claude SDK<br/>子进程"]
  end

  WEB -->|HTTP| REST
  WEB -->|EventSource| SSE
  MCP_CLIENT -->|JSON-RPC over HTTP| MCP_HTTP
  CLI -->|进程内调用| REGSVC
  WEB -->|HTTP| REGAPI

  REST --> KSVC
  SSE --> KSVC
  MCP_HTTP --> KSVC
  REGAPI --> REGSVC

  KSVC <--> DB
  KSVC -->|spawn| RUNNER
  RUNNER --> MACHINE
  MACHINE --> EXEC
  EXEC --> SDK
  EXEC --> DB

  REGSVC <--> LOCK
  REGSVC -->|HTTP| GH["GitHub<br/>workflow-control-registry"]
```

---

## §2. Pipeline IR —— 注册的是什么

> 白皮书 §3.2。

```mermaid
flowchart LR
  EXT["externalInputs<br/>{name, type}"]
  STAGE["stages[]"]
  WIRES["wires[]"]
  STORE["store_schema<br/>(可选)"]

  STAGE --> AGENT["agent stage<br/>config.promptRef<br/>config.mcpServers"]
  STAGE --> SCRIPT["script stage<br/>config.source = registry|inline<br/>config.retry"]
  STAGE --> GATE["gate stage<br/>config.question<br/>config.routing.routes"]

  AGENT --> FANOUT["+ fanout<br/>spec (可选)"]
  SCRIPT --> FANOUT

  WIRES --> WSRC["from.source ∈ {external, stage}"]
  WIRES --> WDST["to.{stage, port}"]

  GATE --> GROUTE["routes:<br/>{ approve: targetA,<br/>  reject: [B, C] }"]

  EXT -.canonicalize+hash.-> VH[(version_hash)]
  STAGE -.canonicalize+hash.-> VH
  WIRES -.canonicalize+hash.-> VH
  STORE -.canonicalize+hash.-> VH
  PROMPTS["pipeline_prompt_refs<br/>+ prompt_contents"] -.fold prompts.-> VH

  VH --> ROW[("pipeline_versions row")]
```

要点：`version_hash = pipelineVersionHash({ ir, prompts })`。
白皮书 §3.2 详述；代码在 `ir/canonical.ts`。

---

## §3. Stage region 状态机（每 stage 一个，并行）

> 白皮书 §3.3。

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> waiting: machine 根入口

  waiting --> executing: 全部入边 deliver<br/>AND (gate-routed → authorized)
  waiting --> error: STAGE_FAILED (本 stage)
  waiting --> error: noDeliverableWire<br/>(authorisation 已到但<br/>有 wire 被丢弃)

  executing --> done: 全部输出已就绪<br/>(PORT_WRITTEN 或 always)
  executing --> done: GATE_ANSWERED (仅 gate stage)
  executing --> error: STAGE_FAILED
  executing --> waiting: STAGE_FAILED + 还有 retry 预算<br/>(仅 script)

  done --> [*]
  error --> [*]

  note right of executing
    agent / script: 调用 executor 子 actor
    INTERRUPT 通过 sendTo() 转发

    gate: 设计上空闲
    没有 INTERRUPT handler ——
    Bug 80 fix 在 runner 层跳过 gate INTERRUPT
  end note

  note right of waiting
    fanout stage: runner 在 invoke 前
    截获，调 orchestrateFanoutStage
    跑游离 promise
  end note
```

Runner 监听 inspector snapshot，看到 `error` final 时构造 verdict
（natural / retry / rollback）。代码：`compiler/ir-to-machine.ts`
+ `runtime/runner.ts`。

---

## §4. Task 生命周期（顶层）

> 白皮书 §1.1 + §3.4。

```mermaid
stateDiagram-v2
  [*] --> running: startPipelineRun
  running --> running: stage 成功<br/>→ 下一 stage 激活

  running --> gated: gate.executing
  gated --> running: answer_gate (approve)
  gated --> running: answer_gate (reject)<br/>→ rollback 重建

  running --> secret_pending: stage 抛出<br/>MCP_ENV_MISSING
  secret_pending --> running: provide_task_secrets

  running --> completed: 全部 sink stage 完成<br/>(natural)
  running --> failed: STAGE_FAILED<br/>+ retry 用尽
  running --> cancelled: cancelTask<br/>OR INTERRUPT 超时

  completed --> [*]
  failed --> [*]
  cancelled --> [*]

  note right of secret_pending
    Lineage: idx=N attempt 仍是
    status='secret_pending';
    新 idx=N+1 在提供 secret 后打开。
  end note

  note left of gated
    设计上空闲。
    Bug 80 fix: migration 在
    "全是 gate 在跑" 时跳过 INTERRUPT。
  end note
```

---

## §5. Reject-rollback —— 多目标

> 白皮书 §2.3 + dogfood-8/11。

```mermaid
sequenceDiagram
  participant U as User
  participant API as REST /gates/:id/answer
  participant K as KernelService
  participant R as Runner
  participant DB as SQLite

  U->>API: POST { answer: "reject", comment }
  API->>K: answerGate(gateId, "reject", comment)
  K->>DB: UPDATE gate_queue SET answer, answered_at
  K->>DB: INSERT __gate_feedback__ port value
  K->>K: 检测 rejectRollbackMap[gate]<br/>→ targetStages (string OR array)
  K->>R: dispatcher.send({type: "GATE_REJECTED",<br/>targetStage, affectedStages})
  Note over R: rejectHandler → resolveAttempt({verdict: "rollback"})

  R->>R: 对每个 affectedStage 都<br/>从 persistentPortValues prune
  R->>R: 对每个 affected gate 重新<br/>seed __gate_feedback__ = ""<br/>(skip fromGate 保留 comment)<br/>(Bug 16 fix)
  R->>R: rebuild actor with isRetryRebuild=true
  R-->>DB: 新 stage_attempt 行<br/>(idx=2, status=running)
  Note over DB: idx=1 success 行保留<br/>(lineage, 不 superseded)

  R->>R: stage 用新 attempt 重跑
  R->>DB: INSERT 新 port_values
  R->>R: gate 重新打开，新 gate_id
  Note over U: 用户看到新 gate 等回答
```

---

## §6. 热更新迁移

> 白皮书 §3.5 + dogfood-10/12/13。

```mermaid
sequenceDiagram
  participant U as User
  participant API as REST /tasks/:id/migrate
  participant K as KernelService
  participant ORCH as migration-orchestrator
  participant R as Live Runner
  participant START as startPipelineRun
  participant DB as SQLite

  U->>API: POST { proposalId }
  API->>K: migrateTask(taskId, proposalId)
  K->>ORCH: executeMigration(...)

  ORCH->>ORCH: 拿 per-task 锁
  ORCH->>DB: load proposal + 检查 status='approved'

  ORCH->>DB: 查 running stage_attempts
  alt 全部 running attempt 都是 gate
    Note over ORCH: Bug 80 路径:<br/>跳过 INTERRUPT 往返
  else 有非 gate attempt 在跑
    ORCH->>R: dispatcher.send(INTERRUPT)
    Note over R: dispatcher 先 abort<br/>fanoutInterruptController<br/>(Bug 81 fix)<br/>再转给 actor
    R->>R: stage region INTERRUPT handler<br/>→ 触发 AbortSignal<br/>→ executor 清理
    R->>R: graceful summary turn<br/>(B10)
    R->>DB: writeTaskFinals(reason='interrupted')
    R->>ORCH: awaitTermination resolves
  end

  ORCH->>DB: snapshot pre-supersede status
  ORCH->>DB: BEGIN TX
  ORCH->>DB: UPDATE stage_attempts SET status='superseded'<br/>对 supersedeSet (保留 fanout_element success)
  ORCH->>DB: 关闭过期 gate_queue 行
  ORCH->>DB: INSERT hot_update_events (status='success')
  ORCH->>DB: COMMIT

  alt 有 rerunFrom
    ORCH->>ORCH: tryResetWorktreeToBeforeSha (B9)
    ORCH->>START: startRunner({resumeFrom: rerunFrom})
    alt startRunner 失败
      Note over ORCH: 反向 SUPERSEDE
      ORCH->>DB: BEGIN TX
      ORCH->>DB: 按 snapshot 还原 status
      ORCH->>DB: COMMIT
      ORCH->>DB: writeAuditFailed(reason='RESUME_FAILED')
      ORCH-->>K: { ok: false, code: MIGRATION_RESUME_FAILED }
    else startRunner 成功
      Note over R: 新 Runner 在 toVersion 的<br/>rerunFrom 处接上<br/>fanout_element idx=0..N (B17)<br/>保留为 lineage
    end
  else 没有 rerunFrom (forward-only)
    Note over ORCH: prompts-only 提议<br/>不会触发 rerun.<br/>新任务才用 toVersion
  end

  K-->>API: { ok: true, eventId, supersededStages }
  API-->>U: 200 OK
```

---

## §7. 重启后的可恢复性

> 白皮书 §3.6。

```mermaid
sequenceDiagram
  participant SIG as SIGTERM
  participant SHUT as graceful-shutdown
  participant DB as SQLite
  participant BOOT as bootResumability
  participant ORPH as orphan-reconciler
  participant R as new Runner

  SIG->>SHUT: kill -TERM
  SHUT->>SHUT: taskRegistry.interruptAll(deadline)
  Note over SHUT: 每个 live runner 收到 INTERRUPT<br/>+ 等其退出
  SHUT->>DB: BEGIN TX
  SHUT->>DB: stage_attempts status='running' → 'superseded'
  SHUT->>DB: gate_queue answered_at = now (synthetic)
  SHUT->>DB: task_finals INSERT OR IGNORE<br/>(reason='interrupted') 给每个任务
  SHUT->>DB: COMMIT

  Note over SIG,R: ───── server 停止 ─────

  Note over BOOT,R: ───── server 启动 ─────
  BOOT->>DB: 查 task_finals 中没有的任务
  loop 每个未终结的任务
    BOOT->>ORPH: classifyOrphan(taskId)
    ORPH->>DB: 读 stage_attempts 状态
    alt 已完全终止
      ORPH->>DB: 写 task_finals(failed/orphaned)
    else 处于运行中、可恢复
      ORPH->>BOOT: { resumeFrom: <stage> }
      BOOT->>R: startPipelineRun({ resumeFrom })
      Note over R: 重建 machine 看到<br/>portValues = 已持久化<br/>finalizedStages = 派生<br/>fanout: 已成功元素保留
    end
  end
```

---

## §8. Fanout 执行

> 白皮书 §3.3（注释）+ dogfood-12。

```mermaid
flowchart TB
  START["orchestrateFanoutStage(args)"]
  START --> SOURCE["读源数组<br/>(splitter 输出)"]
  SOURCE --> PRESERVED["查询 preservedByIdx<br/>(B17: fanout_element WHERE status='success')"]
  PRESERVED --> POOL["spawn worker pool<br/>(并发上限，默认 3)"]

  POOL --> WORKER1["worker 1"]
  POOL --> WORKER2["worker 2"]
  POOL --> WORKERN["worker N"]

  WORKER1 --> ELEM["拿下一个 idx (atomic 游标)"]
  ELEM --> CHECK_INT{interruptSignal<br/>aborted?}
  CHECK_INT -->|是| BAIL["set firstError<br/>(Bug 81 入口检查)"]
  CHECK_INT -->|否| CHECK_PRESERVED{idx 在<br/>preservedByIdx 中?}
  CHECK_PRESERVED -->|是| AGGREGATE["把保留输出<br/>拷贝进 aggregate"]
  CHECK_PRESERVED -->|否| RUN["执行元素<br/>调 executor.executeStage<br/>(每元素 AbortController<br/>+ 监听父 INTERRUPT signal)"]
  RUN --> RESULT{result.status}
  RESULT -->|success| AGGREGATE
  RESULT -->|error + 还有 retry| RUN
  RESULT -->|error 终态| FIRSTERR["set firstError"]
  RESULT -->|secret_pending| PAUSE["secretPendingObserved = true"]
  RESULT -->|timeout| RUN
  AGGREGATE --> ELEM

  POOL --> JOIN["等所有 worker"]
  JOIN --> EMIT{state}
  EMIT -->|firstError 已设| EMIT_ERR["返回 error"]
  EMIT -->|secretPendingObserved| EMIT_PAUSE["返回 secret_pending"]
  EMIT -->|全部 ok| EMIT_OK["写 aggregate 行<br/>+ 聚合后的数组<br/>via livePortRuntime"]
```

---

## §9. Web UI surface map

> 白皮书 §4.1。

```mermaid
flowchart LR
  ROOT["/<br/>Launch hub"] --> TASKS
  TASKS["/kernel-next<br/>任务列表"] --> TASK
  TASK["/kernel-next/[taskId]<br/>实时任务详情"] --> ATTEMPT
  TASK --> AUDIT
  TASK --> MOD["Modify pipeline →<br/>启动 pipeline-modifier"]
  TASK --> CXL["Cancel"]
  TASK --> RBK["Rollback (按事件)"]

  ATTEMPT["/kernel-next/<br/>attempts/[id]<br/>单 attempt 深挖"]
  AUDIT["热更新时间线<br/>(内嵌组件)"]

  ROOT --> PIPES["/kernel-next/pipelines"]
  PIPES --> PIPE["/kernel-next/<br/>pipelines/[name]<br/>IR + 版本历史"]

  ROOT --> PROPS["/kernel-next/proposals"]
  PROPS --> MIGRATE["Migrate dialog →<br/>POST /tasks/:id/migrate"]

  ROOT --> CAT["/kernel-next/mcp-catalog"]
  CAT --> SECRET["添加 MCP entry +<br/>加密 secret"]

  ROOT --> REG["/registry<br/>(本次会话新增)"]
  REG --> INSTALL["Install / Uninstall /<br/>Update / Outdated 角标"]
```

---

## §10. Bug 修复要点 —— 接线图

dogfood 期间浮现的三个 bug 定义了当前跨 stage 类型的 INTERRUPT 故事。

### §10.1 Bug 16 —— gate-feedback 重新 seed

> dogfood-5/6。

```mermaid
flowchart LR
  REJ["GATE_REJECTED 到达"] --> PRUNE["对 affectedStages 从<br/>persistentPortValues prune"]
  PRUNE --> WHY["但: compiler 在首次 compile 时<br/>把每个 gate 的 __gate_feedback__ seed = ''"]
  WHY --> BAD["prune 把它们删了"]
  BAD --> BUG["下游 gate-routed stage<br/>看到 undefined feedback port<br/>→ wireDelivers 失败<br/>→ actor 卡在 waiting"]
  BUG --> FIX["FIX: 给每个 affected gate<br/>重新 seed __gate_feedback__ = ''<br/>(skip fromGate 保留 comment)"]
```

### §10.2 Bug 80 —— gated 任务 INTERRUPT 超时

> dogfood-10。

```mermaid
flowchart LR
  MIG["migrate gated 任务"] --> SEND["dispatcher.send INTERRUPT"]
  SEND --> GATE["gate.executing 没有<br/>INTERRUPT handler"]
  GATE --> SILENT["XState v5 noop"]
  SILENT --> WAIT["awaitTermination 30s"]
  WAIT --> FAIL["MIGRATION_INTERRUPT_TIMEOUT"]
  FAIL --> FIX2["FIX: orchestrator 查<br/>running stage_attempts;<br/>如果全是 gate stage<br/>→ 跳过 INTERRUPT"]
```

### §10.3 Bug 81 —— fanout 不响应 INTERRUPT

> dogfood-13。

```mermaid
flowchart LR
  MIG2["migrate fanout 中段任务"] --> SEND2["dispatcher.send INTERRUPT"]
  SEND2 --> ACTOR["转给 actor"]
  ACTOR --> ACTORSTOP["actor.stop() 1500ms 后"]
  ACTORSTOP --> DETACHED["但: fanout promise<br/>跑在 actor 之外"]
  DETACHED --> KEEPGOING["排队元素继续跑<br/>整整 30 秒"]
  KEEPGOING --> FAIL2["MIGRATION_INTERRUPT_TIMEOUT"]
  FAIL2 --> FIX3["FIX: runner 层<br/>fanoutInterruptController<br/>在 dispatcher.send 中先 abort;<br/>orchestrateFanoutStage 入口检查<br/>+ 每元素 controller 监听父信号"]
```

---

## §11. 数据库 —— 主要表与连接路径

> 白皮书 §4.3。

```mermaid
erDiagram
  pipeline_versions ||--o{ stage_attempts : "version_hash"
  pipeline_versions ||--o{ pipeline_prompt_refs : "version_hash"
  pipeline_prompt_refs ||--|| prompt_contents : "content_hash"

  stage_attempts ||--o{ port_values : "attempt_id"
  stage_attempts ||--o| gate_queue : "attempt_id"
  stage_attempts ||--o| stage_checkpoints : "attempt_id"
  stage_attempts ||--o| agent_execution_details : "attempt_id"
  stage_attempts ||--o| script_execution_details : "attempt_id"

  task_finals ||--|| pipeline_versions : "version_hash"
  task_worktrees ||--|| task_finals : "task_id (终态时)"
  task_env_values ||--o{ stage_attempts : "task_id (终结时清空)"
  secret_gate_queue ||--|| stage_attempts : "attempt_id"
  hot_update_events ||--o| pipeline_proposals : "proposal_id"
  hot_update_events }o--|| pipeline_versions : "from_version + to_version"

  migration_hints ||--|| stage_attempts : "(task_id, stage_name)<br/>partial unique unconsumed"

  mcp_servers ||--o{ mcp_secrets : "entry_id"
```

这套 schema 的关键质量：**所有跨表连接都按 `attempt_id` 或
`version_hash`**，从不按 `task_id + stage_name + idx` 字符串。这就
是为什么 lineage 查询又快又无歧义——lineage 行永远存活，因为它
们绑在产生它的具体 attempt 上。

---

## §12. Dogfood 时间线 —— 我们交付了什么

> 白皮书 §5；详细叙述见
> `docs/superpowers/dogfood-2026-04-28/handoff-dogfood-11-12-13.md`。

```mermaid
gantt
  title Dogfood 链条 (2026-04-28 → 2026-05-03)
  dateFormat YYYY-MM-DD
  axisFormat %m-%d
  excludes weekends

  section c12+ review
  Wave 1 — Theme 1            :done, w1, 2026-04-28, 1d
  Wave 2 — Theme 2 + 3        :done, w2, 2026-04-29, 2d
  Wave 3                      :done, w3, after w2, 1d
  Wave 4                      :done, w4, after w3, 1d
  P2 sweep                    :done, p2, after w4, 1d

  section dogfood path
  Fresh dogfood (Bug 13/14/15) :done, d1, 2026-05-02, 1d
  Bug 16 root-cause + fix      :done, d2, after d1, 1d
  Cancel mid-run (dogfood-7)   :done, d3, 2026-05-03, 1d
  Multi-target rollback unit (dogfood-8) :done, d4, after d3, 1d
  Secret-pending (dogfood-9)   :done, d5, after d4, 1d
  Hot-update Bug 80 (dogfood-10) :done, d6, after d5, 1d
  Real-LLM multi-target (dogfood-11) :done, d7, after d6, 1d
  Fanout B17 (dogfood-12)      :done, d8, after d7, 1d
  Reverse-supersede + Bug 81 (dogfood-13) :done, d9, after d8, 1d

  section deliverables
  Registry UI                  :done, t1, 2026-05-03, 1d
  Web UI completion            :done, t2, after t1, 1d
  Whitepaper v2                :done, t3, after t2, 1d
```

---

## §13. 累计交付物

> 白皮书 §6（限制）划定边界；本节是边界内的成绩单。

| 产物 | 数量 |
|---|---|
| Server 测试 | 251 文件 / 2,374 测试通过 |
| Web 测试 | 13 文件 / 66 测试通过 |
| Registry-service 测试 | 65（unit + adversarial） |
| 修复 bug | c12+ → dogfood-13 共 81 |
| c12+ 闭环以来 commit | ~50 |
| HTTP 路由（kernel-next） | 18（含 SSE） |
| MCP 工具 | 17 |
| Web 页面 | 9 |
| TSC 干净 TypeScript 行数 | ≈ 60K (server) + ≈ 18K (web) |

---

**可视化文档 v2.0 完。**

更新规则：bump version + 在新章节加 §N。不要修 legacy
`architecture-visual.md`。
