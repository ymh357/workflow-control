# Store Schema: 现状与剩余工作

> Version 0.1 | 2026-04-19
> Purpose: A3 Phase 3.1 设计交付物。但和原 roadmap 预期不同——store_schema 的**语法、Zod 校验、derivation、pipeline validator 集成都已落地**。本文档是 **gap analysis**：核对已做 vs 未做，定义剩余工作。

---

## 0. TL;DR

**Roadmap 以为要做什么** vs **代码里实际已做什么**：

| Step | Roadmap 说法 | 实际状态 | 证据 |
|---|---|---|---|
| 3.1 设计 store_schema YAML 语法 | 要做 | ✅ 已做 | `lib/config/types.ts:143-162` 定义了 `StoreSchemaField`/`StoreSchemaEntry`；`lib/config/schema.ts:261-291` 的 Zod 校验 |
| 3.2 parser + validator + 单测 | 要做 | ✅ 已做 | `lib/config/store-schema.ts` 有 `deriveStageWrites` / `deriveStageOutputs`；`store-schema.test.ts` 10 个测试 |
| 3.3 pipeline validator 接入 drift 检查 | 要做 | 🟡 部分 | `packages/shared/src/pipeline-validator.ts` 已按 schema pre-populate writes；但 warn 级别，不 reject |
| 3.4 3 个内置 pipeline 迁移到 schema | 要做 | 🟡 1/3 | `pipeline-generator` 已迁移（5 个 schema entry）；`tech-research` / `web3-tech-research` **根本不存在**（见 Phase 0 补做议题） |
| 3.5 运行时写入 shape 校验 | 要做 | ❌ 未做 | `applyStoreUpdates` 在 `state-builders.ts:84` 无 shape 校验 |
| 3.6 tier1 context 基于 schema 重写 | 要做 | ❌ 未做 | `context-builder.ts` 仍是 5 级 fallback |
| 3.7 token 回归测试 | 要做 | ❌ 未做 | 无测试 |

**核心判断**：A3 Phase 3A（schema 表达 + 校验）**已完成 80%**，剩 3.3 的 severity 提升 + 3.4 的 Phase 0 依赖。A3 Phase 3B（runtime enforcement + tier1 rewrite）**未开始**。

---

## 1. 现状：已实现的部分

### 1.1 类型系统

```typescript
// lib/config/types.ts
export interface StoreSchemaField {
  type: "string" | "number" | "boolean" | "string[]" | "object" | "object[]" | "markdown";
  description?: string;
  required?: boolean;
  fields?: Record<string, StoreSchemaField>;   // 支持嵌套
  display_hint?: "link" | "badge" | "code";
  hidden?: boolean;
}

export interface StoreSchemaEntry {
  produced_by: string;                         // 生产者 stage 名
  type?: "object";
  description?: string;
  required?: boolean;
  fields?: Record<string, StoreSchemaField>;
  additional_properties?: boolean;             // 允许未声明字段（未 enforce）
  assertions?: string[];                       // expr-eval 表达式（已 enforce）
}

export type StoreSchema = Record<string, StoreSchemaEntry>;
```

### 1.2 YAML 语法（样例）

出自 `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml`：

```yaml
store_schema:
  pipelineDesign:
    produced_by: analyzing           # 声明：analyzing stage 写这个 key
    description: Pipeline Design
    fields:
      pipelineName:
        type: string
        description: Human-readable pipeline name
      estimatedStageCount:
        type: number
      stageContracts:
        type: object[]
        description: Structured naming contracts for each stage
  pipelineYaml:
    produced_by: genSkeleton
    fields:
      pipeline:
        type: object
      warnings:
        type: string[]
```

### 1.3 Derivation（build 时）

`lib/config/store-schema.ts` 从 schema 自动生成每个 stage 的 `writes` / `outputs`：

```typescript
// Build time: no stage-level "writes" / "outputs" needed in YAML
deriveStageWrites(schema, "analyzing")
// → [{ key: "pipelineDesign" }]

deriveStageOutputs(schema, "analyzing")
// → { pipelineDesign: { type: "object", fields: [...] } }
```

意义：pipeline 作者（AI）**只在 `store_schema` 里声明一次**，stage 内不重复写 `writes` 和 `outputs`。实际 pipeline-generator YAML 的 agent stage **已经没有 `writes:` 字段**。

### 1.4 Pipeline Validator 集成

`packages/shared/src/pipeline-validator.ts:71` 接受 `storeSchema` 参数，预填 `allWrites`（让 `reads` 声明能命中 schema 定义的 key）。

有一个部分执行的 drift check（第 556-591 行）：
- 如果 stage 手写了 `writes` 且对应 key **不在** `outputs` 里 → 发 **warning**
- 如果 stage `outputs` 有 key 但 `writes` 没声明 → 发 **warning**
- Schema-derived 的 key 跳过此检查（避免误报）

### 1.5 Assertions 已 enforce

`machine/assertion-evaluator.ts` 用 expr-eval 沙盒执行 `assertions`。state-builders 在 stage 输出落盘时跑 assertions，失败则 retry。**已生产可用**。

### 1.6 完成度评估

| 能力 | 状态 |
|---|---|
| YAML 表达 store 结构 | ✅ 完整 |
| Build 时 derive writes/outputs | ✅ 完整 |
| Zod schema 校验 | ✅ 完整 |
| Assertions 运行时执行 | ✅ 完整 |
| Pipeline validator 集成 | 🟡 warn 级 |
| pipeline-generator 使用 | ✅ 完整 |

---

## 2. 现状：未实现的部分

### 2.1 运行时 shape 校验（Phase 3.5，未做）

**现状**：`state-builders.ts:84-99` 的 `applyStoreUpdates`：

```typescript
function applyStoreUpdates(store, updates, writeStrategies): void {
  for (const [key, value] of Object.entries(updates)) {
    const strategy = writeStrategies.get(key) ?? "replace";
    if (strategy === "append" && Array.isArray(store[key])) {
      store[key] = [...store[key], ...(Array.isArray(value) ? value : [value])];
    } else if (strategy === "merge" && ...) {
      store[key] = { ...store[key], ...value };
    } else {
      store[key] = value;
    }
  }
}
```

**没有 schema 校验**。agent 吐出的 JSON 是什么形状就写什么形状。

**缺陷**：
- stage 声明 `pipelineDesign.fields.estimatedStageCount: number`
- agent 写入 `{ estimatedStageCount: "约 5 个" }`
- applyStoreUpdates 原样写入，下游 stage `reads` 时拿到 string 而非 number
- 下游 stage 静默失败或产生错误输出

**影响**：这是 A3 roadmap 说的"runtime 无类型强制"的根本问题。schema 存在但不执行，等于没有。

### 2.2 Pipeline Validator 未拒绝未声明的 writes（Phase 3.3 部分未做）

**现状**：validator 目前是 warn 级。

- Stage 声明 schema 里没有的 key → warn
- Stage schema 里有但 writes 未声明 → warn

**Roadmap 期望**：**error 级**，reject 未声明的 writes，不允许 build。

**缺陷**：`persist-pipeline` 接受 warn，依然保存。AI 写 pipeline 时如果 writes 和 schema 不一致，不会被立即挡下。

### 2.3 Tier1 context 仍是 5 级 fallback（Phase 3.6，未做）

**现状**：`context-builder.ts:136-146` 保留完整的 5 级压缩级联（完整 inline → 语义摘要 → 字段预览 → 概要视图）。

**Roadmap 期望**：既然 schema 已知 reads 对应字段的 shape，tier1 应该：
- 只渲染 reads 涉及的字段（不扫全量 store）
- 按 schema 的 `type` 直接格式化（`type: string[]` → 渲染为 bullet list；`type: markdown` → 原样；`type: number` → 一行）
- 删 5 级 fallback（schema 就是 shape 的 source of truth）

**阻碍**：tier1 改写需要大量回归测试（3.7），容易引入 token 数或信息丢失。

### 2.4 Additional properties 未 enforce

`StoreSchemaEntry.additional_properties: boolean` 字段存在于类型和 YAML 里，但 `applyStoreUpdates` 不读它。

**影响**：声明 `additional_properties: false` 的 entry 不会拒绝额外字段。当前语义是"文档性"，不是"强制性"。

---

## 3. 剩余工作分解

### Phase 3.3-hard：提升 validator 到 error 级 + 强制 schema

**工作量**：1-2 天

**改动**：
- `packages/shared/src/pipeline-validator.ts:560-591` 的 warn → error
- **新增**：pipeline 没声明 `store_schema` → 发 error（Q3 决策：不兼容 legacy）
- `services/pipeline-generator.ts:275` 的 `getValidationErrors` 已经区分 severity，改 severity 后自动 reject
- 更新现有测试
- **当前只有 pipeline-generator，已有 schema，无回归**

**风险**：pipeline-autofix 可能需要更新，让它自动修 drift。

### Phase 3.4-wait：内置 pipeline 迁移

**阻塞**：只有 1 个内置 pipeline，其他 2 个根本不存在（Phase 0 补做议题里记录）。

**处理**：等 Phase 0 补做恢复 `tech-research` / `web3-tech-research` 后，带 schema 一起写，不单独做。

### Phase 3.5：运行时 shape 校验

**工作量**：3-4 天

**设计**（应用 §5 决策）：

```typescript
// lib/config/store-schema-validator.ts (新文件)
export function validateStoreValue(
  value: unknown,
  field: StoreSchemaField,
  path: string,
): ValidationError[] {
  // 递归校验 value 符合 field 的 type + nested fields
  // - type === "markdown" 等同 type === "string" (Q4)
  // - required 字段缺失 → error
  // - 类型不匹配 → error
}

export function validateStoreUpdate(
  schema: StoreSchema,
  key: string,
  value: unknown,
): ValidationError[] {
  const entry = schema[key];
  if (!entry) {
    // Q3: 强制 schema，未声明的 key 一律 error
    return [{ path: key, message: "key not declared in store_schema" }];
  }
  // Q2: additional_properties 默认 false — value 里有 schema.fields 之外的 key → error
  // 递归校验每个 field
}
```

**落点**：`applyStoreUpdates` 接受 schema 参数，校验失败 → **不写入** + **抛 stage 错误**，按现有 retry 逻辑重跑（Q1 决策：retry with feedback）。

**反馈注入格式**（给 agent 重试时看到）：

```
[Schema validation failed on previous attempt]
Key "pipelineDesign": field "estimatedStageCount" expected number, got string "约 5 个"
Key "pipelineDesign": required field "pipelineName" missing
Fix these and retry.
```

### Phase 3.6：Tier1 重写

**工作量**：1 周 + 3-4 天回归

**设计**：

```typescript
// context-builder.ts 新函数
export function buildTier1ContextFromSchema(
  context: WorkflowContext,
  runtime: AgentRuntimeConfig,
  schema: StoreSchema,
  maxTokens: number,
): string {
  // 1. 解析每个 reads 目标，定位到 schema 条目
  // 2. 按 schema.fields 的 type 格式化，不 fallback 5 级
  // 3. 超预算时优先保留 required: true 字段
  // 4. Other Available Context 也按 schema 列，注明可用的 sub-paths
}
```

**风险**：
- pipeline-generator 的 `pipelineDesign.stageContracts: object[]` 可能很大 → 需要摘要策略，不能简单 inline
- Token 数变化要回归测试确认不恶化

**无降级**：Q3 决策强制所有 pipeline 必须有 schema。3.6 实施时**删除** `context-builder.ts` 里的 5 级 fallback 逻辑（fallback 变死代码）。

### Phase 3.7：Token 回归测试

**工作量**：2-3 天

**内容**：
- 固定几个典型 reads 组合（小 store、大 store、深嵌套、大数组）
- 记录 tier1 token 数 before/after
- 断言：p50 不退步 30%+，p95 不退步 50%+
- 信息丢失检查：关键字段（required: true）不能缺失

---

## 4. 接下来做什么

### 推荐顺序

| # | 动作 | 工作量 | 必要性 |
|---|---|---|---|
| 1 | **Phase 3.3-hard**：validator drift 提 error 级 | 1 天 | 高 |
| 2 | **Phase 3.5**：运行时 shape 校验 | 3-4 天 | 高 |
| 3 | **Phase 3.7** 先做一部分：建立 token 基线测试 | 2 天 | 中 |
| 4 | **Phase 3.6**：tier1 重写 | 1 周 | 高（ROI 高） |
| 5 | Phase 0 补做（恢复 2 个内置 pipeline） | 1-2 周 | 依赖 |
| 6 | Phase 3.4：内置 pipeline 迁移 | 3 天 | 等 5 完成 |

### 为什么推荐先 3.3 + 3.5

- 3.3 是 **trivial enforcement**，能立刻提高 AI 写 pipeline 时的反馈质量
- 3.5 是 **根本性**问题——schema 存在但不执行等于没有
- 两者都不触碰 tier1 context 结构，风险低

### 3.6 在 3.7 之后做的原因

3.6 动 tier1 => token 数会变化 => 需要基线测试 (3.7) 在前作为保险。**不能蒙着重写**。

### 5 / 6 的依赖

Phase 0 补做和 Phase 3 不紧耦合——可以并行。但如果先做 Phase 0 补做，第二、三个 pipeline 就能直接以 schema 形式诞生，省一次迁移。

---

## 5. 设计决策（已确认）

2026-04-19 作者拍板：**全部从严，不兼容 legacy**。以下 4 个问题的决策：

### Q1：shape 校验失败行为 → **A (retry with feedback)**

Agent 写出的 value 不符合 schema → **stage 失败 + 注入 "shape 不符" 反馈 + retry**。

- 跟现有 `assertions` 失败处理语义一致
- Agent 能根据反馈自我修正
- 超过 retry 上限仍然失败 → 走现有 blocked 流程（不是新逻辑）

### Q2：`additional_properties` 默认值 → **`false` (拒绝额外字段)**

Entry 没显式写 `additional_properties` → 等同 `additional_properties: false`：**schema 没声明的字段不允许出现**。

- 严格契约：schema 就是完整 shape 定义
- 想宽松的作者显式写 `additional_properties: true`
- pipeline-generator 当前 5 个 entry 都没写该字段，实施 3.5 时需要 review 这些 entry 的实际字段集，决定是显式声明 `true` 还是补全 fields

### Q3：Legacy 兼容 → **不兼容，强制全 pipeline 声明 schema**

**3A**：**pipeline validator build 时拒绝**没有 `store_schema` 的 pipeline（error 级）。

- 没 schema 的 pipeline 根本进不了系统
- 不用处理 "没 schema 时运行时走什么路径" 的 legacy 分支
- 配合 3.5 / 3.6 删掉所有 fallback 逻辑

**影响**：
- 当前只有 1 个内置 pipeline（已有 schema），无回归
- Phase 0 补做 `tech-research` / `web3-tech-research` 时必须带 schema
- pipeline-generator 生成 YAML 时必须产出 schema

### Q4：`markdown` type 的运行时语义 → **等同 string**

- `type: markdown` 在运行时 shape 校验等价于 `type: string`
- 不做 markdown 语法检查（ROI 低）
- `markdown` 仅用作**展示提示**（frontend 按 markdown 渲染）和**pipeline 作者意图表达**

---

## 6. 不覆盖的议题

本文档**不**包含：

- Phase 3.6 tier1 的具体压缩算法（留到 3.6 实施时细化）
- Pipeline-generator 的 prompt 如何指导 AI 正确写 schema（属于 pipeline-generator 本身的维护）
- 数据库 migration（研发期无 migration，schema 变化用 `rm -rf data_dir`）

---

## 7. 参考

- 已落地代码：
  - `apps/server/src/lib/config/types.ts:143-162`
  - `apps/server/src/lib/config/schema.ts:261-291`
  - `apps/server/src/lib/config/store-schema.ts`（整个文件）
  - `apps/server/src/lib/config/store-schema.test.ts`
  - `apps/server/src/machine/pipeline-builder.ts:117-150`
  - `apps/server/src/machine/assertion-evaluator.ts`
  - `packages/shared/src/pipeline-validator.ts:71, 85-92, 555-591`
- 已迁移 pipeline：
  - `apps/server/src/builtin-pipelines/pipeline-generator/pipeline.yaml:14-118`
- 相关评估：
  - `docs/dataflow-model-evaluation.md` §1.3（当前 A3 只是黑板模式的补丁）
- Roadmap：
  - `docs/product-roadmap.md` §6.3（A3 原计划）

---

## 修订历史

| 日期 | 版本 | 修改 |
|---|---|---|
| 2026-04-19 | 0.1 | 首版。gap analysis 而非从零设计 |
