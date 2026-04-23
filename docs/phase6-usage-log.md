# Phase 6 — Usage Log

真实任务执行记录。按 §9 M1-M4 成熟度指标驱动。

**M1**: 自己 95% AI 编码流程能用 workflow-control 完成
**M2**: 3-5 个开发者持续使用
**M3**: Pipeline 成功率 > 90%（completed / total）
**M4**: 热更新成功率高（AI 提议的热更新不需 reject / 回滚）

---

## 运行台账

| # | 日期 | 任务描述 | Pipeline | taskId | 状态 | 耗时 | 发现的 bug | 备注 |
|---|---|---|---|---|---|---|---|---|
| 1 | 2026-04-23 | 空 seed 首跑 smoke-test | smoke-test | smoke-test-1776877365350-d4192d2a | API 返回 completed（**实际 timeout**） | 33s agent / 10s timeout | P6-1, P6-2 | 只跑了 greet；echoBack 从未启动；getTaskStatus 谎报 completed |
| 2 | 2026-04-23 | 修完 P6-1 P6-2 后 smoke-test 干净重跑 | smoke-test | smoke-test-1776879763943-0d93c5ef | completed ✅ | 26s，2 stage 真跑完 | P6-4 | task_finals=completed/natural；cost $0.073；但 prompt 期望 "task text" 而 IR 无 externalInputs，agent 走 fallback 路径输出"unknown"——设计层契约不一致 |
| 3 | 2026-04-23 | 研究 zod（TypeScript validation 库）| Tech Research Collector | `Tech Research Collector-1776879895803-4a4424cd` | completed ✅ | 170s agent，$0.294 | P6-5, P6-6 | 真实有用的报告：19 sources 尝试 / 12 成功 / Zod 42.5k stars；taskId 含空格（URL 不友好）；HTTP `name` 要传 IR 显示名而非目录名 |
| 4 | 2026-04-23 | 让 AI 写个 github-onboarding pipeline | Pipeline Generator | `Pipeline Generator-1776880477238-0b86754c` | completed ✅ | 275s agent total，$0.355，gate 等待 118s | P6-7, P6-8 | 5 stages 全跑完 + gate + approve；但 persisting 提交的 IR 是空壳（I/O 全丢） |
| 5 | 2026-04-23 | 跑 AI 生成的 github-onboarding pipeline | (AI-generated) | `GitHub Repository Onboarding Generator-1776880884097-ab079f23` | not_found → **completed 空跑** | 瞬完成 | P6-9 | 空壳 IR 立刻 onDone，无任何 stage 执行；pre-fix status=not_found，post-fix completed |
| 6 | 2026-04-23 | P6-8 修复后再跑 pipeline-generator #1 | Pipeline Generator | `Pipeline Generator-1776882328721-1dcf0df9` | **stuck after awaitingConfirm** | 60s 后 API 说 completed 但只跑 3 stage | P6-10 | gate approve 后 downstream genSkeleton 从未激活；task_finals 未写 |
| 7 | 2026-04-23 | P6-8 修复后再跑 pipeline-generator #2 | Pipeline Generator | `Pipeline Generator-1776882481413-463158c6` | 同上 | 75s | P6-10 | 同一症状复现；tsx watch 可能是环境元凶 |
| 8 | 2026-04-23 | **B5 Confirm UI 端到端验证**（API 路径，无浏览器手测）| Pipeline Generator | `Pipeline Generator-1776908172804-66cc82d1` | **gate context API 正确返回全 16 port**；approve 流转到 genSkeleton | analyzing 22s → gate → approve 即时转发 | — | P6-7 resolved：`GET /api/kernel/gates/:id/context` 返回 `upstreams[0].stage=analyzing` 和 16 个 outputs（summary/stageDesign/dataFlowSummary 等），answerOptions=["approve","reject"]；404 unknown gate 验过。UI 层由 GateCard + page.tsx 两个 useEffect 接入 |

## 成熟度快照

- **M3 分子/分母**: 3 / 7（run #2,3,4 真 completed；run #1,5,6,7 API 说 completed 但实际未全跑）
- **真实成功率（API completed 中真正完整跑完的）**: 3/7 ≈ 43%，远低于 M3 目标 >90%
- **M4 热更新总数 / reject + rollback 次数**: 0 / 0
- **覆盖的 builtin**: 3 / 4 （✅ `smoke-test`, ✅ `Tech Research Collector`, ✅ `Pipeline Generator`（但不稳定）, `Tech Research Writer` pending）
- **AI-generated pipeline 实际可用率**: 0 / 1（产出了 pipeline_version 但 IR 是空壳）

## 结论：B5 / B12 决策（基于实际使用数据）

### B5 Confirm UI — 建议：**高优先级，立刻做**

理由，**基于 run #4 和 run #6,#7 的实际观察**：

1. 当前 gate `"question": { text: "Approve this result?" }` 完全没有给用户判断依据。Run #4 里 user（我）不得不**去 DB 查 analyzing 输出**才能决定 approve/reject。这破坏了 gate 的产品意义——gate 应该是"用户看一眼就能决策"的交互点。
2. 当前答 gate 的唯一渠道是 `curl -X POST`，对"开朋友试用（M2）"完全不可行。
3. B5 能同步解决 P6-7（gate question 缺 context）：Confirm UI 必须渲染 analyzing 输出的 summary/stageDesign/pipelineName 才能做出有意义的决策，UI 实现必然顺带把 question template 问题一起解决。

**不做 B5 的代价**：M2 = 0（无人愿意通过 curl 看 raw JSON 来做决策）。这是阻塞 M2 的**唯一**最大问题。

### B12 Single-session 回补 — 建议：**不做，替换为 resumability**

理由：

1. **B12 原始动机**是热更新后 resume 时，在同一 Claude Agent session 里"重放已执行 stage 的 compact prompt"以保持连续性。但 Phase 6 实际使用中，**热更新还没发生过**（M4 分母=0），也就没有验证这个假想的价值。
2. **B12 的代价很具体**：需要 session 快照 + compact prompt 存储 + per-message replay 协议。额外数据模型 + Claude Agent SDK 集成。
3. **P6-10 暴露的才是真阻塞**：runner 连 **tsx watch reload** 都无法 survive，跨 process resume 根本没做（内存 taskRegistry 丢失时 gate 永远卡住）。这是**通用 resumability 问题**，和 single-session token 节约完全不同主题，但优先级高得多。
4. **替换动作**：把 B12 的预算投到 **"跨 process runner resumption"**——pending gate + stage attempt 已经在 DB，还缺 "哪些 runner 在等哪个 gate" 的持久化 + server 启动时扫描 DB 重建 taskRegistry 条目 + 从 snapshot 重建 XState actor。这本质是 Phase 5C/5D 做了一半的 worktree ownership 契约要延伸到 runner actor ownership。
5. **Single-session token 成本**：等 M2 出现真实反馈再说。目前一次 pipeline-generator 真跑 $0.355，没人抱怨过 token 成本。

**做 B12（single-session）**的净效果：未验证的 token 节约 vs 明显的 resumability 不稳定。**不做 B12，做 resumability**净效果：M3 从 43% 提到 >90% 的硬路径。

## Bug 清单

按发现时间倒序。每条给出：发现场景 / 根因 / 修复 commit / 回归测试。

### P6-1 — getTaskStatus 把"只跑了一部分 stage"误判为 completed

**发现时间**：2026-04-23，首次 Phase 6 真实跑 smoke-test
**taskId**：smoke-test-1776877365350-d4192d2a
**现象**：HTTP `GET /api/kernel/tasks/:taskId/status` 返回 `status=completed`，但 DB 里 `stage_attempts` 只有 `greet` 一行（success）；`echoBack` 从未被 create。
**根因**：`KernelService.getTaskStatus` (`kernel-next/mcp/kernel.ts:1003-1018`) 只基于 stage_attempts latest 派生状态 —— "有 success 的 greet + 没有任何 running/error = completed"。但 IR 里还有 echoBack 这个声明但未到达的 stage。没有 task-level 权威 final 记录。
**影响**：API 对调用方撒谎。更严重：如果 runPipeline 因 timeout/异常退出，DB 残留"前几个 stage success"，从调用方看就是成功完成。
**关联 bug**：同次运行暴露 P6-2（默认 timeout 太短）；两者叠加才让这个 bug 显现出来。
**修复**：待设计（需要一张 task_finals 表或等价的权威终态信号）
**回归测试**：smoke-test.linear-two-stage.test.ts（已证明 mock runPipeline 下两 stage 都能跑，所以 bug 只在"runPipeline 异常退出后 status 端点"路径）

### P6-10 — gate approve 后 downstream stage 不激活（生产环境复现）

**现象**：run #6, #7 在 pipeline-generator 下 gate approve 后 `genSkeleton` 从未 executed。`task_finals` 也没写——runner.finally 未达成，进程应还活着但卡住。
**根因假说**（未确认）：`pnpm dev` = `tsx watch` 检测到代码变化触发 reload → node process 重启 → 内存 `taskRegistry` 清空 → 原 runner 的 dispatcher 句柄丢失 → HTTP /gates/:id/answer 路由在新 process 里 `taskRegistry.get()` 返回 undefined → `dispatcher?.send(GATE_ANSWERED)` 静默丢弃 → machine 永远卡在 gate executing。
**代码层验证**：`gate-resume-downstream.test.ts` 在 mock runPipeline + 同进程 auto-approve 下 gate 路径正常完成。排除了编译层和 runner 层 bug。
**确认路径**：用 `pnpm start` (non-watch) 重跑 pipeline-generator，看是否稳定完成。如果稳定 → 确认是 tsx watch reload 的环境 bug，**真实部署不用 tsx watch 所以非阻塞**。
**如果是跨进程 reload 也要修**：runner 跨 process 不可恢复（无 checkpoint 指向"曾经等过某 gateId"）——这本是 B 系列的 resumption 问题，需要把 pending gate + dispatcher hook 从内存搬到 DB，restart 时 rehydrate runner。这是本来的 Phase 5C/5D 范围但没做。**或**：接受"tsx watch 环境下 reload 会让任务悬挂"但在生产 non-watch 下不 reload 所以 OK。

### P6-7 — Gate question 空洞无信息 ✅ 已修 (via B5)

**现象**：pipeline-generator 的 `awaitingConfirm` gate 问 "Approve this result?"；user 看不到 analyzing 输出，无法判断。
**根因**：gate.config.question.text 是静态字符串，没拼接 analyzing 的关键输出（summary / stageDesign / pipelineName）。
**修复 (B5)**：2026-04-23 新增 `GET /api/kernel/gates/:id/context`：按 IR wires 追溯 gate 的 upstream stages，返回它们的全部 latest success output ports。dashboard GateCard 组件展示。run #8 验证：pipeline-generator gate 现在暴露 analyzing 的全部 16 个 outputs（summary / stageDesign / dataFlowSummary / pipelineName / stageContracts 等）给用户作决策依据。commit 链 2106a6d..664ddaa。

### P6-8 — pipeline-generator 的 persist stage 向 submit_pipeline 传空壳 IR

**现象**：analyzing / genSkeleton 都正确产出带 I/O 的 IR；persisting 的 input `ir` port 也正确收到完整 IR；但 persisting agent 调 `submit_pipeline` 时却把 IR 的每个 stage 的 `inputs=[]` `outputs=[]` 并丢掉 `externalInputs`。连续 5 次尝试都是空壳，最后一次连 `wires` 也删干净。
**根因**：LLM 在 persist prompt"verbatim"约束下仍自作主张"simplify" IR。kernel 层 PipelineIRSchema.parse 对这个空壳合法接受。
**影响**：AI 生成的 pipeline 名义成功实际不可用（P6-9 的 stuck "not_found" 就是这个 bug 的症状）。M4 热更新成功率的"基础成功率"指标直接归零——连生成都错，热更就更别谈。
**修复方向**：(a) 在 submit_pipeline 层面加 **语义拒绝**："stage 声明 wire 但无 I/O port 匹配" → reject。(b) 强化 persist prompt，禁止 any mutation，加 post-submit 校验"stage 数 × 平均端口数 > 0 else abort"。先做 (a)——代码层硬约束比 prompt 文案可靠。
**关联 bug**：P6-9（空壳 IR 让 getTaskStatus 报 not_found）。

### P6-3 — pipeline 在 server cwd 下写 `.workflow/` 污染工作区（已消除误解）

**更新 2026-04-23**：不是测试残留。是 tech-research-collector 第一个 stage 的 prompt 指定 `reportPath=".workflow/primary-sources-<target>.md"`，agent 用 `Write` 工具把报告写到 **server 进程 cwd（apps/server/）的 .workflow/**。smoke-test 那次的 `.workflow/primary-sources-unknown.md` 是空 seed 下 agent prompt 被强行走 collector 风格的副作用。
**根因**：agent 有 FS 写权限 + prompt 让它把 reportPath 当实际路径用。不是污染仓库，是 agent 按 prompt 的契约完成工作；但这些文件不该进 git。
**修复思路**：加 `.gitignore` 条目（`**/.workflow/`）+ 让 cwd 指向 `{data_dir}/workspaces/<taskId>/` 而非 server cwd；后者是 Phase 5C worktree 接入的自然扩展。先加 gitignore 堵血路。

### P6-4 — smoke-test prompt 与 IR 契约不一致

**现象**：`greet.md` 说"Read the user's task text"，但 smoke-test IR 无 `externalInputs`，所以没有渠道把 task text 给 agent。agent 执行时读不到 → 按 fallback 输出 "Empty or unreadable task text received."。
**根因**：smoke-test IR 停留在"echo back 能运行"这一级验证，没设计真实用户输入通路。
**修复**：给 smoke-test IR 加 `externalInputs: [{ name: "task_text", type: "string" }]` 和对应 wire 到 greet.inputs。低优先级——这只是 builtin pipeline 自身的完整性问题，不阻塞系统功能。

### P6-5 — HTTP `run` 要求传 IR 显示名而非目录标识

**现象**：`POST /api/kernel/tasks/run { name: "tech-research-collector" }` 返回 `UNKNOWN_PIPELINE`；必须传 `"Tech Research Collector"`（IR.name）。
**根因**：`start-pipeline-run` 按 `pipeline_versions.pipeline_name` 查找，而 `seedBuiltinPipelineByName` 调用 `svc.submit(loaded.ir, ...)` 把 IR.name 作为 pipeline_name 写入。目录名 vs 显示名不对应。
**修复**：两条路，任选—— (a) 统一用目录名作为 pipeline_name（改 IR.name 或另加字段）； (b) 允许 `run` 按模糊 match（目录名/IR.name 都认）。先采 (a)：IR.name = 目录名是唯一 SSO 原则。

### P6-6 — taskId 默认含空格（URL 编码障碍）

**现象**：`Tech Research Collector-1776879895803-4a4424cd` 这种 taskId 在 HTTP path 里要 URL-encode；SSE URL 更麻烦。
**根因**：`startPipelineRun` 合成 taskId = `${pipelineName}-${ts}-${rand}`。pipelineName 有空格时 taskId 就坏了。
**修复**：合成时 slugify pipelineName（`/[^a-zA-Z0-9-]/g -> '-'`）。与 P6-5 根治方案（IR.name 保持目录标识）重合：两问题一并解决。

### P6-2 — runPipeline 默认 10s timeout 对真实 agent 不可用

**发现时间**：2026-04-23
**根因**：`runPipeline(opts, timeoutMs = 10_000)` (`runner.ts:213`) 默认 10s。HTTP 入口 start-pipeline-run 没传 timeoutMs，所以走默认。真实 Claude Agent SDK 一次对话常见 30-120s。
**现象**：greet 单独跑了 33s → runner throws `runPipeline timeout after 10000ms` → start-pipeline-run catch 试图发 synthetic run_final=failed，但 **DB 的 stage_attempts 已经被 port-runtime 标为 success**（因为 executor 实际返回了）。
**影响**：任何真实 agent pipeline 都会在默认路径下超时。
**修复**：方向是"默认超时必须远大于 agent 单轮"；或改成显式必填；或不在 runner 层设默认。需要决策。
**回归测试**：待加。

---
