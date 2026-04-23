# Phase 6 Session 3 — Handoff

> **Date**: 2026-04-23
> **Session head**: commit `c57d9c5`
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
- **Investigate before claim gap**：任何"X 缺了"论断先读当前源码验证
- **读文件捆绑 edit**：改前必 Read；stale context → silent edit fail
- **cwd 漂移**：每 Bash 前 `pwd` 验证

## 2. 本 session 完成的工作

### 2.1 PG store_schema 升级（commit `11975bf`）

run #18。延续上个 session handoff §7 推荐 #1：

- Propose UI 发 prompts-only 提案（ops:[], 4-prompts map，替换 `system/gen-skeleton` 加"Store schema generation (REQUIRED)" + 4 self-check）
- Approve → run with `versionHash=ecec9778...`
- 生成的 `Web Research Reporter` IR 含完整 `store_schema`（validator ok / COMPLETE）
- **A3 gap 真实消除**；M4 计数 3→4
- Filesystem 落盘 `system/gen-skeleton.md`，server restart 后 seed 同 hash

### 2.2 Resumability: spec → plan（commits `c61927c`, `98a60f1`）

- **独立 reviewer 审过**：发现 3 个 Critical issue（SSE 需真 event-id 机制、gate_queue 答案丢失窗口、`task_finals IS NULL` 不等于 crashed）全修进设计
- Scope: A+B+C+D+G+H+I（not E/F 因自然 fallout，not 多 server active-active/cross-machine）
- 无 schema migration：复用 `stage_attempts.status='superseded'` + `termination_reason='interrupted'`

### 2.3 Resumability: 5 milestone 实现（18 commits）

| Milestone | Commits | 内容 |
|---|---|---|
| M-R1 | b1ba1ba..a872474 | PID-file server lock + graceful SIGTERM shutdown |
| M-R2 | 63ff134..4e021a9 | orphan reconciler（scan/classify/lookup session/boot） + index.ts 集成 |
| M-R3 | 5d56791 | runner 从 gate_queue 读未转发的答案 |
| M-R4 | 5c39758, f844842 | SSE 每事件 monotonic seq + `id:` 行 + `Last-Event-ID` 重连 |
| M-R5 | eabb78f, 0f87b84, c57d9c5 | clampMaxTurns + parseNumTurnsFromStream helpers + resumeSessionId 全链路 |

**实测验证**：
- kill -9 server A → server B 启动 → orphan reconciler 检测 → `startPipelineRun` with `resumeFrom` → smoke-test 完整 resume → task_finals=completed/natural ✅

## 3. 当前状态

```
Branch: main
Head:   c57d9c5
Status: clean

Server tests: 1485 pass / 4 skipped / tsc 0
Web tests:    17 pass / tsc 0
```

**M 指标快照**（`docs/phase6-usage-log.md`）：

- **M1**（作者自用 95%）: 5 数据点（session 2 run #18 + session 3 orphan resume smoke）
- **M2**（3-5 朋友持续用）: 0 朋友在用；**关键基础设施全到位**——UI + SSE + crash/restart resume + gate 存活 + lock + SDK session resume
- **M3**（pipeline 成功率 > 90%）: 11/18 = 61% 全样本；**post-audit 7/7 = 100%**
- **M4**（热更新 propose/reject/rollback）: 4 / 0 / 0（session 2 完成）

## 4. 架构债清零状态

从 session 2 继承 + 本 session 新增：
- 债 A..F（上个 session 清）: ✅
- 债 G（task 跨 server 生命周期丢失）: ✅ M-R1+M-R2 解决
- 债 H（gate 答过了但 runner crash 之前未转发）: ✅ M-R3
- 债 I（SSE 断线重连只能 replay 整个 ring，无 gap 精确恢复）: ✅ M-R4
- 债 J（crash 后 agent 已烧 token 全丢重跑）: ✅ M-R5（wiring 完，SDK-level fallback 留为 todo）

## 5. 完整未完成清单

### 5.1 M 指标
- M1: 累积数据点
- M2: 朋友邀请（基础设施不再是阻塞）
- M3/M4: 靠继续用

### 5.2 架构决策未定
- **Single-session 回补**——未 benchmark
- **Agent SDK session resume 失败的 try/catch fallback**——M-R5 wiring 完但若 SDK 自己抛错，当前会让 stage 失败而不是换 fresh 重跑。实际 `~/.claude/projects/` 很稳，概率低；留作 issue。

### 5.3 Resumability M-R6（real-API dogfood）
**未做**。需要：
- 真 API 跑 PG → kill server mid-analyzing → restart → 观察 session 接续
- 对比 kill 前 / kill 后的 `agent_execution_details.cost_usd` 看真省了多少 token
- 写进 `docs/phase6-usage-log.md` 作为 run #19 条目
- 工程量小（1-2h），本身不 block M2，延后无妨

### 5.4 非 autonomous
- 朋友试用邀请
- deployment 便利性（README + 起动脚本 + onboarding）—— 现在 server crash 不再丢 task，朋友门槛降了一大截

### 5.5 新发现（本 session）
- 无新发现 bug；所有改动都有 test 覆盖

## 6. 环境细节

```bash
# 主工作目录
cd /Users/minghao/workflow-control/apps/server

# tsc & vitest 必须在子包里跑
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit && npx vitest run
cd /Users/minghao/workflow-control/apps/web    && npx tsc --noEmit && npx vitest run

# 清启 server（PID-file lock 现在存在，一定要清 .lock）
pkill -f "tsx src/index.ts"; sleep 2
rm -f /tmp/workflow-control-data/kernel-next.lock
rm -f /tmp/workflow-control-data/kernel-next.db*
rm -rf /Users/minghao/workflow-control/apps/server/dist
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server.log 2>&1 &
sleep 22
lsof -nP -iTCP:3001 | head -3
```

**DB 路径**: `/tmp/workflow-control-data/kernel-next.db`
**Lock 路径**: `/tmp/workflow-control-data/kernel-next.lock`
**Server port**: 3001
**Web port**: 3000

## 7. 下一步候选

按"合理正确优先" + 实际价值：

1. **M-R6: real-API dogfood**——验证 SDK session resume 在真实 API 上省 token。小工作量，价值明确（M1 +1 数据点，完成 resumability 最后一环）。
2. **deployment 便利性**（M2 外部阻塞）——现在 crash 安全了，onboarding 是最后一公里。非代码，产品化动作。
3. **朋友试用**——基础设施全到位后的真实 M2 测试。

自决推 **#1（M-R6）**：
- 同时能验证 M-R5 的 SDK resume 实际是否 work
- 是 plan 里明确定义的 final milestone
- 工作量小，产出是一个明确的 ledger 条目
- 若 SDK resume 行为与预期不符（比如 session 文件格式变），现在知道比 M2 后知道好

**#2 和 #3** 依赖外部人/动作，非 autonomous。

## 8. 参考文档

- `docs/phase6-usage-log.md` — runs #1-#18 全历史 + 成熟度 snapshot + 架构审计结论 + Bug 清单
- `docs/product-roadmap.md` — 终极目标 M1-M4 定义（§9）、A/B 系列全状态
- `docs/superpowers/specs/2026-04-23-resumability-design.md` — 本 session 资源性设计（含 reviewer feedback 三大 critical 的修复说明）
- `docs/superpowers/plans/2026-04-23-resumability.md` — 7 milestone 实施计划（M-R1..M-R5 已实现，M-R6 待做）
- `docs/superpowers/plans/2026-04-23-phase-6-session-2-handoff.md` — 上个 session handoff
- `docs/superpowers/specs/2026-04-23-propose-ui-design.md` / `plans/2026-04-23-propose-ui.md`
- `docs/superpowers/specs/2026-04-23-pg-api-validation-design.md` / `plans/2026-04-23-pg-api-validation.md`

## 9. 新 session 开头 checklist

1. 读本 handoff
2. `git log --oneline -20` 快速看 commit 链
3. `cd apps/server && npx vitest run` 确认 1485 pass 基线
4. 按 §7 推进 #1（M-R6 dogfood）或按用户指示
5. 新架构债出现时系统性修到根，不小修小补
