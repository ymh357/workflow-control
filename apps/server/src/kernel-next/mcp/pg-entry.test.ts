import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import * as sqlMod from "../ir/sql.js";
import { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { handleStartPipelineGenerator, handleWaitPipelineResult } from "./pg-entry.js";
import { BuiltinPipelineLoadError, loadBuiltinPipelineIR } from "../runtime/load-builtin-pipeline.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageExecutor } from "../runtime/executor.js";
import { randomUUID } from "node:crypto";

// Load real pipeline-generator prompts once for reuse across loader mocks.
// Using the real prompts map avoids PROMPT_REF_MISSING diagnostics from
// KernelService.submit (invoked inside handleStartPipelineGenerator).
const realPrompts = loadBuiltinPipelineIR("pipeline-generator").prompts;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

// realIR loads the actual pipeline-generator YAML via the loader.
// Used in tests that need a schema-valid IR for versionHash computation
// and insertPipelineVersion; a minimal cast stub would fail the strict
// schema checks in those paths.
function realIR(): PipelineIR {
  return loadBuiltinPipelineIR("pipeline-generator").ir;
}

describe("handleStartPipelineGenerator — input validation", () => {
  it("rejects empty description", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const res = await handleStartPipelineGenerator(
      { description: "" },
      { db, broadcaster, runner: vi.fn() as any, loader: vi.fn() as any, model: "claude-haiku-4-5" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("INVALID_DESCRIPTION");
    if (res.error === "INVALID_DESCRIPTION") {
      expect(res.reason).toBe("empty");
    }
  });

  it("rejects whitespace-only description", async () => {
    const db = freshDb();
    const res = await handleStartPipelineGenerator(
      { description: "   \n\t  " },
      { db, broadcaster: new KernelNextBroadcaster(), runner: vi.fn() as any, loader: vi.fn() as any, model: "m" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("INVALID_DESCRIPTION");
  });

  it("rejects description over 64000 chars", async () => {
    const db = freshDb();
    const res = await handleStartPipelineGenerator(
      { description: "x".repeat(64001) },
      { db, broadcaster: new KernelNextBroadcaster(), runner: vi.fn() as any, loader: vi.fn() as any, model: "m" },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("INVALID_DESCRIPTION");
    if (res.error === "INVALID_DESCRIPTION") {
      expect(res.reason).toBe("too_long");
    }
  });
});

describe("handleStartPipelineGenerator — happy path", () => {
  it("returns taskId + versionHash and kicks runner with seedValues", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const ir = realIR();
    const loader = vi.fn(() => ({ ir, promptRoot: "/tmp/prompts", pipelineDir: "/tmp/pipeline-generator", warnings: [], prompts: realPrompts }));
    const runner = vi.fn(async () => undefined);
    const executorFactory = vi.fn(() => ({ executeStage: vi.fn() }) as unknown as StageExecutor);

    const res = await handleStartPipelineGenerator(
      { description: "make a pipeline for X" },
      { db, broadcaster, loader, runner, executorFactory, model: "claude-haiku-4-5" },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pipelineDir).toBe("pipeline-generator");
    expect(res.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.versionHash).toMatch(/^[0-9a-f]+$/);
    expect(loader).toHaveBeenCalledWith("pipeline-generator");
    expect(runner).toHaveBeenCalledOnce();
    const runnerArgs = (runner.mock.calls as unknown as [unknown, unknown[]][])[0][0] as {
      seedValues: Record<string, unknown>;
      taskId: string;
      broadcaster: KernelNextBroadcaster;
    };
    expect(runnerArgs.seedValues).toEqual({ taskDescription: "make a pipeline for X" });
    expect(runnerArgs.taskId).toBe(res.taskId);
    expect(runnerArgs.broadcaster).toBe(broadcaster);
  });

  it("forwards deps.tscPath to executorFactory so the per-stage MCP can run validateTypes", async () => {
    const ir = realIR();
    const executorFactory = vi.fn(() => ({ executeStage: vi.fn() }) as unknown as StageExecutor);
    await handleStartPipelineGenerator(
      { description: "x" },
      {
        db: freshDb(),
        broadcaster: new KernelNextBroadcaster(),
        loader: vi.fn(() => ({ ir, promptRoot: "/p", pipelineDir: "/p", warnings: [], prompts: realPrompts })),
        runner: vi.fn(async () => undefined),
        executorFactory,
        model: "m",
        tscPath: "/path/to/monorepo/tsc",
      },
    );
    expect(executorFactory).toHaveBeenCalledOnce();
    const args = (executorFactory.mock.calls as unknown as [Record<string, unknown>][])[0]![0];
    expect(args.tscPath).toBe("/path/to/monorepo/tsc");
  });

  it("uses provided taskId when passed", async () => {
    const ir = realIR();
    const res = await handleStartPipelineGenerator(
      { description: "x", taskId: "my-task-1" },
      {
        db: freshDb(),
        broadcaster: new KernelNextBroadcaster(),
        loader: vi.fn(() => ({ ir, promptRoot: "/p", pipelineDir: "/p", warnings: [], prompts: realPrompts })),
        runner: vi.fn(async () => undefined),
        executorFactory: vi.fn(() => ({ executeStage: vi.fn() }) as any),
        model: "m",
      },
    );
    expect(res.ok && res.taskId).toBe("my-task-1");
  });
});

describe("handleStartPipelineGenerator — bootstrap errors", () => {
  it("returns CONVERT_FAILED when loader throws BuiltinPipelineLoadError", async () => {
    const loader = vi.fn(() => {
      throw new BuiltinPipelineLoadError("boom", [{ code: "YAML_READ_FAILED" }]);
    });
    const res = await handleStartPipelineGenerator(
      { description: "x" },
      {
        db: freshDb(),
        broadcaster: new KernelNextBroadcaster(),
        loader,
        runner: vi.fn() as any,
        executorFactory: vi.fn() as any,
        model: "m",
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("CONVERT_FAILED");
    if (res.error === "CONVERT_FAILED") {
      expect(res.diagnostics[0].code).toBe("YAML_READ_FAILED");
    }
  });

  it("returns RUN_BOOTSTRAP_FAILED when runner sync-throws", async () => {
    const ir = realIR();
    const runner = vi.fn(() => {
      throw new Error("runner init blew up");
    });
    const res = await handleStartPipelineGenerator(
      { description: "x" },
      {
        db: freshDb(),
        broadcaster: new KernelNextBroadcaster(),
        loader: vi.fn(() => ({ ir, promptRoot: "/p", pipelineDir: "/p", warnings: [], prompts: realPrompts })),
        runner,
        executorFactory: vi.fn(() => ({ executeStage: vi.fn() }) as any),
        model: "m",
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("RUN_BOOTSTRAP_FAILED");
  });

  it("returns RUN_BOOTSTRAP_FAILED when executorFactory missing", async () => {
    const ir = realIR();
    const res = await handleStartPipelineGenerator(
      { description: "x" },
      {
        db: freshDb(),
        broadcaster: new KernelNextBroadcaster(),
        loader: vi.fn(() => ({ ir, promptRoot: "/p", pipelineDir: "/p", warnings: [], prompts: realPrompts })),
        runner: vi.fn(async () => undefined),
        model: "m",
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("RUN_BOOTSTRAP_FAILED");
  });

  it("returns RUN_BOOTSTRAP_FAILED when submit throws (insertPipelineVersion db failure)", async () => {
    // handleStartPipelineGenerator now routes through KernelService.submit,
    // which calls insertPipelineVersion internally. A DB-layer throw from
    // insertPipelineVersion surfaces as a RUN_BOOTSTRAP_FAILED with the
    // underlying error message prefixed by 'submit: '.
    const spy = vi.spyOn(sqlMod, "insertPipelineVersion").mockImplementation(() => {
      throw new Error("db blew up");
    });
    const ir = realIR();
    try {
      const res = await handleStartPipelineGenerator(
        { description: "x" },
        {
          db: freshDb(),
          broadcaster: new KernelNextBroadcaster(),
          loader: vi.fn(() => ({ ir, promptRoot: "/p", pipelineDir: "/p", warnings: [], prompts: realPrompts })),
          runner: vi.fn(async () => undefined),
          executorFactory: vi.fn(() => ({ executeStage: vi.fn() }) as any),
          model: "m",
        },
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toBe("RUN_BOOTSTRAP_FAILED");
      if (res.error === "RUN_BOOTSTRAP_FAILED") {
        expect(res.reason).toMatch(/submit.*db blew up/);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("returns CONVERT_FAILED with LOADER_ERROR code when loader throws unexpected error", async () => {
    const loader = vi.fn(() => {
      throw new Error("filesystem permission denied");
    });
    const res = await handleStartPipelineGenerator(
      { description: "x" },
      {
        db: freshDb(),
        broadcaster: new KernelNextBroadcaster(),
        loader,
        runner: vi.fn() as any,
        executorFactory: vi.fn() as any,
        model: "m",
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("CONVERT_FAILED");
    if (res.error === "CONVERT_FAILED") {
      expect(res.diagnostics[0].code).toBe("LOADER_ERROR");
      expect(res.diagnostics[0].message).toMatch(/permission denied/);
    }
  });
});

// Helper: insert a stage_attempt row (required by port_values FK).
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

// Helper: insert a port_values row for a given attempt.
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

describe("handleWaitPipelineResult — error paths", () => {
  it("returns error when run_final finalState=failed", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-fail-1";
    broadcaster.publish({
      taskId,
      timestamp: new Date().toISOString(),
      type: "run_final",
      data: { finalState: "failed", stageErrors: [{ stage: "analyzing", message: "boom" }] },
    });
    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir: realIR() });
    expect(res.ok).toBe(false);
    if (res.ok || res.status !== "error") throw new Error("expected error");
    expect(res.error).toBe("boom");
    expect(res.failedStage).toBe("analyzing");
  });

  it("returns error on stage_error (stage_error always means final failure — no more retries)", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-fail-2";
    broadcaster.publish({
      taskId,
      timestamp: new Date().toISOString(),
      type: "stage_error",
      data: { stage: "genSkeleton", message: "sdk timeout" },
    });
    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir: realIR() });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.status).toBe("error");
    expect(res.failedStage).toBe("genSkeleton");
    expect(res.error).toBe("sdk timeout");
  });

  it("ignores stage_retry (retry in flight) and falls through to running on timeout", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-retry-1";
    broadcaster.publish({
      taskId,
      timestamp: new Date().toISOString(),
      type: "stage_retry",
      data: { stage: "analyzing", backToStage: "analyzing", retryIdx: 0, maxRetries: 2, errorMessage: "transient" },
    });
    // stage_retry is not terminal — wait falls through to timeout → running
    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir: realIR() });
    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "running") throw new Error("expected running");
  });

  it("returns generic error message when run_final failed but stageErrors is empty", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-fail-empty";
    broadcaster.publish({
      taskId,
      timestamp: new Date().toISOString(),
      type: "run_final",
      data: { finalState: "failed", stageErrors: [] },
    });
    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir: realIR() });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.status).toBe("error");
    expect(res.error).toBeTruthy(); // any non-empty string
    expect(res.failedStage).toBeUndefined();
  });
});

describe("handleWaitPipelineResult — gate_pending", () => {
  it("returns gate_pending when stage_executing fires for a gate-type stage", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-gate-1";
    const ir = realIR();

    // Seed a pipeline_versions row so stage_attempts FK succeeds.
    const versionHash = "test-vh-gate-1";
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES (?, 'test', ?, NULL, '{}', '')`,
    ).run(versionHash, Date.now());

    // Seed pipelineDesign port values so gateContext snapshot has something.
    const aD = seedAttempt(db, taskId, versionHash, "pipelineDesign");
    seedPortValue(db, aD, "pipelineDesign", "pipelineName", "My Gate Pipeline");
    seedPortValue(db, aD, "pipelineDesign", "description", "A design description");

    // Seed an unanswered gate_queue row — required for the wait to settle
    // as gate_pending after Finding 2 fix (history-replay guard).
    const gateAttempt = seedAttempt(db, taskId, versionHash, "awaitingConfirm");
    db.prepare(
      `INSERT INTO gate_queue (gate_id, task_id, stage_name, attempt_id, question_json, created_at)
       VALUES ('g1', ?, 'awaitingConfirm', ?, '{"text":"approve?"}', ?)`,
    ).run(taskId, gateAttempt, Date.now());

    broadcaster.publish({
      taskId,
      timestamp: new Date().toISOString(),
      type: "stage_executing",
      data: { stage: "awaitingConfirm" } as any,
    });

    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir });
    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "gate_pending") throw new Error(`expected gate_pending, got: ${JSON.stringify(res)}`);
    expect(res.gateName).toBe("awaitingConfirm");
    expect(res.gateContext).toBeDefined();
    // pipelineDesign snapshot should contain the seeded ports
    expect(typeof res.gateContext.pipelineDesign).toBe("object");
    expect((res.gateContext.pipelineDesign as any).pipelineName).toBe("My Gate Pipeline");
  });

  it("ignores history-replayed stage_executing for an already-answered gate (Finding 2 regression)", async () => {
    // Dogfood Finding 2 (2026-04-25): broadcaster.subscribe replays event
    // history. After answer_gate fires, the historical stage_executing for
    // that gate is still in the broadcaster's buffer. Pre-fix wait would
    // re-settle on the replayed event, returning gate_pending for a gate
    // the user already approved/rejected. Post-fix: the wait queries
    // gate_queue for an unanswered row before settling; an answered gate
    // gets ignored and wait keeps blocking for the next terminal event
    // (or running on timeout).
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-gate-answered";
    const ir = realIR();

    const versionHash = "test-vh-gate-answered";
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES (?, 'test', ?, NULL, '{}', '')`,
    ).run(versionHash, Date.now());

    // Seed an ANSWERED gate_queue row — represents a gate that user has
    // already approved.
    const gateAttempt = seedAttempt(db, taskId, versionHash, "awaitingConfirm");
    db.prepare(
      `INSERT INTO gate_queue (gate_id, task_id, stage_name, attempt_id, question_json, answer, answered_at, created_at)
       VALUES ('g1', ?, 'awaitingConfirm', ?, '{"text":"approve?"}', 'approve', ?, ?)`,
    ).run(taskId, gateAttempt, Date.now(), Date.now() - 1000);

    // Replay the historical stage_executing for the gate — pre-fix this
    // would settle wait as gate_pending.
    broadcaster.publish({
      taskId,
      timestamp: new Date().toISOString(),
      type: "stage_executing",
      data: { stage: "awaitingConfirm" } as any,
    });

    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    // Should fall through to timeout → status: "running" (or "done" if
    // a terminal event arrives), NOT gate_pending.
    expect(res.status).not.toBe("gate_pending");
    expect(res.status).toBe("running");
  });

  it("ignores stage_executing for non-gate stage (falls through to timeout)", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-nongate-1";
    const ir = realIR();
    broadcaster.publish({
      taskId,
      timestamp: new Date().toISOString(),
      type: "stage_executing",
      data: { stage: "analyzing" } as any,
    });
    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    expect(res.status).toBe("running");
  });
});

describe("handleWaitPipelineResult — running", () => {
  it("returns running with currentStage from stage_attempts on timeout", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-run-1";

    // Need a pipeline_versions row to satisfy stage_attempts FK.
    const versionHash = "test-vh-run-1";
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES (?, 'test', ?, NULL, '{}', '')`,
    ).run(versionHash, Date.now());

    // Insert two attempts for the same task; second has higher started_at — latest wins.
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
       VALUES (?, ?, ?, ?, 0, ?, 'running', 'regular')`,
    ).run(randomUUID(), taskId, versionHash, "analyzing", Date.now() - 1000);
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
       VALUES (?, ?, ?, ?, 1, ?, 'running', 'regular')`,
    ).run(randomUUID(), taskId, versionHash, "analyzing", Date.now());

    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir: realIR() });
    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "running") throw new Error("expected running");
    expect(res.currentStage).toBe("analyzing");
    expect(res.elapsedMs).toBeGreaterThanOrEqual(1000);
  });

  it("returns currentStage=null when no stage_attempts row exists for the task", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const res = await handleWaitPipelineResult({ taskId: "task-empty-1", timeoutMs: 1000 }, { db, broadcaster, ir: realIR() });
    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "running") throw new Error("expected running");
    expect(res.currentStage).toBeNull();
  });

  it("clamps timeoutMs below minimum to 1000", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const start = Date.now();
    const res = await handleWaitPipelineResult(
      { taskId: "task-clamp-low", timeoutMs: 10 },
      { db, broadcaster, ir: realIR() },
    );
    const dur = Date.now() - start;
    expect(res.ok && res.status).toBe("running");
    expect(dur).toBeGreaterThanOrEqual(1000);
  });

  // Upper-clamp test (timeoutMs > 300000 clamped to 300000) is symmetric to the
  // lower-clamp test — both use the same clampTimeout helper. Verifying it would
  // require actually waiting 5 minutes, so it is intentionally skipped here.
});

describe("handleStartPipelineGenerator — version idempotency", () => {
  it("two starts with identical inputs both succeed (insertPipelineVersion is idempotent)", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const ir = realIR();
    const loader = vi.fn(() => ({ ir, promptRoot: "/p", pipelineDir: "/p", warnings: [], prompts: realPrompts }));
    const runner = vi.fn(async () => undefined);
    const executorFactory = vi.fn(() => ({ executeStage: vi.fn() }) as any);

    const deps = { db, broadcaster, loader, runner, executorFactory, model: "m" };

    const r1 = await handleStartPipelineGenerator({ description: "same" }, deps);
    const r2 = await handleStartPipelineGenerator({ description: "same" }, deps);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.versionHash).toBe(r2.versionHash);
      expect(r1.taskId).not.toBe(r2.taskId);
    }
  });
});

describe("handleWaitPipelineResult — rollback transparency", () => {
  it("ignores stage_rolled_back and keeps waiting for terminal event", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-rb-wait";
    const ir = realIR();

    // Seed pipeline_versions row for FK constraint.
    const versionHash = "test-vh-rb-wait";
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES (?, 'test', ?, NULL, '{}', '')`,
    ).run(versionHash, Date.now());

    // Seed port values required by assembleDone.
    const aP = seedAttempt(db, taskId, versionHash, "persistResult");
    seedPortValue(db, aP, "persistResult", "pipelineId", "rb-pid");
    seedPortValue(db, aP, "persistResult", "yamlPath", "/tmp/rb/pipeline.yaml");

    const aD = seedAttempt(db, taskId, versionHash, "pipelineDesign");
    seedPortValue(db, aD, "pipelineDesign", "pipelineName", "Rollback Pipeline");
    seedPortValue(db, aD, "pipelineDesign", "description", "desc after rollback");

    // Sequence: publish stage_rolled_back FIRST, then run_final completed.
    // The wait must not settle on the transient rollback event.
    broadcaster.publish({
      taskId,
      timestamp: new Date().toISOString(),
      type: "stage_rolled_back",
      data: { fromGate: "G", toStage: "A", affectedStages: ["A", "G"] },
    });
    broadcaster.publish({
      taskId,
      timestamp: new Date().toISOString(),
      type: "run_final",
      data: { finalState: "completed", stageErrors: [] } as any,
    });

    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 2000 }, { db, broadcaster, ir });
    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "done") throw new Error(`expected done, got: ${JSON.stringify(res)}`);
    expect(res.result.pipelineId).toBe("rb-pid");
  });
});

describe("handleWaitPipelineResult — secret_pending", () => {
  it("returns secret_pending verdict with hint when secret_gate_queue has an unresolved row", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-secret-1";
    const ir = realIR();

    const versionHash = "test-vh-secret-1";
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES (?, 'test', ?, NULL, '{}', '')`,
    ).run(versionHash, Date.now());

    // Seed a stage_attempt in secret_pending status.
    const attemptId = randomUUID();
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
       VALUES (?, ?, ?, 'fetchData', 0, ?, 'secret_pending', 'regular')`,
    ).run(attemptId, taskId, versionHash, Date.now());

    // Seed an unresolved secret_gate_queue row.
    db.prepare(
      `INSERT INTO secret_gate_queue (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
       VALUES ('sg-test-1', ?, 'fetchData', ?, '["GITHUB_TOKEN","NPM_TOKEN"]', ?)`,
    ).run(taskId, attemptId, Date.now());

    // No SSE events published — wait will time out and detect secret_pending via DB query.
    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir });

    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "secret_pending") {
      throw new Error(`expected secret_pending, got: ${JSON.stringify(res)}`);
    }
    expect(res.pending).toHaveLength(1);
    expect(res.pending[0].stageName).toBe("fetchData");
    expect(res.pending[0].requiredKeys).toEqual(["GITHUB_TOKEN", "NPM_TOKEN"]);
    // Both keys are missing (no task_env_values rows seeded).
    expect(res.pending[0].stillMissing).toEqual(["GITHUB_TOKEN", "NPM_TOKEN"]);
    expect(res.hint).toContain("provide_task_secrets");
    expect(res.hint).toContain("GITHUB_TOKEN");
    expect(res.hint).toContain("NPM_TOKEN");
  });

  it("returns running (not secret_pending) when secret_gate_queue row is resolved", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-secret-resolved";
    const ir = realIR();

    const versionHash = "test-vh-secret-resolved";
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES (?, 'test', ?, NULL, '{}', '')`,
    ).run(versionHash, Date.now());

    const attemptId = randomUUID();
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
       VALUES (?, ?, ?, 'fetchData', 0, ?, 'secret_pending', 'regular')`,
    ).run(attemptId, taskId, versionHash, Date.now());

    // Resolved secret_gate_queue row (resolved_at IS NOT NULL) — should not trigger secret_pending.
    db.prepare(
      `INSERT INTO secret_gate_queue (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at, resolved_at)
       VALUES ('sg-resolved', ?, 'fetchData', ?, '["GITHUB_TOKEN"]', ?, ?)`,
    ).run(taskId, attemptId, Date.now() - 2000, Date.now() - 1000);

    const res = await handleWaitPipelineResult({ taskId, timeoutMs: 1000 }, { db, broadcaster, ir });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error();
    // Should fall through to running since the secret gate is resolved.
    expect(res.status).toBe("running");
  });
});

describe("handleWaitPipelineResult — done", () => {
  it("returns done with result fields when run_final completed event arrives", async () => {
    const db = freshDb();
    const broadcaster = new KernelNextBroadcaster();
    const taskId = "task-done-1";
    const ir = realIR();

    // To satisfy port_values FK, we need a pipeline_versions row first.
    // Use a simple stub version_hash for the seed data.
    const versionHash = "test-vh-done-1";
    db.prepare(
      `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
       VALUES (?, 'test', ?, NULL, '{}', '')`,
    ).run(versionHash, Date.now());

    // Seed port values via stage_attempts + port_values.
    const aP = seedAttempt(db, taskId, versionHash, "persistResult");
    seedPortValue(db, aP, "persistResult", "pipelineId", "my-pid");
    seedPortValue(db, aP, "persistResult", "yamlPath", "/tmp/out/pipeline.yaml");

    const aD = seedAttempt(db, taskId, versionHash, "pipelineDesign");
    seedPortValue(db, aD, "pipelineDesign", "pipelineName", "My Pipeline");
    seedPortValue(db, aD, "pipelineDesign", "description", "Short descr");

    const aPF = seedAttempt(db, taskId, versionHash, "promptFiles");
    seedPortValue(db, aPF, "promptFiles", "outputDir", "/tmp/out/prompts");

    // Fire the terminal event BEFORE wait subscribes — broadcaster replays history.
    broadcaster.publish({
      type: "run_final",
      taskId,
      timestamp: new Date().toISOString(),
      data: { finalState: "completed", stageErrors: [] },
    });

    const res = await handleWaitPipelineResult(
      { taskId, timeoutMs: 1000 },
      { db, broadcaster, ir },
    );

    expect(res.ok).toBe(true);
    if (!res.ok || res.status !== "done") throw new Error("expected done");
    expect(res.result.pipelineId).toBe("my-pid");
    expect(res.result.pipelineName).toBe("My Pipeline");
    expect(res.result.yamlPath).toBe("/tmp/out/pipeline.yaml");
    expect(res.result.promptDir).toBe("/tmp/out/prompts");
    expect(res.result.pipelineDesignSummary).toBe("Short descr");
  });
});
