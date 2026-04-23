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
| 9 | 2026-04-23 | Phase 6 Path 3: dogfood pr-description-generator | pr-description-generator | `PR Description Generator-1776909721698-d441911f` | completed ✅ | 229s, $0.23 | — | 非 watch 模式跑通。title 准确、summary 3 bullets OK、notable changes 有 2 个小编造（`gates()` 应为 `getGateContext()`；load-builtin-pipeline 只改 test）。**比手写快 ~5x**。M1 首个真实数据点 |
| 10 | 2026-04-23 | **P6-10 诊断：非 watch 下重跑 Pipeline Generator**（假说验证） | Pipeline Generator | `Pipeline Generator-1776909980634-8dcfaf27` | 仍 stuck after awaitingConfirm | 48s API 说 completed（fallback 派生） | P6-10 根因确认 | **watch 不是元凶**。真 bug：XState v5 下 gate 自身 region 的 GATE_ANSWERED transition fire 后消耗 event，root-level on.GATE_ANSWERED 不再运行 → gateAuthorizedTargets 永不更新 → downstream picked target 的 allInboundDelivered 返回 false → hang |
| 11 | 2026-04-23 | **P6-10 修后再跑 Pipeline Generator** | Pipeline Generator | `Pipeline Generator-1776911258984-66db2597` | completed ✅ 5 stages 全跑 | 241s, $0.612 | — | analyzing 40s → gate → approve → genSkeleton 25s → genPrompts 103s → persisting 82s。生成 pipeline `markdown-table-of-contents-generator` 的 IR schema 完整（3 stages / 3 wires / externalInputs 正确）。P6-10 真修了。M3 分数大幅跳升 |
| 12 | 2026-04-23 | P6-5/6 修后跑 pr-description-generator（用 slug name） | pr-description-generator | `pr-description-generator-1776912404019-3768f94f` | completed ✅ | 275s, $0.276 | — | taskId **无空格**（slug 合成）；HTTP 调用无需 URL encode；title `"fix(kernel-next): gate race condition + slug support + pr-generator"` 准确识别 3 条独立主线；body 3 bullets + 6 notable changes 全部对应实际 commit，**0 编造**（对比 run #9 有 2 处小编造）。M1 第二个数据点，质量比首跑更高 |
| 13 | 2026-04-23 | **M4 迭代**：改进 write-pr.md prompt（加 multi-theme 规则 + verb-first），对同 diff 重跑 | pr-description-generator (new hash `96ab20f8`) | `pr-description-generator-1776913226897-bd6a1d49` | API completed 但内容是 ERROR | 396s, $—（中断前分析） | **P6-12** | title=`"[no changes]"`；body=`"ERROR: upstream stage failed to produce diffText and commitMessages (port not found)"`。查 tool_calls：writePr agent 调用 `read_port(stage="writePr", port="diffText")` 读**自己**而非上游 fetchDiff → 404 → 假设上游失败 → 误写错误。**formatInputLine 把当前 stage 名传给了 read_port 指令**，这是 Phase 6 新发现的 bug |
| 14 | 2026-04-23 | **P6-12 修后再重跑 run #13**（同 prompt + 同 diff） | pr-description-generator (hash `96ab20f8`) | `pr-description-generator-1776914057309-9a5ad8e2` | completed ✅ | 277s | — | Title `"fix(kernel): P6-10 gate race + P6-5/6 slug + pr-description-generator"` 严格按新 multi-theme 规则（69 chars, verb 开头, 3 theme 用 ` + ` 连接）。Body 7 个 notable changes 全部对应 commit，0 编造。**M4 首个真实数据点**：prompt iteration 1 次，reject 0 次，rollback 0 次，新版本输出质量 > 旧版本 |

## 成熟度快照

- **M3 分子/分母**: 7 / 14（run #2,3,4,9,11,12,14 真 completed；run #1,5,6,7,10,13 API completed 但未全跑 / 内容错；#8 是 B5 API 验证）
- **真实成功率**: 7/14 = **50%**。P6-12 修后跑（run #14）继续成功，老 bug 堆积修完后新 runs 稳定
- **P6-10 + P6-12 修后子集**: 3/3 = **100%**（runs #11, #12, #14 全过；run #13 在 P6-12 修前）
- **M4 热更新 propose / reject / rollback**: **1 / 0 / 0** — 第一个真实数据点！（write-pr.md prompt 升级，新版本输出质量 > 旧版本，无 reject 无 rollback）
- **覆盖的 builtin + generated**: 4 ✅ （`smoke-test`, `Tech Research Collector`, `Pipeline Generator`, `pr-description-generator`） + 1 AI-generated IR 完整（`markdown-table-of-contents-generator`，未运行）; 1 pending: `Tech Research Writer`
- **AI-generated pipeline schema 可用率**: 1 / 2（run #4 空壳；run #11 IR 结构完整过 validator）

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

### P6-12 — buildSystemPromptAppend 把大 input 的 read_port 指令指错 stage ✅ 已修 (2026-04-23)

**发现**: run #13 pr-description-generator 的 writePr stage，43 KB diffText 超过 1 KiB inline 阈值 → system prompt 让 agent 用 `read_port` 读取。指令里 `stage: "writePr"`——当前 stage 名，**不是产出 port 的上游 stage 名**。agent 调 `read_port(stage="writePr", port="diffText")` 返回 port-not-found → 误写 `"ERROR: upstream stage failed"`。
**根因**: `formatInputLine(k, v, stage.name, ctx)` 传 current stage 名，缺 wire source 查找。
**修复**: `buildSystemPromptAppend` 接收 optional `ir` 参数；内部建 port→source stage 查表，formatInputLine 用上游 stage 名。legacy 调用（无 ir）仍 fallback 到 stage.name 不破坏现有测试。commit a02502c。
**影响**: 任何大于 1 KiB 的 cross-stage input（典型业务场景）自 size-aware 特性上线以来都有这个 bug。只因大部分 pipeline 的 inputs 小（或 agent 容错）才未被发现。M3/M4 数据未来受此影响显著。
**回归**: real-executor.empty-inputs.test.ts 新增一例。



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

### P6-10 — gate approve 后 downstream stage 不激活 ✅ 已修 (2026-04-23)

**现象**：run #6, #7, #10 在 pipeline-generator 下 gate approve 后 `genSkeleton` 从未 executed。
**真根因**（非 tsx watch 环境——已排除）：XState v5 下，gate 自身 region 的 `executingBody.on.GATE_ANSWERED` transition（guard=gateAnsweredIsMe）fire 后**消耗 event**。Root-level `on.GATE_ANSWERED` 的 assign 不再运行（最小 XState probe 确认）→ `gateAuthorizedTargets` 永不更新。上游 stage 仍在异步写 output ports 时 gate 已被 approve 的**典型 race**：downstream picked target 的 `allInboundDelivered` 短路于 `!context.gateAuthorizedTargets.includes(stage)` 为 false，即使之后所有 inbound wires 都 settle 也激活不了，machine hang。
**修复**：gate region 的 GATE_ANSWERED transition action **合并** root-level 的 `gateAuthorizedTargets/gateSkippedTargets` assign。因为 gateAnsweredIsMe 保证是自己的 answer，安全。commit 7d34d81。
**回归**：`gate-race-downstream.test.ts` 用自定义 StageExecutor 模拟分阶段 writePort + 外部 approve 信号；pre-fix timeout 15s，post-fix 52ms。生产验证 run #11: Pipeline Generator 5 stages 全跑 241s / $0.612，生成可用 IR。

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

### P6-5 — HTTP `run` 要求传 IR 显示名而非目录标识 ✅ 已修 (2026-04-23)

**现象**：`POST /api/kernel/tasks/run { name: "tech-research-collector" }` 返回 `UNKNOWN_PIPELINE`。
**修复**：采用方案 (b) —— `start-pipeline-run` 在 exact `pipeline_name` lookup 失败时 fallback 到 slug-equivalence scan（`slugifyPipelineName(stored) === slugifyPipelineName(input)` 即命中）。exact match 路径保留，完全向后兼容。commit ccd34b0。
**验证**：run #12 用 `"pr-description-generator"` 调 run，server 返回正确 versionHash。

### P6-6 — taskId 默认含空格（URL 编码障碍） ✅ 已修 (2026-04-23)

**现象**：`Tech Research Collector-1776879895803-4a4424cd` 这种 taskId 要 URL-encode。
**修复**：`startPipelineRun` 合成 taskId 时对 name 调用 slugifyPipelineName。如果 name 无 alphanumeric 内容（几乎不可能），fallback 到 `"task-"` 前缀。显式 `input.taskId` 原样通过作 escape hatch。commit ccd34b0。
**验证**：run #12 taskId = `pr-description-generator-1776912404019-3768f94f`，全程 URL 不需 encode。

### P6-2 — runPipeline 默认 10s timeout 对真实 agent 不可用

**发现时间**：2026-04-23
**根因**：`runPipeline(opts, timeoutMs = 10_000)` (`runner.ts:213`) 默认 10s。HTTP 入口 start-pipeline-run 没传 timeoutMs，所以走默认。真实 Claude Agent SDK 一次对话常见 30-120s。
**现象**：greet 单独跑了 33s → runner throws `runPipeline timeout after 10000ms` → start-pipeline-run catch 试图发 synthetic run_final=failed，但 **DB 的 stage_attempts 已经被 port-runtime 标为 success**（因为 executor 实际返回了）。
**影响**：任何真实 agent pipeline 都会在默认路径下超时。
**修复**：方向是"默认超时必须远大于 agent 单轮"；或改成显式必填；或不在 runner 层设默认。需要决策。
**回归测试**：待加。

---
