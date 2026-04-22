# Stage 5E — Hot Update Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox `- [ ]`.

**Goal:** B 系列收尾：聚合查询、清理 skipped tests、端到端集成、文档。

**Architecture:** 单一纯函数模块 `hot-update/stats.ts` + 测试。`KernelService.queryHotUpdateStats` thin delegator。`mcp/server.ts` 注册 `query_hot_update_stats` external tool。清理 11 skipped tests。3 个 end-to-end 测试。

**Tech Stack:** TypeScript strict, vitest, node:sqlite.

---

## File Structure

### New

| File | 作用 |
|---|---|
| `apps/server/src/kernel-next/hot-update/stats.ts` | `computeHotUpdateStats(db, input): StatsOutput` 纯读 DB |
| `apps/server/src/kernel-next/hot-update/stats.test.ts` | 单测 |
| `apps/server/src/kernel-next/hot-update/end-to-end.test.ts` | 3 个 scenario 测试 |

### Modified

| File | 变更 |
|---|---|
| `apps/server/src/kernel-next/mcp/kernel.ts` | + `queryHotUpdateStats` 方法 |
| `apps/server/src/kernel-next/mcp/server.ts` | + `query_hot_update_stats` tool 注册 |
| `apps/server/src/kernel-next/mcp/server.test.ts` | tool list 断言 20→21 / 19→20 |
| `apps/server/src/kernel-next/mcp/migrate-task.test.ts` | 删除 9 个 `it.skip` block |
| `docs/product-roadmap.md` | B22 状态 + 5.17-5.20 + v1.7 |

### Deleted

| File | 理由 |
|---|---|
| `apps/server/src/kernel-next/mcp/a2-3-5-live-migration.adversarial.test.ts` | 2 skipped 全部；语义被 orchestrator + agent-machine 覆盖 |

---

## Task 1: stats.ts 纯函数

- [ ] **Step 1.1 — 写测试**

创建 `apps/server/src/kernel-next/hot-update/stats.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { computeHotUpdateStats } from "./stats.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function seedVersion(db: DatabaseSync, hash: string, name: string): void {
  db.prepare(
    `INSERT INTO pipeline_versions (version_hash, name, ir_json, ts_source, created_at)
     VALUES (?, ?, '{}', '', ?)`,
  ).run(hash, name, Date.now());
}

function seedEvent(
  db: DatabaseSync,
  eventId: string,
  taskId: string,
  fromV: string,
  toV: string,
  status: "success" | "failed" | "rolled_back",
  actor: string,
  startedAt: number,
): void {
  db.prepare(
    `INSERT INTO hot_update_events
     (event_id, task_id, from_version, to_version, actor, proposal_id,
      rerun_from_stage, status, started_at, finished_at, diagnostic_json)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
  ).run(eventId, taskId, fromV, toV, actor, status, startedAt, startedAt + 10);
}

describe("computeHotUpdateStats", () => {
  it("empty DB → all zeros", () => {
    const db = makeDb();
    const r = computeHotUpdateStats(db, {});
    expect(r.totalMigrations).toBe(0);
    expect(r.successCount).toBe(0);
    expect(r.failedCount).toBe(0);
    expect(r.rolledBackCount).toBe(0);
    expect(r.successRate).toBe(0);
    expect(r.rollbackRate).toBe(0);
    expect(r.byPipelineName).toEqual({});
    expect(r.byActor).toEqual({});
    expect(r.topChurnPipelines).toEqual([]);
    db.close();
  });

  it("aggregates status counts", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t1", "vA", "vA", "success", "ai", 200);
    seedEvent(db, "e3", "t1", "vA", "vA", "failed", "ai", 300);
    seedEvent(db, "e4", "t1", "vA", "vA", "rolled_back", "user", 400);
    const r = computeHotUpdateStats(db, {});
    expect(r.totalMigrations).toBe(4);
    expect(r.successCount).toBe(2);
    expect(r.failedCount).toBe(1);
    expect(r.rolledBackCount).toBe(1);
    expect(r.successRate).toBe(0.5);
    expect(r.rollbackRate).toBe(0.25);
    db.close();
  });

  it("groups byPipelineName via JOIN on to_version", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedVersion(db, "vB", "pipeB");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t1", "vA", "vB", "success", "ai", 200);
    seedEvent(db, "e3", "t2", "vB", "vB", "failed", "ai", 300);
    const r = computeHotUpdateStats(db, {});
    expect(r.byPipelineName["pipeA"]).toEqual({
      total: 1, success: 1, failed: 0, rolled_back: 0,
    });
    expect(r.byPipelineName["pipeB"]).toEqual({
      total: 2, success: 1, failed: 1, rolled_back: 0,
    });
    db.close();
  });

  it("groups byActor", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t1", "vA", "vA", "success", "user", 200);
    seedEvent(db, "e3", "t1", "vA", "vA", "failed", "ai", 300);
    const r = computeHotUpdateStats(db, {});
    expect(r.byActor).toEqual({ ai: 2, user: 1 });
    db.close();
  });

  it("topChurnPipelines sorted by total desc, rates per pipeline", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedVersion(db, "vB", "pipeB");
    seedVersion(db, "vC", "pipeC");
    // pipeA: 3 total (2 success 1 failed)
    seedEvent(db, "a1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "a2", "t1", "vA", "vA", "success", "ai", 200);
    seedEvent(db, "a3", "t1", "vA", "vA", "failed", "ai", 300);
    // pipeB: 2 total (1 success 1 rolled_back)
    seedEvent(db, "b1", "t1", "vB", "vB", "success", "ai", 400);
    seedEvent(db, "b2", "t1", "vB", "vB", "rolled_back", "user", 500);
    // pipeC: 1 total (success)
    seedEvent(db, "c1", "t1", "vC", "vC", "success", "ai", 600);

    const r = computeHotUpdateStats(db, {});
    expect(r.topChurnPipelines[0]!.pipelineName).toBe("pipeA");
    expect(r.topChurnPipelines[0]!.total).toBe(3);
    expect(r.topChurnPipelines[1]!.pipelineName).toBe("pipeB");
    expect(r.topChurnPipelines[1]!.total).toBe(2);
    expect(r.topChurnPipelines[2]!.pipelineName).toBe("pipeC");
    expect(r.topChurnPipelines[0]!.successRate).toBeCloseTo(2 / 3, 5);
    expect(r.topChurnPipelines[1]!.rollbackRate).toBe(0.5);
    db.close();
  });

  it("applies taskId filter", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t2", "vA", "vA", "failed", "ai", 200);
    const r = computeHotUpdateStats(db, { taskId: "t1" });
    expect(r.totalMigrations).toBe(1);
    expect(r.successCount).toBe(1);
    expect(r.failedCount).toBe(0);
    db.close();
  });

  it("applies pipelineName filter (via JOIN on to_version)", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedVersion(db, "vB", "pipeB");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t2", "vB", "vB", "success", "ai", 200);
    const r = computeHotUpdateStats(db, { pipelineName: "pipeA" });
    expect(r.totalMigrations).toBe(1);
    db.close();
  });

  it("applies sinceMs / untilMs time window", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t1", "vA", "vA", "success", "ai", 500);
    seedEvent(db, "e3", "t1", "vA", "vA", "success", "ai", 1000);
    const r = computeHotUpdateStats(db, { sinceMs: 200, untilMs: 800 });
    expect(r.totalMigrations).toBe(1);
    db.close();
  });

  it("applies actor filter", () => {
    const db = makeDb();
    seedVersion(db, "vA", "pipeA");
    seedEvent(db, "e1", "t1", "vA", "vA", "success", "ai", 100);
    seedEvent(db, "e2", "t1", "vA", "vA", "success", "user", 200);
    const r = computeHotUpdateStats(db, { actor: "user" });
    expect(r.totalMigrations).toBe(1);
    expect(r.byActor).toEqual({ user: 1 });
    db.close();
  });
});
```

- [ ] **Step 1.2 — 确认 FAIL**

```
cd apps/server && npx vitest run src/kernel-next/hot-update/stats.test.ts 2>&1 | tail -5
```

- [ ] **Step 1.3 — 实现 stats.ts**

创建 `apps/server/src/kernel-next/hot-update/stats.ts`：

```ts
// Aggregate queries over hot_update_events for Stage 5E B22.
// Pure read — no writes. Consumer: query_hot_update_stats MCP tool.

import type { DatabaseSync } from "node:sqlite";

export interface StatsInput {
  taskId?: string;
  pipelineName?: string;
  sinceMs?: number;
  untilMs?: number;
  actor?: string;
}

export interface PipelineBreakdown {
  total: number;
  success: number;
  failed: number;
  rolled_back: number;
}

export interface ChurnEntry {
  pipelineName: string;
  total: number;
  successRate: number;
  rollbackRate: number;
}

export interface StatsOutput {
  totalMigrations: number;
  successCount: number;
  failedCount: number;
  rolledBackCount: number;
  successRate: number;
  rollbackRate: number;
  byPipelineName: Record<string, PipelineBreakdown>;
  byActor: Record<string, number>;
  topChurnPipelines: ChurnEntry[];
}

const TOP_CHURN_LIMIT = 10;

export function computeHotUpdateStats(
  db: DatabaseSync,
  input: StatsInput,
): StatsOutput {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (input.taskId !== undefined) {
    where.push("hue.task_id = ?");
    params.push(input.taskId);
  }
  if (input.pipelineName !== undefined) {
    where.push("pv.name = ?");
    params.push(input.pipelineName);
  }
  if (input.sinceMs !== undefined) {
    where.push("hue.started_at >= ?");
    params.push(input.sinceMs);
  }
  if (input.untilMs !== undefined) {
    where.push("hue.started_at <= ?");
    params.push(input.untilMs);
  }
  if (input.actor !== undefined) {
    where.push("hue.actor = ?");
    params.push(input.actor);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT hue.status AS status, hue.actor AS actor, pv.name AS pipeline_name
    FROM hot_update_events hue
    LEFT JOIN pipeline_versions pv ON pv.version_hash = hue.to_version
    ${whereSql}
  `;
  const rows = db.prepare(sql).all(...params) as Array<{
    status: "success" | "failed" | "rolled_back";
    actor: string;
    pipeline_name: string | null;
  }>;

  let successCount = 0;
  let failedCount = 0;
  let rolledBackCount = 0;
  const byPipelineName: Record<string, PipelineBreakdown> = {};
  const byActor: Record<string, number> = {};

  for (const row of rows) {
    if (row.status === "success") successCount++;
    else if (row.status === "failed") failedCount++;
    else if (row.status === "rolled_back") rolledBackCount++;

    byActor[row.actor] = (byActor[row.actor] ?? 0) + 1;

    if (row.pipeline_name !== null) {
      const entry = byPipelineName[row.pipeline_name] ??= {
        total: 0, success: 0, failed: 0, rolled_back: 0,
      };
      entry.total++;
      entry[row.status]++;
    }
  }

  const totalMigrations = rows.length;
  const successRate = totalMigrations > 0 ? successCount / totalMigrations : 0;
  const rollbackRate = totalMigrations > 0 ? rolledBackCount / totalMigrations : 0;

  const topChurnPipelines: ChurnEntry[] = Object.entries(byPipelineName)
    .map(([pipelineName, b]) => ({
      pipelineName,
      total: b.total,
      successRate: b.total > 0 ? b.success / b.total : 0,
      rollbackRate: b.total > 0 ? b.rolled_back / b.total : 0,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_CHURN_LIMIT);

  return {
    totalMigrations,
    successCount,
    failedCount,
    rolledBackCount,
    successRate,
    rollbackRate,
    byPipelineName,
    byActor,
    topChurnPipelines,
  };
}
```

- [ ] **Step 1.4 — 确认 PASS**

```
cd apps/server && npx vitest run src/kernel-next/hot-update/stats.test.ts 2>&1 | tail -5
```
期望：9 tests passed.

- [ ] **Step 1.5 — tsc + commit**

```bash
cd apps/server && npx tsc --noEmit
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/hot-update/stats.ts apps/server/src/kernel-next/hot-update/stats.test.ts
git commit -m "feat(hot-update-5e): computeHotUpdateStats — B22 aggregate queries"
```

---

## Task 2: KernelService.queryHotUpdateStats + MCP tool

- [ ] **Step 2.1 — KernelService 方法**

在 `apps/server/src/kernel-next/mcp/kernel.ts`：

import 追加：
```ts
import {
  computeHotUpdateStats,
  type StatsInput,
  type StatsOutput,
} from "../hot-update/stats.js";
```

在 class 末尾（`rollbackHotUpdate` 之后）加：
```ts
  /**
   * Stage 5E — aggregate queries over hot_update_events. Supports
   * scoping by taskId / pipelineName / time window / actor. All filters
   * are optional and combined with AND.
   */
  queryHotUpdateStats(input: StatsInput): StatsOutput {
    return computeHotUpdateStats(this.db, input);
  }
```

- [ ] **Step 2.2 — MCP tool 注册**

在 `apps/server/src/kernel-next/mcp/server.ts`：

`ToolName` 追加 `| "query_hot_update_stats"`，`EXTERNAL_TOOLS` 追加 `"query_hot_update_stats"`。

在 `rollback_hot_update` 注册后追加：

```ts
      {
        name: "query_hot_update_stats",
        description:
          "Stage 5E — aggregate queries over hot_update_events. Returns " +
          "total/success/failed/rollback counts, per-pipeline breakdown, " +
          "per-actor counts, and top-churn pipelines. All filters optional.",
        inputSchema: {
          taskId: z.string().optional(),
          pipelineName: z.string().optional(),
          sinceMs: z.number().int().optional(),
          untilMs: z.number().int().optional(),
          actor: z.string().optional(),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: async (args: any) => {
          try {
            return jsonResponse({
              ok: true,
              stats: kernel.queryHotUpdateStats({
                taskId: typeof args.taskId === "string" ? args.taskId : undefined,
                pipelineName: typeof args.pipelineName === "string" ? args.pipelineName : undefined,
                sinceMs: typeof args.sinceMs === "number" ? args.sinceMs : undefined,
                untilMs: typeof args.untilMs === "number" ? args.untilMs : undefined,
                actor: typeof args.actor === "string" ? args.actor : undefined,
              }),
            });
          } catch (err) {
            return errorResponse(err instanceof Error ? err.message : String(err));
          }
        },
      },
```

- [ ] **Step 2.3 — server.test.ts 断言更新**

找到 `expect([...tools.keys()].sort()).toEqual([...])` 两处（combined 和 external），插入 `"query_hot_update_stats"` 到正确的字典序位置（在 `query_lineage` 之后，`read_port` 之前）。

combined test: size 从 20 变 21；external test: size 从 19 变 20。

在对应 `tools.size).toBe(N)` 处也加 1。在"combined includes every tool"处加 `expect(tools.has("query_hot_update_stats")).toBe(true);`。

- [ ] **Step 2.4 — 跑**

```
cd apps/server && npx vitest run src/kernel-next/mcp/server.test.ts src/kernel-next/mcp/kernel.test.ts 2>&1 | tail -10
```
期望：全绿。

- [ ] **Step 2.5 — tsc + commit**

```bash
cd apps/server && npx tsc --noEmit
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/mcp/kernel.ts apps/server/src/kernel-next/mcp/server.ts apps/server/src/kernel-next/mcp/server.test.ts
git commit -m "feat(hot-update-5e): register query_hot_update_stats MCP tool"
```

---

## Task 3: 清理 migrate-task.test.ts 9 skipped blocks

- [ ] **Step 3.1 — 删除 9 个 it.skip block**

打开 `apps/server/src/kernel-next/mcp/migrate-task.test.ts`，删除每一个 `it.skip(...)` 完整块（从 `it.skip(` 开始，到对应的 `});` 结束，含中间所有 body）。9 个块分布在 241/349/413/442/481/505/545/592/649 行附近。

推荐做法：逐个识别删除，保留非 skip 的 test 和 describe 壳。

删除后，对每个无剩余 `it` 的 `describe` 块（如 A2.3.4 describe 全部是 skipped）也一并删除 describe 壳。

- [ ] **Step 3.2 — 确保通过**

```
cd apps/server && npx vitest run src/kernel-next/mcp/migrate-task.test.ts 2>&1 | tail -5
```
期望：7 tests passed, 0 skipped, 0 failed.

- [ ] **Step 3.3 — tsc + commit**

```bash
cd apps/server && npx tsc --noEmit
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/mcp/migrate-task.test.ts
git commit -m "chore(hot-update-5e): delete 9 skipped A8-era migrate-task tests (coverage moved to orchestrator)"
```

---

## Task 4: 删除 a2-3-5-live-migration.adversarial.test.ts

- [ ] **Step 4.1 — 删文件**

```bash
cd /Users/minghao/workflow-control
git rm apps/server/src/kernel-next/mcp/a2-3-5-live-migration.adversarial.test.ts
```

- [ ] **Step 4.2 — 确认无 import 引用**

```
grep -rn "a2-3-5-live-migration" apps/server/src 2>&1 | head
```
期望：零结果。

- [ ] **Step 4.3 — commit**

```bash
cd /Users/minghao/workflow-control
git commit -m "chore(hot-update-5e): delete a2-3-5-live-migration adversarial suite (2 skipped tests; superseded by orchestrator + agent-machine coverage)"
```

---

## Task 5: end-to-end 集成测试

- [ ] **Step 5.1 — 创建 end-to-end.test.ts**

创建 `apps/server/src/kernel-next/hot-update/end-to-end.test.ts`:

```ts
// Stage 5E end-to-end integration — exercises submit → propose autoApprove
// → migrate → query_hot_update_stats round-trip, plus rollback and INTERRUPT
// timeout paths. Uses mock startRunner so the orchestrator can complete
// without launching real agents.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import {
  executeMigration,
  __resetOrchestratorLocksForTest,
} from "./migration-orchestrator.js";
import { executeRollback } from "./rollback.js";
import { taskRegistry } from "../runtime/task-registry.js";

function diamondPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of diamondIR().stages) {
    if (s.type === "agent") out[s.config.promptRef] = "dummy";
  }
  return out;
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function seedAttempt(
  db: DatabaseSync, taskId: string, versionHash: string,
  stageName: string, status: "success" | "running" | "error" | "superseded",
): string {
  const attemptId = randomUUID();
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, status,
      started_at, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'regular')`,
  ).run(attemptId, taskId, versionHash, stageName, 0, status, Date.now());
  return attemptId;
}

describe("Stage 5E end-to-end: autoApprove → migrate → stats", () => {
  beforeEach(() => {
    __resetOrchestratorLocksForTest();
    taskRegistry.__clearForTest();
  });

  it("idle task: autoApprove safe, migrate succeeds, stats reports 1 success", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");

    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    seedAttempt(db, "t-e2e-1", submitted.versionHash, firstAgent.name, "success");

    const newPromptRef = firstAgent.type === "agent"
      ? firstAgent.config.promptRef + "-v2" : "x";
    const propose = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{
        op: "update_stage_config", stage: firstAgent.name,
        configPatch: { promptRef: newPromptRef },
      }] },
      actor: "ai",
      rerunFrom: firstAgent.name,
      migrateRunningTasks: ["t-e2e-1"],
      autoApprove: true,
    });
    if (!propose.ok) throw new Error("propose failed");
    expect(propose.autoApplied).toBe(true);

    const startRunner = vi.fn(async () => ({
      ok: true as const, taskId: "t-e2e-1", versionHash: propose.proposedVersion,
    }));
    const mig = await executeMigration({
      db, taskId: "t-e2e-1", proposalId: propose.proposalId,
      startRunnerOverride: startRunner as never,
    });
    expect(mig.ok).toBe(true);

    const stats = svc.queryHotUpdateStats({ taskId: "t-e2e-1" });
    expect(stats.totalMigrations).toBe(1);
    expect(stats.successCount).toBe(1);
    expect(stats.failedCount).toBe(0);
    expect(stats.rolledBackCount).toBe(0);
    db.close();
  });

  it("forward then rollback: stats reports 2 success + 1 rolled_back", async () => {
    const db = makeDb();
    const svc = new KernelService(db, { skipTypeCheck: true });
    const v1 = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!v1.ok) throw new Error("submit failed");

    // Seed all diamond stages completed on v1
    for (const s of diamondIR().stages) {
      seedAttempt(db, "t-e2e-2", v1.versionHash, s.name, "success");
    }

    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    const newPromptRef = firstAgent.type === "agent"
      ? firstAgent.config.promptRef + "-fwd" : "x";
    const prop = svc.propose({
      currentVersion: v1.versionHash,
      patch: { ops: [{
        op: "update_stage_config", stage: firstAgent.name,
        configPatch: { promptRef: newPromptRef },
      }] },
      actor: "ai",
      rerunFrom: firstAgent.name,
      migrateRunningTasks: ["t-e2e-2"],
      autoApprove: true,
    });
    if (!prop.ok) throw new Error("propose failed");
    const v2 = prop.proposedVersion;

    // Forward migration
    const startRunner = vi.fn(async () => ({
      ok: true as const, taskId: "t-e2e-2", versionHash: v2,
    }));
    const fwd = await executeMigration({
      db, taskId: "t-e2e-2", proposalId: prop.proposalId,
      startRunnerOverride: startRunner as never,
    });
    expect(fwd.ok).toBe(true);

    // Seed new attempt on v2 so rollback can discover currentVersion=v2
    seedAttempt(db, "t-e2e-2", v2, firstAgent.name, "running");

    const rb = await executeRollback({
      db, taskId: "t-e2e-2", toVersion: v1.versionHash, actor: "user",
      startRunnerOverride: startRunner as never,
    });
    expect(rb.ok).toBe(true);

    const stats = svc.queryHotUpdateStats({ taskId: "t-e2e-2" });
    // 1 forward success + 1 rollback-driven success + 1 rolled_back audit = 3
    expect(stats.totalMigrations).toBe(3);
    expect(stats.successCount).toBe(2);
    expect(stats.rolledBackCount).toBe(1);
    db.close();
  });

  it("INTERRUPT timeout: state preserved, stats reports failedCount=1", async () => {
    const db = makeDb();
    const svc = new KernelService(db, {
      skipTypeCheck: true, migrationInterruptWaitMsOverride: 50,
    });
    const submitted = svc.submit(diamondIR(), { prompts: diamondPrompts() });
    if (!submitted.ok) throw new Error("submit failed");
    const firstAgent = diamondIR().stages.find((s) => s.type === "agent")!;
    seedAttempt(db, "t-e2e-3", submitted.versionHash, firstAgent.name, "running");

    // Register a swallowing dispatcher to simulate hung runner
    taskRegistry.register("t-e2e-3", { send: () => { /* swallow */ } });

    const newPromptRef = firstAgent.type === "agent"
      ? firstAgent.config.promptRef + "-v2" : "x";
    const prop = svc.propose({
      currentVersion: submitted.versionHash,
      patch: { ops: [{
        op: "update_stage_config", stage: firstAgent.name,
        configPatch: { promptRef: newPromptRef },
      }] },
      actor: "ai",
      rerunFrom: firstAgent.name,
      migrateRunningTasks: ["t-e2e-3"],
      autoApprove: true,
    });
    if (!prop.ok) throw new Error("propose failed");

    const result = await svc.migrateTask("t-e2e-3", prop.proposalId);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.diagnostics[0]!.code).toBe("MIGRATION_INTERRUPT_TIMEOUT");

    // Stage still running — no state change
    const stillRunning = db.prepare(
      `SELECT status FROM stage_attempts WHERE task_id = 't-e2e-3' AND stage_name = ?`,
    ).get(firstAgent.name) as { status: string };
    expect(stillRunning.status).toBe("running");

    const stats = svc.queryHotUpdateStats({ taskId: "t-e2e-3" });
    expect(stats.totalMigrations).toBe(1);
    expect(stats.failedCount).toBe(1);
    expect(stats.successCount).toBe(0);

    taskRegistry.__clearForTest();
    db.close();
  });
});
```

- [ ] **Step 5.2 — 跑**

```
cd apps/server && npx vitest run src/kernel-next/hot-update/end-to-end.test.ts 2>&1 | tail -10
```
期望：3 tests passed.

- [ ] **Step 5.3 — commit**

```bash
cd /Users/minghao/workflow-control
git add apps/server/src/kernel-next/hot-update/end-to-end.test.ts
git commit -m "test(hot-update-5e): end-to-end integration — autoApprove + migrate + rollback + stats"
```

---

## Task 6: Roadmap + handoff

- [ ] **Step 6.1 — roadmap 更新**

在 `docs/product-roadmap.md`：

§7.6 B22 行改为：
```
| B22 | **聚合指标**：... ✅ 5E（`query_hot_update_stats` MCP 返回 total / success / failed / rolled_back / byPipelineName / byActor / topChurn） |
```

§10 的 Stage 5E 5.17-5.20 全部前缀 `✅`（在 markdown 表格那一节）。

修订历史追加 v1.7：
```
| 2026-04-24 | 1.7 | Stage 5E 完成：B22 聚合查询（`query_hot_update_stats` MCP + `computeHotUpdateStats` 纯函数）；清理 11 个 A8 时代 skipped tests（9 migrate-task + 2 a2-3-5 live-migration 整文件删除）；3 个端到端集成测试覆盖 autoApprove→migrate / forward→rollback / INTERRUPT timeout。B 系列 22 项除 5C 推迟的 B9/B10/B12 外全部落地。|
```

- [ ] **Step 6.2 — handoff**

创建 `docs/superpowers/plans/2026-04-24-hot-update-5e-done-handoff.md`:

```markdown
# Stage 5E — Hot Update Finalization — Handoff

**Status:** Complete 2026-04-24.

**Roadmap:** B 系列 22 项中，除 5C 推迟的 B9/B10/B12 外**全部落地**。

## Delivered

- `hot-update/stats.ts` + tests (9) — `computeHotUpdateStats` B22 聚合查询
- `KernelService.queryHotUpdateStats` 方法
- MCP tool `query_hot_update_stats`（external surface；tool 总数 external 20, combined 21）
- `hot-update/end-to-end.test.ts` — 3 个集成场景：
  - autoApprove → migrate idle → stats 1 success
  - forward → rollback → stats 2 success + 1 rolled_back
  - INTERRUPT timeout → state preserved + stats 1 failed
- 清理 11 个 A8 skipped tests（9 migrate-task + 2 a2-3-5，整文件删除）

## B 系列完成度（5 stages 合计）

| 项 | 状态 | milestone |
|---|---|---|
| B1 propose_pipeline_change | ✅ | 5A |
| B2 update_registry_pipeline | ✅ | 5A |
| B3 dry-run + autoApprove | ✅ | 5A |
| B4 safe 范围 (prompt/reads/writes/budget) | ✅ | 5A |
| B5 SSE wf.hotUpdatePending | 延期 Phase 6 | — |
| B6 migrateRunningTasks 参数 | ✅ | pre-5 |
| B7 impact 分析 | ✅（结构性；cost/latency 延期） | 5A |
| B8 同步触发 | ✅ | 5B |
| B9 worktree 切换 | 推迟 5C | — |
| B10 graceful summary | 推迟 5C | — |
| B11 sibling stage 跑完 | ✅ | 5B |
| B12 single-session 摘要注入 | 推迟 5C | — |
| B13 parallel fine-grained | ✅ | 5B |
| B14 乐观锁 | ✅ | 5A |
| B15 删 stage 校验 | ✅ | 5A |
| B16 schema drift | ✅ | 5A |
| B17 foreach schema-compat | N/A (no foreach) | — |
| B18 AI 决定 retry_from | ✅ | 5A |
| B19 migration 失败兜底 | ✅ | 5B |
| B20 rollback_hot_update 真实执行 | ✅ | 5B |
| B21 audit trail | ✅ | pre-5 + 5A 扩展 diagnostic_json |
| B22 聚合指标 | ✅ | 5E |

已落地 17/22；推迟 3 项（B9/B10/B12 绑定 5C 依赖 checkpoint infra）；N/A 1 项
（B17 需 foreach）；Phase 6 项 1（B5 UI）。

## 下一步

- **5C 独立 brainstorm**：需要先做 checkpoint infra，再加 AgentMachine summary
  turn 状态，再加 tier1 摘要注入 API
- **Phase 6 打磨**：每天使用 workflow-control，朋友试用，白皮书重写
```

- [ ] **Step 6.3 — commit**

```bash
git add docs/product-roadmap.md docs/superpowers/plans/2026-04-24-hot-update-5e-done-handoff.md
git commit -m "docs(hot-update-5e): roadmap B22 + 5.17-5.20 done, v1.7 history, handoff"
```

---

## Task 7: Full verification

- [ ] **Step 7.1 — tsc**

```
cd apps/server && npx tsc --noEmit
```

- [ ] **Step 7.2 — 全量测试**

```
cd apps/server && npx vitest run 2>&1 | tail -5
```
期望：1484+ passed（之前 1485，减 9 migrate-task deleted + 2 a2-3-5 deleted + 13 new tests = 1487 左右）。0 failed。

---

## Self-Review

**Spec coverage**:
- §1 B22 query_hot_update_stats → Task 1 (stats.ts) + Task 2 (MCP)
- §2.1 migrate-task.test.ts cleanup → Task 3
- §2.2 a2-3-5 deletion → Task 4
- §3 end-to-end integration → Task 5
- §4 roadmap → Task 6
- §6 success criteria → Task 7

**Placeholder scan**: 无 TBD / "similar to" / 空占位。所有 code block 完整。

**Type consistency**: `StatsInput` / `StatsOutput` / `computeHotUpdateStats` /
`queryHotUpdateStats` 在 Task 1 / 2 / 5 一致。`query_hot_update_stats` tool
名在 Task 2 / 6 一致。
