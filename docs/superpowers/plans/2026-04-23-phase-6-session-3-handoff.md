# Phase 6 Session 3 — Handoff (extended)

> **Date**: 2026-04-23
> **Session head**: commit `4caa76f`
> **Previous handoff**: `docs/superpowers/plans/2026-04-23-phase-6-session-2-handoff.md`（上个 session 在 commit `01f500e`）

---

## 1. 原则（每 session 开头必复述）

- **中文对话**；code comment 英文；no emoji
- **合理正确优先，不考虑成本**
- **除需决策外不停下来**——milestone 完客观 self-review，通过就静默进下一个
- **每 milestone self-review** 写进 commit body
- **brainstorming 自决 Q1/Q2/Q3**，仅 scope 级取舍问用户
- **严格 TDD**（红→实现→绿→提交）
- **Git 每 task 独立 commit 直接 main**（已授权），**不 push 远端**
- **forced verification**：完成前 `cd apps/server && npx tsc --noEmit && npx vitest run`（从子包跑，不从 repo root）
- **不小修小补**：真架构问题系统性修到根
- **不保 backward compat**（fixture 碰了改 fixture）
- **Investigate before claim gap**
- **读文件捆绑 edit**
- **cwd 漂移**：每 Bash 前 `pwd` 验证

## 2. 本 session 完成的工作

### 2.1 PG store_schema 升级（commit `11975bf`）
run #18，A3 gap 消除，M4 计数 3→4。见 `docs/phase6-usage-log.md`。

### 2.2 Resumability: spec → plan（`c61927c`, `98a60f1`）
独立 reviewer 三个 Critical issue 全修进设计。

### 2.3 Resumability M-R1..M-R5（18 commits）

| Milestone | Commit range | 内容 |
|---|---|---|
| M-R1 | b1ba1ba..a872474 | PID-file lock + graceful SIGTERM |
| M-R2 | 63ff134..4e021a9 | orphan reconciler + index.ts 集成 |
| M-R3 | 5d56791 | runner 从 gate_queue 读未转发答案 |
| M-R4 | 5c39758, f844842 | SSE monotonic seq + Last-Event-ID |
| M-R5 | eabb78f, 0f87b84, c57d9c5 | clamp helpers + resumeSessionId 全链路 |

### 2.4 M-R5 session_id flush gap（commit `dec8313`）

**dogfood 发现的真实架构债**：M-R5 unit tests 全绿，但首次 real-API dogfood 立刻暴露——`agent_execution_details.session_id` 只在 `writer.close()` 时 flush 到 DB。Mid-stage SIGKILL 后 DB 里是 NULL，orphan reconciler `lookupResumeSessionId` 返回 undefined，SDK resume 路径完全不可用。

Fix：
- `writer.updateSessionId()` 改为 **sync flush**（1 次额外 DB write per stage attempt）
- `real-executor.ts` 的 `onSdkMessage` 在 `system.init` 捕获 sid 时立即调 `writer.updateSessionId(sid)`
- 新 test case 验证 sync flush 语义

**lesson**：pure unit tests + 1485 passing + tsc 0 ≠ end-to-end works。M-R6 dogfood 是闭环必要环节。

### 2.5 Run #19：M-R6 dogfood verified SDK session resume（commit `4caa76f`）

**真实 API 验证**：
- 发 PG run，等 analyzing running + session_id 写入 DB（`f391e6d6...`）
- burn 20s tokens → `kill -9` tsx + child process
- 启 server D → reconciler `resumed=1` → runner 带 `options.resume=f391e6d6` 调 SDK
- **attempt #2 的 session_id = 与 pre-kill 完全相同的 `f391e6d6`** → SDK 接受 resume，没 fork
- Attempt #2 跑完 $0.1182 / 4133 output tokens，pipeline 全链路 completed/natural，total $0.4056

**验证结论**：M-R1..M-R5 resumability 栈在真实 Claude API 下端到端 work。

**副 bug 发现**（非 resumability 相关）：persist stage 报 `WIRE_TYPE_MISMATCH` + "tsc not available"。AI-generated pipeline 未最终入 DB（`versionHash=FAILED`）但 task_finals 正确 completed/natural。独立问题，见 §5.

## 3. 当前状态

```
Branch: main
Head:   4caa76f
Status: clean

Server tests: 1486 pass / 4 skipped / tsc 0
Web tests:    17 pass / tsc 0
```

**M 指标快照**（`docs/phase6-usage-log.md`）：
- **M1**: 6 数据点（含 run #19 完整 resume dogfood）
- **M2**: 0 朋友在用；**Resumability 栈完整可用** + UI + SSE + 所有 crash-safety 到位
- **M3**: 12/19 = 63% 全样本；**post-audit 8/8 = 100%**
- **M4**: 4 / 0 / 0

## 4. 架构债清零

- 债 A..F（上个 session）: ✅
- 债 G（task 跨 server 生命周期丢失）: ✅ M-R1+M-R2
- 债 H（gate 答了但 runner crash 前未转发）: ✅ M-R3
- 债 I（SSE 断线重连无法 gap-precise 恢复）: ✅ M-R4
- 债 J（crash 后 agent 已烧 token 全丢重跑）: ✅ M-R5（wiring + session_id flush fix）
- 债 K（M-R5 session_id 只在 close 时 flush）: ✅ `dec8313` 修掉了

## 5. 完整未完成清单

### 5.1 M 指标
- M1: 累积
- M2: 朋友邀请（基础设施不再阻塞）
- M3/M4: 靠继续用

### 5.2 架构决策未定
- **Single-session 回补**：未 benchmark
- **SDK session resume 失败时的 try/catch fallback**：wiring 完。若 ~/.claude/projects 文件缺失 / corrupt，当前让 stage 失败（没降级到 fresh session）。实际发生概率低；保留为 issue。

### 5.3 新发现 bug（run #19 暴露）

**Persist stage 报 WIRE_TYPE_MISMATCH / "tsc not available"**:

- 情形：PG 生成的 2-stage IR `code-review-pipeline` 被 persist 提交到 kernel
- 症状：submit_pipeline 返回含 WIRE_TYPE_MISMATCH 诊断；agent 推理 "tsc not available in validation environment" → 写 versionHash=FAILED
- 证据：`/Users/minghao/workflow-control/apps/server/node_modules/.bin/tsc` 存在；`MONOREPO_TSC_PATH` 算法在 `routes/kernel-run.ts:41-46` 正确指向
- 假说：MCP inner `submit_pipeline` 调用从另外路径 spawn tsc（不是 routes/kernel-run.ts 的 HTTP 入口）。可能 `kernelRunRoute.ts` 的 tscPath 没被 inner `submit_pipeline` 用（MCP server 是另一条 path，看 `kernel-next/mcp/server.ts`）
- 优先级：中。阻塞真实 AI-generated pipeline 注册到 DB。与 resumability 无关；独立 issue
- 复现路径：跑 PG（any)，等 persist stage，观察其 tool_calls 里 submit_pipeline 返回的 diagnostics
- 待查文件：`src/kernel-next/mcp/server.ts`（submit_pipeline tool handler）/ `src/kernel-next/runtime/start-pipeline-run.ts:47`（tscPath 流入）/ `src/kernel-next/mcp/kernel.ts`（validate 如何调 tsc）

### 5.4 非 autonomous
- 朋友试用邀请
- deployment 便利化（README + 起动脚本）—— M2 最后一公里，**现在 server crash 安全了，朋友门槛大幅降低**

## 6. 环境细节

```bash
# 工作目录
cd /Users/minghao/workflow-control/apps/server

# tsc + vitest 必须在子包里跑
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit && npx vitest run
cd /Users/minghao/workflow-control/apps/web    && npx tsc --noEmit && npx vitest run

# 清启（SIGKILL 后 .lock 会留住，必须删）
pkill -9 -f "tsx src/index.ts"; sleep 2
rm -f /tmp/workflow-control-data/kernel-next.lock
rm -f /tmp/workflow-control-data/kernel-next.db*
rm -rf /Users/minghao/workflow-control/apps/server/dist
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server.log 2>&1 &
sleep 22
lsof -nP -iTCP:3001 | head -3
```

**DB**: `/tmp/workflow-control-data/kernel-next.db`
**Lock**: `/tmp/workflow-control-data/kernel-next.lock`
**Server port**: 3001
**Web port**: 3000

## 7. 下一步候选

按"合理正确优先" + 实际价值：

1. **修 §5.3 persist tsc bug**——真实阻塞 PG 的端到端产出。工作量中（需 trace MCP path）。
2. **deployment 便利性**（M2 外部阻塞）——onboarding 是最后一公里。非代码、产品化。
3. **SDK session resume 失败 fallback**——小工作量，defensive。
4. **朋友邀请**——真实 M2 测试。

自决推 **#1（persist tsc bug）**：autonomous 可做、阻塞 AI-generated pipeline 可用性、是 M3 天花板之一。修完 M3 分子会再涨。

#2 和 #4 依赖外部动作，非 autonomous。

## 8. 参考文档

- `docs/phase6-usage-log.md` — runs #1-#19 全历史 + 成熟度 snapshot
- `docs/product-roadmap.md` — 终极目标 M1-M4、A/B 系列
- `docs/superpowers/specs/2026-04-23-resumability-design.md` — 本轮设计
- `docs/superpowers/plans/2026-04-23-resumability.md` — 7 milestone（M-R1..M-R5 已完成 + M-R6 dogfood 已完成）
- `docs/superpowers/plans/2026-04-23-phase-6-session-2-handoff.md`

## 9. 新 session 开头 checklist

1. 读本 handoff
2. `git log --oneline -10` 快速看 commit 链
3. `cd apps/server && npx vitest run` 确认 1486 pass 基线
4. 按 §7 推进 #1 或按用户指示
5. 新架构债出现时系统性修到根，不小修小补
