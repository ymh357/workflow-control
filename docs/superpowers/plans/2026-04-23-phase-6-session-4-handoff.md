# Phase 6 Session 4 — Handoff

> **Date**: 2026-04-23
> **Session head**: commit `e3b9229`
> **Previous handoff**: `docs/superpowers/plans/2026-04-23-phase-6-session-3-handoff.md`（上个 session 头 `4caa76f` / 尾 `e39ff7b`）

---

## 1. 原则（每 session 开头必复述）

- **中文对话**；code comment 英文；no emoji
- **合理正确优先，不考虑成本**
- **除需决策外不停下来**——milestone 完客观 self-review，通过就静默进下一个
- **每 milestone self-review** 写进 commit body
- **brainstorming 自决 Q1/Q2/Q3**，仅 scope 级取舍问用户
- **严格 TDD**（红→实现→绿→提交）
- **Git 每 task 独立 commit 直接 main**（已授权），**不 push 远端**
- **forced verification**：完成前 `cd apps/server && npx tsc --noEmit && npx vitest run`
- **不小修小补**：真架构问题系统性修到根
- **不保 backward compat**
- **Investigate before claim gap**
- **读文件捆绑 edit**
- **cwd 漂移**：每 Bash 前 `pwd` 验证

## 2. 本 session 完成的工作

### 2.1 Persist-tsc bug investigation → 决定性证据（无 commit, work file）

对 run #19 的 side bug "WIRE_TYPE_MISMATCH / tsc not available" 深挖。写 repro 脚本对 run #19 原 IR 跑 `validateTypes`：
- 传 `MONOREPO_TSC_PATH` → `ok=true`
- 不传 → fallback `"This is not the tsc command you are looking for"`

真因定位：**两条 PG 入口路径都没把 tscPath 传到 per-stage MCP**。

### 2.2 Debt L fix — resume 路径 tscPath（commit `8b5f92d`）

`orphan-reconciler.ts`:
- `BootResumabilityInput` 增 `tscPath?: string`
- 签名扩展 `startPipelineRun(input: { ..., tscPath? })`
- 调用时透传 `tscPath: input.tscPath`

`index.ts`:
- `import { MONOREPO_TSC_PATH }` from `kernel-run.ts`
- `bootResumability({ ..., tscPath: MONOREPO_TSC_PATH, startPipelineRun: (inp) => startPipelineRun({ ..., tscPath: inp.tscPath })})`

`routes/kernel-run.ts`:
- `MONOREPO_TSC_PATH` 改为 `export const`

`orphan-reconciler.test.ts`:
- 新 test "forwards tscPath to startPipelineRun for resumed orphans"

### 2.3 Debt M fix — MCP start_pipeline_generator handler tscPath（commit `83daf77`）

`pg-entry.ts`:
- `PgEntryDeps.executorFactory` 签名增 `tscPath?: string`
- `deps.executorFactory({ ..., tscPath: deps.tscPath })`

`mcp/server.ts`:
- `start_pipeline_generator` handler deps 增 `tscPath: options.tscPath`
- `executorFactory` body 用 `tscPath` 参数构造 inner `createKernelMcp(db, { ..., tscPath })`

`pg-entry.test.ts`:
- 新 test "forwards deps.tscPath to executorFactory so the per-stage MCP can run validateTypes"

### 2.4 Run #20 re-dogfood（commit `9e1072e` 的一部分）

Clean DB，发 PG（"A tiny pipeline that takes a URL string and returns its hostname..."）→ 全 5 stage 跑完 → `persisting.versionHash="52d3b767...cacd8440"`（real SHA）/ `pipelineId="extract-hostname"`（real slug）/ `pipeline_versions` 新行 `Extract Hostname` 入表。**与 run #19 相比，FAILED 完全消失**。

### 2.5 tscPath contract tightening（commit `c06d21d`）

防止 debt L/M 类 bug 再现。新增 `src/kernel-next/runtime/monorepo-tsc-path.ts`：singleton `resolveMonorepoTscPath()` 一次性定位 `apps/server/node_modules/.bin/tsc`，process-wide cache。修改 `validator/types.ts:runTsc`：当 caller 未传 tscPath 时**先试 `resolveMonorepoTscPath()`**再 fallback npx。结果：无论上游是否漏传，validator 都能跑真 tsc。3 个新 test（2 unit + 1 contract），总 1491 pass。

### 2.6 sdk-adapter tool_use_id fix（commit `e3b9229`）

**Debt N 发现**：`agent_execution_details.tool_calls_json` 每条 entry 的 `result` + `finishedAt` 都是 null——observability 失效。Investigate 流程：
1. Grep SDK `sdk.mjs` 找 tool_result 字段 → 发现 **`tool_use_id`**（snake）和 **`toolUseId`**（camel）都出现
2. `sdk-adapter.ts:124` 只读 `b.id` → real SDK 永远不 emit 该字段 → 每个 TOOL_RESULT_RECEIVED 被 silent drop → `completeToolCall` 从不调用

Fix：adapter 接受三种形式（`tool_use_id` → `toolUseId` → 回退 `id`）。扩展 `SdkMessageLike` type。2 个新 test。

### 2.7 Run #21 re-dogfood tool_result（commit `e3b9229` + docs）

smoke-test 跑完 → greet/echoBack 的 tool_calls_json 验证：`result = [{"type":"text","text":"{\"ok\":true}"}]`，`finishedAt` 时间戳 populated。Observability 端到端修复。

## 3. 当前状态

```
Branch: main
Head:   e3b9229（docs 未 commit，待本 session 收尾 commit）
Status: 2 docs modified

Server tests: 1493 pass / 4 skipped / tsc 0
Web tests:    17 pass / tsc 0
```

**M 指标快照**（`docs/phase6-usage-log.md`）：
- **M1**: 8 数据点（含 run #21 tool_result 验证）
- **M2**: 0 朋友在用；**Resumability + AI-pipeline DB 注册 + observability 均完整**
- **M3**: 14/21 = 67%；**post-audit 10/10 = 100%**
- **M4**: 5 / 0 / 0

## 4. 架构债清零

- 债 A..F（sessions #1-2）: ✅
- 债 G（task 跨 server 生命周期丢失）: ✅ M-R1+M-R2
- 债 H（gate 答了但 runner crash 前未转发）: ✅ M-R3
- 债 I（SSE 断线重连无法 gap-precise 恢复）: ✅ M-R4
- 债 J（crash 后 agent 已烧 token 全丢重跑）: ✅ M-R5
- 债 K（M-R5 session_id 只在 close 时 flush）: ✅ `dec8313`
- 债 L（bootResumability 未透传 tscPath）: ✅ `8b5f92d`
- 债 M（MCP start_pipeline_generator handler 未透传 tscPath）: ✅ `83daf77`
- 债 L/M 契约加固（validator 自 resolve tscPath 兜底）: ✅ `c06d21d`
- 债 N（sdk-adapter 读 `id` 而非 `tool_use_id`，tool_calls_json.result 永 null）: ✅ `e3b9229`

## 5. 完整未完成清单

### 5.1 M 指标
- M1: 累积
- M2: 朋友邀请（基础设施不再阻塞）
- M3/M4: 靠继续用

### 5.2 架构决策未定 / 低优先级
- **Single-session 回补**：未 benchmark
- **SDK session resume 失败时的 try/catch fallback**：wiring 完成；若 `~/.claude/projects` 文件缺失/corrupt，当前让 stage 失败（未 degrade to fresh session）。发生概率低；保留为 defensive issue
- **Tscpath 设计级加固**：当前 `startPipelineRun` 的 `tscPath` 是 optional，每个 caller 可以悄悄漏掉（run #20 暴露的 debt L/M 就是两个独立 caller 同一漏）。未来可考虑 required 参数或 default-to-resolved 以契约层阻断此类 bug 再现

### 5.3 剩余 known bugs
- **~~tool_calls_json partial 记录~~**：**已修** (`e3b9229`)。root cause 不是 partial，是 `id` vs `tool_use_id` 字段拼错导致 tool_result 全被 silent drop → `result/finishedAt` 永 null。Run #21 验证修复。
- **第二次写 FAILED 的 defensive sentinel**（run #19）：persisting agent 首次 submit 失败后写了 `versionHash=FAILED`；这是 prompt 层 defensive 行为。虽不 ideal，但 task_finals 正确写 completed/natural。若 B/C 进一步修 prompt 可避免 dead 数据

### 5.4 非 autonomous
- 朋友试用邀请
- deployment 便利化（README + 起动脚本）
- Tech Research Writer builtin 未 dogfood

## 6. 环境细节

```bash
# 工作目录
cd /Users/minghao/workflow-control/apps/server

# tsc + vitest 必须在子包里跑
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit && npx vitest run
cd /Users/minghao/workflow-control/apps/web    && npx tsc --noEmit && npx vitest run

# 清启
pkill -9 -f "tsx src/index.ts"; sleep 2
rm -f /tmp/workflow-control-data/kernel-next.lock
rm -f /tmp/workflow-control-data/kernel-next.db*
rm -rf /Users/minghao/workflow-control/apps/server/dist
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server.log 2>&1 &
sleep 15
lsof -nP -iTCP:3001 | head -3
```

**DB**: `/tmp/workflow-control-data/kernel-next.db`
**Lock**: `/tmp/workflow-control-data/kernel-next.lock`
**Server port**: 3001
**Web port**: 3000

## 7. 下一步候选

按"合理正确优先" + 实际价值。**本 session 已完成原候选 #2（tool_calls_json）和 #3（tscPath 契约）**。剩余：

1. **Tech Research Writer builtin dogfood**——补 builtin coverage。但 Writer 是 13-externalInputs single-agent pipeline，期望 `.workflow/outline-*.md` + 多个 `research-*.md` 文件，独立 dogfood 需要先造合理 inputs 或编排 Collector→Writer 链。工作量中，价值中
2. **FAILED sentinel 清理**：run #19 persisting agent 首次 submit 失败后写 FAILED sentinel 到 ports。现在根因修完（tscPath + tool_use_id），该 defensive code 永不触发。若未来真失败，prompt 层规则仍会写 FAILED——考虑是否改 prompt 让 agent 直接 throw 让 retry 机制 handle
3. **deployment 便利化**（M2 外部阻塞）—— onboarding 最后一公里。非 autonomous
4. **朋友邀请**——真实 M2 测试。非 autonomous

**autonomous 空间越来越小**。架构债 A-N 全清。剩的都是 coverage/onboarding，不再是 architectural bug。

自决：若用户继续要求 autonomous 推进，推 **#1 Writer dogfood**——造最小合理 inputs（1-2 个 dummy outline + project/verification facts）跑 Writer 看能否 produce deliverable，即使失败也能暴露新 bug。

## 8. 参考文档

- `docs/phase6-usage-log.md` — runs #1-#20 全历史 + 成熟度 snapshot
- `docs/product-roadmap.md` — 终极目标 M1-M4、A/B 系列
- `docs/superpowers/specs/2026-04-23-resumability-design.md` — resumability 设计
- `docs/superpowers/plans/2026-04-23-resumability.md` — 7 milestone（M-R1..M-R6 全部完成）
- `docs/superpowers/plans/2026-04-23-phase-6-session-3-handoff.md`

## 9. 新 session 开头 checklist

1. 读本 handoff
2. `git log --oneline -10` 快速看 commit 链
3. `cd apps/server && npx vitest run` 确认 1493 pass 基线
4. 按 §7 推进 #1 或按用户指示
5. 新架构债出现时系统性修到根，不小修小补
