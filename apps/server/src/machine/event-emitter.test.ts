import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
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

import { emitWorkflowEvent, getNextEventId } from "./event-emitter.js";
import { loadEvents } from "./workflow-events.js";

beforeEach(() => {
  testDataDir = join(tmpdir(), `wf-emitter-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(testDataDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("emitWorkflowEvent", () => {
  it("auto-assigns monotonic id and ISO timestamp", async () => {
    await emitWorkflowEvent("task-1", "stage_started", "brainstorm");
    await emitWorkflowEvent("task-1", "stage_completed", "brainstorm");

    const events = loadEvents("task-1");
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(1);
    expect(events[1].id).toBe(2);
    expect(events[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("includes payload when provided", async () => {
    await emitWorkflowEvent("task-2", "cost_update", undefined, { totalCostUsd: 1.5 });

    const events = loadEvents("task-2");
    expect(events[0].payload).toEqual({ totalCostUsd: 1.5 });
  });

  it("id counter resets per task", async () => {
    await emitWorkflowEvent("task-a", "stage_started", "x");
    await emitWorkflowEvent("task-b", "stage_started", "y");

    const eventsA = loadEvents("task-a");
    const eventsB = loadEvents("task-b");
    expect(eventsA[0].id).toBe(1);
    expect(eventsB[0].id).toBe(1);
  });
});

describe("getNextEventId", () => {
  it("returns 1 for new task", () => {
    expect(getNextEventId("brand-new-task")).toBe(1);
  });

  it("returns next id after loading existing events", async () => {
    await emitWorkflowEvent("task-existing", "stage_started", "a");
    await emitWorkflowEvent("task-existing", "stage_completed", "a");

    // Counter is already in memory, should be 3
    expect(getNextEventId("task-existing")).toBe(3);
  });
});
