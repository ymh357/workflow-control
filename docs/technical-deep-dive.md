# 竞品技术深度分析 -- 对 Workflow Control 的架构启发

> 调研日期: 2026-04-13
> 目标: 从 LangGraph / Temporal / Claude-Code-Workflow 三个项目的内部实现中提取可落地的技术改进

---

## 目录

- [LangGraph: 状态图与 Checkpoint 机制](#langgraph-状态图与-checkpoint-机制)
- [Temporal: 持久执行与事件溯源](#temporal-持久执行与事件溯源)
- [Claude-Code-Workflow: Context-First 与 Skill 系统](#claude-code-workflow-context-first-与-skill-系统)
- [汇总: 优先级排序的改进建议](#汇总-优先级排序的改进建议)

---

## LangGraph: 状态图与 Checkpoint 机制

### 1. State Management 与 Channel 系统

**LangGraph 实现原理**

LangGraph 的 `StateGraph` 基于 typed annotation 定义状态 schema. 每个字段通过 Python 的 `Annotated` 类型映射到一个 Channel 对象:

- **LastValue**: 只保留最新值. `update()` 严格限制每个 superstep 只能收到一个写入, 多写直接抛 `InvalidUpdateError`. 等价于"单一所有权"语义.
- **BinaryOperatorAggregate**: 通过 reducer 函数 (如 `operator.add`) 将新值与累积值合并. 允许多个 node 同时写入同一 key.
- **EphemeralValue**: 读后即消, 下一 superstep 不可见.

```python
class State(TypedDict):
    messages: Annotated[list[str], operator.add]  # BinaryOperatorAggregate
    result: str                                     # LastValue (default)
```

Channel 的设计本质是一个**写入冲突解决策略声明**. 所有并行 node 的写入在 Execution 阶段被隔离 buffer, 直到 Update 阶段才通过 channel 的 `update()` 统一 apply.

**对比 Workflow Control**

Workflow Control 采用显式 `reads`/`writes` 声明, 本质上是 LastValue 语义 -- 后写覆盖前写. 并行 group 内通过校验禁止写入 key 重叠, 从源头消除冲突.

**启发: 为 writes 引入 merge strategy**

在 YAML 的 `writes` 声明中引入可选的 `merge_strategy` 字段:

```yaml
writes:
  - key: findings
    strategy: append    # 数组拼接, 允许并行 stage 同时贡献
  - key: summary
    strategy: replace   # 默认, LastValue 语义
```

这样并行 group 内多个 stage 可以同时向同一 key 贡献数据, 无需新增"汇总 stage". 实现上只需在 store merge 逻辑中根据 strategy dispatch.

---

### 2. Checkpointing 与持久化

**LangGraph 实现原理**

Checkpoint 包含完整运行时快照:

```python
Checkpoint = {
    "v": 1,
    "id": "uuid6-based",          # 单调递增, 可排序
    "ts": "ISO-8601",
    "channel_values": {...},       # 所有 channel 的序列化值
    "channel_versions": {...},     # 每个 channel 的版本号
    "versions_seen": {...},        # 每个 node 已观察到的版本
}
```

关键设计: `versions_seen` 记录每个 node 上次看到的 channel 版本. 恢复执行时, 系统比较 `channel_versions` 和 `versions_seen`, 只有"有新数据"的 channel 对应的 node 才被激活. 实现**精确增量恢复** -- 不重跑已成功的 node.

**时间旅行**: 通过 `copy_checkpoint()` 浅拷贝, metadata 标记 `source: "fork"`. 用户可从任意 `checkpoint_id` 恢复, 后续执行产生新的 checkpoint 链.

**对比 Workflow Control**

当前使用 XState `getPersistedSnapshot()` 序列化整个状态机, 写入单个 JSON 文件. 粒度是 task 级别, 没有 per-stage 的历史链.

**启发: 引入 checkpoint 链**

```
task_abc/
  checkpoint_001.json  <- stage: brainstorm completed
  checkpoint_002.json  <- stage: plan completed
  checkpoint_003.json  <- stage: execute completed (failed at verify)
```

每个 stage 完成时生成带递增 ID 的 checkpoint. `RETRY_FROM` 可以从目标 stage 对应的 checkpoint 精确恢复 store 状态, 而非从头重跑. 这直接提升恢复的可靠性和效率.

---

### 3. Human-in-the-Loop 实现

**LangGraph 实现原理**

`interrupt()` 函数机制:

1. 在 node 内调用 `interrupt(value)`, 抛出 `GraphInterrupt` 异常
2. 异常被 Pregel 引擎捕获, 当前 superstep 中断, 已完成 node 的写入保存为 pending checkpoint writes
3. 恢复时, 用户通过 `Command(resume=value)` 提供响应
4. 被中断的 node **从头重新执行**, 但 `interrupt()` 通过内部计数器检测到恢复调用, 直接返回 resume value

关键: node 必须幂等, 因为恢复时整个 node 会重执行.

**对比 Workflow Control**

`human_confirm` 是独立的 stage 类型, 作为状态机显式状态. 优势: gate 是一等公民, 有 SSE 事件、Slack 通知、Notion 同步.

**启发: Stage 内中断**

当前只有 stage 间才能暂停. 可借鉴 `interrupt()` 模式, 允许 agent stage 内部通过 MCP tool call 请求确认. `createAskUserQuestionInterceptor` 已接近这个方向, 可增强为: tool hook 暂停时自动保存 stage checkpoint, 恢复时注入 resume value 继续.

同时, 可扩展 REJECT_WITH_FEEDBACK 为允许 human reviewer 直接编辑 store 数据 (如修改 plan 中的 task 列表), 再恢复执行.

---

### 4. 子图组合

**LangGraph 实现**: 将编译后的 graph 作为 node 嵌入父 graph. 自动在边界处只传递重叠 key, 子图内部 key 不泄漏. Checkpoint 继承父图 checkpointer.

**Workflow Control**: 子管道是完全独立 XState actor, 数据通过 reads/writes 映射. `foreach_executor.ts` 支持 worktree 隔离、并发控制、错误策略.

**启发**:
1. **消除轮询**: 当前子管道通过 2 秒轮询检查状态. 改为子 actor 完成时 emit 事件, 父 actor 通过 XState `waitFor` 获通知. 减少延迟和 CPU 开销.
2. **嵌套 SSE namespace**: 给子管道事件增加 namespace 前缀, 前端展示嵌套执行视图.

---

### 5. Pregel 执行模型

**LangGraph 实现**: Superstep 循环三阶段:

1. **Plan**: 检查哪些 channel 更新, 订阅了这些 channel 的 node 被选入执行集
2. **Execute**: 选中 node 并行执行, 写入 buffer 隔离
3. **Update**: buffered 写入通过 channel `update()` apply 到全局状态

与 XState 的核心区别: XState 是**事件驱动** (状态转换由事件触发); Pregel 是**数据驱动** (node 激活由数据变更触发). XState 更适合 Workflow Control 的线性/分支管道场景.

**启发: Reactive Stage**

引入 `reactive` stage type, 不在线性管道占位, 而是"监听某个 store key 变更时自动触发". 结合 Pregel 的数据驱动思想和现有线性管道的简洁性:

```yaml
reactive_stages:
  - name: cost_alert
    trigger: "store.total_cost > 5.0"
    action: notify_slack
```

用例: cost 超阈值自动告警、store 出现特定 pattern 时注入额外检查.

---

### 6. 错误处理

**LangGraph**: `RetryPolicy` 配置; superstep 事务性 -- 任何 node 失败, 整个 superstep 的 channel 更新回滚.

**Workflow Control**: 两层重试 (stage 内 `MAX_STAGE_RETRIES=2` + stage 间 `back_to` 回退), 比 LangGraph 单层 RetryPolicy 更强.

**启发**:
1. 并行 group 可借鉴事务性: 只有所有并行 stage 都成功, 才 apply store 更新
2. 当前重试是立即重试, 可加入指数退避 (`backoff_factor`, `jitter`)

---

## Temporal: 持久执行与事件溯源

### 1. Event Sourcing 与持久执行

**Temporal 实现**

每个 Workflow Execution 维护线性 Event History, 事件按 EventID 单调递增, 存储在 `history_node` 表 (按 batch 分组). Workflow 代码调用 `scheduleActivity()` 时**不直接执行**, 而是发送 **Command**, Server 将 Command 转化为 **Event** 并持久化:

- `WorkflowExecutionStarted` -- 初始输入
- `ActivityTaskScheduled/Started/Completed/Failed/TimedOut` -- Activity 生命周期
- `TimerStarted/Fired` -- 定时器
- `MarkerRecorded` -- `getVersion()`, `sideEffect()` 结果

**确定性约束**: 禁止 `Date.now()`/`Math.random()`/直接网络调用, 必须用 `workflow.now()` 等替代 API. 非确定性导致 Replay 时 Command 序列不匹配.

**Event History 限制**: 51,200 事件 / 50MB 硬限. 解法: **Continue-As-New** 原子关闭当前 Execution 并以相同 Workflow ID 创建新的.

**对比 Workflow Control**

Workflow Control 是**快照模型** (全量覆盖), 非事件溯源. 恢复粒度是 Stage 级别, 无中间状态审计.

**启发: 叠加轻量级事件日志**

不需要完整事件溯源, 但可以在快照模型上叠加关键决策事件:

```typescript
interface WorkflowEvent {
  eventId: number;
  timestamp: string;
  type: 'stage_started' | 'stage_completed' | 'stage_failed' | 
        'retry_triggered' | 'gate_approved' | 'gate_rejected' | 
        'store_write' | 'cost_threshold';
  stageName: string;
  payload: Record<string, unknown>;
}
```

保持快照恢复简洁性, 同时获得事件级审计追踪. 特别是记录每次 store 写入的增量 diff, 比全量快照更有诊断价值.

---

### 2. 四层超时与重试模型

**Temporal 实现**

| 超时类型 | 含义 | 用途 |
|----------|------|------|
| **ScheduleToStart** | 入队到 Worker 开始 | 检测 Worker 过载/死亡 |
| **StartToClose** | 单次执行上限 | 限制单次尝试耗时 |
| **ScheduleToClose** | 端到端含重试 | 整体 SLA 约束 |
| **Heartbeat** | 两次心跳间隔 | 活性检测, **可携带进度数据** |

重试策略参数: `InitialInterval` (首次等待), `BackoffCoefficient` (退避系数), `MaximumInterval` (退避上限), `MaximumAttempts`, `NonRetryableErrorTypes`.

**对比 Workflow Control**

当前只有 `MAX_STAGE_RETRIES = 2` 和 `max_budget_usd` (成本间接超时), 无时间维度分层.

**启发: AI Agent 专用分层超时**

```yaml
stages:
  - name: execute
    type: agent
    timeouts:
      queue_timeout: 60s          # 等待进程可用
      execution_timeout: 30m      # 单次执行上限
      heartbeat_interval: 60s     # 进程活性检测
      idle_timeout: 5m            # 无活动超时 (当前 BUSY_TIMEOUT_MS)
    retry:
      max_retries: 2
      backoff: exponential
      initial_interval: 5s
      max_interval: 60s
      non_retryable_errors: ['invalid_pipeline_config', 'auth_failure']
```

特别是 **heartbeat** -- Temporal 的心跳不只是存活检测, 还**携带进度数据**. Agent 可以定期报告:

```typescript
// stream-processor.ts 中
for await (const event of claudeStream) {
  if (event.type === 'tool_use') {
    await heartbeat({
      lastToolUse: event.name,
      tokensSoFar: currentTokenCount,
      elapsedMs: Date.now() - startTime,
    });
  }
}
```

心跳超时不直接终止, 标记为 `stale` 并通知用户确认. 比硬超时更适合 AI agent 不可预测性.

---

### 3. Signal 与 Query 机制

**Temporal 实现**

| 消息类型 | 语义 | 持久化 |
|----------|------|--------|
| **Signal** | 异步写入, 可修改 Workflow 状态 | 是 (Event History) |
| **Query** | 同步只读, 不影响执行 | 否 |
| **Update** | 同步读写, 有返回值 | 是 |

Signal 保证 at-least-once 投递, Worker 崩溃后 Replay 时重新投递.

**对比 Workflow Control**

| Temporal | Workflow Control | 差异 |
|----------|-----------------|------|
| Signal | confirm_gate, interrupt_task | WC 事件是内存态, 处理中崩溃会丢失 |
| Query | get_task_status, get_store_value | WC 直接读 actor snapshot |

**启发: 关键消息预写日志**

在处理 `CONFIRM`/`REJECT`/`INTERRUPT` 前, 先将消息写入事件日志文件, 进程恢复后可重放未处理的消息. 防止人工审批在处理中间崩溃丢失.

---

### 4. Workflow 版本控制

**Temporal 实现**

- **Patching API**: `patched('v2')` 在首次执行写入 Marker 事件, Replay 时据此选择分支
- **Worker Versioning**: 给 Worker 打版本标签, Server 将旧 Workflow 路由给旧版 Worker

**启发**: Pipeline YAML 版本校验

快照中嵌入 pipeline 配置哈希. 恢复时对比当前 pipeline 配置与快照中的配置, 不同则给出明确警告或拒绝恢复.

---

### 5. 子 Workflow 与补偿 (Saga)

**Temporal 实现**

- 子 Workflow 通过 `ParentClosePolicy` 绑定生命周期: `TERMINATE`/`ABANDON`/`REQUEST_CANCEL`
- Saga: 每步注册补偿函数, 失败时 LIFO 顺序回滚

**启发: Git 即补偿**

对 AI 编码场景, **Git 本身就是天然的补偿机制**:

```yaml
stages:
  - name: execute
    type: agent
    compensation:
      strategy: git_reset    # 失败时 reset 到 stage 开始的 commit
      # 或 git_stash -- 保留变更但不在主分支
```

当前已有 worktree 隔离, 在此基础上添加 stage 级别 git checkpoint 是自然延伸.

---

### 6. AI Agent 编排的新兴模式

**Temporal 社区推荐**:

- 每次 LLM 调用作为 Activity, 带心跳 (携带 streaming 进度)
- Activity 重试时可从 `heartbeatDetails` 恢复检查点
- 多 agent 扇出需要复杂的取消树管理
- 人类审批通过 Signal + `condition()` 等待

**Workflow Control 的已有优势**:
- `session-persister.ts` 的 session ID 持久化让 agent 崩溃后可 resume 同一 Claude session -- 比 Temporal 无状态 Activity 重试更高效
- `interactive: true` 模式让 agent 执行中可以向人类提问 -- 在 Temporal 中需复杂 Signal 编排
- `max_budget_usd` 成本上限比纯时间超时更适合 LLM 场景

---

## Claude-Code-Workflow: Context-First 与 Skill 系统

### 1. Beat Model 与 Cadence 协调

**CCW 实现**

三层协调:

**Chain Loader** (`chain-loader.ts`): JSON 定义的 `SkillChain` 图驱动工作流. 三种节点: `StepNode` (步骤), `DecisionNode` (LLM 路由), `DelegateNode` (子链). 无状态协调 -- 每次从 JSON 文件加载/保存状态.

**Queue Scheduler** (`queue-scheduler-service.ts`): 完整状态机 (`idle -> running -> paused -> stopping -> completed/failed`), 通过 `depends_on` 构建 DAG, 自动解析依赖:

```typescript
private resolveDependencies(): void {
  const completedIds = new Set(
    this.state.items.filter(i => i.status === 'completed').map(i => i.item_id)
  );
  for (const item of this.state.items) {
    if (item.depends_on.every(depId => completedIds.has(depId))) {
      item.status = 'queued';
    }
  }
}
```

**Team Message Bus** (`team-msg.ts`): JSONL 文件持久化, coordinator/worker 通过 `log`/`broadcast`/`get_state` 通信.

**启发: LLM Decision Gate**

在 XState 状态机中新增 `llm_decision` stage type -- 保留状态机形式化可验证性, 获得 CCW 的动态路由能力:

```yaml
stages:
  - name: route_task
    type: llm_decision
    prompt: "Based on the analysis, decide the next step"
    choices:
      - condition: "needs_more_research"
        goto: deep_analysis
      - condition: "ready_to_implement"
        goto: execute
      - condition: "too_complex"
        goto: decompose
```

---

### 2. Context-First 架构

**CCW 实现**

三个维度:

**Preload**: 每个 SkillChain 定义 `preload` 字段, 支持 `@path/file.md`、`memory:MEMORY.md`、`$env:VAR` 四种源.

**UnifiedContextBuilder**: 分层组装, 严格字符限制:
- session-start: <= 1500 字符 (MEMORY.md 摘要 + 集群概览 + 热实体 + 固化模式 + 近期会话)
- per-prompt: <= 500 字符 (向量搜索 + 意图匹配)

**跨会话知识积累** (最有价值的设计):
- Phase 1 (per-session): Filter -> Truncate -> LLM Extract -> Redact -> Store
- Phase 2 (global): 物化到磁盘, CLI agent 生成全局 `MEMORY.md`

**对比 Workflow Control**

6 层 prompt 组装是**静态声明式**. CCW 的核心差异: (1) 上下文基于热度/向量相似度/时间衰减动态选择; (2) 有跨会话知识积累闭环.

**启发**:
1. **动态 fragment 选择**: knowledge_fragments 支持 `source: runtime_query`, 由运行时上下文决定注入哪些 fragments
2. **跨 pipeline 记忆**: pipeline 完成后提取关键决策/发现, 写入持久化记忆层, 供后续 pipeline tier-1 上下文引用

---

### 3. Skill 系统设计

**CCW 实现**

双轨制:

**Workflow Skills** (Chain Loader): `.claude/workflow-skills/{name}/` 目录, 包含 `SKILL.md` (YAML frontmatter) + `chains/{name}.json` (节点图). 支持线性步骤、条件分支、子链委托.

```json
// brainstorm chain: 4 节点, 2 决策点, 3 个命名入口
"entries": [
  { "name": "default", "node": "S_P1" },
  { "name": "auto", "node": "S_P2" },
  { "name": "single-role", "node": "S_P3" }
]
```

**Slash Commands** (Command Registry): 扫描 `.claude/commands/workflow/` Markdown 文件, 解析 YAML header.

**语义触发**: `keyword-detector.ts` 定义 15 种 magic keywords (`autopilot`, `team`, `pipeline` 等), 按优先级匹配, 激活对应执行模式.

**启发**:
1. Registry 包增加 `triggers` 字段, 支持正则模式匹配自动选择 pipeline
2. CCW 的 `delegate` 节点 (子链嵌套 + chain_stack 返回) 启发 pipeline 内 `pipeline_ref` stage type

---

### 4. 多 Agent 团队架构

**CCW 实现**

24 个专业化 agent, 分两类:

**team-worker** (任务发现生命周期): Phase 1 任务发现 -> Phase 2-4 角色执行 -> Phase 5 报告. 支持 **inner loop** -- 单实例批处理同 prefix 任务, 通过 `context_accumulator` 维护跨迭代上下文.

**team-supervisor** (消息驱动常驻): 跨 checkpoint 存活, 监控 pipeline 健康, 通过 `SendMessage` 被唤醒执行审核.

9 种标准角色: analyst, writer, planner, executor, tester, reviewer, architect, fe-developer, fe-qa.

**启发**:
1. **Guardian stage**: 新 stage type, 在 pipeline 关键节点插入自动审核 (比 human_confirm 轻量, 比 script 更智能)
2. **inner loop**: stage 的 `repeat_until` 配置 -- 单 agent 批处理同类任务直到条件满足

---

### 5. CodexLens 代码智能

**CCW 实际状态**: 向量索引已 **stub 化** (`isUnifiedEmbedderAvailable()` 始终返回 false). 实际可用的是 SQLite Memory Store (实体跟踪, 热度评分, 关联图).

`EntityStats` 维护 read_count / write_count / mention_count / heat_score 四维指标. 支持时间窗口过滤 (默认 7 天).

**启发**: 实体热度追踪可集成到 knowledge_fragments -- 自动将 pipeline 运行中频繁访问的文件/模块提升为 tier-1 上下文.

---

### 6. 执行模式与调度

**CCW 实现**

`QueueSchedulerService` 支持 DAG 调度, 四种模式:
- **Collaborative** (`team`): maxConcurrentTasks: 3
- **Parallel** (`swarm`): maxConcurrentTasks: 5
- **Iterative** (`ultrawork`): 单线程迭代
- **Pipeline** (`pipeline`): 顺序执行

3 层会话池分配: resumeKey 亲和 -> 空闲复用 -> 新建.

**启发**:
1. YAML 增加 `depends_on` 字段, 从线性 pipeline 升级为 DAG 调度
2. `resumeKey` 会话亲和 -- stage 需要在同一 LLM 会话中继续时, 通过 session affinity 避免重建上下文
3. Pipeline 级 `execution_mode` 字段 (sequential | parallel | dag)

---

### 7. JSON vs YAML 配置

| 维度 | CCW (JSON) | Workflow Control (YAML) |
|------|-----------|----------------------|
| 类型安全 | JSON Schema 可验证 | YAML + Zod 运行时验证 |
| 可读性 | 无注释, 嵌套深 | 天然可读, 支持注释 |
| 工具支持 | 更好的 IDE 补全 | 缺乏类型推导 |
| 人工编辑 | 括号配对困难 | 缩进敏感但直观 |

CCW 的 `content_ref` 模式值得借鉴: 工作流结构在 JSON 中, 执行内容在外部 Markdown.

**启发**: stage 的 `system_prompt` 支持引用外部 Markdown 文件 (`prompt_file: prompts/execute.md`), 减少 YAML 体积. 实际上当前的 `system_prompt` 已经是独立 `.md` 文件, 但可以进一步将 prompt 组装逻辑抽离.

---

## 汇总: 改进建议实施状态

### 已完成 (2026-04-13)

| # | 改进 | 来源 | Commit |
|---|------|------|--------|
| 1+2+5 | **Workflow Event Log** -- 审计追踪 events.jsonl + API | Temporal + LangGraph | `9bc15b9` |
| 3 | **Stage Git Checkpoint + Compensation** -- git_reset/git_stash on failure | Temporal Saga | `7a1d340` |
| 7 | **writes merge strategy** -- append/merge/replace for parallel groups | LangGraph Channel | `42902dd` |
| 8 | **子管道事件订阅替代轮询** -- actor.subscribe() | LangGraph 子图 | `d345a28` |
| 9 | **LLM Decision Gate** -- 新 stage type, LLM 运行时动态路由 | CCW DecisionNode | `a7f6960` |
| 13 | **可配置 max_attempts** -- 每 stage 独立控制重试次数 | Temporal RetryPolicy | `98e3bd4` |

### 已评估并推迟

| # | 改进 | 原因 |
|---|------|------|
| 4 | 分层超时 (heartbeat) | 需要改 agent runner 执行循环, 架构改动大 |
| 6 | Pipeline 配置版本校验 | 当前 fingerprint warn 已够用, 强制拒绝恢复可能造成数据丢失 |
| 10+11 | 智能上下文 (动态 fragment + 跨 pipeline 记忆) | 需要 LLM 提取 + 向量搜索, 独立 session 实施 |
| 12+16 | 并行执行 v2 (事务性 + DAG) | 大版本重构, 等基础稳定后启动 |
| 14 | 进程内调度队列 | 单用户场景价值不高 |

### 已评估并放弃

| # | 改进 | 原因 |
|---|------|------|
| 13b | 指数退避 | XState actions 是同步的, 延迟需要中间 state, 成本过高 |
| 15 | Reactive stage | 与 LLM Decision Gate 冲突, 且用例可通过现有 side-effects 覆盖 |
| 17 | 子 pipeline ParentClosePolicy | 依赖 #8 完成 (已完成), 但实际需求不迫切 |
| 18 | 结构化搜索属性 | dashboard 当前 task 量级不需要复杂查询 |

---

### 核心洞见总结

**从 LangGraph 学到的**: 状态管理的 **冲突解决策略声明** (Channel/Reducer) 和 **精确增量恢复** (versions_seen). Workflow Control 应该让数据流更智能, 而非仅仅是"读写声明".

**从 Temporal 学到的**: "将 **我做了什么** 和 **我要做什么** 分离, 前者持久化, 后者可重建". 不需要完整事件溯源, 但应从中汲取"增量持久化"和"心跳检查点"思想, 使恢复粒度从 stage 级精细化到 tool call 级.

**从 Claude-Code-Workflow 学到的**: **上下文不应该是静态的** -- 应基于热度、相关性和历史积累动态选择. 以及 **跨执行记忆** 的价值 -- pipeline 不是孤立运行的, 它们之间的知识传递可以显著提升后续执行质量.
