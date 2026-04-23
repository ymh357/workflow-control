# Phase 6 Session 2 — Handoff

> **Date**: 2026-04-23
> **Session head**: commit `3e36671`
> **Previous session handoff**: `docs/superpowers/plans/2026-04-23-phase-6-architecture-audit-handoff.md`（上一 session 结束在 commit `a2b076e`）

---

## 1. 原则（必读，新 session 别偏）

非 negotiable，对话每个决策点默认套这些：

- **中文对话**；code comment 英文；no emoji
- **合理正确优先，不考虑成本**——不要用"工作量大/成本高/务实"简化理由
- **除需决策外不停下来**——milestone 完了客观 self-review，通过就静默进下一个；不问"继续吗？"
- **每 milestone 客观 self-review**，结论写进 commit body
- **brainstorming 自决 Q1/Q2/Q3**，仅 scope 级取舍问用户
- **严格 TDD**（红→实现→绿→提交）
- **Git 每 task 独立 commit 直接 main**（已授权），**不 push 远端**
- **forced verification**：完成前 `npx tsc --noEmit` + `npx vitest run`（从 `apps/server` / `apps/web` 子包跑，**不是** repo root——root 会扫 dist 误报）
- **不小修小补**：真架构问题系统性修到根
- **不保 backward compat**（研发期；fixture 碰了改 fixture）
- **Investigate before claim gap**：任何"X 缺了"论断先读当前源码验证
- **读文件捆绑 edit**：改前必 Read；stale context → silent edit fail
- **cwd 漂移**：每 Bash 前 `pwd` 验证

## 2. 本 session 完成的工作（从 `a2b076e` 到 `3e36671`）

### 2.1 Propose UI 端到端（12 task / 7 milestone / M-A..M-G）

完整收尾 M2 解锁基础设施。关键 commits：

```
92c71b9 docs(propose-ui): spec for browser-based proposal creation (M2 unblock)
070c6c5 docs(propose-ui): implementation plan, 12 tasks across 7 milestones
c0d2504 refactor(ir-patch): relax ops.min(1) — empty ops is legitimate shape
7b5a688 refactor(route): propose body schema accepts ops:[]
890805a feat(propose): NO_OP_PROPOSAL replaces ops.min(1) as the "no change" guard
341269b feat(api): GET /api/kernel/pipelines — list pipelines with latest version
2d87964 feat(api): GET /api/kernel/pipelines/:versionHash — IR + prompts + meta
7e4d249 feat(proposals): listProposals returns pipelineName via JOIN
21dc35d feat(ui): PromptsEditor — multi-textarea editor
6a5d6e3 feat(ui): /kernel-next/pipelines — list page
37aeb3f feat(ui): /kernel-next/pipelines/[name] — editor page
aa10ff1 feat(ui): /kernel-next/proposals — list + approve/reject
a71d946 feat(ui): nav links (+ zh/en i18n)
d2a7748 docs(phase6): run #16 — Propose UI end-to-end dogfood + M2 unblocker
```

**A+ 架构**：`propose()` 现在接受 `{ops:[], prompts:{...}}`——prompts-only 提案是合法形态；`NO_OP_PROPOSAL` 在 `proposedHash === currentVersion` 兜底。彻底退役 run #15 的 workaround。

### 2.2 第二轮细修（6/7/4 组做 4 项、skip 3 项）

原则驱动：合理正确就做，投机性就 skip。

| 项 | 状态 | commit |
|---|---|---|
| P6-4 smoke-test IR + prompt 补 externalInputs | ✅ | `4ec44c8` |
| F3 per-task workspace cwd（agent SDK options.cwd） | ✅ | `994badf` |
| 7A getGateContext fanout-preserved audit（SQL 改 attempt_id match + CASE ordering） | ✅ | `d494000` |
| B5 SSE `wf.hotUpdatePending` broadcast + nav badge | ✅ | `537cf64` |
| F4 runPipeline timeout 必填 | ❌ skip | 30min 默认无 bug，改只是洁癖 |
| F5 persist.md prompt 硬化 | ❌ skip | EMPTY_DATAFLOW 已兜；prompt 硬化效果不可测 |
| 7B propose_pipeline_fix real-API smoke | ❌ skip | synth smoke 已覆盖；wrapper isSafeRangePatch 已 unit-tested |

### 2.3 PG API 验证（run #17）

Roadmap §6.3 的"4 个 builtin 用 pipeline-generator 重新生成"按用户指示调整为 B→A 方案：**真 API 跑 PG 一次，产出不入 builtin，只进 DB，归档文档**。

```
1286799 docs(pg-api-validation): spec
9a95112 docs(pg-api-validation): plan
3e36671 docs(phase6): run #17 — PG real-API tech-research validation
```

产出：
- `research-report-generator` 2-stage pipeline（`collectSources` → `generateReport`）
- validator 绿 / 所有 prompt refs 齐 / 0 extraneous
- smoke 端到端 completed，产出 6867-byte markdown report
- **Finding**：PG **不产** `store_schema` 顶层字段（A3 迁移的真实 gap；4 个现行 builtin 的 schema 是 Phase 4.5 T5 手工镜像补的，PG 自己没被教会产出）

## 3. 当前状态

```
Branch: main
Head:   3e36671
Status: clean

Server tests: 1454 pass / 4 skipped / tsc 0
Web tests:    17 pass / tsc 0
```

**M 指标快照**（`docs/phase6-usage-log.md`）：

- **M1**（作者自用 95%）: 4 个真实 PR body + 1 个 PG-generated 研究报告端到端跑通 → 5 数据点
- **M2**（3-5 朋友持续用）: 0 朋友在用；**UI + SSE 基础设施完成**，朋友在本机能全程 GUI 操作
- **M3**（pipeline 成功率 > 90%）: 10/17 = 59% 全样本；**post-audit 6/6 = 100%**
- **M4**（热更新 propose/reject/rollback）: 3 / 0 / 0（样本小）

## 4. 架构债清零状态

上个 session 归纳的 3 条系统性债全部修完：
- 债 A（task 生命周期多源真相 / P6-1+P6-9）: ✅ `task_finals` 唯一权威
- 债 B（XState v5 parallel event consumption / P6-10）: ✅ gate region 自 assign
- 债 C（propose prompt iteration / P6-11）: ✅ `pipelineVersionHash` + carry + merge + rename-carry + PROMPT_REF_MISSING

本 session 新修：
- 债 D（propose"非 no-op"识别语义）: ✅ `NO_OP_PROPOSAL` with `proposedHash === currentVersion`
- 债 E（getGateContext fanout-preserved 漏选）: ✅ SQL 改 attempt_id match + CASE ordering
- 债 F（agent 写 cwd 污染 server 根目录 / P6-3 根因）: ✅ `{DATA_DIR}/workspaces/{taskId}` 默认 cwd

## 5. 完整未完成清单（auto-generated 状态）

### 5.1 M 指标（非代码，需真实使用）

- M1: 继续累积数据点
- M2: 外部朋友邀请
- M3/M4: 分母涨靠继续用（UI/SSE 已就位）

### 5.2 架构决策未定

- **Single-session 回补决策**——未做 benchmark（prompt caching + read_port MCP 优化→ 对比 legacy R1）。若决定回补，4-8 周工程

### 5.3 B 系列 / 依赖 single-session

- B12 摘要注入（multi-session 等价物 port-level summary handoff）

### 5.4 非 autonomous（需用户外部行动）

- 朋友试用邀请
- ~~4 个 builtin 用 PG 重新生成~~——run #17 用 B→A 方案满足 spec intent：证明 PG 能端到端产合法 pipeline；**真正要替换 builtin 不做**（按用户指示 run #17 为试验不入 builtin）

### 5.5 Phase 6 低优先（已判定）

- F4（timeout 必填）: skip——洁癖
- F5（persist 硬化）: skip——EMPTY_DATAFLOW 已兜
- F2（非空壳但 stage orphan 校验）: skip——投机性，未观察到

### 5.6 autonomous 小候选（已判定）

- 7A lineage audit: ✅ 做完
- 7B propose_pipeline_fix real-API smoke: skip——重复工作

### 5.7 真正剩余（新发现或延续）

- **PG store_schema 产出 gap**（run #17 finding）—— PG 的 genSkeleton / genPrompts prompts 未教它产 store_schema。若要 A3 "AI 代写 YAML 含 schema" 真正成立，得升级 PG 的 prompts。这是一个**具体的 prompt iteration 任务**，自然要走 Propose UI：加"produce store_schema"规则进 PG 的 prompts。scope 小，但需要真跑 PG 再次验证改动生效（烧 API token）
- **deployment 便利性**（M2 最后一公里）——朋友在自己机器上 onboard。需要：README 清理 / 起动脚本 / 依赖说明 / preflight 报错人性化
- **resumability**（replace B12）——长 task 跨 server 重启怎么恢复 runner actor + task_registry。当前 server kill 就丢 in-memory state。这是 Phase 5C 未做部分的自然延续。工程量中

## 6. 环境细节（新 session 直接抄）

```bash
# 主工作目录
cd /Users/minghao/workflow-control/apps/server

# tsc & vitest 必须在子包里跑（不要在 repo root，会扫 dist 误报）
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit
cd /Users/minghao/workflow-control/apps/server && npx vitest run
cd /Users/minghao/workflow-control/apps/web    && npx tsc --noEmit
cd /Users/minghao/workflow-control/apps/web    && npx vitest run

# 清启 server 惯用模式（build cache 可能带旧 dist → 需 wipe）
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill
sleep 2
rm -f /tmp/workflow-control-data/kernel-next.db*
rm -rf /Users/minghao/workflow-control/apps/server/dist   # 关键：tsx 偶会解析到旧 dist
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server.log 2>&1 &
sleep 22
lsof -nP -iTCP:3001 | head -3
```

**DB 路径**: `/tmp/workflow-control-data/kernel-next.db`（会随 /tmp 清或手工 rm 丢）
**Server port**: 3001
**Web port**: 3000（`npx next dev -p 3000`）
**Dashboard**: `http://localhost:3000/kernel-next/<taskId>`、`/kernel-next/pipelines`、`/kernel-next/proposals`

## 7. 下一步候选（按原则排序）

按"合理正确优先"+ 当前 gap 实际价值：

1. **PG store_schema 升级**——具体可做：用 Propose UI 发一个 prompts-only 提案给 PG，加一条"`genSkeleton` 必须产出 `store_schema` 顶层字段"的规则，approve，再跑 run #18 验证。工作量小、价值明确（A3 真正完成）、同时是 M4 数据点+1
2. **deployment 便利性**（M2 外部阻塞）——README + 起动脚本 + onboarding。不是代码架构，是产品化动作
3. **resumability**（B12 替换）——工程量中，需要单独 spec

按原则自决推 **#1（PG store_schema 升级）**。这是唯一"autonomous 可做 + 消灭一个具体 gap"的候选。

## 8. 参考文档

- `docs/phase6-usage-log.md` — runs #1-#17 全历史 + 成熟度 snapshot + 架构审计结论 + Bug 清单
- `docs/product-roadmap.md` — 终极目标 M1-M4 定义（§9）、A/B 系列全状态
- `docs/superpowers/specs/2026-04-23-propose-ui-design.md` / `plans/2026-04-23-propose-ui.md` — Propose UI 落地
- `docs/superpowers/specs/2026-04-23-pg-api-validation-design.md` / `plans/2026-04-23-pg-api-validation.md` — run #17
- `docs/superpowers/plans/2026-04-23-phase-6-architecture-audit-handoff.md` — 上个 session handoff（架构审计结论）

## 9. 新 session 开头 checklist

1. 读本 handoff
2. `git log --oneline -20` 快速看 commit 链
3. `cd apps/server && npx vitest run` 确认 1454 pass 基线（如果数字飘 ±5 一般是 I/O 噪声，定向重跑）
4. 按 §7 推进 #1（PG store_schema 升级）或等用户指示
5. 不要再小修小补；新架构债出现时系统性修到根
