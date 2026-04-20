# kernel-next SSE 观察层 — 完成情况 + 下一步候选

> Created: 2026-04-20
> Author: Opus 4.7 (与产品 owner 协作)
> Status: **code-complete + 浏览器端到端验证通过**（Slice 1/2/3/5 合并；Slice 4 撤销；生产入口 + 真实验证已补）
> Parent: `docs/kernel-next-terminal-design.md`
> Predecessor plan: `docs/superpowers/plans/2026-04-20-kernel-next-sse-observability.md`

读完 §0 就能恢复上下文。其余章节是补充。

---

## 0. 2026-04-20 — 交付情况

### 0.1 本轮 commits

| Commit | Slice | 内容 | Δ tests |
|---|---|---|---|
| `922fd53` | plan | 5-slice plan | 0 |
| `1e52bd3` | Slice 1 | broadcaster + event types（含 7 单测） | +7 |
| `f81942a` | Slice 2 | runner + PortRuntime broadcast hook（含 3 集成测） | +3 |
| `87f4ef8` | Slice 3 | HTTP route `/api/kernel-next/tasks/:id/stream`（含 5+3 测） | +8 |
| ~~Slice 4~~ | 撤销 | 见 §0.3 | — |
| `bad0289` | Slice 5 | dashboard 最小订阅页 `apps/web/.../kernel-next/[taskId]/page.tsx` | web-only |

**累计**：4028 → 4046 (+18)，plan 估算 +10~15；超估主要因 http.test 拆成 5 个独立场景。server+web tsc clean，0 回归。

### 0.2 端到端链路（已通）

```
runner (XState)
    │
    │  opts.broadcaster?.publish(...)         ← Slice 2
    ▼
KernelNextBroadcaster                          ← Slice 1
    │   ┌──────────────────────────┐
    │   │ per-task ring (100 ev.)  │
    │   │ listeners Set             │
    │   └──────────────────────────┘
    │
    ▼
/api/kernel-next/tasks/:id/stream              ← Slice 3
    │   text/event-stream
    │   event: <type> / data: <json>
    │   heartbeat every 30s
    ▼
Next.js page at /kernel-next/<taskId>          ← Slice 5
    ├─ top-level state
    ├─ stage table (executing / done / error)
    ├─ port writes feed (last 20)
    └─ run_final diagnostics
```

### 0.3 Slice 4 撤销原因

计划预设 runner 默认走 singleton broadcaster，让"任何 runPipeline 入口自动产 SSE"。但代码摸查发现**当前 kernel-next 的 runPipeline 没有真实生产入口**——非测试调用仅 2 个 demo 文件。让 runner 默认注入 singleton 会导致所有测试污染同一个 broadcaster 实例，破坏 Slice 1 test 的独立性。

正确做法：当真实生产入口出现时（某个 Hono handler / MCP 工具调度），由该入口**显式注入** singleton。runner 本身保持"无隐式依赖"——和 `opts.executor` / `opts.handlers` 的风格一致。

诊断模式和 Debt #5 / #6 相同：先验证再实施。

### 0.4 决策记录

| 决策点 | 选择 |
|---|---|
| 方向（§1.x vs A7 vs §10.5） | SSE 观察层 |
| event schema 粒度 | **完整**（task_state + stage_executing/done/error + port_written + run_final）|
| 实施范围 | 一次到位（runner + route + dashboard） |
| 广播层定位 | **独立 kernel-next broadcaster**（不扩 legacy SSE manager / 不动 `packages/shared/types.ts`） |
| Slice 4 | 撤销（详情见 §0.3） |

### 0.5 开工前 checklist（继任 session）

- [ ] `git log --oneline -10` 最顶是 `bad0289 SSE Slice 5 ...` 之上
- [ ] `cd apps/server && ./node_modules/.bin/tsc --noEmit` 干净
- [ ] `cd apps/web && ./node_modules/.bin/tsc --noEmit` 干净
- [ ] `cd apps/server && ./node_modules/.bin/vitest run` 4046 passed / 5 skipped
- [ ] 本文档 §0 读完；plan 原件的 §5 切片划分 + §0.3 Slice 4 撤销原因

---

## 1. 未做但值得做的

### 1.1 浏览器端真实验证 — ✅ 已完成（2026-04-20）

commit `4b0c2b0`（`POST /api/kernel/tasks/run` + slow-diamond fixture）落地后，启动两端 dev server（`apps/server :3001` + `apps/web :3004`）做了完整端到端验证：

- `curl -X POST /api/kernel/tasks/run`（body: `{pipeline:"diamond-slow", taskId:"browser-..."}`）立即返回 202 + `{taskId, versionHash}`
- SSE `curl -N /api/kernel-next/tasks/<id>/stream` 收到完整事件序列：task_state（idle→running→completed）、4 × stage_executing、4 × stage_done、4 × port_written（A.x、B.y、C.z、D.final）、run_final（completed, stageErrors=[]）
- 时间戳正确反映拓扑：A 用 ~1.5s → B/C 并行 ~1.5s → D ~1.5s，总约 4.5s
- 浏览器访问 `http://localhost:3004/kernel-next/<taskId>`：Connection=open, Events received=16, State=completed, Stages 表格 4 行全 done（绿色），Recent port writes 4 条带时间戳，Run final 方块 finalState=completed

端到端通路：POST → KernelService.submit → runPipeline 后台 → broadcaster.publish → HTTP SSE route → fetch-streaming → Next.js page 实时渲染。**无需额外修补，一遍通**。

### 1.2 生产入口接入 — ✅ 已完成（commit `4b0c2b0`）

新增 `POST /api/kernel/tasks/run`（`src/routes/kernel-run.ts`）。body: `{pipeline: string; taskId?: string}`，pipeline 在文件内小 registry 注册（首批 `diamond` + `diamond-slow`），返回 202 + `{ok, taskId, versionHash}`。后台 `runPipeline` 注入 singleton broadcaster，`.catch` 兜底 publish `run_final(failed)` 确保 dashboard 看到 coherent 结束。

接受 **注册过的 pipeline 名字**，不接受任意 IR——那个攻击面属于 MCP surface，不属于 dashboard 触发入口。想加新 builtin 就在 registry 新增一项即可。

### 1.3 新 session 可选方向

§1.1 + §1.2 已完成，余下方向：

| 方向 | 阻塞依赖 | 估算 |
|---|---|---|
| **A7 真实 pipeline 验证** | 无，dashboard 已可作为调试工具 | 3-7 fix 切片，需 API key |
| **§10.5 deep live-migration** | 无 | 2-3 周 |
| **pipeline-generator MCP surface** | 无 | 中大型 |
| **dashboard UX 打磨** | 无，但验证驱动场景有限 | 小-中 |
| **kernel-run registry 扩充** | 无 | 每条新 pipeline 几行 |

---

## 2. 架构不变量（未动，仍然成立）

沿用 CLAUDE.md、F1-F8 handoff、A2.3 handoff 记录的规则。本轮新增几条 SSE 相关：

- **独立 event schema**：`kernel-next/sse/types.ts` 与 `packages/shared/types.ts` 解耦；不要在 shared 里加 kernel-next 专用类型
- **runner 保持无隐式依赖**：`opts.broadcaster?` 是 optional；不做"默认 singleton"；生产入口显式注入
- **broadcaster 同步发布**：listener 错误被 swallow；任何 listener 或 broadcaster 自身的故障都不应阻断 runner 主循环
- **port write 广播在 live PortRuntime**：silent PortRuntime（fanout element）不传 hook——聚合前的中间写入不进入 SSE 流

---

## 3. 代码入口点

### 3.1 SSE 核心（Slice 1/2/3）

| 模块 | 角色 |
|---|---|
| `apps/server/src/kernel-next/sse/types.ts` | 6 种 event type 的 envelope + data shape |
| `apps/server/src/kernel-next/sse/broadcaster.ts` | KernelNextBroadcaster class（subscribe/publish/history） |
| `apps/server/src/kernel-next/sse/singleton.ts` | 模块级单例（`kernelNextBroadcaster`） |
| `apps/server/src/kernel-next/sse/http.ts` | `createKernelNextStream` — SSE ReadableStream |
| `apps/server/src/routes/kernel-next-stream.ts` | Hono route `/kernel-next/tasks/:id/stream`（挂在 `/api`）|
| `apps/server/src/index.ts` | route 注册（L163 附近） |

### 3.2 Runner 挂钩（Slice 2）

| 模块 | 修改点 |
|---|---|
| `apps/server/src/kernel-next/runtime/runner.ts` | `RunnerOptions.broadcaster?`；publish helper；4 类 hook 点（state / stage_executing / stage_done+error / run_final）；PortRuntime 构造时注入 port-written lambda |
| `apps/server/src/kernel-next/runtime/port-runtime.ts` | `PortWrittenHook` type + `onPortWritten?` 构造参数 + writePort 末尾调用 |

### 3.3 Dashboard（Slice 5）

| 模块 | 角色 |
|---|---|
| `apps/web/src/app/kernel-next/[taskId]/page.tsx` | client component，fetch-streaming 订阅 SSE；顶层状态 / stage 表 / port feed / run_final 四块 |

### 3.4 测试

| 文件 | 覆盖 |
|---|---|
| `apps/server/src/kernel-next/sse/broadcaster.test.ts` | 7 unit：订阅/取消/history replay/overflow/多订阅者/listener-error isolation/clearTask |
| `apps/server/src/kernel-next/sse/http.test.ts` | 5 unit：history replay frame 格式/live delivery/heartbeat/cancel 解订阅/任务隔离 |
| `apps/server/src/routes/kernel-next-stream.test.ts` | 3 route：headers/订阅生命周期/live 事件穿透 |
| `apps/server/src/kernel-next/runtime/runner.test.ts` | +3 integration：完整成功流事件序列/guard-drop 错误流/broadcaster 省略 |

---

## 4. 新 session 快速恢复指南

**必读**：
1. 本文档 §0（尤其 §0.3 Slice 4 撤销原因）
2. plan 原件 `2026-04-20-kernel-next-sse-observability.md` §5 切片划分（含当时的决策上下文）
3. A2.3 handoff 的 §1 候选方向列表（仍然成立，但已把"SSE 观察层"划掉）
4. `docs/kernel-next-terminal-design.md` §4（TaskMachine 语义）+ §11.1（acceptance criteria）

**基准**：
- Baseline 前 SSE：`4028 passed / 5 skipped`
- Baseline 后 SSE：`4046 passed / 5 skipped`
- 跑法：`cd apps/server && ./node_modules/.bin/vitest run`
- web tsc：`cd apps/web && ./node_modules/.bin/tsc --noEmit`

**不要做的事**：
- **不要**让 runner 默认注入 singleton broadcaster —— Slice 4 撤销原因已说清
- **不要**把 kernel-next event type 加到 `packages/shared/types.ts` —— legacy 与 kernel-next 应结构性解耦
- **不要**给 `http.ts` 加 DB 持久化 —— broadcaster 的 ring buffer + SQLite lineage 已覆盖
- **不要**修 Slice 5 dashboard 的视觉 —— 这是 verification demo，polished UX 在 §1.2 之后再考虑
- **不要**在 `ExecuteStageArgs` 里暴露 broadcaster —— executors 不该管 orchestration-layer 的观察性（同 fanout 不走 Composite 的理由）

---

## 5. Verdict

kernel-next SSE 观察层 **code-complete + 浏览器端到端验证通过**。

5 个 slice 落地（4 个实施 + 1 个撤销），测试数量与 plan 估算同量级（+18 vs +10~15），0 回归，tsc 两端干净。broadcaster / HTTP route / dashboard 三层独立可测。

commit `4b0c2b0` 补上生产入口（POST /api/kernel/tasks/run）+ slow-diamond fixture（+6 tests，4046→4052），启动 server+web dev server 跑通：POST → 后台 runPipeline → broadcaster → SSE → Next.js 页面 4 stage 全 done、port feed 4 条、run_final=completed。

下一步候选见 §1.3；最顺手的大方向是 **A7 真实 pipeline 验证**——dashboard 已就位作为实战调试工具。
