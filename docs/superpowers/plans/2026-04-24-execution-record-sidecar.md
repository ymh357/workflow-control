# Execution Record Sidecar — Stage 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `agent_execution_details` sidecar table in kernel-next.db, wire RealStageExecutor to write per-attempt rows (prompt content, tool calls, agent stream, cost, lifecycle), migrate debug tools to the new table, and delete the legacy `lib/execution-record/` module plus the legacy `execution_records` table DDL.

**Architecture:** New DDL + writer module in `kernel-next/runtime/`. RealStageExecutor opens writer at attempt start, feeds SDK messages as they arrive, closes at attempt end. `debug-queries.ts` rewritten to JOIN `stage_attempts` with the new table. Legacy execution-record module entirely deleted.

**Tech Stack:** TypeScript, Vitest, node:sqlite (DatabaseSync), Claude Agent SDK.

**Spec:** `docs/superpowers/specs/2026-04-24-execution-record-sidecar-design.md`

**Baseline (post Stage 4b)**: 1499 passed / 1 skipped / 0 failed. Server+Web tsc clean. HEAD `bcf1b64`.

---

## Pre-flight

- [ ] **Step 1: Record baseline**

```bash
cd /Users/minghao/workflow-control
git log -1 --format=%H    # expect a recent SHA past bcf1b64 (3050833 after spec commit)
cd apps/server && ./node_modules/.bin/vitest run 2>&1 | tail -3
./node_modules/.bin/tsc --noEmit
cd ../web && ./node_modules/.bin/tsc --noEmit
```
Record counts.

- [ ] **Step 2: Enumerate legacy `lib/execution-record/` files that will be deleted**

```bash
ls /Users/minghao/workflow-control/apps/server/src/lib/execution-record/
```

Expected:
- `build-prompt-blob.ts` + `.test.ts`
- `types.ts`
- `workflow-version.ts` + `.test.ts`
- `writer.ts` + `.test.ts` + `.adversarial.test.ts`

All go in Task 3.

- [ ] **Step 3: Enumerate legacy `execution_records` DDL references**

```bash
grep -n 'execution_records' /Users/minghao/workflow-control/apps/server/src/lib/db.ts
```

Should see 5-7 matches: CREATE TABLE, 4 CREATE INDEX, PRAGMA drift-check block.

All goes in Task 3.

---

## Task 1: DDL + helpers in `kernel-next/ir/sql.ts`

**Files:**
- Modify: `apps/server/src/kernel-next/ir/sql.ts`
- Modify: `apps/server/src/kernel-next/ir/sql.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `apps/server/src/kernel-next/ir/sql.test.ts`:

```typescript
describe("agent_execution_details table", () => {
  it("creates table with attempt_id PK + FKs", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const cols = db.prepare("PRAGMA table_info(agent_execution_details)").all() as Array<{ name: string; pk: number; notnull: number }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toContain("attempt_id");
    expect(names).toContain("prompt_ref");
    expect(names).toContain("prompt_content_hash");
    expect(names).toContain("prompt_content");
    expect(names).toContain("model");
    expect(names).toContain("tool_calls_json");
    expect(names).toContain("agent_stream_json");
    expect(names).toContain("cost_usd");
    expect(names).toContain("token_input");
    expect(names).toContain("token_output");
    expect(names).toContain("session_id");
    expect(names).toContain("duration_ms");
    expect(names).toContain("started_at");
    expect(names).toContain("ended_at");
    expect(names).toContain("termination_reason");
    expect(names).toContain("last_heartbeat_at");
    const pk = cols.find((c) => c.name === "attempt_id");
    expect(pk?.pk).toBe(1);

    const fks = db.prepare("PRAGMA foreign_key_list(agent_execution_details)").all() as Array<{ table: string; from: string }>;
    expect(fks.some((fk) => fk.table === "stage_attempts" && fk.from === "attempt_id")).toBe(true);
    expect(fks.some((fk) => fk.table === "prompt_contents" && fk.from === "prompt_content_hash")).toBe(true);
  });

  it("rejects rows without matching stage_attempts row (FK enforcement)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    expect(() => db.prepare(
      `INSERT INTO agent_execution_details
       (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
        tool_calls_json, agent_stream_json,
        started_at, last_heartbeat_at)
       VALUES ('no-such-attempt', 'r', 'h', 'c', 'm', '[]', '[]', 1, 1)`,
    ).run()).toThrow(/FOREIGN KEY/i);
  });

  it("rejects bad termination_reason via CHECK", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    // Seed required rows: version + attempt + prompt_content.
    db.prepare(`INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source) VALUES ('v', 't', 0, NULL, '{}', '')`).run();
    db.prepare(`INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status) VALUES ('a1', 'tk', 'v', 's', 1, 0, 'running')`).run();
    db.prepare(`INSERT OR IGNORE INTO prompt_contents (content_hash, content, created_at) VALUES ('h', 'c', 0)`).run();
    expect(() => db.prepare(
      `INSERT INTO agent_execution_details
       (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
        tool_calls_json, agent_stream_json,
        started_at, ended_at, termination_reason, last_heartbeat_at)
       VALUES ('a1', 'r', 'h', 'c', 'm', '[]', '[]', 1, 2, 'bogus_reason', 2)`,
    ).run()).toThrow(/CHECK/i);
  });
});
```

- [ ] **Step 2: Run — FAIL**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/sql.test.ts 2>&1 | tail -15
```
Expected: 3 new test cases fail with `no such table: agent_execution_details`.

- [ ] **Step 3: Add DDL**

Edit `apps/server/src/kernel-next/ir/sql.ts`. Find the end of `KERNEL_NEXT_SCHEMA` template string (before the closing backtick). Append before the backtick:

```sql
CREATE TABLE IF NOT EXISTS agent_execution_details (
  attempt_id           TEXT PRIMARY KEY
                       REFERENCES stage_attempts(attempt_id) ON DELETE RESTRICT,

  prompt_ref           TEXT NOT NULL,
  prompt_content_hash  TEXT NOT NULL
                       REFERENCES prompt_contents(content_hash) ON DELETE RESTRICT,
  prompt_content       TEXT NOT NULL,
  model                TEXT NOT NULL,
  sub_agents_json      TEXT,

  tool_calls_json      TEXT NOT NULL DEFAULT '[]',
  agent_stream_json    TEXT NOT NULL DEFAULT '[]',

  cost_usd             REAL,
  token_input          INTEGER,
  token_output         INTEGER,
  session_id           TEXT,
  duration_ms          INTEGER,

  started_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  termination_reason   TEXT
                       CHECK (termination_reason IS NULL
                              OR termination_reason IN
                              ('natural_completion','interrupted','error','superseded')),
  last_heartbeat_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aed_prompt_hash
  ON agent_execution_details(prompt_content_hash);
CREATE INDEX IF NOT EXISTS idx_aed_open
  ON agent_execution_details(last_heartbeat_at)
  WHERE ended_at IS NULL;
```

- [ ] **Step 4: Run — PASS**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/ir/sql.test.ts 2>&1 | tail -10
```
Expected: all sql tests pass.

- [ ] **Step 5: tsc + full regression**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | tail -5
./node_modules/.bin/vitest run 2>&1 | tail -3
```
Expected: 0 errors / 0 failures.

- [ ] **Step 6: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/ir/sql.ts apps/server/src/kernel-next/ir/sql.test.ts && git commit -m "feat(sidecar): agent_execution_details table DDL + indexes + FK + CHECK

New table in kernel-next.db holds one row per agent-stage attempt.
attempt_id is PK + FK to stage_attempts (ON DELETE RESTRICT).
prompt_content_hash FK to prompt_contents. termination_reason CHECK
enforces the 4-value enum. Two indexes: prompt_content_hash reverse
lookup, open-row heartbeat scan.

Test delta: +3
tsc: 0 errors"
```

---

## Task 2: Writer module — types + open/append/close + buffered flush

**Files:**
- Create: `apps/server/src/kernel-next/runtime/execution-record-types.ts`
- Create: `apps/server/src/kernel-next/runtime/execution-record-writer.ts`
- Create: `apps/server/src/kernel-next/runtime/execution-record-writer.test.ts`

- [ ] **Step 1: Write types file**

Create `apps/server/src/kernel-next/runtime/execution-record-types.ts`:

```typescript
// Types for kernel-next agent execution sidecar.
// See docs/superpowers/specs/2026-04-24-execution-record-sidecar-design.md §5.1.

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
  tokenIn: number | null;
  tokenOut: number | null;
  durationMs: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface AgentStreamEvent {
  type: "text" | "thinking";
  text: string;
  timestamp: string;
}

export type TerminationReason =
  | "natural_completion"
  | "interrupted"
  | "error"
  | "superseded";

export interface OpenWriterInput {
  attemptId: string;
  promptRef: string;
  promptContentHash: string;
  promptContent: string;
  model: string;
  subAgents?: unknown[] | null;
}

export interface CloseWriterInput {
  terminationReason: TerminationReason;
  costUsd?: number | null;
  tokenInput?: number | null;
  tokenOutput?: number | null;
  sessionId?: string | null;
}
```

- [ ] **Step 2: Write writer tests**

Create `apps/server/src/kernel-next/runtime/execution-record-writer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPromptContent } from "../ir/sql.js";
import { openExecutionRecordWriter } from "./execution-record-writer.js";

function seedAttempt(db: DatabaseSync, attemptId: string): void {
  db.prepare(
    `INSERT INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
     VALUES ('v1','t',0,NULL,'{}','')`,
  ).run();
  db.prepare(
    `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
     VALUES (?, 'tk', 'v1', 'analyzing', 1, 0, 'running')`,
  ).run(attemptId);
  insertPromptContent(db, "hash-1", "prompt body");
}

describe("execution-record-writer", () => {
  it("opens a row with prompt context and initial defaults", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a1");

    const w = openExecutionRecordWriter(db, {
      attemptId: "a1",
      promptRef: "analyzing",
      promptContentHash: "hash-1",
      promptContent: "prompt body",
      model: "claude-haiku-4-5",
    });

    const row = db.prepare("SELECT * FROM agent_execution_details WHERE attempt_id = ?").get("a1") as Record<string, unknown>;
    expect(row.prompt_ref).toBe("analyzing");
    expect(row.prompt_content_hash).toBe("hash-1");
    expect(row.model).toBe("claude-haiku-4-5");
    expect(row.tool_calls_json).toBe("[]");
    expect(row.agent_stream_json).toBe("[]");
    expect(row.started_at).toBeGreaterThan(0);
    expect(row.ended_at).toBeNull();

    w.close({ terminationReason: "natural_completion" });
  });

  it("appendToolCall + completeToolCall persist via flush", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a2");

    const w = openExecutionRecordWriter(db, {
      attemptId: "a2",
      promptRef: "r",
      promptContentHash: "hash-1",
      promptContent: "p",
      model: "m",
    });

    w.appendToolCall({
      id: "t1",
      name: "write_port",
      input: { port: "x", value: 1 },
      result: null,
      isError: false,
      tokenIn: null,
      tokenOut: null,
      durationMs: null,
      startedAt: "2026-04-24T00:00:00Z",
      finishedAt: null,
    });
    w.completeToolCall("t1", { result: "ok", finishedAt: "2026-04-24T00:00:01Z", durationMs: 1000 });
    w.__flushForTests();

    const row = db.prepare("SELECT tool_calls_json FROM agent_execution_details WHERE attempt_id = ?").get("a2") as { tool_calls_json: string };
    const calls = JSON.parse(row.tool_calls_json) as Array<Record<string, unknown>>;
    expect(calls.length).toBe(1);
    expect(calls[0]!.id).toBe("t1");
    expect(calls[0]!.result).toBe("ok");
    expect(calls[0]!.durationMs).toBe(1000);

    w.close({ terminationReason: "natural_completion" });
  });

  it("appendAgentStream accumulates text and thinking events", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a3");
    const w = openExecutionRecordWriter(db, {
      attemptId: "a3", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    w.appendAgentStream({ type: "text", text: "hello", timestamp: "t1" });
    w.appendAgentStream({ type: "thinking", text: "think", timestamp: "t2" });
    w.__flushForTests();
    const row = db.prepare("SELECT agent_stream_json FROM agent_execution_details WHERE attempt_id = ?").get("a3") as { agent_stream_json: string };
    const events = JSON.parse(row.agent_stream_json);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe("text");
    expect(events[1].type).toBe("thinking");
    w.close({ terminationReason: "natural_completion" });
  });

  it("close sets ended_at, termination_reason, cost, duration_ms", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a4");
    const w = openExecutionRecordWriter(db, {
      attemptId: "a4", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    w.close({ terminationReason: "natural_completion", costUsd: 0.03, tokenInput: 500, tokenOutput: 200, sessionId: "sess-1" });
    const row = db.prepare("SELECT * FROM agent_execution_details WHERE attempt_id = ?").get("a4") as Record<string, unknown>;
    expect(row.ended_at).not.toBeNull();
    expect(row.termination_reason).toBe("natural_completion");
    expect(row.cost_usd).toBe(0.03);
    expect(row.token_input).toBe(500);
    expect(row.token_output).toBe(200);
    expect(row.session_id).toBe("sess-1");
    expect(Number(row.duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it("close is idempotent (second call is a no-op)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a5");
    const w = openExecutionRecordWriter(db, {
      attemptId: "a5", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    w.close({ terminationReason: "natural_completion" });
    const row1 = db.prepare("SELECT ended_at FROM agent_execution_details WHERE attempt_id = ?").get("a5") as { ended_at: number };
    w.close({ terminationReason: "superseded" });
    const row2 = db.prepare("SELECT ended_at, termination_reason FROM agent_execution_details WHERE attempt_id = ?").get("a5") as { ended_at: number; termination_reason: string };
    expect(row2.ended_at).toBe(row1.ended_at);  // unchanged
    expect(row2.termination_reason).toBe("natural_completion"); // unchanged
  });

  it("returns no-op writer + logs warning when FK violates (missing stage_attempts row)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    insertPromptContent(db, "hash-1", "p");

    // No stage_attempts row for "missing-attempt" — FK will fail.
    const w = openExecutionRecordWriter(db, {
      attemptId: "missing-attempt",
      promptRef: "r",
      promptContentHash: "hash-1",
      promptContent: "p",
      model: "m",
    });

    // Calls succeed silently (no-op).
    expect(() => {
      w.appendToolCall({
        id: "t1", name: "write_port", input: {}, result: null, isError: false,
        tokenIn: null, tokenOut: null, durationMs: null, startedAt: "t", finishedAt: null,
      });
      w.appendAgentStream({ type: "text", text: "x", timestamp: "t" });
      w.close({ terminationReason: "natural_completion" });
    }).not.toThrow();

    // No row inserted.
    const row = db.prepare("SELECT COUNT(*) AS n FROM agent_execution_details WHERE attempt_id = ?").get("missing-attempt") as { n: number };
    expect(row.n).toBe(0);
  });

  it("heartbeat updates last_heartbeat_at without closing", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    seedAttempt(db, "a6");
    const w = openExecutionRecordWriter(db, {
      attemptId: "a6", promptRef: "r", promptContentHash: "hash-1",
      promptContent: "p", model: "m",
    });
    const before = db.prepare("SELECT last_heartbeat_at FROM agent_execution_details WHERE attempt_id = ?").get("a6") as { last_heartbeat_at: number };
    // Sleep briefly so heartbeat timestamp can advance.
    const waitMs = 5;
    const start = Date.now();
    while (Date.now() - start < waitMs) { /* spin */ }
    w.heartbeat();
    const after = db.prepare("SELECT last_heartbeat_at, ended_at FROM agent_execution_details WHERE attempt_id = ?").get("a6") as { last_heartbeat_at: number; ended_at: number | null };
    expect(after.last_heartbeat_at).toBeGreaterThanOrEqual(before.last_heartbeat_at);
    expect(after.ended_at).toBeNull();
    w.close({ terminationReason: "natural_completion" });
  });
});
```

- [ ] **Step 2: Run — FAIL**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/execution-record-writer.test.ts 2>&1 | tail -15
```
Expected: FAIL (module not found).

- [ ] **Step 3: Write the writer implementation**

Create `apps/server/src/kernel-next/runtime/execution-record-writer.ts`:

```typescript
// kernel-next agent execution sidecar writer. See spec §5.
// Buffered append-only appender over agent_execution_details.
// Never throws into the executor; on any DB failure, logs + returns
// a degraded writer.

import type { DatabaseSync } from "node:sqlite";
import { logger } from "../../lib/logger.js";
import type {
  AgentStreamEvent,
  CloseWriterInput,
  OpenWriterInput,
  ToolCallRecord,
} from "./execution-record-types.js";

const FLUSH_DEBOUNCE_MS = 1_000;

export interface ExecutionRecordWriter {
  readonly attemptId: string;
  appendToolCall(call: ToolCallRecord): void;
  completeToolCall(id: string, patch: Partial<ToolCallRecord>): void;
  appendAgentStream(event: AgentStreamEvent): void;
  updateCost(patch: { costUsd?: number | null; tokenInput?: number | null; tokenOutput?: number | null }): void;
  updateSessionId(sessionId: string | null): void;
  heartbeat(): void;
  close(input: CloseWriterInput): void;
  __flushForTests(): void;
}

class NoopWriter implements ExecutionRecordWriter {
  constructor(public readonly attemptId: string) {}
  appendToolCall(): void {}
  completeToolCall(): void {}
  appendAgentStream(): void {}
  updateCost(): void {}
  updateSessionId(): void {}
  heartbeat(): void {}
  close(): void {}
  __flushForTests(): void {}
}

class ActiveWriter implements ExecutionRecordWriter {
  readonly attemptId: string;
  private readonly db: DatabaseSync;
  private readonly startedAt: number;
  private toolCalls: ToolCallRecord[] = [];
  private agentStream: AgentStreamEvent[] = [];
  private costUsd: number | null = null;
  private tokenInput: number | null = null;
  private tokenOutput: number | null = null;
  private sessionId: string | null = null;
  private pendingFlush: NodeJS.Timeout | null = null;
  private closed = false;
  private dirtyAppend = false;
  private dirtyMeta = false;

  constructor(db: DatabaseSync, attemptId: string, startedAt: number) {
    this.db = db;
    this.attemptId = attemptId;
    this.startedAt = startedAt;
  }

  appendToolCall(call: ToolCallRecord): void {
    if (this.closed) return;
    this.toolCalls.push(call);
    this.dirtyAppend = true;
    this.scheduleFlush();
  }

  completeToolCall(id: string, patch: Partial<ToolCallRecord>): void {
    if (this.closed) return;
    for (const c of this.toolCalls) {
      if (c.id === id) {
        Object.assign(c, patch);
        this.dirtyAppend = true;
        this.scheduleFlush();
        return;
      }
    }
  }

  appendAgentStream(event: AgentStreamEvent): void {
    if (this.closed) return;
    this.agentStream.push(event);
    this.dirtyAppend = true;
    this.scheduleFlush();
  }

  updateCost(patch: { costUsd?: number | null; tokenInput?: number | null; tokenOutput?: number | null }): void {
    if (this.closed) return;
    if (patch.costUsd !== undefined) this.costUsd = patch.costUsd;
    if (patch.tokenInput !== undefined) this.tokenInput = patch.tokenInput;
    if (patch.tokenOutput !== undefined) this.tokenOutput = patch.tokenOutput;
    this.dirtyMeta = true;
    this.scheduleFlush();
  }

  updateSessionId(sessionId: string | null): void {
    if (this.closed) return;
    this.sessionId = sessionId;
    this.dirtyMeta = true;
    this.scheduleFlush();
  }

  heartbeat(): void {
    if (this.closed) return;
    this.flushNow();
  }

  close(input: CloseWriterInput): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
    if (input.costUsd !== undefined) this.costUsd = input.costUsd;
    if (input.tokenInput !== undefined) this.tokenInput = input.tokenInput;
    if (input.tokenOutput !== undefined) this.tokenOutput = input.tokenOutput;
    if (input.sessionId !== undefined) this.sessionId = input.sessionId;
    const endedAt = Date.now();
    try {
      this.db.prepare(
        `UPDATE agent_execution_details
         SET tool_calls_json = ?, agent_stream_json = ?,
             cost_usd = ?, token_input = ?, token_output = ?, session_id = ?,
             ended_at = ?, termination_reason = ?, duration_ms = ?,
             last_heartbeat_at = ?
         WHERE attempt_id = ?`,
      ).run(
        JSON.stringify(this.toolCalls),
        JSON.stringify(this.agentStream),
        this.costUsd,
        this.tokenInput,
        this.tokenOutput,
        this.sessionId,
        endedAt,
        input.terminationReason,
        endedAt - this.startedAt,
        endedAt,
        this.attemptId,
      );
    } catch (err) {
      logger.error(
        { attemptId: this.attemptId, err: (err as Error).message },
        "[execution-record-writer] close failed",
      );
    }
  }

  __flushForTests(): void {
    this.flushNow();
  }

  private scheduleFlush(): void {
    if (this.pendingFlush || this.closed) return;
    this.pendingFlush = setTimeout(() => {
      this.pendingFlush = null;
      this.flushNow();
    }, FLUSH_DEBOUNCE_MS);
  }

  private flushNow(): void {
    if (this.closed) return;
    const now = Date.now();
    try {
      this.db.prepare(
        `UPDATE agent_execution_details
         SET tool_calls_json = ?, agent_stream_json = ?,
             cost_usd = ?, token_input = ?, token_output = ?, session_id = ?,
             last_heartbeat_at = ?
         WHERE attempt_id = ?`,
      ).run(
        JSON.stringify(this.toolCalls),
        JSON.stringify(this.agentStream),
        this.costUsd,
        this.tokenInput,
        this.tokenOutput,
        this.sessionId,
        now,
        this.attemptId,
      );
      this.dirtyAppend = false;
      this.dirtyMeta = false;
    } catch (err) {
      logger.error(
        { attemptId: this.attemptId, err: (err as Error).message },
        "[execution-record-writer] flush failed",
      );
    }
  }
}

export function openExecutionRecordWriter(
  db: DatabaseSync,
  input: OpenWriterInput,
): ExecutionRecordWriter {
  const startedAt = Date.now();
  try {
    db.prepare(
      `INSERT INTO agent_execution_details
       (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
        sub_agents_json, started_at, last_heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.attemptId,
      input.promptRef,
      input.promptContentHash,
      input.promptContent,
      input.model,
      input.subAgents && input.subAgents.length > 0 ? JSON.stringify(input.subAgents) : null,
      startedAt,
      startedAt,
    );
    return new ActiveWriter(db, input.attemptId, startedAt);
  } catch (err) {
    logger.warn(
      { attemptId: input.attemptId, err: (err as Error).message },
      "[execution-record-writer] open failed; falling back to no-op writer",
    );
    return new NoopWriter(input.attemptId);
  }
}
```

- [ ] **Step 4: Run — PASS**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/execution-record-writer.test.ts 2>&1 | tail -10
```
Expected: all 7 tests pass.

- [ ] **Step 5: Full regression**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | tail -5
./node_modules/.bin/vitest run 2>&1 | tail -3
```
Expected: 0 errors / 0 failures.

- [ ] **Step 6: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/execution-record-types.ts apps/server/src/kernel-next/runtime/execution-record-writer.ts apps/server/src/kernel-next/runtime/execution-record-writer.test.ts && git commit -m "feat(sidecar): execution-record-writer with buffered flush + no-op fallback

Writer opens a row at stage start, buffers tool_calls and agent_stream
with 1Hz debounced flush, heartbeat keeps last_heartbeat_at current,
close is idempotent. FK violation on open returns a no-op writer so
executor is never blocked.

Test delta: +7
tsc: 0 errors"
```

---

## Task 3: RealStageExecutor integration

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/port-runtime.ts` (add `getDb()` accessor)
- Modify: `apps/server/src/kernel-next/runtime/real-executor.ts`
- Modify: `apps/server/src/kernel-next/runtime/real-executor.test.ts`
- Modify: `apps/server/src/kernel-next/runtime/stream-pump.ts` (if events emitted aren't structured — inspect first)

- [ ] **Step 1: Expose db from PortRuntime**

Read current state:
```bash
grep -n "constructor\|readonly db\|getDispatcher\|public " /Users/minghao/workflow-control/apps/server/src/kernel-next/runtime/port-runtime.ts | head
```

Add a public accessor after the constructor (near `getDispatcher`):

```typescript
/** Kernel-next DB handle. Used by executors that write sidecar tables. */
getDb(): DatabaseSync {
  return this.db;
}
```

- [ ] **Step 2: Read stream-pump to locate SDK message event points**

```bash
grep -n "text\|thinking\|tool_use\|tool_result\|sessionId\|costUsd\|usage" /Users/minghao/workflow-control/apps/server/src/kernel-next/runtime/stream-pump.ts | head -40
```

Confirm what signals stream-pump surfaces. Likely it calls `send(event)` on each AgentEvent — text / thinking / tool_use / tool_result / compact / cost. Writer hooks fire from the same loop.

If `pumpSdkStream` doesn't expose these events to the executor, extend its options with an `onActivity?: (ev: SdkActivityEvent) => void` callback. Inspect the file before deciding.

- [ ] **Step 3: Write failing RealStageExecutor integration test**

Append to `apps/server/src/kernel-next/runtime/real-executor.test.ts`:

```typescript
describe("RealStageExecutor sidecar integration", () => {
  it("writes an agent_execution_details row per attempt with populated prompt content", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);

    // Minimal IR with one agent stage.
    const ir: PipelineIR = {
      name: "p1",
      stages: [{
        name: "a",
        type: "agent",
        inputs: [],
        outputs: [{ name: "out", type: "string" }],
        config: { promptRef: "p1prompt" },
      }],
      wires: [],
    };

    // Seed pipeline + prompts.
    const svc = new KernelService(db, { skipTypeCheck: true });
    const res = svc.submit(ir, { prompts: { p1prompt: "hello" } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Construct a mock queryFn that sends no tool calls but produces a
    // clean result_success so the AgentMachine reaches `done`.
    const queryFn = () => (async function* () {
      yield { type: "system", subtype: "init", session_id: "test-session" } as const;
      yield {
        type: "result", subtype: "success", session_id: "test-session",
        total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 },
      } as const;
    })();

    const portRuntime = new PortRuntime(db);
    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({ }),
      model: "claude-haiku-4-5",
      queryFn: queryFn as typeof query,
      promptResolver: new DbPromptResolver(db, res.versionHash),
    });

    // Exec. MockStageExecutor-style no-op run (intentionally pared down;
    // actual kernel-run integration is covered by the run-submitted-pipeline
    // end-to-end tests).
    const result = await executor.executeStage({
      ir, stageName: "a", taskId: "tk", versionHash: res.versionHash,
      portValues: {}, handlers: {}, portRuntime,
    });

    expect(result.status).toMatch(/success|error/);
    const row = db.prepare(
      `SELECT * FROM agent_execution_details WHERE attempt_id = ?`,
    ).get(result.attemptId) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.prompt_ref).toBe("p1prompt");
    expect(row!.prompt_content).toBe("hello");
    expect(row!.model).toBe("claude-haiku-4-5");
    expect(row!.ended_at).not.toBeNull();
    expect(row!.termination_reason).toMatch(/natural_completion|error|interrupted/);
  });
});
```

Add imports at the top of real-executor.test.ts:

```typescript
import { DbPromptResolver } from "./db-prompt-resolver.js";
import { KernelService } from "../mcp/kernel.js";
```

Make sure `PortRuntime`, `PipelineIR`, `initKernelNextSchema`, `query` are already imported (they should be — other tests in the file use them).

- [ ] **Step 4: Run — FAIL**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/real-executor.test.ts 2>&1 | tail -25
```
Expected: new test fails (no row written yet — no integration).

- [ ] **Step 5: Integrate writer into RealStageExecutor.doAttempt**

In `apps/server/src/kernel-next/runtime/real-executor.ts`:

1. Add imports near the top:

```typescript
import { openExecutionRecordWriter, type ExecutionRecordWriter } from "./execution-record-writer.js";
import { promptContentHash } from "../ir/canonical.js";
```

2. In `doAttempt`, after the `portRuntime.startAttempt(...)` call (around line 167), open the writer:

```typescript
    // Sidecar: open execution record writer. Promise chain continues even
    // if this fails (writer returns no-op on FK violation).
    const agentStage = stage as AgentStage;
    const resolvedPrompt = this.promptResolver.resolve({
      stage: agentStage, taskId, attemptId, inputs: {},
    });
    const writer = openExecutionRecordWriter(portRuntime.getDb(), {
      attemptId,
      promptRef: agentStage.config.promptRef,
      promptContentHash: promptContentHash(resolvedPrompt),
      promptContent: resolvedPrompt,
      model: this.model,
      subAgents: agentStage.config.subAgents ?? null,
    });
```

3. The original `userPrompt = this.promptResolver.resolve(...)` call later in the function (at step 3 comment) should be replaced with `const userPrompt = resolvedPrompt;` to avoid double-resolution.

4. In the stream-pump consumption loop (inside the try block, around `adapter` usage), hook writer events. Two integration paths depending on stream-pump surface — try this minimal injection first:

Replace the `pumpSdkStream(...)` call with an extended version that observes activity:

```typescript
        agentOutput = await pumpSdkStream({
          stream: stream as AsyncIterable<SdkMessageLike>,
          adapter,
          send: (ev) => {
            // Sidecar hooks mirror agent machine events.
            if (ev.type === "ASSISTANT_TEXT") {
              writer.appendAgentStream({
                type: "text",
                text: ev.text,
                timestamp: new Date().toISOString(),
              });
            } else if (ev.type === "ASSISTANT_THINKING") {
              writer.appendAgentStream({
                type: "thinking",
                text: ev.text,
                timestamp: new Date().toISOString(),
              });
            } else if (ev.type === "TOOL_USE_REQUESTED") {
              writer.appendToolCall({
                id: ev.toolUseId,
                name: ev.name,
                input: ev.input,
                result: null,
                isError: false,
                tokenIn: null,
                tokenOut: null,
                durationMs: null,
                startedAt: new Date().toISOString(),
                finishedAt: null,
              });
            } else if (ev.type === "TOOL_RESULT_RECEIVED") {
              writer.completeToolCall(ev.toolUseId, {
                result: ev.result,
                isError: ev.isError ?? false,
                finishedAt: new Date().toISOString(),
              });
            }
            agentActor.send(ev);
          },
          waitForFinal: async () => {
            const finalSnap = await waitFor(
              agentActor,
              (s) => s.status === "done",
              { timeout: 5_000 },
            );
            return finalSnap.output as AgentMachineOutput;
          },
        });
```

The exact event type names (`ASSISTANT_TEXT`, `TOOL_USE_REQUESTED` etc.) depend on what `sdk-adapter.ts` emits. Verify by reading `apps/server/src/kernel-next/runtime/sdk-adapter.ts`. If names differ, adjust to match — the principle is: one writer call per SDK event type.

5. Compute cost + session_id at end. Look at `agentOutput` for final cost / session_id. Inject into close:

After the existing `agentOutput.status` check and before `return { attemptId, attemptIdx, status: ... }`, call writer.close:

```typescript
      // Close writer with final cost + session info from agentOutput.
      const terminationReason: TerminationReason =
        agentOutput.status === "done" ? "natural_completion"
        : agentOutput.status === "interrupted" ? "interrupted"
        : "error";
      writer.close({
        terminationReason,
        costUsd: agentOutput.totalCostUsd ?? null,
        tokenInput: agentOutput.tokenInput ?? null,
        tokenOutput: agentOutput.tokenOutput ?? null,
        sessionId: agentOutput.sessionId ?? null,
      });
```

`TerminationReason` type import:

```typescript
import type { TerminationReason } from "./execution-record-types.js";
```

Field names on `agentOutput` may differ (`cost`, `usage.input_tokens`, etc.). Inspect `AgentMachineOutput` type and map accordingly. If a field doesn't exist, pass `null`.

6. On the catch / error path after the try block, also close the writer:

```typescript
    } catch (err) {
      writer.close({ terminationReason: "error" });
      // ...existing error-handling code...
    }
```

- [ ] **Step 6: Run — PASS**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/kernel-next/runtime/real-executor.test.ts 2>&1 | tail -10
```
Expected: all real-executor tests pass including the new sidecar one. The existing tests should not regress — writer is side-effect only.

- [ ] **Step 7: Broader regression**

```bash
./node_modules/.bin/vitest run src/kernel-next 2>&1 | tail -5
./node_modules/.bin/tsc --noEmit 2>&1 | tail -5
```
Expected: 0 failures / 0 errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/port-runtime.ts apps/server/src/kernel-next/runtime/real-executor.ts apps/server/src/kernel-next/runtime/real-executor.test.ts && git commit -m "feat(sidecar): RealStageExecutor opens + feeds + closes writer per attempt

Each agent-stage attempt gets one agent_execution_details row. Writer
observes SDK adapter events (text, thinking, tool_use, tool_result) and
close captures termination_reason + cost/tokens + session_id. PortRuntime
exposes getDb() so writer can access the shared kernel-next.db handle.

Test delta: +1
tsc: 0 errors"
```

---

## Task 4: Migrate debug-queries to new table

**Files:**
- Modify: `apps/server/src/lib/debug-queries.ts`
- Modify: `apps/server/src/lib/debug-queries.test.ts`

- [ ] **Step 1: Read current shape**

```bash
grep -n "export\|function\|interface\|type" /Users/minghao/workflow-control/apps/server/src/lib/debug-queries.ts | head -25
```

Record the public function names. They must keep the same signatures (callers in `lib/debug-mcp.ts` + `cli/debug.ts` depend on them).

- [ ] **Step 2: Read current test to understand shape expectations**

```bash
head -120 /Users/minghao/workflow-control/apps/server/src/lib/debug-queries.test.ts
```

Note the fixtures — rows seeded into `execution_records`. These convert to seeded `stage_attempts` + `agent_execution_details` + `port_values` in kernel-next.db.

- [ ] **Step 3: Rewrite debug-queries.ts**

Replace the content of `apps/server/src/lib/debug-queries.ts` with logic that:

1. Imports `getKernelNextDb` from `./kernel-next-db.js` (instead of `./db.js`).
2. All SQL queries target `stage_attempts sa LEFT JOIN agent_execution_details aed ON aed.attempt_id = sa.attempt_id` + optional `LEFT JOIN port_values pv ON pv.attempt_id = sa.attempt_id`.
3. Return shapes preserve public fields but with legacy-only fields (`worktree_diff`, `scratch_pad_snapshot`, `writes_parsed`, `writes_committed`) removed OR optional-undefined.

Because the exact return shape depends on current consumers, adapt conservatively:

- `getTaskAttempts(taskId)`: return `Array<{ attemptId, stageName, attemptIdx, startedAt, endedAt?, status, costUsd?, tokenInput?, tokenOutput? }>` — derive from `stage_attempts` + optional JOIN to `agent_execution_details`.
- `getStageExecutionRecord(taskId, stageName, attempt)`: return one row with all fields from both tables, prompts array from `aed.agent_stream_json` / `aed.tool_calls_json`.
- `analyzeTaskFailure(taskId)`: scan attempts with `sa.status = 'error'`, pull `aed.agent_stream_json` for last message, return `{ failureCount, lastError: string | null, taskId }`.
- `listTaskRecords(taskId)`: same as `getTaskAttempts` (retain alias if callers use it).
- `diffExecutions(recordIdA, recordIdB)`: where `recordId` is `attemptId`, diff `tool_calls_json` + `agent_stream_json` + `cost_usd`.

**Because the rewrite touches 150+ lines**, delegating to a subagent for implementation is fine — but the public-facing signature list must stay stable. Capture the list first:

```bash
grep -n "^export " /Users/minghao/workflow-control/apps/server/src/lib/debug-queries.ts
```

For each exported function: keep name + first argument signature identical. The return type may add optional fields or remove fields that no longer exist; changes must be minimal.

- [ ] **Step 4: Rewrite debug-queries.test.ts**

Replace the `execution_records` seeding with kernel-next seeding:

```typescript
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPromptContent } from "../kernel-next/ir/sql.js";
import { __setKernelNextDbForTest } from "./kernel-next-db.js";
// ...and the functions under test.

function seed(db: DatabaseSync, taskId: string, attempts: Array<{
  attemptId: string;
  stageName: string;
  attemptIdx: number;
  status: "running" | "success" | "error" | "superseded";
  promptRef?: string;
  promptContent?: string;
  toolCalls?: unknown[];
  agentStream?: unknown[];
  costUsd?: number | null;
  terminationReason?: "natural_completion" | "interrupted" | "error" | "superseded" | null;
}>) {
  db.prepare(
    `INSERT OR IGNORE INTO pipeline_versions (version_hash, pipeline_name, created_at, parent_hash, ir_json, ts_source)
     VALUES ('v-test', 't', 0, NULL, '{}', '')`,
  ).run();
  for (const a of attempts) {
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, ended_at, status)
       VALUES (?, ?, 'v-test', ?, ?, 0, 1, ?)`,
    ).run(a.attemptId, taskId, a.stageName, a.attemptIdx, a.status);
    if (a.promptContent) {
      insertPromptContent(db, "hash-" + a.attemptId, a.promptContent);
      db.prepare(
        `INSERT INTO agent_execution_details
         (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model,
          tool_calls_json, agent_stream_json, cost_usd,
          started_at, ended_at, termination_reason, last_heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, 1)`,
      ).run(
        a.attemptId,
        a.promptRef ?? "r",
        "hash-" + a.attemptId,
        a.promptContent,
        "m",
        JSON.stringify(a.toolCalls ?? []),
        JSON.stringify(a.agentStream ?? []),
        a.costUsd ?? null,
        a.terminationReason ?? null,
      );
    }
  }
}

describe("debug-queries on agent_execution_details", () => {
  it("getTaskAttempts returns attempts for a task", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    __setKernelNextDbForTest(db);
    try {
      seed(db, "t1", [
        { attemptId: "a1", stageName: "s1", attemptIdx: 1, status: "success",
          promptContent: "hello" },
        { attemptId: "a2", stageName: "s2", attemptIdx: 1, status: "error",
          promptContent: "world", terminationReason: "error" },
      ]);
      const rows = getTaskAttempts("t1");
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.attemptId).sort()).toEqual(["a1", "a2"]);
    } finally {
      __setKernelNextDbForTest(undefined);
    }
  });

  // Add parallel tests for getStageExecutionRecord, analyzeTaskFailure,
  // listTaskRecords, diffExecutions — same pattern, different assertions.
});
```

**Note**: The above is a scaffold. Full test coverage must match or exceed the pre-migration test count. If the existing test has `N` cases, migrate all `N` (replacing seeds and DB target, keeping assertion intent).

- [ ] **Step 5: Run debug-queries tests**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run src/lib/debug-queries.test.ts 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 6: Verify debug-mcp.ts + cli/debug.ts compile**

These call `debug-queries` functions. If signatures shifted, they'll fail tsc:

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | tail -20
```

If any breakage — update the 2 callers' types, keeping behavior.

- [ ] **Step 7: Full regression**

```bash
./node_modules/.bin/vitest run 2>&1 | tail -3
```
Expected: 0 failures.

- [ ] **Step 8: Commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/server/src/lib apps/server/src/cli && git commit -m "feat(sidecar): migrate debug-queries to kernel-next.db + agent_execution_details

Debug tools now read from kernel-next.db, joining stage_attempts +
agent_execution_details. Public function names preserved; returned
shapes drop legacy-only fields (worktree_diff, scratch_pad_snapshot,
writes_parsed/committed).

Test delta: <record>
tsc: 0 errors"
```

---

## Task 5: Delete legacy `lib/execution-record/` + `execution_records` DDL

**Files:**
- Delete: `apps/server/src/lib/execution-record/` (entire directory — 7 files)
- Modify: `apps/server/src/lib/db.ts`

- [ ] **Step 1: Confirm no remaining consumers of lib/execution-record/**

```bash
cd /Users/minghao/workflow-control/apps/server/src
grep -rn 'from "\.\./execution-record\|from "\./execution-record\|from ".*lib/execution-record' . --include='*.ts' 2>/dev/null | head
```
Expected: zero hits (all consumers deleted in Stage 4a; new sidecar is in kernel-next/runtime/).

- [ ] **Step 2: Delete the legacy module directory**

```bash
cd /Users/minghao/workflow-control
git rm -r apps/server/src/lib/execution-record/
```

- [ ] **Step 3: Remove legacy `execution_records` table from lib/db.ts**

Read:
```bash
grep -n 'execution_records' /Users/minghao/workflow-control/apps/server/src/lib/db.ts
```

Two blocks to remove:

1. The `CREATE TABLE IF NOT EXISTS execution_records (...)` block plus its 4 CREATE INDEX statements.

2. The schema-drift PRAGMA check block that warns about missing columns (around line 160-170 per initial audit).

Use the Edit tool to remove exact strings.

- [ ] **Step 4: Audit if lib/db.ts is now empty or orphan**

```bash
cat /Users/minghao/workflow-control/apps/server/src/lib/db.ts
```

If after removing `execution_records` the file still has meaningful content (other tables like `sse_messages`, `pending_questions` — note: Stage 4a deleted many, audit what remains), keep it.

If file is essentially empty or has only unreachable helpers, delete it:

```bash
# Only if the file is effectively dead:
grep -rn 'from ".*lib/db"' /Users/minghao/workflow-control/apps/server/src 2>/dev/null | head
```

If zero imports besides test files you're about to remove → `git rm apps/server/src/lib/db.ts apps/server/src/lib/db.test.ts` too.

Be conservative: if in doubt, leave it alone. A stale but zero-consumer file is low cost.

- [ ] **Step 5: tsc + vitest gate**

```bash
cd /Users/minghao/workflow-control/apps/server
./node_modules/.bin/tsc --noEmit 2>&1 | tail -10
./node_modules/.bin/vitest run 2>&1 | tail -5
```
Expected: 0 errors / 0 failures. Test count drops by the ~15 tests in the deleted execution-record module + its tests.

- [ ] **Step 6: Residual grep**

```bash
cd /Users/minghao/workflow-control/apps/server/src
grep -rn 'execution_records\b\|ExecutionRecordWriter\|lib/execution-record' . --include='*.ts' 2>/dev/null | head
```
Expected: zero hits in active code.

- [ ] **Step 7: Commit**

```bash
cd /Users/minghao/workflow-control && git add -A apps/server/src/lib && git commit -m "chore(sidecar): delete legacy lib/execution-record/ + execution_records DDL

The legacy module's only purpose was a writer for workflow.db.execution_records,
which had zero producers post-Stage 4a. Sidecar responsibility now lives
entirely in kernel-next/runtime/execution-record-writer.ts. Related DDL
block + schema-drift warning removed from lib/db.ts.

Test delta: <record>
tsc: 0 errors"
```

---

## Task 6: Docs + handoff

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/product-roadmap.md`
- Rewrite: `docs/execution-record-design.md`
- Create: `docs/superpowers/plans/2026-04-24-execution-record-sidecar-done-handoff.md`

- [ ] **Step 1: CLAUDE.md — append retired bullet**

Locate the existing `## Retired areas` section (appended in Stage 4a and extended in Stage 4b). Add one more bullet:

```
- `apps/server/src/lib/execution-record/` — legacy execution-record writer module (deleted 2026-04-24 Stage 6). kernel-next now writes `agent_execution_details` in kernel-next.db via `kernel-next/runtime/execution-record-writer.ts`.
```

- [ ] **Step 2: product-roadmap.md — update A1 status**

Find Phase 1 / A1 section (line ~143 per initial scan). Add a status marker at the end of the A1 §6.1 block:

```
**Status (2026-04-24 Stage 6)**: kernel-next-adapted A1 landed. Sidecar
table `agent_execution_details` in kernel-next.db captures per-attempt
prompt + tool calls + agent stream + cost + lifecycle. Legacy `workflow.db.execution_records`
table + `lib/execution-record/` module deleted. `worktree_diff` +
`scratch_pad_snapshot` not captured (deferred).
```

Add 修订历史 row:
```markdown
| 2026-04-24 | 1.4 | Stage 6 完成：kernel-next sidecar (agent_execution_details) 落地；legacy execution-record 模块删除。AI 自诊断数据源对齐。|
```

- [ ] **Step 3: Rewrite execution-record-design.md**

Replace `docs/execution-record-design.md` with a kernel-next-native version. Full new content:

```markdown
# ExecutionRecord Design (kernel-next)

> **Status:** Landed 2026-04-24 (Stage 6 milestone).
> **Replaces:** The earlier legacy-engine-targeted version of this document.
> **Spec:** `docs/superpowers/specs/2026-04-24-execution-record-sidecar-design.md`

## 1. Purpose

Capture what a kernel-next agent stage actually did during an attempt:
the full prompt it saw, the tool calls it made, the text and thinking
it emitted, the cost and tokens consumed, and the lifecycle timing.
This data grounds AI self-diagnosis (`analyze_task_failure`) and
hot-update proposals.

## 2. Where the data lives

Table `agent_execution_details` in `{data_dir}/kernel-next.db`. One row
per agent-stage attempt. `attempt_id` is PK + FK to `stage_attempts`.

Script stages, gate stages, fanout_aggregate attempts, and `__external__`
seeds do NOT write to this table; only agent executors do.

## 3. Fields

| Column | Type | Meaning |
|---|---|---|
| attempt_id | TEXT PK | FK to stage_attempts.attempt_id (ON DELETE RESTRICT) |
| prompt_ref | TEXT | Same as AgentStage.config.promptRef at exec time |
| prompt_content_hash | TEXT | FK to prompt_contents.content_hash |
| prompt_content | TEXT | Duplicated from prompt_contents so row is self-contained |
| model | TEXT | e.g. "claude-haiku-4-5" |
| sub_agents_json | TEXT? | JSON of AgentStage.config.subAgents if present |
| tool_calls_json | TEXT | JSON array of ToolCallRecord |
| agent_stream_json | TEXT | JSON array of {type: text\|thinking, text, timestamp} |
| cost_usd, token_input, token_output | REAL/INT | End-of-run totals |
| session_id | TEXT? | Claude SDK session identifier |
| duration_ms | INT | ended_at - started_at |
| started_at, ended_at | INT ms | Wall clock |
| termination_reason | TEXT? | one of: natural_completion, interrupted, error, superseded |
| last_heartbeat_at | INT ms | For orphan reaper (future) |

## 4. Lifecycle

1. RealStageExecutor.doAttempt calls portRuntime.startAttempt(...) → stage_attempts row inserted.
2. RealStageExecutor opens the writer → agent_execution_details row INSERT.
3. SDK stream events map to writer calls:
   - ASSISTANT_TEXT / ASSISTANT_THINKING → appendAgentStream
   - TOOL_USE_REQUESTED → appendToolCall
   - TOOL_RESULT_RECEIVED → completeToolCall(id, patch)
   - Cost/usage updates → updateCost
4. Writer debounces DB flushes at 1Hz.
5. On stage exit: writer.close(terminationReason, cost, tokens, sessionId) → final UPDATE with ended_at + duration_ms + termination_reason.

Writer never throws. On FK violation (stage_attempts row missing) or
runtime error, writer logs a warning and degrades to a no-op. Executor
path is never blocked.

## 5. Derived views

Fields NOT stored because they're derivable from other tables:
- `writes_parsed`: extract `{name: "write_port"}` tool_use entries from tool_calls_json.
- `writes_committed`: query port_values where attempt_id = ? and direction = 'out'.
- Wire reads at stage entry: query port_values where attempt_id = ? and direction = 'in'.

## 6. Not captured (out of scope for Stage 6)

- `worktree_diff` — requires stage-boundary git checkpoint infrastructure (future milestone).
- `scratch_pad_snapshot` / PreCompact events — legacy single-session concept; kernel-next defaults multi-session per stage.
- Intermediate retries that runner abandons: writer.close({terminationReason: "superseded"}) is intended but currently only fires on the outermost retry-rebuild path (C5). Intra-stage retries (maxRetries within doAttempt) overwrite the writer instance without explicit supersede close — that attempt's row stays open with ended_at=null until orphan reaper (future) sweeps it.

## 7. Relationship to SSE

kernel-next's SSE broadcaster continues to emit real-time events on top
of the same pipeline execution. Sidecar writes are independent — one
consumer of raw executor events writes to `agent_execution_details`, the
other publishes to subscribers. Both survive the same flush discipline.

## 8. Access patterns

Primary consumers:
- `lib/debug-queries.ts` → `analyze_task_failure` / `get_stage_execution_record` / `list_task_records` / `diff_executions`.
- `lib/debug-mcp.ts` exposes those via SDK MCP tools for in-pipeline self-diagnosis.
- `cli/debug.ts` exposes them to the CLI for human debugging.

All three use kernel-next.db + JOIN with stage_attempts + optional JOIN with port_values.

## 9. Pruning

No automatic GC. Operators delete old task data manually:

```sql
DELETE FROM agent_execution_details
WHERE attempt_id IN (
  SELECT attempt_id FROM stage_attempts WHERE task_id = ?
);
-- Then delete stage_attempts + port_values rows for the task.
```

Future milestone may add a CLI helper.
```

- [ ] **Step 4: Create done-handoff**

Create `docs/superpowers/plans/2026-04-24-execution-record-sidecar-done-handoff.md`:

```markdown
# Stage 6 — Execution Record Sidecar — Completion Handoff

Date: 2026-04-24
Branch: main

## Milestone results

6 sequential commits:

| Task | SHA | Subject |
|---|---|---|
| 1 | TBD | agent_execution_details DDL |
| 2 | TBD | execution-record-writer module |
| 3 | TBD | RealStageExecutor integration |
| 4 | TBD | debug-queries migrated to kernel-next |
| 5 | TBD | delete legacy lib/execution-record/ + execution_records DDL |
| 6 | TBD (this commit) | docs + handoff |

Fill TBDs from `git log --oneline` after each task lands.

## What changed

**New:**
- Table `agent_execution_details` in kernel-next.db with FK to stage_attempts + prompt_contents.
- Module `kernel-next/runtime/execution-record-writer.ts` + types.
- RealStageExecutor writes one row per attempt (open + buffered flush + close).

**Deleted:**
- `apps/server/src/lib/execution-record/` (7 files: writer, types, build-prompt-blob, workflow-version + tests).
- `CREATE TABLE execution_records` + 4 indexes + schema-drift check in `lib/db.ts`.

**Migrated:**
- `lib/debug-queries.ts` + tests — now joins stage_attempts + agent_execution_details in kernel-next.db.
- `lib/debug-mcp.ts` — no-op (passes through).
- `cli/debug.ts` — no-op.

## Not in scope

- `worktree_diff` column — requires checkpoint infra (separate milestone).
- `scratch_pad_snapshot` — kernel-next multi-session default, not needed.
- `script_execution_details` sidecar — no user-authored script stages yet.
- Orphan reaper CLI — manual cleanup for now.
- Enhanced analyze_task_failure logic — signature preserved only.

## Test deltas

| Phase | Tests passed | Delta |
|---|---|---|
| Baseline (post Stage 4b) | 1499 | — |
| Task 1 | TBD | +3 |
| Task 2 | TBD | +7 |
| Task 3 | TBD | +1 |
| Task 4 | TBD | varies (rewrites + 1) |
| Task 5 | TBD | −15 (legacy module tests) |
| Task 6 | TBD | 0 |

Fill TBDs.

## Invariants preserved

- Server `tsc --noEmit` 0 errors at every task.
- Server `vitest run` 0 failures at every task.
- Web `tsc --noEmit` 0 errors (no web touches).
- kernel-next runtime behavior unchanged outside RealStageExecutor (writer is side-effect only).
- All 4 builtin pipelines still register + seed correctly.

## Follow-ups

- Stage 5: B-series hot-update productionization.
- worktree_diff capture once git checkpoint infra arrives.
- script_execution_details table if/when user authors a script stage.
- Orphan reaper + CLI for sidecar row cleanup.
- Enhanced analyze_task_failure logic that uses tool_calls_json / agent_stream_json.
```

- [ ] **Step 5: Commit docs**

```bash
cd /Users/minghao/workflow-control && git add CLAUDE.md docs/ && git commit -m "docs(sidecar): update CLAUDE.md, roadmap, design doc, handoff

- CLAUDE.md Retired areas: append lib/execution-record/ deletion
- docs/product-roadmap.md §6.1: A1 status landed + v1.4 修订历史
- docs/execution-record-design.md rewritten for kernel-next
- docs/superpowers/plans/2026-04-24-execution-record-sidecar-done-handoff.md created"
```

- [ ] **Step 6: Fill TBDs + amend**

After this commit lands, populate SHAs into the handoff:

```bash
cd /Users/minghao/workflow-control
git log --oneline -7
```

Edit the handoff's SHA columns with real values. If that leaves Task 6 row blank (self-reference), use the SHA of the commit you just amended.

```bash
git add docs/superpowers/plans/2026-04-24-execution-record-sidecar-done-handoff.md
git commit --amend --no-edit
```

---

## Task 7: Final verification

- [ ] **Step 1: Full server test**

```bash
cd /Users/minghao/workflow-control/apps/server && ./node_modules/.bin/vitest run 2>&1 | tail -5
```
Record counts.

- [ ] **Step 2: Server tsc**

```bash
./node_modules/.bin/tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Web tsc**

```bash
cd /Users/minghao/workflow-control/apps/web && ./node_modules/.bin/tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: Residual grep**

```bash
cd /Users/minghao/workflow-control/apps/server/src
grep -rn 'lib/execution-record\|execution_records\b\|ExecutionRecordWriter' . --include='*.ts' 2>/dev/null | head
```
Expected: zero hits (possibly a comment-only reference describing what was replaced; that's acceptable).

- [ ] **Step 5: Manual smoke (optional)**

Start dev server, POST smoke-test run, verify:

```bash
sqlite3 /tmp/workflow-control-data/kernel-next.db "SELECT COUNT(*) FROM agent_execution_details"
```
Expected: > 0 after a run.

```bash
sqlite3 /tmp/workflow-control-data/kernel-next.db "SELECT attempt_id, prompt_ref, model, termination_reason, duration_ms FROM agent_execution_details ORDER BY started_at DESC LIMIT 5"
```

- [ ] **Step 6: No code change. No commit.**

---

## Self-Review

**1. Spec coverage:**

| Spec SC | Task |
|---|---|
| SC 1 new DDL | Task 1 |
| SC 2 writer integration | Task 3 |
| SC 3 writer module | Task 2 |
| SC 4 legacy execution_records deletion | Task 5 |
| SC 5 debug tools migration | Task 4 |
| SC 6 no feature flag | Writer is always on (Task 2 code never reads env) |
| SC 7 no worktree_diff | Out of scope; docs note it |
| SC 8 no scratch_pad | Out of scope; docs note it |
| SC 9 manual E2E | Task 7 Step 5 |
| SC 10 tsc + vitest green | Every task gate + Task 7 |

**2. Placeholder scan:** Zero "TBD / TODO / implement later" in the body. Handoff doc placeholder TBDs get filled by Task 6 Step 6.

**3. Type consistency:**

- `ExecutionRecordWriter` interface shape consistent Task 2 → Task 3.
- `TerminationReason` values match DDL CHECK + test expectations.
- `agent_execution_details` column names consistent Task 1 (DDL) → Task 2 (writer SQL) → Task 4 (query SQL).
- `portRuntime.getDb()` added in Task 3 Step 1, consumed in Task 3 Step 5.
- Public debug-queries function signatures preserved Task 4 (exact names read from existing file before editing).
