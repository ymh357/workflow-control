# Builtin Pipelines Design — tech-research / web3-tech-research

> Phase 0.4 补做。设计文档而非 YAML —— 实际 YAML 由 `pipeline-generator`
> 消费本文件的 use cases 与 stage 骨架现场生成，生成产物以 commit 方式
> 纳入 `apps/server/src/builtin-pipelines/` 目录。
>
> **Status (2026-04-19)**：tech-research 和 web3-tech-research 的成熟版
> 已从 `config/pipelines/` 搬到 `src/builtin-pipelines/`（跟随 5 个相关
> sub-pipeline），但**缺 `store_schema` 声明**，不通过 Phase 3.6 引入的
> validator。暂时撤回到 `config/pipelines/` 当本地私有配置。下一步单独
> 开 session 给这两个顶层 pipeline 补 store_schema（~30 writes 反推
> schema 字段），补完重新搬回 builtin。
>
> 当前 builtin 目录内容（5 个通过 validator）：
> - `pipeline-generator` — 原有
> - `smoke-test` — 两 stage 最小样本（本次新增，`docs/builtin-pipelines-design.md` §6）
> - `tech-research-collector` — tech-research 的 foreach 子 pipeline
> - `tech-research-writer` — tech-research 的 foreach 子 pipeline
> - `web3-research-writer` — web3-tech-research 的 foreach 子 pipeline
>
> sub-pipeline 作为 builtin 先就位，等顶层补齐 schema 后就能完整跑通。

## 1. 为什么需要这两个 pipeline

项目当前只有 `pipeline-generator` 一个内置 pipeline。这造成两个问题：

1. **新用户没有可用样本**：安装后没有现成 pipeline 可跑，必须先走一次
   `pipeline-generator` 才能看到系统怎么工作。学习曲线陡。
2. **`pipeline-generator` 缺少参考样本**：生成新 pipeline 时只有自己一个
   "官方样板"可以对齐结构、风格、stage 分层。样本越多，生成质量越稳。

`tech-research` 和 `web3-tech-research` 是经过实际打磨的工作流，直接
commit 成内置 pipeline 后同时解决这两个问题。

## 2. tech-research

### 2.1 Use cases

- 研究一项陌生技术（框架、库、协议、标准）的成熟度与适用性
- 在选型前对比 2-5 个同类方案
- 针对某个技术议题产出一份可直接用于团队分享的 briefing

### 2.2 Stage skeleton（5 stages）

| # | stage | 类型 | writes | reads |
|---|---|---|---|---|
| 1 | `scope` | agent | `scope` | — |
| 2 | `survey` | agent | `survey` | `scope` |
| 3 | `deepdive` | agent (parallel-capable) | `deepdive` | `scope`, `survey` |
| 4 | `compare` | agent | `comparison` | `scope`, `deepdive` |
| 5 | `brief` | agent | `brief` | 以上全部 |

### 2.3 store_schema（字段骨架）

```yaml
scope:
  produced_by: scope
  fields:
    topic: { type: string, required: true }
    questions: { type: string[], required: true }        # 3-7 个研究问题
    decisionContext: { type: markdown }                   # 为什么研究、要支持什么决策
    nonGoals: { type: string[] }

survey:
  produced_by: survey
  fields:
    landscape: { type: markdown, required: true }         # 领域全景
    candidates: { type: object[], required: true }        # 候选方案列表
      # { name, url, oneliner, category }
    keySources: { type: object[] }                        # { title, url, why }

deepdive:
  produced_by: deepdive
  fields:
    perCandidate: { type: object[], required: true }
      # { name, maturity, communityActivity, adoption, strengths, weaknesses, risks }

comparison:
  produced_by: compare
  fields:
    criteria: { type: string[], required: true }          # 打分维度
    scorecard: { type: object[], required: true }
      # { candidate, scores: { [criterion]: number|string }, rationale }
    recommendation: { type: markdown, required: true }

brief:
  produced_by: brief
  fields:
    executiveSummary: { type: markdown, required: true }
    whenToUse: { type: markdown }
    whenNotToUse: { type: markdown }
    openQuestions: { type: string[] }
    references: { type: object[] }                        # { title, url }
```

### 2.4 Stage 职责细则

**scope** — 把用户的一句话扩展成 3-7 个具体研究问题，并写明
decision context（为什么研究，要支持什么决策）。没有这一步后面所有
stage 的输出都会"跑题"。

**survey** — 拉取领域全景，列出候选方案和关键信息源。**必须使用 Web
搜索 MCP**，不要凭模型记忆。输出 `candidates[]` 为后续 deepdive 固定输入。

**deepdive** — 对每个候选做成熟度 / 社区活跃度 / 采用率 / 强弱项评估。
如果候选数 >= 3，pipeline-generator 应产出 parallel group 以缩短延迟；
否则串行即可。

**compare** — 定打分维度，产出 scorecard，基于 scorecard 给 recommendation。
打分维度由 stage 自己决定（不是用户预设），但 scope.questions 决定优先级。

**brief** — 产出最终 executive summary。面向决策者、面向分享，不是堆砌。

### 2.5 MCP / 工具依赖

- `WebSearch` / `WebFetch`（mandatory — survey / deepdive）
- `__debug__` / `__store__` / `__agent_log__`（SDK 默认注入）

### 2.6 Gate 设计

- `scope` 后插入 `human_review` gate（可 skip）。scope 错了后面全白干。
- 其它 stage 自动推进。

## 3. web3-tech-research

### 3.1 与 tech-research 的关系

**继承式扩展**：复用 tech-research 的 5 个 stage 骨架，在 `deepdive` 和
`compare` 追加 web3 专有维度，在最后新增一个 `onchain` stage。保持结构
对齐，降低 pipeline-generator 的理解负担。

### 3.2 差异点

**新增字段（deepdive.perCandidate）**：
- `tokenomics: markdown` — 代币设计 / 供应曲线 / 激励模型
- `securityAudits: object[]` — `{ firm, date, url, findings }`
- `onchainMetrics: object` — `{ tvlUsd, dailyActiveUsers, txCount7d }`

**新增字段（comparison.criteria 建议默认包含）**：
- 去中心化程度、治理模型、审计记录、桥接风险、多链部署

**新 stage — `onchain`（stage 6）**：
- writes: `onchainSnapshot`
- reads: `comparison`
- 职责：取 recommendation 对应协议，拉 Dune / DeFiLlama / Etherscan 的
  当前快照数据，附在 brief 之前。
- MCP 依赖：若项目接入了 Dune/DeFiLlama MCP 则用之；否则用 WebFetch
  直接抓公开页面。

### 3.3 新增 schema

```yaml
onchainSnapshot:
  produced_by: onchain
  fields:
    asOf: { type: string, required: true }                 # ISO timestamp
    source: { type: string[], required: true }             # 数据来源标注
    snapshot: { type: object[], required: true }
      # { candidate, tvlUsd, chains, deployedAt, keyContract, verified }
    redFlags: { type: string[] }
```

## 4. 生成方式

两个 pipeline 的 YAML + prompt 不在本 session 手写，而是：

1. 启动 dev server
2. 跑 `pipeline-generator`，输入本文件 §2.1-2.6 作为 task description
3. 产物 review → 修正 → commit 到 `apps/server/src/builtin-pipelines/`
4. `builtin-installer.ts` 目录扫描会自动装上，无需代码改动

`web3-tech-research` 走同样流程，prompt 里带上 "extend tech-research
with web3 fields as spec'd in docs/builtin-pipelines-design.md §3"。

## 5. 验收标准

- `discoverBuiltinPipelines()` 报告完整的 pipeline 家族（当前 5 个，补
  齐顶层 schema 后 7 个）
- 每个 builtin 通过 `validatePipelineConfig`，由
  `src/lib/builtin-pipelines.test.ts` 在 CI 上强制
- 每个 llm-engine stage 的 `system_prompt` 都有对应的 prompts/system/*.md 文件
- `tech-research` 跑一个真实话题（例："为新服务选 HTTP client 库"）能
  产出可读 brief.executiveSummary
- `web3-tech-research` 跑一个真实话题（例："L2 Rollup 框架选型"）能
  产出 onchainSnapshot 非空

## 6. smoke-test minimal sample

`smoke-test` pipeline 是最小双 stage 样本：

- `greet` (agent, engine=llm) → 写 `greeting.subject` + `greeting.note`
- `echoBack` (agent, engine=llm) → 读 `greeting`，写 `echo.message`

两个 prompt 各 <30 行，无 WebSearch、无 tool 调用。用途：

1. **安装验证**：新安装 workflow-control 后 10 秒内能跑通一个 task 验证
   整个 engine / MCP / store / SSE 链路没问题，成本 <$0.01
2. **pipeline-generator 的最简参考样本**：generator 生成新 pipeline 时能
   看到"最小合法 pipeline"长什么样，避免过度设计
3. **CI 快速通路**（未来）：将来要做 e2e test 时，这个 pipeline 是最便宜的
   跑通性验证载荷
