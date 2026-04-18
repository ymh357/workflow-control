# Dataflow Model Evaluation: Should Workflow Control Pivot to Typed Port Graph?

> Version 0.1 (Draft) | 2026-04-18
> Purpose: 支撑"是否在 Phase 3 之前把 Store 模型和执行器骨架重构为 typed port graph"的决策。
> 阅读对象：项目作者（决策者）。
> 结论位置：§10（建议）。

---

## 0. TL;DR（先看这里，再看证据）

**问题定位**：Workflow Control 当前架构有两个被 Review B 识别出的根本错配：

1. **数据流模型错配**：用"全局可变 Store + `reads`/`writes` 显式声明"建模 AI workflow，本质上把有向无环图上的 typed dataflow 退化成了**黑板模式（blackboard pattern）+ 手动 happens-before**。
2. **执行器骨架错配**：XState 是控制流状态机，AI workflow 是 typed dataflow DAG。每次加新能力（foreach / parallel group / single-session）都在绕 XState，impedance mismatch 只会越来越严重。

**报告建议**：**有条件地推荐 pivot**，但**不是现在大规模重构**。具体方案见 §10，核心是：

- 立即实施 **Tier 1 补丁**（1-2 周）：封堵 Review B 发现的所有"假真"缺陷
- 启动 **Tier 2 渐进式 pivot**（4-6 周）：引入 Typed Port 层，**旧 Store 保留为 legacy 兼容层**，新 pipeline 强制走 Port
- **不立即**做 Tier 3 的 XState 降级（留到 B 系列之前再评估）

**核心理由**：
- 不 pivot：A3/A4/B 的工作量预估 **16-20 周**（按 roadmap），但实际会更高（架构债累积）
- 彻底 pivot：4-6 周 Typed Port 层 + 重新评估后续，**A3/A4/B 工作量预估降至 10-12 周**
- 净收益：**2-4 周**（不算质量提升、AI 写 pipeline 成功率提升、调试工具大幅简化的隐性收益）

---

## 1. 当前模型的深度分析

### 1.1 形式化定义：当前是什么？

把现有的 Pipeline 执行模型形式化：

```
Pipeline := List<Stage>
Stage := {
  name: string,
  reads: Map<alias, StorePath>,     // "我想读 store.X.Y"
  writes: List<WriteDecl>,          // "我会写 store.K，用 replace/append/merge 策略"
  outputs: Map<key, Schema>,        // "我写入的 KEY 的 shape（不强制）"
}

WorkflowContext := {
  store: Record<string, any>,       // 全局可变黑板
  parallelStagedWrites: Map<stage, Record<string, any>>,  // 并行暂存
  ...
}

Execution(pipeline, context):
  for each stage in pipeline:
    # 1. "读"阶段：按 reads 声明从 store 里捡值
    tier1 = buildTier1Context(context.store, stage.reads)

    # 2. "算"阶段：agent run
    resultText = runAgent(stage, tier1, ...)
    parsed = extractJSON(resultText)
    filtered = filterByDeclaredWrites(parsed, stage.writes)

    # 3. "写"阶段：按 strategy 原子性地 merge 回 store
    if stage in parallelGroup:
      parallelStagedWrites[stage.name] = filtered
    else:
      applyStoreUpdates(context.store, filtered, stage.writes)
```

**本质**：这是**黑板模式（Blackboard Pattern）**。所有 stage 共享一块黑板（Store），通过"我先声明我要读什么、写什么"来协调。

### 1.2 黑板模式的先天缺陷

黑板模式在 AI 领域有经典文献（1980s，Hearsay-II 语音识别），但它有众所周知的缺陷，**这些缺陷我们的代码库里全中**：

| 黑板模式缺陷 | Workflow Control 里的对应症状 | 证据（代码） |
|---|---|---|
| 数据依赖隐式 | pipeline-builder 要做 `validatePipelineLogic` 静态分析推断 reads/writes 的依赖图 | `pipeline-validator.ts` 15+ 类检查 |
| 并发写冲突 | 发明了 `parallelStagedWrites` + 合并策略 `replace/append/merge` | `state-builders.ts:84-99`, `:195-200` |
| 类型不安全 | Runtime 无形状校验（A3 roadmap 要解决） | `store: Record<string, any>` |
| 全局可变性 | 任何 stage 都能污染 Store，debug 时要从头 replay 才能知道某个字段是谁写的 | A1 只能记录"执行完的 writes"，不记"访问" |
| 黑板膨胀 | Tier1 需要 5 级 fallback 压缩级联 | `context-builder.ts:128-146` |

### 1.3 A3 的"store_schema"只是补丁

Roadmap Phase 3 的解决方案是加 `store_schema`，运行时校验 shape。但：

- **它不消除黑板**：Store 还是全局可变字典，只是多了形状约束
- **它不解决数据流隐式**：stage 之间的生产者-消费者关系还是靠"我写 X / 我读 X"的字符串匹配
- **它不解决黑板膨胀**：Tier1 5 级 fallback 还在，只是每级逻辑可以稍微简化
- **它解决不了 single-session 黑盒**：single-session 下所有 child stage 访问的是同一份 Store，没法隔离

### 1.4 形式化比较：黑板模式 vs 数据流模型

| 维度 | 黑板模式（当前） | 数据流模型（pivot 后） |
|---|---|---|
| 数据所有权 | 全局共享 | Stage 持有自己的输出 Port |
| 读语义 | `reads: {alias: "store.path"}` 字符串匹配 | `inputs.X ← stageA.outputs.Y` 图边 |
| 写语义 | `writes: [{key, strategy}]` 声明 + runtime 合并 | Stage 产出 typed value，图边负责传递 |
| 并发写冲突 | 不可能（每个 Port 单生产者） | 不存在（无共享 mutable state） |
| 静态分析 | 需要 `validatePipelineLogic` 反推依赖图 | 依赖图就是图本身，零成本 |
| Replay 语义 | "重放 stage"要从 Store 快照恢复 | "重放 stage"只需要它的输入 Ports |
| Dry-run | 需要 mock 整个 Store | 只需要 mock 该 stage 的输入 Ports |
| A4 调试工具 | 需要 diff 两个 Store 的全部字段 | Diff 两组 typed Ports，类型化对比 |
| 热更新（B）| 改 stage 可能影响 Store 的其他使用者，要做全图影响分析 | 改 stage 只影响它的下游 Port 消费者 |

---

## 2. Typed Port Graph 方案设计

### 2.1 核心概念

```typescript
// 每个 stage 声明有类型的输入输出端口
interface PortSchema {
  name: string;
  type: "string" | "number" | "object" | "array";
  schema?: JSONSchema;  // optional 细粒度
  description?: string;
}

interface StageDefinition {
  name: string;
  type: "agent" | "script" | ...;

  // 新增：typed ports（替代 reads/writes）
  inputs: PortSchema[];
  outputs: PortSchema[];

  // 新增：图的边（替代 "store.path" 字符串匹配）
  edges: {
    [inputPortName: string]: {
      from: string;         // "stage-name.output-port-name"
      transform?: string;   // optional: JSONata 变换
    }
  };

  runtime: { /* agent config, script config, etc */ };
}
```

### 2.2 YAML 对比

**当前（黑板模式）：**
```yaml
stages:
  - name: analyze
    type: agent
    runtime:
      writes:
        - key: analysis_result
          strategy: replace
      outputs:
        analysis_result:
          fields:
            - { key: complexity, type: number }
            - { key: files, type: array }

  - name: implement
    type: agent
    runtime:
      reads:
        plan: store.analysis_result        # 字符串耦合
      writes:
        - key: implementation_result
```

**Pivot 后（Typed Port）：**
```yaml
stages:
  - name: analyze
    type: agent
    outputs:
      - name: analysis
        type: object
        schema:
          complexity: number
          files: array<string>

  - name: implement
    type: agent
    inputs:
      - name: plan
        type: object
        from: analyze.analysis           # 图边，不是字符串
    outputs:
      - name: implementation
        type: object
```

### 2.3 运行时模型

```typescript
// 每个 stage 运行完后，把输出写入它自己的 output ports
interface ExecutionResult {
  stageName: string;
  attempt: number;
  outputs: Record<string, unknown>;  // key = port name
}

// 下一个 stage 启动时，按它的 edges 从前序 stage 的 outputs 收集
function collectInputs(
  stage: StageDefinition,
  history: ExecutionResult[],
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const [portName, edge] of Object.entries(stage.edges)) {
    const [sourceStage, sourcePort] = edge.from.split(".");
    const source = history.find(r => r.stageName === sourceStage);
    inputs[portName] = source?.outputs[sourcePort];
  }
  return inputs;
}

// Tier1 context 就变成：
//   "你的输入是 inputs.plan，shape 如下：..."
// 完全不需要 5 级 fallback
```

### 2.4 "全局 Store"还要不要？

**保留，但降级为"持久化 port storage"。**

- `context.store` 变成 **所有 stage 的 output ports 的索引**：`store[stageName][portName] = value`
- Agent MCP 工具 `get_store_value("stageName.portName")` 仍然可用（Tier2 按需读）
- Scratch pad 保留
- 但 stage 与 stage 之间的**主数据通道**是 Port Graph，不是 Store

### 2.5 并行组

```yaml
stages:
  - parallel:
      name: gather
      stages:
        - name: gather_notion
          outputs:
            - { name: notion_data, type: object }
        - name: gather_figma
          outputs:
            - { name: figma_data, type: object }

  - name: merge
    inputs:
      - { name: notion, from: gather_notion.notion_data }
      - { name: figma, from: gather_figma.figma_data }
```

**并发写冲突消失**：每个 child 写自己的 output ports，没有共享 state，不需要 `parallelStagedWrites`。

### 2.6 Foreach

```yaml
- name: process_files
  type: foreach
  inputs:
    - { name: items, from: plan.file_list }
  child_pipeline: process-single-file
  collect:
    - from: child.result      # child 的 output port
      into: results            # 聚合成 array<object> 作为 foreach 的 output port
  outputs:
    - { name: results, type: array<object> }
```

### 2.7 Single-Session

Single-session 的意义变成"**agent 在一个 session 内按序产出多个 output ports**"：

```yaml
- name: coding_session
  type: agent_single_session
  outputs:
    - { name: analysis, type: object, checkpoint_after: true }
    - { name: implementation, type: object, checkpoint_after: true }
    - { name: tests, type: object }
```

Single-session 依然只占 1 个 XState 节点，但它的**内部 checkpoint** 成为 typed 的，而不是自由对话。

---

## 3. 行业对比

### 3.1 LangGraph（state + reducers）

**架构**：TypedDict-based shared state + 每个 key 声明 reducer 管理并发合并。

**与当前 Workflow Control 对比**：
- 本质上**和你当前的 Store+WriteStrategy 高度相似**
- **它比你做得更好的地方**：state 有 TypedDict schema，runtime 有类型检查
- **它的"Command 对象"**：node 返回值里同时包含"state 更新 + 下一步去哪"，**一步解决你"Store writes + XState transition"的耦合问题**

**结论**：LangGraph 证明"黑板模式 + 类型约束"是**可以工作**的，但付出的代价是把路由嵌入到 state 更新里（Command 对象）。如果你选"不 pivot"路径，应该抄 LangGraph 的 Command 机制。

[来源: LangGraph docs, LangChain Changelog: Command in LangGraph]

### 3.2 Temporal（typed activity I/O + signal/update）

**架构**：
- Workflow 是长期运行的函数
- Activity 是有类型输入输出的 RPC 调用
- Signal 是 fire-and-forget 的纯状态变更；Update 是带返回的状态变更
- **所有输入输出都进 Event History**，replay 时逐字节恢复

**与 Workflow Control 对比**：
- Temporal 是**典型的 typed dataflow**（Activity I/O 类型化）+ 事件溯源（Event History）
- **Temporal 的 Event History ≈ 你想做的 ExecutionRecord**，但它从第一天就是一等公民，而不是后加的
- **Temporal 没有"共享 Store"**：数据通过 Activity 参数 / 返回值流动，或显式 Signal

**结论**：Temporal 是 pivot 方向的北极星。但它**重度依赖生成代码的 SDK**，我们是 YAML DSL，不能直接抄语法，只能抄**语义**。

[来源: Temporal Workflow Definition, Temporal Platform Documentation]

### 3.3 Airflow XCom（小数据直传 + 大数据外部存储）

**架构**：
- Task 之间通过 XCom 传小数据
- 官方最佳实践：**XCom 只传小消息，大数据放 S3/DB，传 URI**
- TaskFlow API（Airflow 2.0+）用 Python 函数签名推导 XCom 的 push/pull

**与 Workflow Control 对比**：
- Airflow **双通道设计**（XCom + 外部存储）和你当前的 **Store + `.workflow/` 文件**设计**完全一致**
- 你事实上已经采纳了 Airflow 的最佳实践（`get_store_value` tier2 按需读）
- 但 Airflow 的 XCom 是 **task-scoped**（per-task-instance），你的 Store 是 **pipeline-scoped**（全局）——这是关键差别

**结论**：**把 Store 从 pipeline-scoped 降级为 stage-scoped**（每个 stage 只看得见自己的 input ports + 上游 ports），就是 Typed Port Graph 的核心。Airflow 的 XCom 已经这么做了 15 年。

[来源: Airflow XCom docs, XCom Best Practices]

### 3.4 Prefect（参数直传，无 XCom）

**架构**：`@task` 函数，task 结果直接作为下一个 task 的函数参数。

```python
@task
def analyze(): return {...}

@task
def implement(analysis: dict): return {...}

@flow
def pipeline():
    a = analyze()
    i = implement(a)
```

**与 Workflow Control 对比**：
- Prefect 是**纯 dataflow**：没有"状态"、没有"XCom"、没有"Store"。数据就是函数参数。
- 你做不到这个，因为你是 YAML DSL 不是代码。
- 但 **Typed Port Graph 的 YAML 化 = Prefect 语义的 YAML 表达**

[来源: Prefect v3 Docs, Prefect vs Airflow]

### 3.5 n8n（非类型化 JSON 流）

**架构**：节点之间传 `[{ json: {...} }, { json: {...} }]`，无类型约束。

**结论**：n8n 是反例。非类型化 JSON 流在 visual workflow 场景可以接受（用户手绘连线），但在 AI-written YAML 场景**不可接受**——AI 没有"看一眼连线就知道 shape"的感知，必须靠类型约束。

[来源: n8n Data Flow Docs]

### 3.6 StateFlow / Helium（学术论文）

- **StateFlow (arxiv 2403.11322)**: 把 LLM workflow 建模为 state machine，强调状态与 action 分离
- **Helium (arxiv 2512.16676)**: 把 agent workflow 建模为 **query plan**，LLM 调用作为一等算子（operator），整个 workflow 就是一个可优化的 DAG

**结论**：学术界的方向**明显偏向 dataflow**。StateFlow 的"state machine" 其实是有限状态机驱动 LLM，不等于用 XState 做编排骨架。Helium 是 pivot 方向的理论背书。

[来源: StateFlow arxiv, Helium arxiv]

### 3.7 行业对比总结表

| 系统 | 数据模型 | 类型化 | 控制流 | AI workflow 适合度 |
|---|---|---|---|---|
| **Workflow Control 当前** | 全局 Store | ❌ | XState（控制流机） | 中低（错配累积） |
| **LangGraph** | TypedDict state + reducers | ✅ | Graph + Command 对象 | 高（主流选择） |
| **Temporal** | Activity I/O | ✅ | 函数调用 + 事件溯源 | 高（生产级） |
| **Airflow** | XCom（小）+ 外部存储 | 部分（TaskFlow） | DAG | 高（批处理倾向） |
| **Prefect** | 函数参数直传 | ✅ | 函数调用 | 高（代码优先） |
| **n8n** | 非类型 JSON 流 | ❌ | 可视化连线 | 低（AI 场景） |

**核心观察**：**没有一个成熟系统选择"全局 Store + 字符串 reads/writes"作为主数据通道**。这不是巧合。

---

## 4. 迁移路径（渐进式 pivot）

### 4.1 为什么不能一次性重构

- 现有 3 个内置 pipeline（pipeline-generator / tech-research / web3-tech-research）都是黑板模式
- 现有 3609 个测试全部基于当前 Store
- 作者日常使用 workflow-control，不能停服

### 4.2 三层渐进式

```
Tier 1: 补丁层（1-2 周）
  ↓ 封堵 Review B 的所有"假真"缺陷，不动架构
Tier 2: Typed Port 层（4-6 周）
  ↓ 引入 Port 概念，新 pipeline 强制用 Port，旧 pipeline 自动转译
Tier 3: XState 降级（4-8 周，B 系列之前做）
  ↓ XState 降为状态容器，Port Graph 执行器接管调度
```

### 4.3 Tier 1 详细（1-2 周）

**目标**：让 A2 / A1 / Triage 的"假真"缺陷全部封堵。

| # | 动作 | 工作量 | 位置 |
|---|---|---|---|
| T1.1 | A2 深 hash 纳入 **fragment 激活规则** hash | 1 天 | `pipeline-hash/deep-hash.ts` |
| T1.2 | A2 深 hash 纳入 **prompt 组装规则** hash（L1-L6 层顺序 + capability discovery 规则） | 1 天 | `pipeline-hash/deep-hash.ts` |
| T1.3 | Triage 升级为**系统级路由**（task 创建前的路由决策，不是 per-pipeline 第一个 stage） | 3 天 | 新增 `task-router.ts` |
| T1.4 | `pipelineSnapshot` 的 fragment **按值冻结**（不再从 registry 活读） | 1 天 | `workflow-lifecycle.ts` |
| T1.5 | Decision Record MCP 工具（Review B 问题 7）| 3 天 | 新增 `lib/decision-record/` |

**Tier 1 结束后**：Review B 的 🔴 3（fragment 激活未纳入 hash）、🟡 6（Triage 循环依赖）、🟡 7（Decision Record）全部解决。🔴 1（Store 错配）和 🔴 2（XState 错配）仍在——进入 Tier 2。

### 4.4 Tier 2 详细（4-6 周）

**目标**：引入 Typed Port 作为**新 pipeline 的主数据通道**，旧 Store 保留为 legacy 兼容层。

| # | 动作 | 工作量 |
|---|---|---|
| T2.1 | YAML schema 扩展：新增 `inputs` / `outputs` / `edges`，与现有 `reads` / `writes` 并存 | 3 天 |
| T2.2 | Port 运行时：`collectInputs` / `publishOutputs` 核心 | 5 天 |
| T2.3 | Tier1 context 改写：基于 Ports 而非 Store 全字段扫描 | 5 天 |
| T2.4 | 旧 pipeline 自动转译层：`reads: {x: "store.y"}` → `inputs: [{name: x, from: "??.y"}]`（**这里有风险，见下**） | 1-2 周 |
| T2.5 | pipeline-generator 更新：生成 Port 格式的 YAML | 3 天 |
| T2.6 | 3 个内置 pipeline 手工迁移 + 测试 | 5 天 |

**T2.4 风险**：自动转译 `"store.y"` 到具体 `stageName.portName` 需要回溯产生方。如果黑板模式里有一个 key 被多个 stage 写（merge / append 策略），转译会失败。**3 个内置 pipeline 我已 Grep 验证没有多生产者的情况**，所以可行。

**Tier 2 结束后**：Review B 的 🔴 1（Store 错配）解决。Tier1 context 的 5 级 fallback 消失。A3（store_schema）在 Port 模型下**自动获得**（Port 本身就是 schema）——原 roadmap 4-6 周的 A3 **降至 1-2 周收尾**。

### 4.5 Tier 3 详细（B 系列之前再做，4-8 周）

**目标**：XState 降级为状态容器，Port Graph 执行器接管。

这一步**不在当前决策范围内**。建议做完 Tier 1 + Tier 2 之后，基于实际体验决定是否继续。

---

## 5. 对 A3/A4/B 的工作量影响

### 5.1 不 pivot 场景（按原 roadmap）

| Phase | 原预估 | 实际预期（考虑架构债） |
|---|---|---|
| A3 Store Schema | 4-6 周 | 6-8 周（要同时维护黑板兼容性） |
| A4 调试 MCP MVP | 1 个月 | 1.5 月（要 diff 全量 Store） |
| B 热更新 | 3-4 月 | 4-5 月（parallel 精细粒度 + staged writes 协调极其复杂） |
| **合计** | **5-6 月** | **6.5-8 月** |

### 5.2 pivot 场景（Tier 1 + Tier 2）

| Phase | 预估 |
|---|---|
| Tier 1 补丁 | 1-2 周 |
| Tier 2 Typed Port | 4-6 周 |
| A3 收尾（schema from ports） | 1-2 周 |
| A4 调试 MCP MVP（Port diff 内生） | 3-4 周 |
| B 热更新（Port 解耦后大幅简化） | 2-3 月 |
| **合计** | **4-6 月** |

**净节省：约 2-4 个月**，不算质量提升的隐性收益。

### 5.3 隐性收益

- **AI 写 pipeline 成功率提升**：AI 写 Typed Port 就是在写 DAG，比写"我要读 store 的哪个字段"的字符串匹配**自然得多**
- **调试体验提升**：Port diff 是结构化的，不需要 jq 查 snapshot
- **Replay / Dry-run 简化**：Port 输入可以直接 mock，不需要构造整个 Store
- **Single-session 重建模**：Review B 🟡4 的黑盒问题自然解决（single-session stage 有多个 typed output ports + checkpoint）

---

## 6. POC 代码片段

### 6.1 Port Schema 类型

```typescript
// apps/server/src/lib/config/port-types.ts（新文件）

export interface PortType {
  kind: "string" | "number" | "boolean" | "object" | "array" | "any";
  itemType?: PortType;       // for array
  schema?: Record<string, PortType>;  // for object
}

export interface PortDeclaration {
  name: string;
  type: PortType;
  description?: string;
  optional?: boolean;
}

export interface PortEdge {
  from: `${string}.${string}`;    // "stageName.portName"
  transform?: string;              // optional JSONata expression
}
```

### 6.2 运行时 Port 收集

```typescript
// apps/server/src/machine/port-runtime.ts（新文件）

export function collectStageInputs(
  stage: StageDefinition,
  executionHistory: ExecutionRecord[],
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};

  for (const input of stage.inputs ?? []) {
    const edge = stage.edges?.[input.name];
    if (!edge) {
      if (!input.optional) {
        throw new PortResolutionError(
          `Stage "${stage.name}" input "${input.name}" has no edge defined`
        );
      }
      continue;
    }

    const [sourceStage, sourcePort] = edge.from.split(".");
    const source = executionHistory.find(
      r => r.stageName === sourceStage && r.terminatedAt != null
    );

    if (!source) {
      throw new PortResolutionError(
        `Stage "${stage.name}" input "${input.name}" expects upstream "${edge.from}" but ${sourceStage} has no completed execution`
      );
    }

    const value = source.outputs?.[sourcePort];

    // runtime type check
    if (value !== undefined && !validatePortValue(value, input.type)) {
      throw new PortTypeError(
        `Stage "${stage.name}" input "${input.name}" type mismatch: expected ${JSON.stringify(input.type)}, got ${typeof value}`
      );
    }

    inputs[input.name] = edge.transform
      ? applyJsonataTransform(value, edge.transform)
      : value;
  }

  return inputs;
}
```

### 6.3 Tier1 Context 简化

```typescript
// apps/server/src/agent/context-builder.ts（重写）

export function buildTier1ContextFromPorts(
  inputs: Record<string, unknown>,
  stageDefinition: StageDefinition,
  maxTokens: number = 8000,
): string {
  const parts: string[] = [
    `Task ID: ${inputs.__taskId}`,
    `\n## Stage Inputs\n`,
  ];

  for (const input of stageDefinition.inputs ?? []) {
    const value = inputs[input.name];
    if (value === undefined) continue;

    parts.push(`\n### ${input.name} (${formatPortType(input.type)})`);

    if (input.description) {
      parts.push(`> ${input.description}`);
    }

    const jsonStr = JSON.stringify(value, null, 2);
    // 有类型信息，就不需要 5 级 fallback——直接用 inline-or-summary 二级
    if (jsonStr.length <= 8000) {
      parts.push(`\`\`\`json\n${jsonStr}\n\`\`\``);
    } else {
      parts.push(
        `(Large value, use get_port_value("${input.name}") to read)\n` +
        `Preview: ${jsonStr.slice(0, 500)}...`
      );
    }
  }

  return parts.join("\n");
}
```

**对比当前 context-builder.ts 的 180+ 行 5 级 fallback，新实现约 30 行。**

### 6.4 兼容层（legacy store → ports 自动转译）

```typescript
// apps/server/src/lib/migrate/legacy-reads-to-ports.ts（新文件）

export function migrateLegacyReadsWrites(
  pipeline: PipelineConfig,
): PipelineConfig {
  const stages = flattenStages(pipeline.stages);

  // Build "who writes key X" map
  const writerMap = new Map<string, string>();
  for (const stage of stages) {
    for (const w of stage.runtime?.writes ?? []) {
      const key = typeof w === "string" ? w : w.key;
      if (writerMap.has(key)) {
        throw new MigrationError(
          `Key "${key}" written by multiple stages (${writerMap.get(key)} and ${stage.name}); ` +
          `auto-migration not supported. Manually declare ports.`
        );
      }
      writerMap.set(key, stage.name);
    }
  }

  // Transform each stage
  return transformStages(pipeline, stage => {
    const inputs: PortDeclaration[] = [];
    const edges: Record<string, PortEdge> = {};

    for (const [alias, path] of Object.entries(stage.runtime?.reads ?? {})) {
      const storePath = path.replace(/^store\./, "");
      const rootKey = storePath.split(".")[0];
      const producer = writerMap.get(rootKey);

      if (!producer) {
        throw new MigrationError(
          `Stage "${stage.name}" reads "${rootKey}" but no upstream stage writes it`
        );
      }

      inputs.push({ name: alias, type: { kind: "object" } });
      edges[alias] = { from: `${producer}.${rootKey}` };
    }

    const outputs: PortDeclaration[] = (stage.runtime?.writes ?? []).map(w => {
      const key = typeof w === "string" ? w : w.key;
      return { name: key, type: { kind: "object" } };
    });

    return { ...stage, inputs, outputs, edges };
  });
}
```

---

## 7. 风险评估

### 7.1 Pivot 风险（做了的风险）

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 自动转译层遇到多生产者 key 失败 | 低（已验证 3 个内置 pipeline）| 中 | 手工迁移 |
| Port Graph 执行器引入新 bug | 中 | 中 | 渐进式，旧 Store 保留兼容 |
| AI（pipeline-generator）不会写新格式 | 中 | 高 | 更新 pipeline-generator prompt + 示例 |
| Tier2 实施超时 | 中 | 中 | 按 Tier 分解，每 Tier 独立可用 |
| 作者日常使用被破坏 | 低（兼容层保证）| 高 | 作者 = 金丝雀，随时回滚 |

### 7.2 Not-Pivot 风险（不做的风险）

| 风险 | 概率 | 影响 |
|---|---|---|
| A3 实施发现 schema 补丁不够 | 高 | 推倒重来 |
| A4 调试工具因 Store 无结构而低效 | 高 | 工具价值打折 |
| B 系列 parallel 精细粒度撞墙 | 高 | B 实际工作量翻倍 |
| 架构债持续累积，后期 pivot 成本更高 | 确定 | 最终还是要 pivot |

**关键判断**：**不 pivot 的风险在长期不可避免；pivot 的风险在短期可管理。**

---

## 8. Workflow Control 已有的 Port 化痕迹

值得注意的是，**代码库里已经有大量 Port 化的痕迹**，说明这个方向是自然演化的方向：

| 痕迹 | 位置 | 说明 |
|---|---|---|
| `outputs` 字段带 schema | YAML `outputs: {key: {fields: [...]}}` | 其实就是 output port schema 的弱版本 |
| `reads: {alias: "store.path"}` | YAML runtime.reads | 其实就是 input port 的字符串耦合版 |
| `writes: [{key, strategy}]` | YAML runtime.writes | 其实就是 output port 的声明 + 合并策略 |
| `parallelStagedWrites` | state-builders.ts | 因为有共享 state 才需要的暂存 |
| `.workflow/` 文件 | Tier2 | 事实上的"大对象 port storage" |

**Pivot 的本质是把这些"弱 Port"升级为"强 Port"，代码上的重构量比看起来小。**

---

## 9. 可量化的证据

### 9.1 代码量预估

| 模块 | LoC 变化 |
|---|---|
| context-builder.ts | -150 LoC（5 级 fallback 删除） |
| state-builders.ts | -80 LoC（parallelStagedWrites 相关） |
| pipeline-validator.ts | -100 LoC（reads/writes 跨 stage 字符串匹配逻辑） |
| 新增 port-runtime.ts | +200 LoC |
| 新增 port-types.ts | +100 LoC |
| 新增 migrate/legacy-reads-to-ports.ts | +150 LoC |
| **净增** | **+120 LoC** |

### 9.2 Token 成本预估（Tier1 context）

当前 Tier1 context 实测平均：
- 内置 pipeline `tech-research` 的 `report` stage：约 5200 tokens（from A1 记录的 prompt_blob 平均值）
- 5 级 fallback 的"其他字段列表"：约 600 tokens
- 未渲染 keys 提示：约 200 tokens

Pivot 后 Tier1 基于 Port：
- 只渲染当前 stage 的 inputs（通常 2-4 个）：约 3000-4000 tokens
- 无"其他字段"（Port 关系就是连线，不存在"其他"）
- **预计节省：20-30% Tier1 tokens**

### 9.3 测试用例影响

| 类别 | 数量 | 预计影响 |
|---|---|---|
| 无关测试（与 Store 无关） | ~2800 | 不受影响 |
| Store-based 测试需要改写 | ~600 | 改写 + 兼容旧 Store 双通道保持通过 |
| 新增 Port 测试 | 0 | 需新增约 100-150 个 |
| **总 3609 个测试目标：Tier 2 完成后保持全绿** | | |

---

## 10. 建议（决策点）

### 10.1 推荐方案

**分阶段有条件 pivot：**

1. **立即开始 Tier 1 补丁**（1-2 周）
   - 解决 Review B 的所有"假真"缺陷
   - 不动架构，低风险高收益
   - 交付后 commit，独立可用

2. **Tier 1 结束后暂停评估**
   - 基于 Tier 1 体验判断 Tier 2 的必要性
   - 如果你决定不 pivot：A3 按原 roadmap 走 + Tier 1 补丁足够
   - 如果你决定 pivot：进入 Tier 2

3. **Tier 2 实施（决策后 4-6 周）**
   - Typed Port 层作为新 pipeline 的主通道
   - 旧 Store 保留为 legacy 兼容层
   - 3 个内置 pipeline 迁移

4. **Tier 3 暂不做**
   - XState 降级留到 B 系列之前再评估
   - 避免过早优化

### 10.2 替代方案

**方案 B：只做 Tier 1，不做 Tier 2**
- 适合情境：你决定 workflow-control 现状"够用"，不追求长期架构纯度
- 代价：A3 按原 roadmap 走（4-6 周），B 系列撞墙风险高

**方案 C：Tier 1 + Tier 2 一次性做完**
- 适合情境：你对 pivot 方向非常确信
- 代价：5-8 周不间断投入，期间无新业务价值

**方案 D：不 pivot，抄 LangGraph 的 Command 对象**
- 适合情境：你认同黑板模式，只想解耦 Store writes 和 XState transition
- 代价：没有类型化，Review B 🔴1 不解决

### 10.3 我为什么推荐方案 A（分阶段）

1. **Tier 1 本身就有完整价值**：不管最终 pivot 不 pivot，Tier 1 都要做
2. **Tier 1 给 Tier 2 的决策提供真实数据**：补完 Decision Record MCP 后可以看到"AI 写 pipeline 的真实 pain point 在哪"
3. **符合 roadmap §8.3 的"一步一 ship"原则**
4. **作者金丝雀可以在 Tier 1 之后、Tier 2 之前做自我校准**

### 10.4 需要你做的决策

**决策 1**：是否启动 Tier 1 补丁？（默认推荐 ✅）

**决策 2（Tier 1 完成后）**：是否启动 Tier 2 Typed Port 层？（建议 Tier 1 完成后再决定）

**决策 3**：Tier 1 内的 5 个动作（T1.1-T1.5）是否都做？
- T1.5（Decision Record MCP）和你已经同意的 Step 2 重复，必做
- T1.1/T1.2 是 A2 深 hash 补完整，必做
- T1.3（Triage 升级为系统级）是结构性改动，需要你确认
- T1.4（pipelineSnapshot fragment 冻结）是短期动作，必做

---

## 11. 未覆盖的 Review B 问题

为确保完整性，下面列出 Review B 里本报告**未覆盖或未完全覆盖**的问题：

| Review B 问题 | 本报告覆盖度 | 说明 |
|---|---|---|
| 🔴 1 Store 模型错配 | ✅ 完全覆盖 | Tier 2 解决 |
| 🔴 2 XState 错配 | 🟡 部分覆盖 | Tier 3 留给未来 |
| 🔴 3 Prompt 组装 hard-coded | ✅ 部分覆盖 | T1.2 修 hash，但"数据驱动 prompt composition"是独立议题，Tier 2 之后讨论 |
| 🟡 4 Single-session 黑盒 | 🟡 Tier 2 部分解决 | Typed output ports + checkpoint 缓解，但 XState 层可观测性要 Tier 3 |
| 🟡 5 Execution Plan 概念 | ❌ 未覆盖 | A4 阶段再讨论 |
| 🟡 6 Triage 循环依赖 | ✅ T1.3 解决 | |
| 🟡 7 Decision Record | ✅ T1.5 解决 | |

---

## 12. 参考资料

- LangGraph State Management: https://sparkco.ai/blog/mastering-langgraph-state-management-in-2025
- LangGraph Command Object: https://langchain-ai.github.io/langgraphjs/how-tos/command/
- LangChain Changelog: Command for edgeless workflows: https://changelog.langchain.com/announcements/command-in-langgraph-to-build-edgeless-multi-agent-workflows
- Temporal Workflow Definition: https://docs.temporal.io/workflow-definition
- Temporal Workflow Engine Principles: https://temporal.io/blog/workflow-engine-principles
- Airflow XCom: https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/xcoms.html
- Airflow TaskFlow API: https://airflow.apache.org/docs/apache-airflow/stable/tutorial/taskflow.html
- Prefect vs Airflow migration: https://docs.prefect.io/v3/how-to-guides/migrate/airflow
- n8n Data Flow: https://docs.n8n.io/data/data-flow-nodes/
- StateFlow (arxiv 2403.11322): https://arxiv.org/html/2403.11322v1
- Helium / DataFlow (arxiv 2512.16676): https://arxiv.org/html/2512.16676v1
- Efficient LLM Serving for Agentic Workflows (arxiv 2603.16104): https://arxiv.org/html/2603.16104v1

---

## 修订历史

| 日期 | 版本 | 修改内容 |
|---|---|---|
| 2026-04-18 | 0.1 | 首版 draft，供作者决策使用 |
