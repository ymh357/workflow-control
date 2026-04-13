import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, appendFileSync } from "node:fs";
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
}));

import { appendEvent, loadEvents, eventsPath, type WorkflowEvent } from "./workflow-events.js";

beforeEach(() => {
  testDataDir = join(tmpdir(), `wf-events-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(testDataDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("appendEvent", () => {
  it("creates events.jsonl on first write and appends event", async () => {
    const event: WorkflowEvent = {
      id: 1,
      ts: "2026-04-13T10:00:00.000Z",
      type: "stage_started",
      stage: "brainstorm",
    };

    await appendEvent("task-1", event);

    const events = loadEvents("task-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(event);
  });

  it("appends multiple events preserving order", async () => {
    await appendEvent("task-2", { id: 1, ts: "2026-04-13T10:00:00.000Z", type: "stage_started", stage: "brainstorm" });
    await appendEvent("task-2", { id: 2, ts: "2026-04-13T10:01:00.000Z", type: "stage_completed", stage: "brainstorm" });
    await appendEvent("task-2", { id: 3, ts: "2026-04-13T10:02:00.000Z", type: "stage_started", stage: "plan" });

    const events = loadEvents("task-2");
    expect(events).toHaveLength(3);
    expect(events[0].id).toBe(1);
    expect(events[1].id).toBe(2);
    expect(events[2].id).toBe(3);
  });

  it("stores payload when provided", async () => {
    await appendEvent("task-3", {
      id: 1,
      ts: "2026-04-13T10:00:00.000Z",
      type: "store_write",
      stage: "plan",
      payload: { keys: ["requirements", "tasks"], totalBytes: 4200 },
    });

    const events = loadEvents("task-3");
    expect(events[0].payload).toEqual({ keys: ["requirements", "tasks"], totalBytes: 4200 });
  });
});

describe("loadEvents", () => {
  it("returns empty array for non-existent task", () => {
    expect(loadEvents("no-such-task")).toEqual([]);
  });

  it("skips malformed lines gracefully", async () => {
    await appendEvent("task-corrupt", { id: 1, ts: "2026-04-13T10:00:00.000Z", type: "stage_started", stage: "a" });

    appendFileSync(eventsPath("task-corrupt"), "not valid json\n");

    await appendEvent("task-corrupt", { id: 2, ts: "2026-04-13T10:01:00.000Z", type: "stage_completed", stage: "a" });

    const events = loadEvents("task-corrupt");
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(1);
    expect(events[1].id).toBe(2);
  });
});
