# Workflow Event Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an append-only JSONL event log per task that records stage transitions, gate decisions, retries, and cost updates -- enabling pipeline diagnosis without relying on ephemeral SSE logs.

**Architecture:** New functions in persistence.ts handle event file I/O. Side-effects handlers in side-effects.ts append events when they fire. A new API endpoint exposes the event timeline. Zero changes to the state machine core (state-builders.ts, machine.ts, helpers.ts remain untouched).

**Tech Stack:** Node.js fs (appendFile), JSONL format, Hono route, Vitest

**Spec:** `docs/superpowers/specs/2026-04-13-workflow-event-store-design.md` (Spec A)

---

### Task 1: Event types and persistence functions

**Files:**
- Create: `apps/server/src/machine/workflow-events.ts`
- Modify: `apps/server/src/machine/persistence.ts`
- Create: `apps/server/src/machine/workflow-events.test.ts`

- [ ] **Step 1: Write the test file for event persistence**

```typescript
// apps/server/src/machine/workflow-events.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
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

import { appendEvent, loadEvents, type WorkflowEvent } from "./workflow-events.js";

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
    // Write a valid event then corrupt a line
    await appendEvent("task-corrupt", { id: 1, ts: "2026-04-13T10:00:00.000Z", type: "stage_started", stage: "a" });

    // Manually append a corrupt line
    const { appendFileSync } = await import("node:fs");
    const { eventsPath } = await import("./workflow-events.js");
    appendFileSync(eventsPath("task-corrupt"), "not valid json\n");

    await appendEvent("task-corrupt", { id: 2, ts: "2026-04-13T10:01:00.000Z", type: "stage_completed", stage: "a" });

    const events = loadEvents("task-corrupt");
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(1);
    expect(events[1].id).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && npx vitest run src/machine/workflow-events.test.ts`
Expected: FAIL -- module `./workflow-events.js` does not exist

- [ ] **Step 3: Create the workflow-events module**

```typescript
// apps/server/src/machine/workflow-events.ts
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { taskLogger } from "../lib/logger.js";
import { loadSystemSettings } from "../lib/config-loader.js";

// --- Types ---

export type WorkflowEventType =
  | "stage_started"
  | "stage_completed"
  | "stage_failed"
  | "stage_skipped"
  | "retry"
  | "retry_from"
  | "gate_approved"
  | "gate_rejected"
  | "gate_feedback"
  | "store_write"
  | "cost_update"
  | "task_interrupted"
  | "task_cancelled";

export interface WorkflowEvent {
  id: number;
  ts: string;
  type: WorkflowEventType;
  stage?: string;
  payload?: Record<string, unknown>;
}

// --- Paths ---

export function eventsPath(taskId: string): string {
  const settings = loadSystemSettings();
  const dataDir = settings.paths?.data_dir || "/tmp/workflow-control-data";
  return join(dataDir, "tasks", taskId, "events.jsonl");
}

// --- Write ---

export async function appendEvent(taskId: string, event: WorkflowEvent): Promise<void> {
  const p = eventsPath(taskId);
  try {
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, JSON.stringify(event) + "\n");
  } catch (err) {
    taskLogger(taskId).error({ err }, "append workflow event failed");
  }
}

// --- Read ---

export function loadEvents(taskId: string): WorkflowEvent[] {
  const p = eventsPath(taskId);
  if (!existsSync(p)) return [];
  try {
    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    const events: WorkflowEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch (err) {
    taskLogger(taskId).error({ err }, "load workflow events failed");
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/machine/workflow-events.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/machine/workflow-events.ts apps/server/src/machine/workflow-events.test.ts
git commit -m "feat: add workflow event log persistence (types + read/write)"
```

---

### Task 2: Wire event emission into side-effects

**Files:**
- Modify: `apps/server/src/machine/side-effects.ts`
- Create: `apps/server/src/machine/event-emitter.ts`
- Create: `apps/server/src/machine/event-emitter.test.ts`

The side-effects handlers already fire for every status change, cost update, gate notification, etc. We add a thin helper that maps WorkflowEmittedEvent to WorkflowEvent and appends it. This helper encapsulates the mapping logic so side-effects.ts changes are minimal.

- [ ] **Step 1: Write the test file for event-emitter**

```typescript
// apps/server/src/machine/event-emitter.test.ts
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

    // Reset in-memory counter by getting a fresh id calculation
    expect(getNextEventId("task-existing")).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && npx vitest run src/machine/event-emitter.test.ts`
Expected: FAIL -- module `./event-emitter.js` does not exist

- [ ] **Step 3: Create event-emitter module**

```typescript
// apps/server/src/machine/event-emitter.ts
import { appendEvent, loadEvents, type WorkflowEventType } from "./workflow-events.js";

const counters = new Map<string, number>();

export function getNextEventId(taskId: string): number {
  let counter = counters.get(taskId);
  if (counter === undefined) {
    // Initialize from existing events file
    const existing = loadEvents(taskId);
    counter = existing.length > 0 ? existing[existing.length - 1].id + 1 : 1;
    counters.set(taskId, counter);
  }
  return counter;
}

export async function emitWorkflowEvent(
  taskId: string,
  type: WorkflowEventType,
  stage?: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  const id = getNextEventId(taskId);
  counters.set(taskId, id + 1);

  await appendEvent(taskId, {
    id,
    ts: new Date().toISOString(),
    type,
    ...(stage !== undefined && { stage }),
    ...(payload !== undefined && { payload }),
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/machine/event-emitter.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/machine/event-emitter.ts apps/server/src/machine/event-emitter.test.ts
git commit -m "feat: add workflow event emitter with auto-incrementing IDs"
```

---

### Task 3: Wire side-effects to emit events

**Files:**
- Modify: `apps/server/src/machine/side-effects.ts`
- Modify: `apps/server/src/__integration__/side-effects.test.ts` (verify no regression)

- [ ] **Step 1: Read the existing side-effects integration test**

Read `apps/server/src/__integration__/side-effects.test.ts` to understand what's tested and ensure we don't break it.

- [ ] **Step 2: Add event emission to side-effects handlers**

In `apps/server/src/machine/side-effects.ts`, add import at top:

```typescript
import { emitWorkflowEvent } from "./event-emitter.js";
```

Then add `emitWorkflowEvent` calls inside existing handlers. Each call is fire-and-forget (no `await`):

In the `wf.status` handler (line 29), after the existing `sseManager.pushMessage` call:
```typescript
    // Derive event type from status string
    const stage = event.status;
    if (event.message === "completed" || event.status === "completed") {
      emitWorkflowEvent(event.taskId, "stage_completed", stage);
    } else if (event.status === "blocked" || event.status === "error") {
      emitWorkflowEvent(event.taskId, "stage_failed", stage, event.message ? { message: event.message } : undefined);
    } else {
      emitWorkflowEvent(event.taskId, "stage_started", stage);
    }
```

In the `wf.costUpdate` handler (line 47), after existing code:
```typescript
    emitWorkflowEvent(event.taskId, "cost_update", undefined, {
      totalCostUsd: event.totalCostUsd,
      stageCostUsd: event.stageCostUsd,
    });
```

In the `wf.slackBlocked` handler (line 71), after existing code:
```typescript
    emitWorkflowEvent(event.taskId, "stage_failed", event.stage, { error: event.error });
```

In the `wf.cancelAgent` handler (line 109), after existing code:
```typescript
    emitWorkflowEvent(event.taskId, "task_cancelled");
```

Note: Gate events (gate_approved/gate_rejected/gate_feedback) will be wired in a later iteration if needed -- the `wf.status` handler already captures the stage transition that results from gate decisions, which is sufficient for audit purposes.

- [ ] **Step 3: Run the existing side-effects integration test**

Run: `cd apps/server && npx vitest run src/__integration__/side-effects.test.ts`
Expected: All existing tests PASS (our changes are additive, fire-and-forget)

- [ ] **Step 4: Run full test suite to check for regressions**

Run: `cd apps/server && npx vitest run --reporter=verbose 2>&1 | tail -20`
Expected: No new failures

- [ ] **Step 5: Type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/machine/side-effects.ts
git commit -m "feat: wire workflow event log into side-effects handlers"
```

---

### Task 4: API endpoint for event timeline

**Files:**
- Modify: `apps/server/src/routes/tasks.ts`

- [ ] **Step 1: Add the events endpoint**

In `apps/server/src/routes/tasks.ts`, add import at top:

```typescript
import { loadEvents } from "../machine/workflow-events.js";
```

Add new route after the existing `GET /tasks/:taskId` route (after line 158):

```typescript
// 6. Get task event timeline
tasksRoute.get("/tasks/:taskId/events", (c) => {
  const taskId = c.req.param("taskId");
  const events = loadEvents(taskId);
  return c.json({ taskId, events });
});
```

- [ ] **Step 2: Type check**

Run: `cd apps/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Manual smoke test**

Start the dev server and run a short pipeline. Then:

```bash
curl http://localhost:3001/api/tasks/{taskId}/events | jq .
```

Expected: JSON response with `taskId` and `events` array containing stage_started/stage_completed/cost_update entries.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/routes/tasks.ts
git commit -m "feat: add GET /tasks/:taskId/events API endpoint"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd apps/server && npx vitest run`
Expected: All tests pass, no regressions

- [ ] **Step 2: Type check entire project**

Run: `cd apps/server && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify event log on disk**

After running any pipeline, check the data directory:

```bash
ls -la /tmp/workflow-control-data/tasks/
# Should see {taskId}/ directories alongside {taskId}.json files
cat /tmp/workflow-control-data/tasks/{some-task-id}/events.jsonl
# Should see one JSON object per line
```

- [ ] **Step 4: Commit and tag**

```bash
git add -A
git commit -m "feat: workflow event log - complete implementation

Adds append-only JSONL event log per task for audit trail.
Events recorded: stage_started, stage_completed, stage_failed,
cost_update, task_cancelled.

No changes to state machine core. Events written from
side-effects handlers (fire-and-forget, async).

New API: GET /tasks/:taskId/events"
```
