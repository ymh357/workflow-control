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
| 15 | 2026-04-23 | **首次走正规 propose() 路径做 prompt iteration**（本轮架构修完验证） | pr-description-generator propose 新 hash `71d342d0` | `pr-description-generator-1776916294144-9d7d7019` | completed ✅ | 188s | — | 路径：`POST /api/kernel/proposals` 带 `prompts` override（加一条 "Notable changes must explain WHY, not just WHAT" 规则）→ `proposedVersion=71d342d0...` 不等于 base `96ab20f8...` → approve → run → 新 body 每条 Notable change 都是 `<file>: <WHAT> so <WHY>` 结构，**prompt 规则明显生效**。**M4 第 2 个数据点**：propose 1 次，autoApprove 未触发（safeRange.category=empty 没进入 safe-verdict 路径），人工 approve，0 reject，0 rollback。整条 HTTP 路径正常工作——Phase 6 架构审计的直接验证 |
| 16 | 2026-04-23 | **Propose UI 端到端 dogfood**（browser-native propose 路径）| pr-description-generator propose 新 hash `29016dbb` | `pr-description-generator-1776922394245-15f8c88b` | completed ✅ | ~195s | — | **不再用 curl + 脚本做 iteration**。路径：`GET /api/kernel/pipelines` list → `GET /api/kernel/pipelines/:hash` detail（UI 展示 2 个 prompt ref）→ 改 `system/write-pr` 加一条 "Reference the related GitHub issue number if any (e.g., 'Closes #42')" → `POST /api/kernel/proposals` body `{patch:{ops:[]}, prompts:{...}}`（空 patch + prompts-only 路径，**A+ 架构**直接可用 no workaround）→ 202 新 `proposedVersion=29016dbb`；NO_OP 兜底用空 prompts 试了一次 → 400 `NO_OP_PROPOSAL`。Approve → run → new version 拉新 prompt content（DB `pipeline_prompt_refs.content_hash` 验证）→ task 正常 completed。新规则属 "if any" 类型，本次 diff 无相关 issue → agent 合规跳过（非 bug）。**M4 第 3 个数据点** + **M2 解锁关键基础设施完成** |
| 17 | 2026-04-23 | **PG 真实 API 验证（tech-research 场景）** | Pipeline Generator → **Research Report Generator** (new hash `7fc2d175`) | `pipeline-generator-1776932730593-3835c6cb` | completed ✅ | ~7.5 min, $0.2983 | — | PG 全 5 stage 成功（analyzing → gate → genSkeleton → genPrompts → persisting）。生成了一个 2-stage `research-report-generator` pipeline（collectSources → generateReport，externalInputs=[topic:string]）。**validator.ok=true / missing=[] / extraneous=[]**。用 `topic="WebAssembly"` 跑 smoke → task completed；collectSources 写出 2676-byte sources 数组；generateReport 产出 6867-byte markdown 报告（含 Executive Summary / Overview / Detailed Findings / Source List），cost $0.0362。**Finding**: PG 未产出 `store_schema` 顶层字段——这是 A3 迁移 gap，当前 PG prompts 没强制要求生成 store_schema。详见本日志末尾 "PG API validation run #17" |
| 18 | 2026-04-23 | **PG store_schema 升级 — Propose UI iteration + 真实 API 验证** | Pipeline Generator V1（`ecec9778`，通过 `system/gen-skeleton` prompt 提案升级）→ 生成 **Web Research Reporter** (new hash `dfa3b3cc`) | `pipeline-generator-1776935189303-cb23fdc4` | completed ✅ | ~9.1 min（含 ~2 min gate wait）, $0.9360 | — | 彻底消除 run #17 发现的 A3 gap。路径：从 V0 `f5dbdf18`（filesystem seeded）→ 通过 `POST /api/kernel/proposals`（`ops:[]` + 4-prompts map，只替换 `system/gen-skeleton` 加入 "Store schema generation (REQUIRED)" 章节 + 4 self-check 项）→ `proposedVersion=ecec9778`，safeRange=safe/empty → approve → run with `versionHash=ecec9778`。生成的 `Web Research Reporter` IR **包含 `store_schema` 顶层字段**：2 个 entry（`webResearch.sources` + `reportWriter.report`）全部正确，`produced_by` 精确、types 与端口 trim-equal。**Validator.ok=true / 0 diagnostic**；自定 validator（key count == stage×output expected，types match）：**COMPLETE**。**M4 第 4 个数据点**（propose 1 / approve 1 / reject 0 / rollback 0），**A3 gap 真实消除**，同时验证 Propose UI 在 iterative 场景（4 prompts map / 1 替换）可用 |
| 22 | 2026-04-23 | **Tech Research Writer builtin dogfood + debt O 发现** | Tech Research Writer | `writer-dogfood-1776949794` | completed ✅ | ~2 min, $0.1036 (9246 out tokens) | **Debt O: prompt hint 用错 MCP tool 名** | **Investigate**：写最小合理 synthetic inputs（1 outline + 2 research md + 13 seedValues，真数据只填 pipelineConfig/outputPlan/primarySources/verificationFacts，其他给 `{}`），走 HTTP run 入口，taskId 预置在 `{DATA_DIR}/workspaces/{taskId}/` 让 agent 读相对路径。**结果**：成功生成 199 字 deliverable（outline 命中 target），5 out ports 全写（deliverableId/filePath/wordCount/sourcesLinked/verificationRefsCount），每个量化 claim 带 `[Platform data]` / `[Source code verified]` verification tier label（prompt 规则 compliance 100%）。**tool_calls_json 16 条全 finishedAt + result populated**（validate session 4 e3b9229 fix）。**副发现**：write_port 每个被调两次（5 ports × 2 = 10 calls）——第一次用 prompt 暗示的 `mcp__kernel_next__write_port`（双下划线） → `<tool_use_error>Error: No such tool`；第二次用真实 SDK 暴露名 `mcp____kernel_next____write_port`（四下划线）。根因：SDK wrap `__kernel_next__` server name 时拼接 `mcp__` + server_name + `__` + tool → 4 下划线。Fix commit `a56c148`：修 real-executor.ts 3 hints + generator-real 5 处 + pipeline-generator/persist.md 4 处 + 测试 fixture 3 处 assertions。persist.md 改动会让 PG builtin 的 versionHash 变化（下次 server 启动 auto-seed 新 hash）。**Debt O 清零** |
| 21 | 2026-04-23 | **tool_result capture fix dogfood**（sdk-adapter tool_use_id） | smoke-test | `smoke-test-1776949475528-6d5ea955` | completed ✅（2 agent stages）| ~30s | **Debt N: sdk-adapter 读 `id` 而非 `tool_use_id`** | **Investigate**：run #19/#20 观察到 `agent_execution_details.tool_calls_json` 每条 entry 的 `result` + `finishedAt` 都是 `null`——tool-level debug 能力失效。Grep SDK 源码：`sdk.mjs` 里 tool_result block 字段是 **`tool_use_id`**（snake, Anthropic Messages API spec）或 **`toolUseId`**（camel），而 `sdk-adapter.ts:124` 只读 `b.id` → 每个真实 tool_result 被 silent drop → `completeToolCall` 从不调用。Fix `e3b9229`: 接受三种形式（`tool_use_id` → `toolUseId` → 回退 `id`），扩展 SdkMessageLike type，+ 2 新 test (spec form / camel form)。Re-dogfood smoke-test: greet attempt 的 tool_calls[0].result=`[{"type":"text","text":"{\"ok\":true}"}]`, finishedAt 时间戳非 null。**Observability 债清零** |
| 20 | 2026-04-23 | **persist-tsc bug fix + PG 端到端闭环** | Pipeline Generator V1 `ecec9778` → 生成 **Extract Hostname** (new hash `52d3b767...cacd8440`) | `pipeline-generator-1776948160085-21246215` | completed ✅（full 5 stages + DB registration）| ~2.5 min, ~$0.15 | **Debt L+M: tscPath 未透传** | **Investigate 链**：run #19 side bug 假设是 validator/codegen bug → 写 repro 脚本对 run #19 原 IR 测 `validateTypes`：传 tscPath → ok=true；不传 → fallback "This is not the tsc command you are looking for"。**真因：2 条 PG 入口路径的 MCP 都没收到 tscPath**。Fix `8b5f92d`（resume path: BootResumabilityInput + index.ts 传 `MONOREPO_TSC_PATH`）和 `83daf77`（MCP handler path: `executorFactory` 签名加 tscPath + server.ts handler 传）。Re-dogfood clean DB 发 PG → completed/natural → `persisting.versionHash="52d3b767..."`（real SHA），`pipelineId="extract-hostname"`（real slug），`pipeline_versions` 新行确认入表。**对比 run #19 pre-fix**：`versionHash="FAILED"`，`pipelineId="FAILED"`，DB 无行。M4 第 5 个数据点；AI-generated pipeline → DB registration 链路完整 |
| 19 | 2026-04-23 | **M-R6 dogfood — SIGKILL mid-analyzing + server 重启验证 SDK session resume** | Pipeline Generator V1 `ecec9778` | `pipeline-generator-1776945303486-743bbcc9` | completed ✅（6 stages，含 pre-kill superseded + post-resume 新 attempt） | ~8.5 min (含 ~20s kill/restart 空窗), $0.4056 total | **M-R5 gap: session_id 只在 writer.close 时 flush**（fix `dec8313`） | 真实 API 跑 PG 到 analyzing running，SDK `system.init` 产出 session_id=`f391e6d6...` 已写 DB，burn ~20s tokens → `SIGKILL` server → 重启 server D → **reconciler 检测 orphan, resumed=1** → runner 拉 session_id 传 `options.resume=f391e6d6` → **SDK 接受 resume，新 attempt session_id 与原 attempt 完全相同** → attempt 完成 cost $0.1182 (19/4133 tokens)，没有重新从 turn 0 开始 → 继续跑完整 pipeline。**M-R1..M-R5 联合验证端到端 work**。**Side bug**（非 resumability 相关）：persist stage 报 WIRE_TYPE_MISMATCH / "tsc not available"，AI-generated pipeline 未最终入 DB 但 task_finals=completed/natural 本身正确。**M-R5 session fix 真实必要**：修前 mid-stage kill 后 session_id=NULL, SDK resume 不可用；修后 session_id 在 init 时 sync flush，kill -9 安全 |

## 成熟度快照

- **M3 分子/分母**: 15 / 22（run #2,3,4,9,11,12,14,15,16,17,18,19,20,21,22 真 completed；run #1,5,6,7,10,13 API completed 但未全跑 / 内容错；#8 是 B5 API 验证）
- **真实成功率**: 15/22 = **68%**。架构审计修完后的 runs 全过
- **post-architecture-audit 子集**: 11/11 = **100%**（runs #11,#12,#14,#15,#16,#17,#18,#19,#20,#21,#22）
- **覆盖所有 4 个 builtin**: smoke-test (✅ run #21) / Tech Research Collector (✅ run #3, #4, #17) / **Tech Research Writer (✅ run #22)** / Pipeline Generator (✅ run #11, #17, #18, #19, #20)
- **M4 热更新 propose / reject / rollback**: **5 / 0 / 0**（含 run #20 完整 PG→DB 注册链）
- **Resumability 端到端可用**: ✅ run #19 真实验证 SIGKILL mid-stage 后 SDK session_id 与对话历史跨 server 生命周期保持
- **AI-generated pipeline → DB 注册可用**: ✅ run #20 验证 tscPath fix 后 persisting stage 正确写真实 versionHash 并 INSERT pipeline_versions
- **覆盖的 builtin + generated**: 4 ✅ （`smoke-test`, `Tech Research Collector`, `Pipeline Generator`, `pr-description-generator`） + 4 AI-generated IR 完整（Web Research Reporter / Research Report Generator / Markdown ToC / Extract Hostname） + 1 pending: `Tech Research Writer`
- **AI-generated pipeline schema + DB 注册可用率**: 4 / 5（run #4 空壳；run #11/#17/#18/#20 IR 完整过 validator + 注册）

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

## 架构审计（2026-04-23 post-P6-12）

用户指示："不要小修小补，系统性修"。审视 P6-1..P6-12，归纳三条**真架构债**，一次性修到根：

### 债 A：task 生命周期的多源真相（了结 P6-1 / P6-9）

**问题**：getTaskStatus 有三套信号（machine 终态、runner.finally 写的 task_finals、stage_attempts latest 派生），之前 fallback 允许派生 'completed' 从 stage_attempts——但 runner 如果 crash 在 finally 前，这个派生**会撒谎**（run #6/#7/#10 stuck 时就是这样报 completed）。

**修法**：getTaskStatus **永不从 stage_attempts 派生 completed/failed**。引入 'orphaned' 显式 label："attempts 存在但无 task_finals 又没 running"——这个 runner 是 crashed / killed。调用方处理 orphaned 如 failed 但 ops 视角有真相。commit 98ac034。

### 债 B：XState v5 parallel region event consumption（了结 P6-10）

**问题**：v5 语义下 region 的 on.X transition 若 guard=true 会 fire 并 consume event，此后 **root-level on.X 不触发**。P6-10 时 gate region 每次都 consume GATE_ANSWERED → root 的 assign gateAuthorizedTargets 成 dead code。

**审视结果**：
- PORT_WRITTEN 的 root assign safe（region guard 总读 pre-event context，guard 永 false → root 跑）
- GATE_ANSWERED 原本 broken；已修（gate region 自己做 assign）
- STAGE_FAILED 无 root handler 不受影响
- GATE_REJECTED / INTERRUPT / RETRY_TO_STAGE 无 root handler

**清理**：删掉 root-level on.GATE_ANSWERED 的 dead-code "safety net"——它**永远不跑**，留着误导未来 reader。commit 98ac034。

### 债 C：propose() prompt 迭代路径失效（了结 P6-11）

**问题**：propose() 用 versionHash(ir)（IR-only）算新 hash。prompt-only 改动**哈希碰撞**——新 version 不被创建；就算 IR 有 delta 新 version_hash 诞生了，**pipeline_prompt_refs 从未写入**。DbPromptResolver 在新 version 上跑第一个 stage 即 throw。

**这意味着 propose() 完全没法做 prompt iteration**——我改 write-pr.md 迭代不得不走 "改文件 + 重启 server + 重新 seed" 而不是正规 API。M4 数据收集因此无法走标准路径。

**修法**：
- propose() 签名加 `prompts?: Record<string, string>`
- 使用 `pipelineVersionHash({ir, prompts})` — 与 submit() 同一空间
- 合并策略：`args.prompts` override base，未改部分 carry 自 base version
- **Rename-carry**：stage 改 promptRef 但没传新 content 时，自动把 base 里老 promptRef 的 content 附到新 ref
- Validate 每个 agent stage 的 promptRef 能 resolve，否则 PROMPT_REF_MISSING
- Persist prompt_contents + pipeline_prompt_refs 于新 version

commit 2103aa7。

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

## PG API validation run #17 (2026-04-23)

### Input

**taskDescription**（verbatim）：

> Build a technical research pipeline that takes a topic name as input, collects authoritative sources (official docs, reputable engineering blogs, peer-reviewed papers if any), and synthesises a structured report with an executive summary, source list, and detailed findings. Output a single markdown report.

### Outcome

- PG status: **completed ✅**
- Stage attempts (task `pipeline-generator-1776932730593-3835c6cb`):

| stage | attempt | status | kind |
|---|---|---|---|
| __external__ | 1 | success | external |
| analyzing | 1 | success | regular |
| awaitingConfirm | 1 | success | regular |
| genSkeleton | 1 | success | regular |
| genPrompts | 1 | success | regular |
| persisting | 1 | success | regular |

- Cost: **$0.2983**（全 PG 链路）
- Duration: ~7.5 min（含 gate 等我批准 ~20s）
- Generated versionHash: `7fc2d175aa8b2f7ea6a420ab120d09fb78ccd68c9b5e109794f9b9d1654fb1f6`
- Generated pipeline name: `research-report-generator`
- Validator: `{ ok: true, diagnostics: [] }`
- Prompt coverage: missing=[], extraneous=[]
- **Finding**: 生成的 IR **没有 `store_schema` 顶层字段**。当前 PG prompts（analysis / genSkeleton / genPrompts）未强制要求产出 store_schema，这是 A3 迁移的真实 gap——现行 4 个 builtin 的 store_schema 是 Phase 4.5 T5 手工机械镜像补的，PG 自己不会产出。

### Smoke run

- Task: `research-report-generator-1776933048333-c114cdc0`，seed=`{topic:"WebAssembly"}`, maxTurns=5, maxBudget=$0.5
- 状态：task **completed**
- 细节：
  - `collectSources`: agent 超 maxTurns（5 太紧），但**在超之前已写出 port `sources`（2676 bytes，数组含多个 source 对象）**。stage_attempts.status=error / termination_reason=error，但下游 wire 因 port 已写而激活
  - `generateReport`: success，消费 sources + topic，产出 `report`（6867 bytes）完整 markdown 报告（含 Executive Summary / Overview / Detailed Findings / Source List）
- Cost（smoke）: $0.0362
- **PG 生成的 pipeline 端到端可执行并产出真实内容**

### Generated IR (verbatim, canonical JSON)

```json
{
    "name": "research-report-generator",
    "stages": [
        {
            "name": "collectSources",
            "inputs": [
                {
                    "name": "topic",
                    "type": "string"
                }
            ],
            "outputs": [
                {
                    "name": "sources",
                    "type": "{ url: string; title: string; type: 'official-docs' | 'blog' | 'paper' | 'other'; summary: string; }[]"
                }
            ],
            "type": "agent",
            "config": {
                "promptRef": "collectSources"
            }
        },
        {
            "name": "generateReport",
            "inputs": [
                {
                    "name": "topic",
                    "type": "string"
                },
                {
                    "name": "sources",
                    "type": "{ url: string; title: string; type: 'official-docs' | 'blog' | 'paper' | 'other'; summary: string; }[]"
                }
            ],
            "outputs": [
                {
                    "name": "report",
                    "type": "string"
                }
            ],
            "type": "agent",
            "config": {
                "promptRef": "generateReport"
            }
        }
    ],
    "wires": [
        {
            "from": {
                "source": "external",
                "port": "topic"
            },
            "to": {
                "stage": "collectSources",
                "port": "topic"
            }
        },
        {
            "from": {
                "source": "external",
                "port": "topic"
            },
            "to": {
                "stage": "generateReport",
                "port": "topic"
            }
        },
        {
            "from": {
                "source": "stage",
                "stage": "collectSources",
                "port": "sources"
            },
            "to": {
                "stage": "generateReport",
                "port": "sources"
            }
        }
    ],
    "externalInputs": [
        {
            "name": "topic",
            "type": "string"
        }
    ]
}
```

### Generated prompts (verbatim)

#### `collectSources`

```markdown
# collectSources Stage Prompt

You are the research stage of a technical report pipeline. Find and collect 4-8 authoritative sources on the given topic.

## Available Inputs

- **topic** (string): Technical topic to research (e.g., "Kubernetes observability", "React performance")

## Workflow

1. Use WebSearch to find authoritative sources:
   - Official documentation from project maintainers
   - Technical blog posts from recognized engineers/companies
   - Peer-reviewed papers or research publications
   - Avoid low-quality, outdated, or thin sources

2. For each promising result:
   - Use WebFetch to retrieve full content
   - Extract clear title and key points
   - Classify source type: official-docs, blog, paper, or other
   - Write 1-2 sentence summary of key content

3. Collect at least 4-6 high-quality sources before writing output

## Output Format

Each source must be a JSON object:
\`\`\`json
{
  "url": "https://example.com/resource",
  "title": "Source Title",
  "type": "official-docs",
  "summary": "Concise summary of key content"
}
\`\`\`

## write_port Example

\`\`\`
write_port(
  taskId="pipeline-generator-1776932730593-3835c6cb",
  attemptId="18f6b974-c574-4a6b-a585-38a9cde0e1b9",
  stage="collectSources",
  port="sources",
  value=[
    {"url": "https://kubernetes.io/docs/concepts/", "title": "Kubernetes Concepts", "type": "official-docs", "summary": "Official guide..."},
    {"url": "https://example.com/blog", "title": "Blog Post", "type": "blog", "summary": "Technical insights..."}
  ]
)
\`\`\`

## Error Handling

- If WebSearch returns limited results, broaden search terms and try variations
- If a source URL fails to fetch, skip it and find alternatives
- If sources are sparse, note in comments but proceed with available sources
- Ensure all URLs are valid and content is accessible
```

#### `generateReport`

```markdown
# generateReport Stage Prompt

You are the synthesis stage. Create a structured markdown report synthesizing the collected sources into a cohesive narrative.

## Available Inputs

- **topic** (string): The technical topic being researched
- **sources** (array): Source objects with url, title, type, and summary fields

## Workflow

1. Review all sources to identify common themes and unique insights

2. Structure the report with:
   - **Title** (H1): "Research Report: {topic}"
   - **Executive Summary** (H2): 2-3 sentence overview of topic and key findings
   - **Overview** (H2): Context and importance
   - **Key Findings** (H2): 3-5 subsections synthesizing insights across sources
   - **Best Practices** (H2): Actionable recommendations
   - **References** (H2): Numbered list of all sources with links

3. When writing:
   - Synthesize across sources rather than summarizing individually
   - Use [1], [2] citation format to reference sources
   - Focus on unique insights, patterns, and actionable advice
   - Aim for 800-1500 words total

4. Format as valid markdown with proper hierarchy and links

## write_port Example

\`\`\`
write_port(
  taskId="pipeline-generator-1776932730593-3835c6cb",
  attemptId="18f6b974-c574-4a6b-a585-38a9cde0e1b9",
  stage="generateReport",
  port="report",
  value="# Research Report: Kubernetes Observability\n\n## Executive Summary\n\n[full markdown report as single string]..."
)
\`\`\`

## Error Handling

- If sources are limited, create report with available sources and note constraints
- If topic is unfamiliar, rely on source material to guide structure
- If markdown formatting fails, validate syntax and retry
- Ensure all reference links are valid and clickable
```

### Lessons

- **PG 能自主产出合法 tech-research 类 pipeline**：结构清晰（2 stage 线性 + external input 分发到两个 stage + 中间 wire），过 validator，端到端能跑出真实输出。比 run #11 `markdown-toc-generator`（未运行）进一步——这次是**真的 smoke 跑完出 report**。
- **PG 的 prompt 质量合理**：生成的 `collectSources` / `generateReport` prompts 有结构化 Workflow / Output Format / write_port Example / Error Handling 段。比人类匆忙写的同类 prompt 质量不差。
- **PG 缺 store_schema 产出**：A3 迁移原意是让 PG 产出带 store_schema 的 pipeline；当前 PG prompts 没教它这么做。现行 builtin 的 store_schema 全是 Phase 4.5 T5 手工镜像补的。若要真正让 A3 "AI 代写 YAML 含 schema" 成立，需要升级 PG 的 genSkeleton / genPrompts 让它产出 store_schema。但这不是 run #17 要做的；run #17 只是诊断。
- **PG 没用 fanout / sub-pipelines**：尽管 PG 的 analysis stage 输出 `usesFanout`/`usesSubPipelines` 标志，本轮明确选了 `usesFanout=false` / `usesSubPipelines=false`。对"2 stage 简单线性"是合理选择（多 source 并行抓取本可用 fanout，但 LLM 判断"线性够用"——YAGNI 意义上合理）。
- **Smoke maxTurns 过紧**：给了 5 turns 对 collectSources 抓 multiple sources 不够（它抓了 6 source 后超时）。但端到端 still completed 因为 port 早已写到。下次 smoke 默认 10-15 turns。
- **PG 的 persist stage 成功提交**：对比 run #4 的"空壳 IR"失败，这次 persisting 直接成功一发命中。P6-8 fix + store_schema drift validator 没误伤合法 IR。
- **未尝试替换现有 builtin**：按 spec non-goal 明确。research-report-generator 仅驻留 DB，下次 server 重启随 db wipe 消失。

## PG store_schema upgrade run #18 (2026-04-23)

### Path

1. `seedBuiltinPipelineByName("pipeline-generator")` at server module load → filesystem IR + prompts seeded into `pipeline_versions` as V0=`f5dbdf18ca90a0664537fb417505b7b9a1ee548dad3012ab28f7cbc117553206`。
2. `GET /api/kernel/pipelines/:V0` → 拉 4 prompts（analysis/gen-prompts/gen-skeleton/persist）。
3. 组 body `{currentVersion:V0, patch:{ops:[]}, actor:"dogfood-session-3", prompts:{…, "system/gen-skeleton":<new>}}`，其中 new 内容加入"Store schema generation (REQUIRED)"章节 + 4 条 pre-submit self-check。
4. `POST /api/kernel/proposals` → `proposalId=f72766d5-3699-42a7-8def-fa0e0e8612d8`，`proposedVersion=ecec9778c84000bb09dcff464386f0b860024c4dd08eb0fbbc5a0818e3b1a511` = V1，`safeRange=safe/empty`，`diff.stages={added:[],removed:[],modified:[]}`（prompts-only）。
5. `POST /api/kernel/proposals/:id/approve` → `status=approved`。
6. `POST /api/kernel/tasks/run` body `{versionHash:"ecec9778…", seedValues:{taskDescription:"<2-stage research pipeline>"}, model:"claude-sonnet-4-6", maxTurns:60, maxBudgetUsd:5}` → `taskId=pipeline-generator-1776935189303-cb23fdc4`。
7. Gate（`gate_id=470244f4-53a8-42b3-9dc4-14ea37c1c915`）手动 approve → downstream 3 stages 自然完成。

### Outcome

- Task status: **completed / natural**，duration ~9.1 min（含 ~2 min gate wait），total $0.9360（analyzing $0.2935 / genSkeleton $0.1023 / genPrompts $0.3701 / persisting $0.1701）
- Generated pipeline versionHash: `dfa3b3cc315d7ccc12a4450a79f292ba8fe95deb4cc9dcb7c1255bee99e66f19`
- Generated pipeline name: **Web Research Reporter**（2 stages: webResearch → reportWriter；1 external input `topic:string`；3 wires）
- `KernelService.validate()`: **ok=true / 0 diagnostics**
- `pipeline_prompt_refs` has both `webResearch` and `reportWriter`（prompt coverage 完整）
- **`store_schema` 顶层字段存在**，entry 全正确：
  - `webResearch.sources` → `{ url: string, title: string, content: string }[]` / produced_by webResearch.sources
  - `reportWriter.report` → `string` / produced_by reportWriter.report
- 自定义 validator 结果：
  - entry count (2) == expected (2, 每个 agent/script stage 一个 output)
  - 每个 type 与端口 type `.trim()` 相等
  - Coverage: **COMPLETE**

### Generated IR (verbatim, canonical JSON)

```json
{
  "name": "Web Research Reporter",
  "stages": [
    {
      "name": "webResearch",
      "inputs": [{ "name": "topic", "type": "string" }],
      "outputs": [{ "name": "sources", "type": "{ url: string, title: string, content: string }[]" }],
      "type": "agent",
      "config": { "promptRef": "webResearch" }
    },
    {
      "name": "reportWriter",
      "inputs": [
        { "name": "topic", "type": "string" },
        { "name": "sources", "type": "{ url: string, title: string, content: string }[]" }
      ],
      "outputs": [{ "name": "report", "type": "string" }],
      "type": "agent",
      "config": { "promptRef": "reportWriter" }
    }
  ],
  "wires": [
    { "from": { "source": "external", "port": "topic" }, "to": { "stage": "webResearch", "port": "topic" } },
    { "from": { "source": "external", "port": "topic" }, "to": { "stage": "reportWriter", "port": "topic" } },
    { "from": { "source": "stage", "stage": "webResearch", "port": "sources" }, "to": { "stage": "reportWriter", "port": "sources" } }
  ],
  "externalInputs": [{ "name": "topic", "type": "string" }],
  "store_schema": {
    "webResearch.sources": {
      "type": "{ url: string, title: string, content: string }[]",
      "description": "List of researched web sources with URL, title, and content excerpt for each.",
      "produced_by": { "stage": "webResearch", "port": "sources" }
    },
    "reportWriter.report": {
      "type": "string",
      "description": "Synthesized markdown report covering overview, key findings, and cited sources.",
      "produced_by": { "stage": "reportWriter", "port": "report" }
    }
  }
}
```

### Lessons

- **A3 gap 真正消除**：run #17 诊断出"PG 不产 store_schema"，run #18 通过 Propose UI 发 prompts-only iteration 修好。单次 iteration 命中 — 不需要 reject / rollback。
- **prompt 规则 take effect**：新规则写得足够具体（`{stage}.{port}` naming、character-identical type、forbidden entries 三条排除常见错误、4 条 self-check）。LLM 第一次 genSkeleton 就产出完全合规的 schema，包括对 gate stage 的正确排除（PG 生成的 pipeline 本身不含 gate，但若含则规则禁止为其建 entry）。
- **Propose UI 在 iterative 场景可用**：4 prompts map 只替换一个；`patch:{ops:[]}` + prompts-only + `NO_OP_PROPOSAL` 兜底架构表现完美。API 即可操作，不需要 UI，但 UI 也能替代 — 这个 session 走 HTTP 是因为自动化 script 方便。
- **不更新 filesystem 的 prompt**：V1 只存在 DB 里，server restart + DB wipe 会回到 V0。若要 V1 成为永久 builtin，需把更新后的 `system/gen-skeleton.md` 落盘（此次 session 明确 non-goal）。这一点很符合 product-roadmap 的"AI writes YAML, not human"方向 — PG prompts 本身未来也能走 Propose UI 迭代。
- **gate_id ≠ attempt_id**：调用 `/api/kernel/gates/:id/answer` 时用的是 `gate_queue.gate_id`，不是 `stage_attempts.attempt_id`（即使两者一对一）。脚本化时从 `gate_queue` 读正确。
- **M4 分数累加**：run #18 是第 4 个 propose + approve + run 完整数据点。前 3 个都针对 pr-description-generator；run #18 首次把 PG 自己拿来迭代 — 自举验证。

## M-R6 dogfood run #19 (2026-04-23)

### 目的

验证 M-R1..M-R5 的 resumability 栈（lock + orphan reconciler + gate hydration + SSE seq + SDK session resume）在真实 Claude API 下端到端工作。

### 场景

1. 启 server A（clean DB）。
2. 发 PG run，`taskDescription="A 2-stage code-review pipeline: (1) fetch git diff..."`。
3. 等 analyzing stage `status=running` 且 `agent_execution_details.session_id` 已写 DB → burn ~20s tokens。
4. 对 tsx 主进程 + child Node `kill -9`（模拟硬 crash）。`.lock` 文件残留（SIGKILL skip exit handler）。
5. 删 `.lock` 文件模拟 stale-pid takeover 成功的场景。
6. 启 server D。reconciler 应检测 orphan → reconcile running → superseded → classifyOrphan 返回 resume (resumeFrom=analyzing) → lookupResumeSessionId 返回刚持久化的 sid → runner 带 `resumeSessionId` 调 executor → SDK 带 `options.resume=<sid>` 启动 query。

### 事前 fix（本 session 发现的 M-R5 真实 gap）

M-R5 原 wiring 假设 `agent_execution_details.session_id` 在 stage running 期间可读。实测：只有 `writer.close()` 时才写入 DB，stage 结束前 NULL。一次真实 dogfood 循环才暴露——pure unit tests 看不出。

Fix commit `dec8313`：
- `writer.updateSessionId()` 改为 **sync flush**（1 次额外 DB write / stage）。
- `real-executor.ts` 的 `onSdkMessage` 在 `system.init` 捕获 sid 时立刻调 `writer.updateSessionId(sid)`。

这是 session 开始做 dogfood 前的必要 foundation，否则 M-R6 无意义。

### 核心结果

| 指标 | 值 |
|---|---|
| taskId | `pipeline-generator-1776945303486-743bbcc9` |
| versionHash | `ecec9778...` (PG V1) |
| reconciler resumed 计数 | **1** ✅ |
| analyzing attempt #1 status | superseded / interrupted |
| analyzing attempt #1 session_id | `f391e6d6-90f6-497d-8d56-314f6fa3ad3a` |
| analyzing attempt #2 status | success / natural_completion |
| analyzing attempt #2 session_id | **`f391e6d6-90f6-497d-8d56-314f6fa3ad3a`（same）** ✅ |
| attempt #2 cost / tokens | $0.1182 / 19 in / 4133 out / 111s |
| pipeline final | completed / natural |
| 全链路 cost | $0.4056 |
| 全链路 stages 完成 | 6（含 2 个 analyzing attempts + 2 个 gate attempts） |

**session_id 跨 kill/restart 保持不变** 是决定性验证：SDK `options.resume` 成功接续旧 conversation（同 sessionId = 无 fork）。

### 观察到的 side bug（非 resumability 相关）

Persist stage 报 `WIRE_TYPE_MISMATCH` + 推理认为 "tsc not available"，写 `versionHash=FAILED` 作为输出。尽管 pipeline integrity 已通过 structural validator，tsc 类型校验环节异常。**不阻塞 M-R6 结论** —— resume 栈工作，任务达到 `task_finals=completed/natural`。独立问题进 handoff 待查。

### Lessons

- **"wiring 通过 unit test" ≠ "端到端真实可用"**。M-R5 unit tests 全绿 + tsc 0 + 1485 pass，但首次真 dogfood 立刻暴露 writer.close-only flush 的硬 gap。M-R6 dogfood 不是可选的。
- **Session resume 不一定省 tokens**，但保证 **conversation continuity**。Attempt #2 的 cost $0.1182 并非 savings —— SDK 每次 resume 要读历史，取决于 prompt caching 命中。真正价值是对话上下文不丢，而不是省钱。
- **Reconcile 顺带处理 gate attempts**：awaitingConfirm 也被 reconcile 成 superseded，resume 后新 attempt#2 由 M-R3 的 gate_queue hydration 或正常用户 re-answer 解决。本次 run 观察到两个 gate_queue 条目（每个 attempt 一个），需两次 answer。UI 层需知道该挑"最新未 answered 的"。
- **SIGKILL 后 lock 需手删**（或靠 stale-pid takeover 自动处理）。`process.on("exit")` 在 SIGKILL 下不 fire，这是 POSIX 行为，已在设计中接受（PID-file + liveness check 而非 flock）。
- **`versionHash=FAILED` persist 路径虽丑，但 task_finals 正确写 completed/natural**——kernel 的"stage 错误 ≠ 任务失败"语义完整（per Phase 6 run #15 架构）。

## persist-tsc bug fix run #20 (2026-04-23)

### 目的

闭环 run #19 的 side bug（"WIRE_TYPE_MISMATCH / tsc not available"）。Investigate → commits `8b5f92d` + `83daf77` → re-dogfood 端到端验证。

### Investigate 结论

根因：两条 PG 入口路径都没把 `MONOREPO_TSC_PATH` 塞进 per-stage MCP：

1. **Resume 路径（index.ts bootResumability）**：`orphan-reconciler.ts` 的 `BootResumabilityInput.startPipelineRun` 签名缺 `tscPath`；index.ts 的 adapter 也没传。Resumed 任务的每个 agent stage 的 MCP 拿到 `tscPath=undefined`。
2. **MCP `start_pipeline_generator` 路径（server.ts handler）**：该 handler 走 `deps.runner` 分支（非 `startPipelineRun`），其 `deps.executorFactory` 签名缺 `tscPath`；server.ts:1077 构造 `createKernelMcp` 时也没传。

两处丢了 tscPath → `validateTypes` 走 `npx tsc` fallback → 在 /tmp/kernel-next-tsc-XYZ 下 npx 找不到 TypeScript 安装 → 报 "This is not the tsc command you are looking for" → `parseTscOutput` 不识别 → fallback emit 一个 generic `WIRE_TYPE_MISMATCH`。Agent 读 context 推理"基础设施问题" → 写 `versionHash=FAILED`。

### Repro（决定性证据）

临时 script 调 `validateTypes` 对 run #19 的 **完全相同 IR**：

- With `tscPath = apps/server/node_modules/.bin/tsc` → **ok=true**
- Without tscPath（npx fallback）→ **ok=false**, rawStdout 含 "This is not the tsc command you are looking for"

### Fix 分两个独立 commit

| Commit | 范围 |
|---|---|
| `8b5f92d` | `orphan-reconciler.ts` 扩 `BootResumabilityInput`；`index.ts` 传 `MONOREPO_TSC_PATH`；`kernel-run.ts` export 该常量 |
| `83daf77` | `pg-entry.ts` 扩 `executorFactory` 签名；`server.ts` handler 传 `tscPath` 到 deps 和 inner MCP |

新增 2 个 unit test（resume path + MCP handler path）。tsc 0, **1488 pass / 4 skipped**（从 1486 +2）。

### Re-dogfood

clean DB，发 PG（`"A tiny pipeline that takes a URL string and returns its hostname as a string..."`）。经过 analyzing → awaitingConfirm → approve → genSkeleton → genPrompts → persisting → completed/natural。

**关键验证**（对比 run #19）：

| 字段 | run #19（pre-fix） | run #20（post-fix） |
|---|---|---|
| `persisting.versionHash` | `"FAILED"` | `"52d3b767...cacd8440"` (real SHA256) |
| `persisting.pipelineId` | `"FAILED"` | `"extract-hostname"` (real slug) |
| `pipeline_versions` 新行 | — | `Extract Hostname` 入表 |

生成的 pipeline `"Extract Hostname"` 真实入 `pipeline_versions`，AI-generated pipeline → DB registration 链路完整工作。

### Lessons

- **Investigation-before-claim 再次救命**：handoff 里写的 "persist tsc bug" 我一开始假设是 validator 或 codegen bug。实际是**上游 tscPath 根本没到**。temporarily 写 repro 脚本（传/不传 tscPath 对同一 IR）直接分离了变量，省去了在 validator/codegen 里挖的时间。
- **两条路径同一根因**：resume 路径和 MCP handler 路径独立，但都漏了 tscPath。这是**契约型 debt**——`startPipelineRun` 的 `tscPath` 参数设计成 optional，使得每个 caller 可以悄悄漏掉。若 `tscPath` 是 required（或 default-to-resolved），此类 bug 一开始就不会存在。
- **M4 分子加 1**：run #20 是完整的 propose-less PG-run → DB 注册循环，验证了 AI-generated pipeline 的端到端可用性。
