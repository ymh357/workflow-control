import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { handleStartPipelineGenerator } from "./pg-entry.js";
import { LegacyPipelineLoadError, loadLegacyPipelineIR } from "../runtime/load-legacy-pipeline.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageExecutor } from "../runtime/executor.js";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

function realIR(): PipelineIR {
  return loadLegacyPipelineIR("pipeline-generator").ir;
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

  it("rejects description over 8000 chars", async () => {
    const db = freshDb();
    const res = await handleStartPipelineGenerator(
      { description: "x".repeat(8001) },
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
    const loader = vi.fn(() => ({ ir, promptRoot: "/tmp/prompts", yamlFilePath: "/tmp/pipeline.yaml", warnings: [] }));
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

  it("uses provided taskId when passed", async () => {
    const ir = realIR();
    const res = await handleStartPipelineGenerator(
      { description: "x", taskId: "my-task-1" },
      {
        db: freshDb(),
        broadcaster: new KernelNextBroadcaster(),
        loader: vi.fn(() => ({ ir, promptRoot: "/p", yamlFilePath: "/y", warnings: [] })),
        runner: vi.fn(async () => undefined),
        executorFactory: vi.fn(() => ({ executeStage: vi.fn() }) as any),
        model: "m",
      },
    );
    expect(res.ok && res.taskId).toBe("my-task-1");
  });
});

describe("handleStartPipelineGenerator — bootstrap errors", () => {
  it("returns CONVERT_FAILED when loader throws LegacyPipelineLoadError", async () => {
    const loader = vi.fn(() => {
      throw new LegacyPipelineLoadError("boom", [{ code: "YAML_READ_FAILED" }]);
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
        loader: vi.fn(() => ({ ir, promptRoot: "/p", yamlFilePath: "/y", warnings: [] })),
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
        loader: vi.fn(() => ({ ir, promptRoot: "/p", yamlFilePath: "/y", warnings: [] })),
        runner: vi.fn(async () => undefined),
        model: "m",
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("RUN_BOOTSTRAP_FAILED");
  });
});
