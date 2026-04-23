# Phase 6 — Architecture Audit Session Handoff

> **Date**: 2026-04-23
> **Outgoing session head**: commit `64699ec`
> **Next session start**: read this doc + `docs/phase6-usage-log.md` + `docs/product-roadmap.md` §9 (M1-M4 成熟度指标)

## 本 session 完成的工作

### 1. Phase 6 首轮 dogfood（run #1-#8）

启动 `kernel-next` 真实用，跑 builtin pipelines + AI 生成的 pipeline。
暴露 12 个 bug（P6-1..P6-12），大部分是之前未被 unit test 覆盖的真实集成问题。

### 2. 单点修复（按发现顺序）

- **P6-1** `task_finals` 权威终态表（commit `2985b13`）
- **P6-2** runPipeline 默认 timeout 10s → 30min（`79cdff4`）
- **P6-3** `.workflow/` 泄漏到仓库根 → `.gitignore`（`96eedd5`, `e30c21e`）
- **P6-8** `EMPTY_DATAFLOW` validator 拦空壳 IR（`5f78e21`）
- **P6-9** getTaskStatus 在 stage_attempts 空时错报 not_found（`dc5b3b8`）
- **P6-10** gate race：gate region consume GATE_ANSWERED 让 root 不跑（`7d34d81`）
- **P6-5/P6-6** pipeline name slug + URL-safe taskId（`ccd34b0`）
- **P6-12** `formatInputLine` 大 input 的 read_port 指向错 stage（`a02502c`）

### 3. B5 Confirm UI（commit 链 `2106a6d..b024842`）

- `GET /api/kernel/gates/:id/context` 返回 gate 的上游 stage outputs
- `GateCard` React 组件展示
- dashboard 两个 useEffect（status poller + context fetcher）接入
- P6-7（gate question 空洞）顺带解决

### 4. `pr-description-generator` 新 builtin pipeline

2-stage（fetchDiff → writePr），M1 dogfood 目标，commit `44e57a0`。
run #9, #12, #14, #15 均可用作真实 PR body。

### 5. 架构审计（用户指示"不小修小补"驱动）

审视 P6-1..P6-12，归纳**三条系统性债**，一次性修到根：

- **债 A**: task 生命周期多源真相 → `task_finals` 唯一权威 + 引入 `orphaned` state（`98ac034`）
- **债 B**: XState v5 parallel region event consumption → 清理 dead root handler + 审视其他 root on.X（`98ac034` 同）
- **债 C**: `propose()` 不支持 prompt 迭代（IR-only hash + 不写 `pipeline_prompt_refs`）→ 签名加 `prompts?`、用 `pipelineVersionHash`、carry + merge + rename-carry + `PROMPT_REF_MISSING` validate（`2103aa7`）

### 6. HTTP propose 端点（架构补完）

原先 propose 只通过 MCP 可达。新增 `POST /api/kernel/proposals`（`b99d9c1`），4 个新测试。

### 7. Run #15 验证

通过正规 HTTP propose → approve → run 路径做 prompt iteration，新 prompt 规则生效。
**M4 两个 data points 都 0 reject / 0 rollback。**

## 当前状态

- **main**: commit `64699ec`
- **测试**: 1429 passed / 4 skipped（apps/server）/ tsc 0
- **工作区**: 干净

```bash
git log --oneline -15
# 64699ec docs(phase6): run #15
# b99d9c1 feat(HTTP): POST /api/kernel/proposals
# bd62b30 docs(phase6): architecture audit summary
# 2103aa7 refactor(architecture): propose() carries+merges prompts
# 98ac034 refactor(architecture): task_finals is the ONLY truth
# 15757ca docs(phase6): runs #13-#14 first M4 data point
# a02502c fix(P6-12): read_port upstream source stage
# df040d4 feat(M4): multi-theme title rule + verb-first
# 9fb0cb6 docs(phase6): run #12 slug validation
# ccd34b0 fix(P6-5, P6-6): name slug + URL-safe taskId
# 500d1c2 docs(phase6): runs #9-#11 P6-10 resolved
# 7d34d81 fix(P6-10): gate region GATE_ANSWERED assign
# 44e57a0 feat(M1): pr-description-generator builtin
# b024842 docs(phase6): run #8 B5 validated
# 664ddaa feat(B5): render GateCard
```

## M1-M4 Snapshot

从 `docs/phase6-usage-log.md` 读：

- **M1** (自己 95% AI 编码流程用 workflow-control): 3 个真实 PR body 数据点
- **M2** (3-5 朋友试用): 0（部署便利性未做）
- **M3** (Pipeline 成功率 > 90%): 8/15 = 53% 全样本；post-audit 子集 4/4 = 100%
- **M4** (热更新成功率): 2 propose / 0 reject / 0 rollback

## 下一步候选（按原则自决或等用户指示）

**优先级排序**（上次我给的判断）：

1. **给 B5 UI 补 propose 入口** — M2 阻塞。现在 UI 只能 approve/reject 已有 proposal，不能**创建**。用 form 让用户填 `currentVersion` + 模式化 patch + prompts override，POST `/api/kernel/proposals`。我选这条。

2. **部署便利性 (M2 前置)** — 一键起 + public URL + 文档。3-5 人试用的硬前提。

3. **修 P6-8 root cause** — 现在靠 `EMPTY_DATAFLOW` 拦空壳，但 pipeline-generator 生成的 pipeline 还可能有 fanout 声明缺失等更细问题。想法：**persist stage submit 后自动 dry-run 确认能跑**，不能跑就 reject。

4. **继续积 M4 样本** — 边际递减。

5. **部署 web 到 public URL** — 给朋友试，M2 直接行动。

## 原则提醒（new session 读）

从 global `CLAUDE.md` + 用户已给指令累积：

- **永远用中文对话**。code comment 英文。
- **除明确需要决策，不停下来**——用户烦 "下一步怎么办" 问题。
- **决策只追求正确合理，不考虑成本**——token / 调用次数不是约束。
- **不小修小补**——真架构问题系统性修到根，测试 fixture 碰了就改 fixture，不用 fallback 兼容老行为。
- **严格 TDD，每 task 独立 commit 直接 main**——不建 feature branch（已授权）。
- **brainstorming 自己做 Q1/Q2/Q3** —— 不要让用户选 multiple choice，按原则自决。
- **skill 流程**：brainstorming → writing-plans → executing-plans → finishing-a-development-branch。但大多数小于 8 task 的 feature 可 inline execution（经验）。
- **forced verification**：每次说"完成"前必 `npx tsc --noEmit` + `npx vitest run`（from `apps/server`）。从 repo root 跑会扫 dist 误报。
- **永远不要运行不授权的 destructive git**（force push, reset --hard 等）。
- 我可以**自行起 server** 做 dogfood（用户明确授权了）。用 `cd apps/server && npx tsx src/index.ts`（不用 `pnpm dev` 的 `tsx watch`——watch reload 时序会干扰任务，虽然 P6-10 审计证明这不是 bug 根因但仍建议 non-watch 跑 dogfood）。

## 环境细节

- **DB 路径**: `/tmp/workflow-control-data/kernel-next.db`（会随重启丢，但 seed 自动重建）
- **Server port**: 3001
- **Dashboard**: `http://localhost:3000/kernel-next/<taskId>`（taskId 从 propose 返回拿，URL-safe 无 encode 需求 — P6-6 修后）
- **SSE stream**: `/api/kernel-next/tasks/:taskId/stream`
- **clean restart 惯用模式**:
  ```bash
  ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill
  sleep 2
  rm -f /tmp/workflow-control-data/kernel-next.db*
  cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server.log 2>&1 &
  sleep 20
  lsof -nP -iTCP:3001 | head -3
  ```

## 参考文档

- `docs/phase6-usage-log.md` — 所有 run 记录 + bug 详情 + 架构审计结论
- `docs/product-roadmap.md` — M1-M4 原始定义（§9）
- `docs/superpowers/specs/2026-04-23-b5-confirm-ui-design.md` — B5 spec（实现完）
- `docs/superpowers/plans/2026-04-23-b5-confirm-ui.md` — B5 plan（实现完）

## 未完成的 task

- `#69` 架构审计 — 已 complete（本 session 结束前标 completed）

## 建议 new session 开头做的事

1. 读 `docs/phase6-usage-log.md` 的"架构审计"和"Bug 清单"两节 + M 指标 snapshot
2. 读 `docs/superpowers/plans/2026-04-23-b5-confirm-ui.md` 了解 B5 形态（是否加 propose UI 的参考）
3. `git log --oneline -15` 快速看最近工作
4. 按当前优先级**推进 #1（B5 UI 加 propose 入口）**或等用户指示
5. 不再审计——三条架构债都解完了。继续是真实使用推动，不是代码层继续挖。
