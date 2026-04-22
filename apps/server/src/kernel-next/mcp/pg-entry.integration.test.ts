import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { handleStartPipelineGenerator, handleWaitPipelineResult } from "./pg-entry.js";
import { loadBuiltinPipelineIR } from "../runtime/load-builtin-pipeline.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageExecutor } from "../runtime/executor.js";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function realIR(): PipelineIR {
  return loadBuiltinPipelineIR("pipeline-generator").ir;
}

// Load real prompts once so loader mocks can supply a valid prompts map
// to KernelService.submit (invoked inside handleStartPipelineGenerator).
const realPrompts = loadBuiltinPipelineIR("pipeline-generator").prompts;

// seedAttempt inserts a stage_attempts row (required by port_values FK).
function seedAttempt(
  db: DatabaseSync,
  taskId: string,
  versionHash: string,
  stageName: string,
): string {
  const attemptId = randomUUID();
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
     VALUES (?, ?, ?, ?, 1, ?, 'success', 'regular')`,
  ).run(attemptId, taskId, versionHash, stageName, Date.now());
  return attemptId;
}

// seedPortValue inserts a port_values row for a given attempt.
function seedPortValue(
  db: DatabaseSync,
  attemptId: string,
  stageName: string,
  portName: string,
  value: unknown,
): void {
  db.prepare(
    `INSERT INTO port_values
     (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
     VALUES (?, ?, ?, ?, 'out', ?, ?)`,
  ).run(randomUUID(), attemptId, stageName, portName, JSON.stringify(value), Date.now());
}

// seedDone writes the minimum port_values rows required for assembleDone to
// return a well-formed DoneResult. pipelineId is derived from the first 6
// chars of taskId so concurrent tasks produce distinct values.
function seedDone(db: DatabaseSync, taskId: string, versionHash: string): void {
  const pipelineId = `pid-${taskId.slice(0, 6)}`;

  const aP = seedAttempt(db, taskId, versionHash, "persistResult");
  seedPortValue(db, aP, "persistResult", "pipelineId", pipelineId);
  seedPortValue(db, aP, "persistResult", "yamlPath", `/tmp/${pipelineId}/pipeline.yaml`);

  const aD = seedAttempt(db, taskId, versionHash, "pipelineDesign");
  seedPortValue(db, aD, "pipelineDesign", "pipelineName", `Pipeline ${pipelineId}`);
  seedPortValue(db, aD, "pipelineDesign", "description", `Description for ${pipelineId}`);

  const aPF = seedAttempt(db, taskId, versionHash, "promptFiles");
  seedPortValue(db, aPF, "promptFiles", "outputDir", `/tmp/${pipelineId}/prompts`);
}

describe("pg-entry integration — concurrent start + wait", () => {
  it("two concurrent starts produce independent taskIds and independent wait resolution", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const ir = realIR();

    // Both calls share the same loader (same IR → same versionHash).
    // insertPipelineVersion is now idempotent so the second insert is a no-op.
    const loader = () => ({
      ir,
      promptRoot: "/tmp/prompts",
      pipelineDir: "/tmp/pipeline-generator",
      warnings: [] as Array<{ code: string; message?: string }>,
      prompts: realPrompts,
    });

    // Mock executorFactory: returns a stub StageExecutor.
    const executorFactory = () =>
      ({ executeStage: async () => ({ ok: true, portValues: {} }) }) as unknown as StageExecutor;

    // Mock runner: seeds port values for assembleDone and defers a run_final
    // "completed" event so the subscriber is guaranteed to be registered first.
    const runner = async (args: {
      db: DatabaseSync;
      taskId: string;
      versionHash: string;
      seedValues: Record<string, unknown>;
      broadcaster: KernelNextBroadcaster;
      [key: string]: unknown;
    }) => {
      const { taskId, versionHash } = args;
      seedDone(db, taskId, versionHash);
      // Use setTimeout with 0ms so the event fires after Promise.all has
      // subscribed both waiters.
      setTimeout(() => {
        broadcaster.publish({
          taskId,
          timestamp: new Date().toISOString(),
          type: "run_final",
          data: { finalState: "completed", stageErrors: [] } as any,
        });
      }, 0);
    };

    const depsBase = {
      db,
      broadcaster,
      loader,
      runner,
      executorFactory,
      model: "claude-haiku-4-5",
    } as const;

    // Start two pipeline generator tasks concurrently.
    const [r1, r2] = await Promise.all([
      handleStartPipelineGenerator({ description: "pipeline A task" }, depsBase),
      handleStartPipelineGenerator({ description: "pipeline B task" }, depsBase),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    // The two tasks must have distinct IDs.
    expect(r1.taskId).not.toBe(r2.taskId);

    // Both waiters resolve independently via the shared broadcaster.
    const [w1, w2] = await Promise.all([
      handleWaitPipelineResult({ taskId: r1.taskId, timeoutMs: 3000 }, { db, broadcaster, ir }),
      handleWaitPipelineResult({ taskId: r2.taskId, timeoutMs: 3000 }, { db, broadcaster, ir }),
    ]);

    expect(w1.ok).toBe(true);
    if (!w1.ok || w1.status !== "done") throw new Error(`expected w1 done, got: ${JSON.stringify(w1)}`);
    expect(w1.result.pipelineId).toMatch(/^pid-/);

    expect(w2.ok).toBe(true);
    if (!w2.ok || w2.status !== "done") throw new Error(`expected w2 done, got: ${JSON.stringify(w2)}`);
    expect(w2.result.pipelineId).toMatch(/^pid-/);

    // Results must not cross-contaminate.
    expect(w1.result.pipelineId).not.toBe(w2.result.pipelineId);
    expect(w1.taskId).toBe(r1.taskId);
    expect(w2.taskId).toBe(r2.taskId);
  });
});
