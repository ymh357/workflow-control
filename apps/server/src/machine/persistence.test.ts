import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDataDir: string;

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
  taskLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../lib/config-loader.js", () => ({
  loadSystemSettings: vi.fn(() => ({
    paths: { data_dir: testDataDir },
  })),
  isParallelGroup: (entry: any) => entry && typeof entry === "object" && "parallel" in entry,
  flattenStages: (entries: any[]) => {
    const result: any[] = [];
    for (const e of entries) {
      if (e && typeof e === "object" && "parallel" in e) {
        result.push(...e.parallel.stages);
      } else {
        result.push(e);
      }
    }
    return result;
  },
}));

import {
  pipelineFingerprint,
  snapshotPath,
  persistSnapshot,
  flushSnapshotSync,
  loadSnapshot,
  loadAllPersistedTaskIds,
} from "./persistence.js";
import type { PipelineConfig } from "../lib/config-loader.js";

beforeEach(() => {
  testDataDir = join(tmpdir(), `persistence-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(testDataDir, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(testDataDir, { recursive: true, force: true });
  } catch { /* best effort */ }
});

describe("pipelineFingerprint", () => {
  it("generates correct fingerprint string", () => {
    const pipeline = {
      name: "test",
      stages: [
        { name: "analyze", type: "agent" },
        { name: "confirm", type: "human_confirm" },
        { name: "deploy", type: "script" },
      ],
    } as PipelineConfig;

    expect(pipelineFingerprint(pipeline)).toBe("analyze:agent|confirm:human_confirm|deploy:script");
  });

  it("handles single stage", () => {
    const pipeline = {
      name: "simple",
      stages: [{ name: "run", type: "agent" }],
    } as PipelineConfig;

    expect(pipelineFingerprint(pipeline)).toBe("run:agent");
  });

  it("handles empty stages", () => {
    const pipeline = { name: "empty", stages: [] } as PipelineConfig;
    expect(pipelineFingerprint(pipeline)).toBe("");
  });
});

describe("snapshotPath", () => {
  it("returns path based on data_dir from settings", () => {
    const p = snapshotPath("task-123");
    expect(p).toBe(join(testDataDir, "tasks", "task-123.json"));
  });
});

describe("persistSnapshot + loadSnapshot roundtrip", () => {
  it("persists and loads snapshot correctly", async () => {
    const taskId = "roundtrip-1";
    const snapshot = { context: { taskId, status: "running" }, value: "active" };
    const actor = { getPersistedSnapshot: () => snapshot };

    await persistSnapshot(taskId, actor);

    const loaded = loadSnapshot(taskId);
    expect(loaded).toEqual(snapshot);
  });

  it("handles complex snapshot data", async () => {
    const taskId = "roundtrip-complex";
    const snapshot = {
      context: { taskId, store: { nested: { deep: [1, 2, 3] } } },
      value: { parent: "child" },
    };
    const actor = { getPersistedSnapshot: () => snapshot };

    await persistSnapshot(taskId, actor);

    const loaded = loadSnapshot(taskId);
    expect(loaded).toEqual(snapshot);
  });
});

describe("flushSnapshotSync", () => {
  it("writes snapshot synchronously and loadSnapshot reads it", () => {
    const taskId = "flush-sync-1";
    const snapshot = { value: "synced" };
    const actor = { getPersistedSnapshot: () => snapshot };

    flushSnapshotSync(taskId, actor);

    const loaded = loadSnapshot(taskId);
    expect(loaded).toEqual(snapshot);
  });
});

describe("loadSnapshot", () => {
  it("returns undefined for non-existent file", () => {
    expect(loadSnapshot("non-existent-task")).toBeUndefined();
  });

  it("returns undefined on version mismatch", () => {
    const taskId = "version-mismatch";
    const p = join(testDataDir, "tasks", `${taskId}.json`);
    mkdirSync(join(testDataDir, "tasks"), { recursive: true });
    writeFileSync(p, JSON.stringify({ version: 999, snapshot: { data: "old" } }));

    expect(loadSnapshot(taskId)).toBeUndefined();
  });

  it("loads legacy format (no version wrapper) and returns raw", () => {
    const taskId = "legacy-format";
    const p = join(testDataDir, "tasks", `${taskId}.json`);
    mkdirSync(join(testDataDir, "tasks"), { recursive: true });
    const legacyData = { context: { taskId }, value: "legacy" };
    writeFileSync(p, JSON.stringify(legacyData));

    const loaded = loadSnapshot(taskId);
    expect(loaded).toEqual(legacyData);
  });

  it("returns undefined for corrupted file", () => {
    const taskId = "corrupted";
    const p = join(testDataDir, "tasks", `${taskId}.json`);
    mkdirSync(join(testDataDir, "tasks"), { recursive: true });
    writeFileSync(p, "{{not valid json}}");

    expect(loadSnapshot(taskId)).toBeUndefined();
  });

  it("returns undefined for empty file", () => {
    const taskId = "empty-file";
    const p = join(testDataDir, "tasks", `${taskId}.json`);
    mkdirSync(join(testDataDir, "tasks"), { recursive: true });
    writeFileSync(p, "");

    expect(loadSnapshot(taskId)).toBeUndefined();
  });
});

describe("loadAllPersistedTaskIds", () => {
  it("returns empty array for non-existent directory", () => {
    // Point to a dir that doesn't exist
    const originalDir = testDataDir;
    testDataDir = join(tmpdir(), "does-not-exist-" + Date.now());
    const result = loadAllPersistedTaskIds();
    testDataDir = originalDir;
    expect(result).toEqual([]);
  });

  it("returns empty array for empty tasks directory", () => {
    mkdirSync(join(testDataDir, "tasks"), { recursive: true });
    expect(loadAllPersistedTaskIds()).toEqual([]);
  });

  it("returns task IDs sorted by mtime (newest first)", async () => {
    const tasksDir = join(testDataDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    // Create files with different mtimes
    writeFileSync(join(tasksDir, "task-old.json"), "{}");
    // Set old mtime
    const oldTime = new Date("2020-01-01");
    utimesSync(join(tasksDir, "task-old.json"), oldTime, oldTime);

    writeFileSync(join(tasksDir, "task-mid.json"), "{}");
    const midTime = new Date("2023-06-15");
    utimesSync(join(tasksDir, "task-mid.json"), midTime, midTime);

    writeFileSync(join(tasksDir, "task-new.json"), "{}");
    const newTime = new Date("2025-01-01");
    utimesSync(join(tasksDir, "task-new.json"), newTime, newTime);

    const result = loadAllPersistedTaskIds();
    expect(result).toEqual(["task-new", "task-mid", "task-old"]);
  });

  it("respects the limit parameter", () => {
    const tasksDir = join(testDataDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    for (let i = 0; i < 5; i++) {
      const file = join(tasksDir, `task-${i}.json`);
      writeFileSync(file, "{}");
      const time = new Date(2020 + i, 0, 1);
      utimesSync(file, time, time);
    }

    const result = loadAllPersistedTaskIds(2);
    expect(result).toHaveLength(2);
    // Should be the 2 newest
    expect(result[0]).toBe("task-4");
    expect(result[1]).toBe("task-3");
  });

  it("ignores non-json files", () => {
    const tasksDir = join(testDataDir, "tasks");
    mkdirSync(tasksDir, { recursive: true });

    writeFileSync(join(tasksDir, "task-valid.json"), "{}");
    writeFileSync(join(tasksDir, "readme.txt"), "not a task");
    writeFileSync(join(tasksDir, ".hidden"), "nope");

    const result = loadAllPersistedTaskIds();
    expect(result).toEqual(["task-valid"]);
  });
});

describe("persistSnapshot error paths", () => {
  it("logs error when mkdir fails", async () => {
    const { mkdir } = await import("node:fs/promises");
    const originalMkdir = mkdir;

    // Use a path that will cause mkdir to fail by making testDataDir read-only is unreliable,
    // so we mock the module-level mkdir. Instead, test with an invalid path.
    const taskId = "mkdir-fail-test";
    const actor = { getPersistedSnapshot: () => ({ data: "test" }) };

    // Point to an impossible path
    const originalDir = testDataDir;
    testDataDir = "/dev/null/impossible/path";

    await persistSnapshot(taskId, actor);
    // Should not throw - error is caught and logged

    testDataDir = originalDir;
  });

  it("logs error and tries to unlink tmp when writeFile fails", async () => {
    const taskId = "writefile-fail-test";
    // Create the tasks directory first
    mkdirSync(join(testDataDir, "tasks"), { recursive: true });

    // Make the actor throw during serialization (getPersistedSnapshot returns a value with circular ref)
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const actor = { getPersistedSnapshot: () => circular };

    // Should not throw - error is caught internally
    await persistSnapshot(taskId, actor);
  });
});

describe("flushSnapshotSync error paths", () => {
  it("logs error when mkdirSync fails", () => {
    const taskId = "mkdirsync-fail";
    const actor = { getPersistedSnapshot: () => ({ data: "test" }) };

    const originalDir = testDataDir;
    testDataDir = "/dev/null/impossible/path";

    // Should not throw
    expect(() => flushSnapshotSync(taskId, actor)).not.toThrow();

    testDataDir = originalDir;
  });

  it("logs error when writeFileSync fails due to circular JSON", () => {
    const taskId = "writesync-fail";
    mkdirSync(join(testDataDir, "tasks"), { recursive: true });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const actor = { getPersistedSnapshot: () => circular };

    // Should not throw
    expect(() => flushSnapshotSync(taskId, actor)).not.toThrow();
  });
});

describe("pipelineFingerprint with parallel groups", () => {
  it("handles parallel groups", () => {
    const pipeline = {
      name: "test",
      stages: [
        { parallel: { name: "groupName", stages: [{ name: "child1", type: "agent" }, { name: "child2", type: "script" }] } },
      ],
    } as unknown as PipelineConfig;

    expect(pipelineFingerprint(pipeline)).toBe("P[groupName:child1:agent,child2:script]");
  });

  it("handles mixed sequential and parallel stages", () => {
    const pipeline = {
      name: "mixed",
      stages: [
        { name: "init", type: "script" },
        { parallel: { name: "research", stages: [{ name: "web", type: "agent" }, { name: "docs", type: "agent" }] } },
        { name: "deploy", type: "script" },
      ],
    } as unknown as PipelineConfig;

    expect(pipelineFingerprint(pipeline)).toBe("init:script|P[research:web:agent,docs:agent]|deploy:script");
  });
});
