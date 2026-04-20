# kernel-next SSE 观察层 — 切片计划

> Created: 2026-04-20
> Author: Opus 4.7 (与产品 owner 协作)
> Status: **plan-only**
> Parent: `docs/kernel-next-terminal-design.md`
> Predecessors: `2026-04-20-kernel-next-a2-3-done-handoff.md` §1

---

## 1. 目标

让 kernel-next 的 TaskMachine 执行状态通过 SSE 实时广播到 dashboard，覆盖：
1. **TaskMachine 顶层 state**（idle / running / completed / failed）
2. **每个 stage region 的生命周期**（executing → done / error）
3. **每次 port write**（stage.port = value）
4. **stage 错误诊断**（NO_ACTIVE_WIRE + executor 失败）

dashboard 能实时呈现 pipeline 拓扑 + 每个节点当前状态 + 最近 port 写入。

## 2. 范围

- **In scope**：
  - kernel-next 独立 broadcaster（不走 legacy `SSEManager`）
  - kernel-next 专属 event schema（不动 `packages/shared/types.ts`）
  - HTTP route `GET /kernel-next/tasks/:taskId/stream`（text/event-stream）
  - runner.ts 的广播 hook
  - dashboard web 端一个最小订阅 demo 页面（验证端到端）
- **Out of scope**：
  - legacy SSE manager 的扩展
  - history replay / 冷启动 backfill（第一版只 live，后续可加）
  - 多租户 / 认证（单用户本地引擎）
  - pipeline-generator 的 MCP surface（另一个方向）

## 3. 架构

```
┌─────────────────────────────────────────────────────┐
│ kernel-next runner                                  │
│  ┌──────────────────────┐                           │
│  │ TaskMachine actor    │                           │
│  │  ├─ state change ────┼─┐                         │
│  │  └─ region transition┼─┼──► KernelNextBroadcaster│
│  └──────────────────────┘ │       │                 │
│  ┌──────────────────────┐ │       │ publishes       │
│  │ PortRuntime          │─┘       ▼                 │
│  │  └─ port write ──────┐  KernelNextSSEEvent       │
│  └──────────────────────┘   (type+taskId+data+ts)   │
│  ┌──────────────────────┐                           │
│  │ stageErrors aggregator───────────► Broadcaster   │
│  └──────────────────────┘                           │
└─────────────────────────────────────────────────────┘
                │
                ▼
   ┌─────────────────────────────┐
   │ /kernel-next/tasks/:id/stream│  SSE (text/event-stream)
   │   Hono route                 │
   └─────────────────────────────┘
                │
                ▼
   ┌─────────────────────────────┐
   │ dashboard web EventSource    │
   │   /kernel-next/tasks/:id/...  │
   └─────────────────────────────┘
```

## 4. Event schema

```ts
// src/kernel-next/sse/types.ts（新）
export type KernelNextSSEEventType =
  | "task_state"        // TaskMachine 顶层 state 变化
  | "stage_executing"   // 某 stage region 进入 executing
  | "stage_done"        // 某 stage region 到达 done final
  | "stage_error"       // 某 stage region 到达 error final（含 NO_ACTIVE_WIRE）
  | "port_written"      // 单次 port write
  | "run_final";        // 顶层 final 事件（completed / failed），带聚合诊断

export interface KernelNextSSEEvent {
  type: KernelNextSSEEventType;
  taskId: string;
  timestamp: string;    // ISO 8601
  data: unknown;        // 随 type 变化
}

// 每类 data shape
interface TaskStateData   { state: "idle" | "running" | "completed" | "failed" }
interface StageExecutingData { stage: string; attemptId: string }
interface StageDoneData      { stage: string; attemptId: string }
interface StageErrorData     { stage: string; attemptId?: string; message: string; context?: unknown }
interface PortWrittenData    { stage: string; port: string; valuePreview: string }  // 截断
interface RunFinalData       { finalState: "completed" | "failed"; stageErrors: {stage:string;message:string}[] }
```

## 5. 切片划分

**每片独立 commit，≤5 文件，tsc clean，tests green。**

### 5.1 Slice 1 — broadcaster + event types（纯新建，0 依赖）
- `src/kernel-next/sse/types.ts` — event types 定义
- `src/kernel-next/sse/broadcaster.ts` — KernelNextBroadcaster class
  - `subscribe(taskId, listener): unsubscribe`
  - `publish(event): void`
  - 连接级 history（内存 ring buffer，default 100 events，超出丢旧）
  - 无连接时 publish 仍然记录 history（晚到的订阅可 replay 现有 buffer）
- `src/kernel-next/sse/broadcaster.test.ts` — unit tests：订阅/取消/history replay/多订阅者

**断点**：broadcaster 独立可用，runner 尚未集成。

### 5.2 Slice 2 — runner 集成广播 hook
- `src/kernel-next/runtime/runner.ts` — `RunnerOptions.broadcaster?: KernelNextBroadcaster`
  - 在 `actor.subscribe` 回调里映射 state/region 变化到 broadcaster events
  - 在 dispatched stage 的 `executing` 分发时 publish `stage_executing`（含 attemptId）
  - 在 substate `done` / `error` publish `stage_done` / `stage_error`
  - 顶层 `completed` / `failed` publish `run_final`（含 stageErrors 汇总）
- `src/kernel-next/runtime/port-runtime.ts` — `PortRuntime` 加可选 `onPortWritten` 回调，`writePort` 触发
  - runner 在创建 livePortRuntime 时接上 `onPortWritten = (stage,port,value) => broadcaster.publish(...)`
- `src/kernel-next/runtime/runner.test.ts` — +2~3 测试：runner 带 broadcaster 跑短 pipeline，断言事件序列

**断点**：broadcaster 接完所有 kernel-next 产生的信号，无 HTTP 暴露。

### 5.3 Slice 3 — HTTP SSE route
- `src/kernel-next/sse/http.ts`（新） — Hono handler `streamKernelTask(c)`，text/event-stream 输出
  - 从 url param 取 taskId
  - 从 DI 容器拿 broadcaster（第一版走 module-level singleton 兼容性 = `src/kernel-next/sse/singleton.ts`）
  - `onAbort` 关闭时 unsubscribe
- `src/kernel-next/sse/singleton.ts`（新）— 模块级单例 broadcaster（单用户本地引擎可接受）
- `src/routes/kernel-next-stream.ts`（新） — 挂到 Hono 主 app
- `src/index.ts` — 注册 route
- `src/kernel-next/sse/http.test.ts`（新）— 用 Hono `.fetch` 测 SSE 起始响应 + event 序列

**断点**：HTTP 可 curl，dashboard 未接。

### 5.4 Slice 4 — runner 默认走 singleton broadcaster
- `src/kernel-next/runtime/runner.ts` — broadcaster 默认从 singleton 取（options 可 override，测试用显式注入）
- `src/kernel-next/demo/diamond.ts`、`demo/diamond-real.ts` 无需改（它们的测试不验证 SSE，但跑时会自动 publish）
- 无新 test 文件；已有 runner.test.ts 覆盖 override 路径；新增 1 test 验证"不传 broadcaster 时 publish 到 singleton 可被订阅者收到"

**断点**：任何跑 runPipeline 的入口自动产 SSE，可被 HTTP stream 消费。

### 5.5 Slice 5 — dashboard web 端最小订阅 demo
- `apps/web/src/app/kernel-next/[taskId]/page.tsx`（新） — client component，用 EventSource 订阅
  - 展示：顶层 state、每个 stage 当前状态（collected from events）、port write 最近 10 条、run_final 诊断
- 样式走现有 Tailwind 约定；不追求完美 UI，只要端到端可见
- 无 test（UI demo，后续 QA）

**断点**：启动 dev server，跑一个测试 pipeline，浏览器访问 `/kernel-next/<taskId>`，能看到实时更新。

### 5.6 Slice 6（可选）— handoff 文档
- `docs/superpowers/plans/2026-04-20-kernel-next-sse-observability-done.md`
  - 完成情况 commit table
  - 下一步候选

## 6. 风险 / 开放问题

| 风险 | 缓解 |
|---|---|
| port value 可能很大，广播会爆 payload | PortRuntime 回调就截断到 `PREVIEW_BYTES=200`（runner 已有的常量），`valuePreview` 只传截断版 |
| SSE route 无 auth / rate limit | 单用户本地引擎；文档说明部署边界（`127.0.0.1` only） |
| broadcaster singleton 测试污染 | 每个 test 显式 new 实例并通过 options 注入；singleton 只是 HTTP route 的默认 bridge |
| runner 性能：每次 port write 都 publish | history ring buffer 限 100；publish 是同步 O(订阅数)；单用户无高并发压力 |
| legacy sse-manager.test 与 kernel-next-sse.test 并发互不干扰 | 完全独立路径，无共享可变状态 |

## 7. 验收标准

所有切片合并后：
- [ ] tsc clean
- [ ] 4028+ tests passing（累计 Slice 1-4 预计 +10~15 tests）
- [ ] 手动验证：跑 `diamond` demo pipeline，从 curl 订阅 `/kernel-next/tasks/<id>/stream` 能看到完整事件序列
- [ ] 手动验证：dashboard `/kernel-next/<taskId>` 页面实时显示 pipeline 节点状态
- [ ] 0 回归（现有 legacy SSE 测试全绿）

## 8. 本会话执行顺序

按 §5 顺序推 Slice 1 → 2 → 3 → 4 → 5，每片独立 commit + self-review + tsc + test。Slice 6 handoff 可选，看时间。

预估总 commit 数：5-6 个，测试 Δ +10~15。
