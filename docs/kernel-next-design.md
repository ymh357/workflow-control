# Kernel-Next Design

> Version 0.1 (Spike Draft) | 2026-04-19
>
> 本文是 workflow-control 架构突破方案的 design doc。起因是一次系统级
> 架构评审，识别出当前系统在"YAML-as-authority"、"扁平 Store"、
> "single-session parallel 语义泄漏"、"kernel/userland 未分离" 四处存
> 在根基级缺陷。四项合并为一次 greenfield 重构，落地在新目录
> `apps/server/src/kernel-next/`。
>
> 本文读者假设已读 `docs/architecture-whitepaper-zh.md` 和
> `docs/product-roadmap.md`。本文不重复背景，只写决策 + 设计 + spike 计划。

---

## 1. Scope

Spike 目标：在新目录 `apps/server/src/kernel-next/` 下，用 1500–2500 行
新代码，端到端证明四个能力：

1. **mini pipeline-generator**：AI (mock) 产出一份合法 IR JSON。
2. **Kernel submit + 校验 + codegen**：kernel 接收 IR，校验通过后写
   SQLite、codegen `.ts` 文件、调用 tsc 校验。
3. **Kernel 运行时**：IR 编译到 XState machine；typed port 运行时校验；
   lineage 自动记录。
4. **AI 改 IR 闭环**：mock agent 通过 `propose_pipeline_change` MCP 工具
   对现有 IR 打 patch，patch 通过 kernel 校验后生效。

验收载荷：合成的 **3–4 stage diamond pipeline**（A → {B, C 并行} → D），
不复用现有 tech-research / smoke-test，不依赖真 Claude SDK。

Spike 不做：真 SDK 集成、hot-update auto-apply、multi-tenant、registry
共享、UI、真 foreach / condition / human-confirm 的完整实现（diamond
够用就行）。

---

## 2. 决策清单（上游对话记录）

> 以下决策来自 2026-04-19 架构对话，本 session 范围内视为 frozen。
> 若实施中需要推翻，必须在本节补充 ADR 条目。

### 2.1 战略层
| 维度 | 决策 |
|---|---|
| 产品终局 | AI-编排基础设施（从"个人工具"升级） |
| 突破切入点 | Kernel/Userland 分离 + IR 权威 + Store 数据图（三合一） |

### 2.2 Kernel 边界
| 维度 | 决策 |
|---|---|
| Kernel 范围 | 中等（XState + store + validator + prompt-builder 骨架 + session 管理 + MCP 注册） |
| API 形式 | 混合：声明式 DSL 表结构 + MCP RPC 给自反操作 |
| 自反策略 | AI 可 propose，100% 进 confirm queue，无 auto-apply |

### 2.3 数据模型
| 维度 | 决策 |
|---|---|
| Pipeline 权威表示 | SQLite IR |
| 辅表示 | TypeScript 源码 + tsc 校验；`.ts` 入 git |
| DSL 形态 | **Typed Port + Wires**（stage 声明 input/output port，pipeline 层声明连线） |
| Store | 数据图（port value 作为节点，wire 作为边，lineage 自动记录） |
| 类型系统 | TypeScript + tsc |

### 2.4 运行时
| 维度 | 决策 |
|---|---|
| 状态机 | 继续用 XState（IR 编译到 machine） |
| Session 模型 | multi-session 默认；single-session 降级为 second-class（sequential only，无 parallel group） |

### 2.5 Kernel MCP 工具集（spike 必须覆盖）
- `submit_pipeline(irJson)` / `validate_pipeline(irJson)`
- `read_port(stage, port, attempt?)`
- `query_lineage(port)` / `diff_runs(taskA, taskB)`
- `propose_pipeline_change(currentVersion, patch)`

### 2.6 pipeline-generator 产出方式
一次性提交完整 IR JSON，kernel 整体校验；失败返回 structured diagnostic；
AI 基于诊断重提。不使用"逐步 tool call 增量构建"模式。

### 2.7 迁移
- Greenfield：不保 BC，旧 pipeline / 旧 kernel 归档。
- 旧 roadmap A/B 全线冻结，旧 kernel 只维持现有任务不动，不再加新特性。

### 2.8 Spike 执行参数
| 维度 | 决策 |
|---|---|
| 位置 | `apps/server/src/kernel-next/`（平行于现有模块，不 import 旧代码） |
| Agent 层 | **Mock agent**，不接真 SDK |
| 验收任务 | 合成 diamond: A → {B, C 并行} → D |
| 规模预算 | 1500–2500 行 TypeScript，2–3 周 |

---

## 3. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                        Userland                               │
│                                                               │
│  Pipeline-generator (mock agent)                              │
│     │                                                         │
│     │  submit_pipeline(irJson)                                │
│     │  propose_pipeline_change(currentVer, patch)             │
│     ▼                                                         │
├──────────────────────────────────────────────────────────────┤
│                     Kernel MCP Surface                        │
│                                                               │
│   submit_pipeline  validate_pipeline                          │
│   propose_pipeline_change                                     │
│   read_port  query_lineage  diff_runs                         │
├──────────────────────────────────────────────────────────────┤
│                        Kernel Core                            │
│  ┌────────────┐  ┌────────────┐  ┌──────────────┐            │
│  │ IR Store   │  │ Validator  │  │ Codegen      │            │
│  │ (SQLite)   │  │ (Zod + TS) │  │ (.ts files)  │            │
│  └─────┬──────┘  └─────┬──────┘  └──────┬───────┘            │
│        │               │                │                     │
│        ▼               ▼                ▼                     │
│  ┌──────────────────────────────────────────────┐             │
│  │  Compiler: IR → XState machine definition    │             │
│  └────────────────────┬─────────────────────────┘             │
│                       ▼                                       │
│  ┌──────────────────────────────────────────────┐             │
│  │  Runtime: XState interpreter + port runtime  │             │
│  │           + lineage recorder                 │             │
│  └────────────────────┬─────────────────────────┘             │
│                       ▼                                       │
│  ┌──────────────────────────────────────────────┐             │
│  │  Stage executor (mock agent for spike)       │             │
│  └──────────────────────────────────────────────┘             │
└──────────────────────────────────────────────────────────────┘
```

关键不变式：
- Userland 只能通过 MCP surface 影响 Kernel。
- Kernel 内部子系统之间有单向数据流（IR → Compiler → Runtime → Executor）。
- 反向只允许通过 Runtime 写 lineage 回 IR Store。

---

## 4. IR Schema（SQLite）

### 4.1 表定义

```sql
-- 一个 pipeline 的某个 immutable 版本。
CREATE TABLE pipeline_versions (
  version_hash   TEXT PRIMARY KEY,        -- SHA256 of canonical JSON
  pipeline_name  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  parent_hash    TEXT REFERENCES pipeline_versions(version_hash),
  ir_json        TEXT NOT NULL,           -- full IR for cheap reconstruction
  ts_source      TEXT NOT NULL            -- codegen artifact (entry .ts content)
);

-- Stage 定义（属于某个 pipeline version）。
CREATE TABLE stages (
  version_hash   TEXT NOT NULL REFERENCES pipeline_versions(version_hash),
  stage_name     TEXT NOT NULL,
  stage_type     TEXT NOT NULL,           -- 'agent' | 'script' | 'human_confirm' | ...
  config_json    TEXT NOT NULL,           -- prompt ref, budget, engine, etc.
  PRIMARY KEY (version_hash, stage_name)
);

-- Stage 的 input/output port（typed）。
CREATE TABLE ports (
  version_hash   TEXT NOT NULL,
  stage_name     TEXT NOT NULL,
  port_name      TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('in','out')),
  type_signature TEXT NOT NULL,           -- TS type source, e.g. "string[]"
  zod_schema     TEXT,                    -- optional zod expression for runtime validate
  PRIMARY KEY (version_hash, stage_name, port_name, direction),
  FOREIGN KEY (version_hash, stage_name)
    REFERENCES stages(version_hash, stage_name)
);

-- Wire: 连线一条上游 output → 下游 input。
-- 注意: port direction 的匹配 (from=out, to=in) 由应用层 validator 强制，
-- 不在 SQLite FK 层表达。SQLite FK 不允许字面量列（如 'out'），且 validator
-- 本来就要做这件事，FK 冗余。
CREATE TABLE wires (
  version_hash    TEXT NOT NULL,
  from_stage      TEXT NOT NULL,
  from_port       TEXT NOT NULL,
  to_stage        TEXT NOT NULL,
  to_port         TEXT NOT NULL,
  PRIMARY KEY (version_hash, to_stage, to_port)  -- 一个 input 只能被一条 wire 驱动
);

-- 运行时 attempt（每次 stage 执行）。
CREATE TABLE stage_attempts (
  attempt_id     TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  version_hash   TEXT NOT NULL,
  stage_name     TEXT NOT NULL,
  attempt_idx    INTEGER NOT NULL,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  status         TEXT NOT NULL            -- 'running'|'success'|'error'|'superseded'
);
CREATE INDEX idx_sa_task_stage ON stage_attempts(task_id, stage_name, attempt_idx DESC);
CREATE INDEX idx_sa_version_stage ON stage_attempts(version_hash, stage_name);

-- 端口写值（lineage 的核心）。
CREATE TABLE port_values (
  value_id       TEXT PRIMARY KEY,        -- uuid
  attempt_id     TEXT NOT NULL REFERENCES stage_attempts(attempt_id),
  stage_name     TEXT NOT NULL,
  port_name      TEXT NOT NULL,
  direction      TEXT NOT NULL,           -- 'out' = produced by, 'in' = read by
  value_json     TEXT NOT NULL,
  written_at     INTEGER NOT NULL
);
CREATE INDEX idx_pv_port     ON port_values(stage_name, port_name, direction, written_at DESC);
CREATE INDEX idx_pv_attempt  ON port_values(attempt_id);

-- AI 改 IR 的 propose 记录（B 系列 audit trail 雏形）。
CREATE TABLE pipeline_proposals (
  proposal_id      TEXT PRIMARY KEY,
  base_version     TEXT NOT NULL REFERENCES pipeline_versions(version_hash),
  proposed_version TEXT REFERENCES pipeline_versions(version_hash),  -- null if rejected
  actor            TEXT NOT NULL,          -- 'ai:pipeline-generator' | 'human:alice' | ...
  status           TEXT NOT NULL,          -- 'pending' | 'approved' | 'rejected'
  diagnostic_json  TEXT,                   -- if rejected, reason
  created_at       INTEGER NOT NULL
);
```

**Versioning 策略**：每个 version 是**完整 snapshot**（stages / ports / wires
全套在新 version_hash 下重写），**不存 delta**。对 15 stage × 3 port × 20 wire
的 pipeline，单次 propose ≈ 150 行 insert，SQLite 单事务内完全可接受。
Phase 2 若遇存储压力再考虑 delta / GC，spike 期不考虑。

### 4.2 IR JSON 形态

`submit_pipeline` / `propose_pipeline_change` 的 payload 形态（spike
需要的最小字段集）：

```typescript
interface PipelineIR {
  name: string;
  stages: StageIR[];
  wires: WireIR[];
  entry?: string;           // 入口 stage name（可省，kernel 推断为入度 0 的 stage）
}

interface StageIR {
  name: string;
  type: 'agent' | 'script';  // spike 只做两种
  inputs:  PortIR[];
  outputs: PortIR[];
  config: {
    engine?: 'claude';       // mock，用于表达结构
    prompt?: string;         // mock agent 看这个字符串决定 output
    script?: string;         // script stage 的 TS 源码引用（spike 不必真跑）
  };
}

interface PortIR {
  name: string;
  type: string;              // TypeScript type 源码，如 "string[]" | "{ foo: number }"
  zod?: string;              // 可选 zod 表达，用于运行时校验
}

interface WireIR {
  from: { stage: string; port: string };
  to:   { stage: string; port: string };
}
```

**约束**（validator 强制）：

1. `name` 全局唯一。
2. `stages[].name` 在 pipeline 内唯一。
3. `inputs[].name` / `outputs[].name` 在 stage 内唯一。
4. 每条 wire 的 `from.stage.from.port` 必须是已声明的 output；
   `to.stage.to.port` 必须是已声明的 input。
5. **每个 input 最多被一条 wire 驱动**（SQLite PK 保证）。
6. **Wire 类型兼容**：`from` port 的 TS type 必须是 `to` port 的子类型，
   由 codegen 后 tsc 强制（见 §5.3）。
7. **无环**：wire 构成的 DAG 不能有环，用拓扑排序检测。

---

## 5. Typed Port 类型系统

### 5.1 类型表达

Port 的 `type` 是 TypeScript 源码片段。合法例子：

```
"string"
"number[]"
"{ topic: string; questions: string[] }"
"Array<{ candidate: string; score: number }>"
```

不允许 `any`、`unknown`、函数类型、`Promise<T>`。

### 5.2 codegen

Kernel 为每个 pipeline version 生成 `.ts` 文件到
`{data_dir}/pipelines/{version_hash}/pipeline.ts`：

```typescript
// Generated from IR version <hash>.
// DO NOT EDIT BY HAND.

export namespace PipelineIR {
  export namespace Stages {
    export namespace scope {
      export interface Outputs { topic: string; questions: string[]; }
    }
    export namespace survey {
      export interface Inputs  { topic: string; questions: string[]; }
      export interface Outputs { landscape: string; candidates: Candidate[]; }
    }
    // ... more stages
  }

  // Wire assertions: 每条 wire 产出一个 dummy assignment，直接让 tsc 对
  // concrete type 做赋值检查。类型不兼容时 tsc 报 TS2322，消息自带
  // 具体 from/to type，且错误行号精确指向该 wire 对应的断言。
  //
  // 变量命名规则: __wire__<fromStage>_<fromPort>__TO__<toStage>_<toPort>
  // 错误解析时用变量名反查 wire id。
  export const __wire__scope_topic__TO__survey_topic:
    Stages.survey.Inputs['topic'] =
      null as unknown as Stages.scope.Outputs['topic'];

  export const __wire__scope_questions__TO__survey_questions:
    Stages.survey.Inputs['questions'] =
      null as unknown as Stages.scope.Outputs['questions'];

  // ...
}
```

**为什么不用 `extends ... ? true : never`**：该写法只产生 `never` 类型，
不触发 tsc error（never 是合法类型）。dummy assignment 会触发 TS2322，
这是 tsc 的一等错误。

### 5.3 tsc 校验

Kernel 在 `submit_pipeline` 时：

1. 写 `pipeline.ts` 到临时目录。
2. 派生一个包含 stub 库类型的最小 `tsconfig.json`（`strict: true`）。
3. `tsc --noEmit --pretty false` 跑（subprocess）。
4. 解析 tsc stdout，筛选 `TS2322` (Type not assignable) 错误。
5. 对每条错误，从"错误所在行"定位源码中的 `__wire__*` 标识符，用变量
   命名规则（见 §5.2 注释）反查 wire 的 `from` / `to` stage+port，拼成
   structured diagnostic 返回给 AI：

```json
{
  "ok": false,
  "diagnostics": [
    {
      "code": "WIRE_TYPE_MISMATCH",
      "wire": { "from": "scope.topic", "to": "survey.topic" },
      "fromType": "number",
      "toType": "string",
      "tsMessage": "Type 'number' is not assignable to type 'string'."
    }
  ]
}
```

**Spike 实施说明**：tsc 通过 subprocess 调用，典型 3-5 秒/次。mock agent
不受影响，但接真 AI 后会被 feedback loop 放大——phase 2 切换到 ts-morph
in-process `Program`（`updateSourceFile + getSemanticDiagnostics`，典型
200-500 ms），是 commitment 不是 open question。

### 5.4 运行时校验

每次 stage 结束写 output port 时，kernel 用可选 `zod` 表达式做 shape
校验（如果 port 声明了 `zod`）。纯 TS type 的 port 不做运行时 shape 校验
（相信上游写的是声明的类型）。

---

## 6. Runtime

### 6.1 IR → XState machine 编译

对每个 IR，kernel 产出如下 XState machine 定义（伪码）：

```typescript
const machine = createMachine({
  id: `wf_${taskId}`,
  initial: 'idle',
  context: {
    taskId,
    versionHash,
    portValues: new Map<string, any>(),   // "stage.port" -> value
    lineageLog: [],
  },
  states: {
    idle: { on: { START: 'running' } },
    running: {
      type: 'parallel',
      states: {
        // 每个 stage 一个 region
        // transition 由 wire DAG 的拓扑序决定：当所有 inbound wire 的 source
        // port 都被写入，stage 才进入 ready
        [stageName]: {
          initial: 'waiting',
          states: {
            waiting: {
              on: {
                PORT_WRITTEN: [{ target: 'ready', guard: 'allInputsReady' }],
              },
              // 入口 stage (入度 0) 进入时立即就绪
              always: [{ target: 'ready', guard: 'allInputsReady' }],
            },
            ready:    { invoke: { src: 'stageExecutor', onDone: 'done', onError: 'error' } },
            done:     { type: 'final' },
            error:    {},
          }
        },
        // ...
      },
      onDone: { target: 'completed' },
    },
    completed: { type: 'final' },
  }
});
```

并行通过 XState `type: 'parallel'` + event-driven guard re-eval 实现。
每个 stage 是独立 XState region，每个 stage 触发时启动独立 SDK session
（multi-session 默认）。没有"single-session parallel group"这种特殊构造。

**Event choreography（关键）**：

- 每当 port-runtime 写入某个 stage 的 output port，**派发 `PORT_WRITTEN
  { stage, port, value }` 事件到 machine root**。
- 所有 `waiting` 子状态订阅 `PORT_WRITTEN`，被触发时重新评估
  `allInputsReady` guard。只有当此 stage 所有 inbound wire 的 source port
  都已写入时，guard 返回 true，stage 迁移到 `ready` 继续 invoke。
- `always` transition **只在 state 进入时触发一次**，不是持续轮询，所以
  不能独用。`on: { PORT_WRITTEN }` 是真正的等待机制。
- 入口 stage (入度 0)：`allInputsReady` 在 waiting 入场时返回 true，
  `always` 立即推进到 `ready`。

这个机制的可行性是 M0 的硬前置验证（见 §10）。若 XState v5 的 parallel
region 无法稳定接收 external event 触发 guard re-eval，回退到 actor-based
方案（每 stage 一个 `spawn` child actor，父 actor 用 `sendTo` 通知 input
就绪），预计重构 compiler/ir-to-machine.ts + runner.ts 共 2-3 天。

### 6.2 Stage executor（mock）

```typescript
async function mockStageExecutor(args: {
  stageName: string;
  inputs: Record<string, any>;
  stageConfig: StageIR['config'];
}): Promise<{ outputs: Record<string, any> }> {
  // 读 prompt 字符串，hardcode 几个 case 决定 output
  // 例: if prompt === 'echo-topic' then output.topic = inputs.topic
  //     if prompt === 'split' then output.a = inputs.x / 2; output.b = inputs.x / 2
}
```

Mock executor 同时负责：
- 每次 stage 启动时写 `stage_attempts` 一条记录
- 读 input port 前写 `port_values { direction: 'in' }`
- 写 output port 时写 `port_values { direction: 'out' }`
- 完成时更新 `stage_attempts.status`

lineage 自此自动累积。

### 6.3 Lineage 查询

```typescript
// MCP: query_lineage(port: "survey.candidates")
// 返回: 此 port 最近的写入 + 所有读它的 stage

query_lineage({ stage: 'survey', port: 'candidates' })
// →
{
  port: { stage: 'survey', port: 'candidates' },
  latestWrite: {
    attemptId: 'a3',
    taskId: 't1',
    writtenAt: 1713500000000,
    valuePreview: '[{name: "libX", ...}, ...]'
  },
  downstream: [
    { stage: 'deepdive', port: 'candidates', readInAttempt: 'a7' }
  ]
}
```

### 6.4 diff_runs

```typescript
// MCP: diff_runs(taskA, taskB)
// 比对两个 task 的 port value 和 stage 执行序列

diff_runs({ taskA: 't1', taskB: 't2' })
// →
{
  versionHashA: '...', versionHashB: '...',
  stageComparison: [
    { stage: 'scope', inputsEqual: true, outputsEqual: false, diff: {...} },
    // ...
  ]
}
```

---

## 7. MCP Surface（详细签名）

```typescript
// Kernel MCP server, spike 阶段所有 tool。

interface KernelMcp {
  // --- pipeline lifecycle ---
  submit_pipeline(args: { ir: PipelineIR }):
    Promise<{ ok: true; versionHash: string } | { ok: false; diagnostics: Diagnostic[] }>;

  validate_pipeline(args: { ir: PipelineIR }):
    Promise<{ ok: true } | { ok: false; diagnostics: Diagnostic[] }>;

  propose_pipeline_change(args: {
    currentVersion: string;
    patch: IRPatch;                       // JSON patch over IR
  }): Promise<{
    ok: true;
    proposalId: string;
    proposedVersion: string;
    autoApplied: false;                   // spike 永远 false
  } | { ok: false; diagnostics: Diagnostic[] }>;

  // --- runtime read ---
  read_port(args: {
    taskId: string;
    stage: string;
    port: string;
    attempt?: number;                     // default: latest
    maxBytes?: number;                    // default 65536；超限返回 truncated
  }): Promise<
    | { value: any; writtenAt: number; attemptId: string; truncated: false }
    | { value: null; preview: string; totalBytes: number; valueId: string;
        writtenAt: number; attemptId: string; truncated: true }
  >;

  // --- debug ---
  query_lineage(args: { stage: string; port: string; taskId?: string }):
    Promise<LineageReport>;                // valuePreview 已截断，与 read_port 策略对齐

  diff_runs(args: { taskA: string; taskB: string }):
    Promise<DiffReport>;
}

interface IRPatch {
  // JSON-patch-ish 操作序列
  ops: Array<
    | { op: 'add_stage'; stage: StageIR }
    | { op: 'remove_stage'; stageName: string }
    | { op: 'add_wire'; wire: WireIR }
    | { op: 'remove_wire'; wire: WireIR }
    | { op: 'update_port_type'; stage: string; port: string; newType: string }
    | { op: 'update_stage_config'; stage: string; configPatch: Partial<StageIR['config']> }
  >;
}
```

**IRPatch 语义边界（强制）**：

1. **`remove_stage` 级联删 wires**：删 stage 时，所有以该 stage 为 from
   或 to 的 wire 自动删除。AI 不需要先手工清 wire。
2. **整个 `ops` 数组作为单事务**：全部 op 按顺序应用到 IR 副本后**一次
   性** validate（structural + DAG + codegen + tsc）。中间态不 validate，
   因此 `[add_stage, add_wire]` 这种 batch 合法；单独一个 `add_stage`
   不带 wire 也合法（stage 暂时悬空，等下次 patch 连线）。
3. **`update_port_type` 级联失败通过 wire-level diagnostic 报回**：改
   port type 若让下游 wire 类型不兼容，tsc 报 TS2322 → §5.3 的 diagnostic
   解析器把具体冲突 wire 列出来给 AI。AI 决定是要改 port type 还是连带
   改下游 port。

---

## 8. 验收任务：Diamond pipeline

### 8.1 结构

```
              ┌─────┐
              │  A  │   writes: x: number
              └──┬──┘
                 │
          ┌──────┴──────┐
          ▼             ▼
       ┌─────┐       ┌─────┐
       │  B  │       │  C  │   B: reads x, writes bResult: string
       └──┬──┘       └──┬──┘   C: reads x, writes cResult: string
          │             │
          └──────┬──────┘
                 ▼
              ┌─────┐
              │  D  │   reads bResult + cResult, writes final: string
              └─────┘
```

4 个 stage，5 条 wire。B 和 C 并行。D 需要 B 和 C 都完成才能进入。

### 8.2 Spike 完成的定义

1. **Pipeline 提交**：mock pipeline-generator 产出此 IR JSON，调
   `submit_pipeline`，kernel 返回 `ok: true` + versionHash。
2. **tsc 校验**：codegen `.ts` 文件存在、`tsc --noEmit` 退出 0。
3. **运行**：启动 task，A 先跑，B/C 并行（通过 XState parallel 节点观测
   两者 active 时段重叠），D 最后跑。
4. **Lineage 可查**：`query_lineage({ stage: 'A', port: 'x' })` 返回
   B 和 C 作为 downstream reader。
5. **AI 修改**：mock agent 调 `propose_pipeline_change` 给 B 加一个新
   output port（更新 B 的 TS type + 加 wire），kernel validate 通过，
   写入 pipeline_proposals，status: pending。
6. **拒绝测试**：提交一个 wire 类型不兼容的 patch，kernel 返回 reject
   + diagnostic 能精确指出冲突 wire。
7. **Retry / multi-attempt**：mock executor 在第一次调用 B 时抛 error。
   `stage_attempts` 写入一条 `status='error'` 记录，port_values 无 B 的
   out 记录。手动发送 `RETRY { stage: 'B' }` event，B 第二次成功，
   port_values 出现 `attempt_idx=2` 的 out 记录；`query_lineage` 默认只
   返回 latest attempt 的 out，但 `read_port({ attempt: 1 })` 能拿到
   第一次失败前的状态（空）。**此条 exercise `attempt_idx` 列，否则该
   列在 spike 里是死设计。**

**Scope limitation（显式声明）**：

- Spike 不验证 agent 的 output schema 遵从性——mock executor hardcode
  output，跳过了"Claude 不完全遵守 JSON schema"这一现实中最常见的失败
  模式。phase 2 第一件事是用真 SDK + schema-deviation stress test 验证。
- Spike 不覆盖：foreach、condition、human_confirm、嵌套 parallel、
  跨 version retry、自定义 compensation。diamond 通过不等于 tech-research
  级 pipeline 能过。

---

## 9. 目录结构

```
apps/server/src/kernel-next/
├── README.md                      # 指向本文
├── ir/
│   ├── schema.ts                  # Zod schemas for IR
│   ├── sql.ts                     # DDL + queries
│   └── canonical.ts               # canonical JSON + SHA256 hash
├── validator/
│   ├── structural.ts              # 结构约束（唯一性、wire 指向存在）
│   ├── dag.ts                     # 环检测 + 拓扑
│   └── types.ts                   # codegen + tsc 编排
├── codegen/
│   ├── emit-ts.ts                 # IR → pipeline.ts 字符串
│   └── tsconfig-template.ts       # 临时 tsconfig 模板
├── compiler/
│   └── ir-to-machine.ts           # IR → XState machine def
├── runtime/
│   ├── runner.ts                  # XState interpreter 封装
│   ├── port-runtime.ts            # port read/write + lineage 记录
│   └── mock-executor.ts           # mock stage executor
├── mcp/
│   ├── server.ts                  # sdk-MCP server
│   └── tools/
│       ├── submit-pipeline.ts
│       ├── validate-pipeline.ts
│       ├── propose-change.ts
│       ├── read-port.ts
│       ├── query-lineage.ts
│       └── diff-runs.ts
├── generator-mock/
│   └── mini-generator.ts          # "AI" 的 mock：硬编码产出 diamond IR
├── demo/
│   ├── diamond.ts                 # spike 的 end-to-end 脚本
│   └── diamond.test.ts            # 验收测试
└── index.ts                       # export 给外部（仅测试用）
```

规模预估（粗略）：
- ir/ ~200 行
- validator/ ~300 行
- codegen/ ~200 行
- compiler/ ~250 行
- runtime/ ~300 行
- mcp/ ~400 行
- generator-mock/ ~100 行
- demo/ ~200 行
- **合计 ~2000 行**，落在 1500–2500 区间。

---

## 10. 实施 Milestones

### M0: XState parallel 可行性 spike (day 0, 0.5–1 天) — **硬前置**

只做一件事：裸 XState v5，写一个 3-region parallel machine（A/B/C），
其中 B/C 的 waiting 子状态通过 external `PORT_WRITTEN` event + guard
迁移到 ready。**不接 IR、不接 codegen、不接 kernel**，纯验证 §6.1
event choreography 的可行性。

- **pass**：B/C 能正确等 A 的 event，guard 正确 re-eval，进入 M1。
- **fail**：立即 fork 到 actor-based 方案（spawn child actor + sendTo），
  回来修改 §6.1 后再进 M1。

这条 M0 是 OQ #3 的硬前置，必须先过。否则 M3 中段卡死的风险太大。

### M1: IR 存储 + 校验 (week 1, day 1–3)
- schema.ts / sql.ts / canonical.ts
- validator/structural.ts + validator/dag.ts
- 索引 DDL（见 §4.1）一起落
- 单测：IR JSON 被拒绝的 10+ 种情况

### M2: Codegen + tsc (week 1, day 4–6)

压缩到 3 天（原 4 天）。tsc 子进程 + TS2322 解析是相对成熟技术栈。

- codegen/emit-ts.ts（含 `__wire__*` dummy assignment 生成）
- validator/types.ts（tsc subprocess + 错误行号反查 wire 名）
- 单测：type mismatch（TS2322 精确定位 wire）、unknown type、valid case

### M3: Compiler + Runtime (week 2, day 1–6)

扩到 6 天（原 4 天）。这是 spike 最复杂的一环，首次实现 XState parallel +
event-driven guard re-eval + port-runtime + lineage，需要调试预算。

- compiler/ir-to-machine.ts
- runtime/runner.ts + port-runtime.ts + mock-executor.ts
- PORT_WRITTEN event 派发（由 port-runtime 触发到 machine）
- lineage 记录（port_values insert + attempt_idx 正确递增）
- 单测：diamond pipeline 跑通、retry 场景 attempt_idx 正确

### M4: MCP Surface (week 2 day 7 – week 3 day 2, 3 天)
- mcp/server.ts + 6 个 tool（6 个都是 M1-M3 的薄 wrapper）
- generator-mock/mini-generator.ts
- 集成测试：用 MCP client 调 submit / propose / query_lineage / read_port

### M5: End-to-end 验收 (week 3, day 3–4)
- demo/diamond.ts + diamond.test.ts
- §8.2 七条全过（含 retry）
- 手动 review + 对 §11 的 open questions 做一轮决策

总工期 ~2.5 周 + M0 半天前置，仍在原预算（2-3 周）内。

### M6: Post-spike（本 doc 外）
- 如果验收过：开第二个 session 讨论 phase 2（真 SDK 集成、registry 接入、旧 kernel 下线）
- 如果验收不过：写 post-mortem，按 §12.1 的 rollback 三路径决定出口

---

## 11. Open questions（spike 中决定，本文暂留）

1. **SQLite connection 怎么管理**：kernel-next 独立 DB 还是复用
   `apps/server/.../workflow.db`？spike 期独立 DB，路径
   `{data_dir}/kernel-next.db`。Post-spike 再决定合并还是保留。

2. **tsc 调用性能**：每次 submit 都起 tsc 子进程，diamond 这种小
   pipeline 可能 3-5 秒。Post-spike 考虑 `ts-morph` 或 in-process TS
   program。

3. **XState parallel 的 guard-based wait 的实际行为**：需要 spike 验证
   "input port 未就绪时 stage state 停在 waiting" 的语义是否真能靠
   `always + guard` 实现，如果不行就改 actor-based。

4. **Port value 存储体积**：port_values 表无 retention，spike 阶段不处
   理。Post-spike 决定。

5. **IR patch 操作集足够吗**：spike 只用 add_stage / remove_stage /
   add_wire / update_port_type 几个，真 hot-update 可能需要更多（如
   rename_stage、复制子图）。Post-spike 补。

---

## 12. 对现状的影响

- 旧 roadmap §6–§7（A 系列、B 系列）全部冻结，不再做新任务。已完成
  部分（execution record、store_schema、builtin-pipelines 目录扫描等）
  继续留在旧 kernel 供当前任务使用。
- `docs/product-roadmap.md` 顶部加 superseded 标记，指向本文。
- 冷冻模块（Edge / Gemini / Codex）不变。
- `docs/builtin-pipelines-design.md` 里"tech-research store_schema 反推"
  的待办永久搁置（新 kernel 不再用 store_schema 声明，用 typed port）。

### 12.1 Spike 失败的 Rollback 路径（预先商定）

M5 验收不通过时，M6 post-mortem 从下列三条出口选一条，不临时扯皮：

1. **(a) 机制可行，局部环节需重做**——某单点（tsc 性能 / XState 选型 /
   MCP 签名等）需迭代，但架构方向不变。在 kernel-next/ 目录内部 iterate；
   旧 kernel 保持冻结。开新 session 定位问题 + 修复计划。

2. **(b) 根本路线错误**——Typed port TS 类型系统表达力不够、IR 权威
   模型不 work 等架构级失败。`kernel-next/` 整个目录移到
   `apps/server/src/_archived/kernel-next-v1/`，重写 design doc。旧
   kernel 解冻 1 个周期吸收核心需求（例如 store provenance）。

3. **(c) 时间严重超预算**——架构可行但 §8.2 的 7 条里只通过 3-4 条。
   砍 §8.2 至 submit + run + lineage 三条核心，propose_pipeline_change /
   diff_runs / retry 推迟到 phase 2。spike 的结论降级为 "architecture
   is viable at core, full MCP surface needs phase 2"。

---

## 13. 成功后的 phase 2 轮廓（仅占位，不作为 spike 约束）

- 真 Claude SDK 接入，替换 mock executor
- propose_pipeline_change 接 confirm UI（复用旧 human_confirm SSE 机制）
- Pipeline-generator 真实版本：LLM 产出 IR JSON → kernel 校验 → commit
- 旧 kernel 的 in-flight task drain + 归档
- Multi-session 的优化（prompt cache / fragment 注入 / prompt 六层体系
  移植到 kernel-next）
- single-session sequential 作为 second-class 模式实现

所有这些都依赖 spike 先证明架构可行。spike 完成前不做。
