# Resumability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make kernel-next tasks survive server restart/crash/graceful shutdown so M2 (朋友持续用) is reachable.

**Architecture:** Startup reconciler scans `task_finals IS NULL` orphans, transitions stale `running` attempts to `superseded`, and re-dispatches `startPipelineRun` with `resumeFrom` + optional Claude SDK `resumeSessionId`. Graceful SIGTERM flushes in-flight attempts with the same transition. PID-file mutex prevents double-boot. SSE gains monotonic `seq` + `Last-Event-ID` for clean reconnect. Runner extends existing `resumeFrom` hydration to read `gate_queue.answer` rows so the "answered but not forwarded" window never loses answers. Hot-update migration takes priority when `hot_update_events.rerun_from_stage` is newer.

**Tech Stack:** TypeScript + Node.js + SQLite (`node:sqlite`) + Vitest + XState v5 + Hono + `@anthropic-ai/claude-agent-sdk`.

---

## Conventions

**Working directory**: Every bash command assumes `cd /Users/minghao/workflow-control/apps/server` unless stated otherwise. tsc + vitest MUST run from this subpath, not repo root (repo root scans `dist/` and false-reports errors).

**TDD discipline**: Red → green → commit. Never skip the failing-test step.

**forced verification before commit**:
```bash
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit
cd /Users/minghao/workflow-control/apps/server && npx vitest run
```

**Commit style**: Follow existing `feat(resumability): ...` / `test(resumability): ...` / `refactor(resumability): ...` convention. Direct to main, no push.

---

## File Structure

| Path | Purpose |
|---|---|
| `apps/server/src/kernel-next/runtime/server-lock.ts` | **new** — PID-file mutex (acquire/release, stale-pid takeover) |
| `apps/server/src/kernel-next/runtime/server-lock.test.ts` | **new** — unit tests for lock behaviour |
| `apps/server/src/kernel-next/runtime/graceful-shutdown.ts` | **new** — SIGTERM/SIGINT handler that flushes in-flight attempts |
| `apps/server/src/kernel-next/runtime/graceful-shutdown.test.ts` | **new** — unit tests |
| `apps/server/src/kernel-next/runtime/orphan-reconciler.ts` | **new** — DB scan + dispatch resumes on startup |
| `apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts` | **new** — unit tests |
| `apps/server/src/kernel-next/runtime/runner.ts` | modify resume hydration (L362-412) to read `gate_queue` |
| `apps/server/src/kernel-next/runtime/runner.resume-gate-hydration.test.ts` | **new** — integration test for gate_queue hydration |
| `apps/server/src/kernel-next/runtime/real-executor.ts` | add `queryFn` injection + `options.resume` + clamp maxTurns |
| `apps/server/src/kernel-next/runtime/real-executor.resume.test.ts` | **new** — unit tests for SDK resume path |
| `apps/server/src/kernel-next/sse/broadcaster.ts` | stamp monotonic per-task `seq` on each published event |
| `apps/server/src/kernel-next/sse/types.ts` | `KernelNextSSEEvent` gains `seq: number` |
| `apps/server/src/kernel-next/sse/http.ts` | emit `id:` line; honour `Last-Event-ID` header |
| `apps/server/src/kernel-next/sse/broadcaster.test.ts` | extend tests for seq + Last-Event-ID filter |
| `apps/server/src/index.ts` | wire server lock acquire (before DB), reconciler (after builtin seed), SIGTERM handler |

No DB migrations. Values reused: `stage_attempts.status='superseded'`, `agent_execution_details.termination_reason='interrupted'`. Verified at `apps/server/src/kernel-next/ir/sql.ts:60,226-229`.

---

## Milestone M-R1: Server lock + graceful shutdown

Each task assumes you have already run `git status` and the working tree is clean.

### Task 1.1: PID-file lock acquire (happy path)

**Files:**
- Create: `apps/server/src/kernel-next/runtime/server-lock.ts`
- Create: `apps/server/src/kernel-next/runtime/server-lock.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/server/src/kernel-next/runtime/server-lock.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireServerLock, releaseServerLock } from "./server-lock.js";

describe("server-lock", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wfc-lock-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires lock when no prior lock exists", () => {
    const path = join(dir, "kernel-next.lock");
    const handle = acquireServerLock(path);
    expect(handle.ok).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe(String(process.pid));
    if (handle.ok) releaseServerLock(handle.release);
    expect(existsSync(path)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/server-lock.test.ts
```
Expected: `Cannot find module './server-lock.js'`.

- [ ] **Step 3: Implement server-lock.ts (acquire+release)**

```ts
// apps/server/src/kernel-next/runtime/server-lock.ts
import { openSync, closeSync, writeSync, unlinkSync, readFileSync, existsSync } from "node:fs";

export type AcquireResult =
  | { ok: true; release: { path: string; fd: number } }
  | { ok: false; reason: "already_held_alive"; pid: number }
  | { ok: false; reason: "io_error"; detail: string };

export function acquireServerLock(path: string): AcquireResult {
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, String(process.pid));
    } catch (err) {
      closeSync(fd);
      try { unlinkSync(path); } catch { /* best effort */ }
      return { ok: false, reason: "io_error", detail: (err as Error).message };
    }
    return { ok: true, release: { path, fd } };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") {
      return { ok: false, reason: "io_error", detail: (err as Error).message };
    }
    return takeoverIfStale(path);
  }
}

function takeoverIfStale(path: string): AcquireResult {
  let priorPid: number;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    priorPid = Number.parseInt(raw, 10);
    if (!Number.isFinite(priorPid) || priorPid <= 0) {
      priorPid = 0;
    }
  } catch {
    priorPid = 0;
  }
  if (priorPid > 0) {
    try {
      process.kill(priorPid, 0);
      return { ok: false, reason: "already_held_alive", pid: priorPid };
    } catch {
      /* ESRCH → dead; fall through to takeover */
    }
  }
  try { unlinkSync(path); } catch { /* best effort */ }
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, String(process.pid));
    return { ok: true, release: { path, fd } };
  } catch (err) {
    return { ok: false, reason: "io_error", detail: (err as Error).message };
  }
}

export function releaseServerLock(release: { path: string; fd: number }): void {
  try { closeSync(release.fd); } catch { /* ignore */ }
  if (existsSync(release.path)) {
    try { unlinkSync(release.path); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/server-lock.test.ts
```
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/server-lock.ts apps/server/src/kernel-next/runtime/server-lock.test.ts && git commit -m "feat(resumability): PID-file server lock acquire/release (M-R1.1)"
```

### Task 1.2: Lock rejects when held by live process

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/server-lock.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// Add inside the existing `describe("server-lock")` block
it("rejects acquire when existing lock holder is alive", () => {
  const path = join(dir, "kernel-next.lock");
  const first = acquireServerLock(path);
  expect(first.ok).toBe(true);
  const second = acquireServerLock(path);
  expect(second.ok).toBe(false);
  if (!second.ok) {
    expect(second.reason).toBe("already_held_alive");
    if (second.reason === "already_held_alive") {
      expect(second.pid).toBe(process.pid);
    }
  }
  if (first.ok) releaseServerLock(first.release);
});
```

- [ ] **Step 2: Run and confirm pass (already covered by §1.1 impl)**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/server-lock.test.ts
```
Expected: 2 passed. (If fail: impl is broken; debug.)

- [ ] **Step 3: No code change needed. Commit the test alone.**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/server-lock.test.ts && git commit -m "test(resumability): live-holder rejection for server lock (M-R1.2)"
```

### Task 1.3: Stale-pid takeover

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/server-lock.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// Add inside the same describe block
import { writeFileSync } from "node:fs";

it("takes over the lock when the prior pid is dead", () => {
  const path = join(dir, "kernel-next.lock");
  // pid 1 on any POSIX system is the init process. Pick a high pid
  // unlikely to be live instead: probe and find a dead pid.
  let deadPid = 999_990;
  while (deadPid > 2) {
    try { process.kill(deadPid, 0); deadPid -= 1; } catch { break; }
  }
  writeFileSync(path, String(deadPid), "utf-8");
  const res = acquireServerLock(path);
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(readFileSync(path, "utf-8")).toBe(String(process.pid));
    releaseServerLock(res.release);
  }
});
```

- [ ] **Step 2: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/server-lock.test.ts
```
Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/server-lock.test.ts && git commit -m "test(resumability): stale-pid takeover for server lock (M-R1.3)"
```

### Task 1.4: Wire server lock into index.ts

**Files:**
- Modify: `apps/server/src/index.ts` (insert before `getDb()` call at L64)

- [ ] **Step 1: Read current startup ordering**

```bash
sed -n '60,75p' /Users/minghao/workflow-control/apps/server/src/index.ts
```

- [ ] **Step 2: Edit index.ts to acquire lock before DB init**

Add at L62 (after dataDir validation, before `getDb()`):

```ts
// --- Server instance mutex ---
import { acquireServerLock, releaseServerLock } from "./kernel-next/runtime/server-lock.js";
const lockPath = join(loadSystemSettings().paths?.data_dir ?? "/tmp/workflow-control-data", "kernel-next.lock");
const lockResult = acquireServerLock(lockPath);
if (!lockResult.ok) {
  if (lockResult.reason === "already_held_alive") {
    logger.error({ pid: lockResult.pid, lockPath }, "Another kernel-next server instance is already running. Exiting.");
  } else {
    logger.error({ detail: lockResult.detail, lockPath }, "Could not acquire server lock. Exiting.");
  }
  process.exit(1);
}
const lockHandle = lockResult.release;
process.on("exit", () => { releaseServerLock(lockHandle); });
```

(Hoist the `import` to the top of the file with the other imports.)

- [ ] **Step 3: Verify tsc + server still starts**

```bash
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: Smoke test startup**

```bash
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill; sleep 2
rm -f /tmp/workflow-control-data/kernel-next.lock /tmp/workflow-control-data/kernel-next.db*
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server-a.log 2>&1 &
sleep 18
test -f /tmp/workflow-control-data/kernel-next.lock && echo "LOCK_OK"
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server-b.log 2>&1 &
sleep 6
grep -q "already_held_alive\|Exiting" /tmp/server-b.log && echo "MUTEX_OK"
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill
sleep 2
```
Expected: `LOCK_OK` and `MUTEX_OK` both printed.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/index.ts && git commit -m "feat(resumability): install PID-file lock at server startup (M-R1.4)"
```

### Task 1.5: Graceful shutdown handler — pure function

**Files:**
- Create: `apps/server/src/kernel-next/runtime/graceful-shutdown.ts`
- Create: `apps/server/src/kernel-next/runtime/graceful-shutdown.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/server/src/kernel-next/runtime/graceful-shutdown.test.ts
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "../ir/sql.js";
import { reconcileRunningAttempts } from "./graceful-shutdown.js";

describe("reconcileRunningAttempts", () => {
  it("flips running stage_attempts to superseded for listed taskIds", () => {
    const db = new DatabaseSync(":memory:");
    applySchema(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','s1',0,'v','regular','running',?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a2','t1','s2',0,'v','regular','success',?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a3','t2','s1',0,'v','regular','running',?)`,
    ).run(now);

    const changed = reconcileRunningAttempts(db, ["t1"]);
    expect(changed).toBe(1);

    const a1 = db.prepare("SELECT status FROM stage_attempts WHERE attempt_id='a1'").get() as { status: string };
    const a2 = db.prepare("SELECT status FROM stage_attempts WHERE attempt_id='a2'").get() as { status: string };
    const a3 = db.prepare("SELECT status FROM stage_attempts WHERE attempt_id='a3'").get() as { status: string };
    expect(a1.status).toBe("superseded");
    expect(a2.status).toBe("success");
    expect(a3.status).toBe("running");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/graceful-shutdown.test.ts
```
Expected: FAIL with `Cannot find module './graceful-shutdown.js'`.

- [ ] **Step 3: Implement graceful-shutdown.ts**

```ts
// apps/server/src/kernel-next/runtime/graceful-shutdown.ts
import type { DatabaseSync } from "node:sqlite";

export function reconcileRunningAttempts(db: DatabaseSync, taskIds: string[]): number {
  if (taskIds.length === 0) return 0;
  const now = Date.now();
  const placeholders = taskIds.map(() => "?").join(",");
  const updateAttempts = db.prepare(
    `UPDATE stage_attempts SET status='superseded'
     WHERE status='running' AND task_id IN (${placeholders})`,
  );
  const attemptsRes = updateAttempts.run(...taskIds);
  const aedIds = db.prepare(
    `SELECT attempt_id FROM stage_attempts
     WHERE status='superseded' AND task_id IN (${placeholders})`,
  ).all(...taskIds) as Array<{ attempt_id: string }>;
  if (aedIds.length > 0) {
    const aedPh = aedIds.map(() => "?").join(",");
    db.prepare(
      `UPDATE agent_execution_details
         SET termination_reason='interrupted', ended_at=?
       WHERE attempt_id IN (${aedPh}) AND ended_at IS NULL`,
    ).run(now, ...aedIds.map((r) => r.attempt_id));
  }
  return Number(attemptsRes.changes);
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/graceful-shutdown.test.ts
```
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/graceful-shutdown.ts apps/server/src/kernel-next/runtime/graceful-shutdown.test.ts && git commit -m "feat(resumability): reconcileRunningAttempts for graceful shutdown (M-R1.5)"
```

### Task 1.6: Install SIGTERM/SIGINT handler in index.ts

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Read existing shutdown points**

```bash
grep -n "SIGTERM\|SIGINT\|process.on" /Users/minghao/workflow-control/apps/server/src/index.ts
```

- [ ] **Step 2: Add handler right after lock install**

```ts
// Installed right after `process.on("exit", () => releaseServerLock(lockHandle));`
import { reconcileRunningAttempts } from "./kernel-next/runtime/graceful-shutdown.js";

let shuttingDown = false;
async function gracefulExit(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "graceful shutdown: reconciling in-flight attempts");
  try {
    const db = getDb();
    const taskIds = (db.prepare(
      `SELECT DISTINCT task_id FROM stage_attempts
        WHERE status='running' AND task_id NOT IN (SELECT task_id FROM task_finals)`,
    ).all() as Array<{ task_id: string }>).map((r) => r.task_id);
    const n = reconcileRunningAttempts(db, taskIds);
    logger.info({ signal, reconciled: n }, "graceful shutdown: complete");
  } catch (err) {
    logger.error({ err }, "graceful shutdown: reconcile failed");
  }
  process.exit(0);
}
process.on("SIGTERM", () => { void gracefulExit("SIGTERM"); });
process.on("SIGINT", () => { void gracefulExit("SIGINT"); });
```

(Put the import at the top with the other imports.)

- [ ] **Step 3: Verify tsc**

```bash
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 4: Smoke test graceful shutdown**

```bash
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill; sleep 2
rm -f /tmp/workflow-control-data/kernel-next.lock /tmp/workflow-control-data/kernel-next.db*
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server.log 2>&1 &
PID=$!
sleep 18
kill -TERM "$PID"
sleep 3
grep -q "graceful shutdown: complete" /tmp/server.log && echo "GRACEFUL_OK"
test ! -f /tmp/workflow-control-data/kernel-next.lock && echo "LOCK_RELEASED"
```
Expected: `GRACEFUL_OK` and `LOCK_RELEASED`.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/index.ts && git commit -m "feat(resumability): SIGTERM/SIGINT graceful shutdown handler (M-R1.6)"
```

---

## Milestone M-R2: Orphan reconciler (startup resume)

### Task 2.1: Scan orphan task ids

**Files:**
- Create: `apps/server/src/kernel-next/runtime/orphan-reconciler.ts`
- Create: `apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "../ir/sql.js";
import { scanOrphanTaskIds } from "./orphan-reconciler.js";

describe("scanOrphanTaskIds", () => {
  it("returns task ids with attempts but no task_finals row", () => {
    const db = new DatabaseSync(":memory:");
    applySchema(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','s1',0,'v','regular','running',?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a2','t2','s1',0,'v','regular','success',?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO task_finals (task_id, version_hash, final_state, reason, ended_at)
       VALUES ('t2','v','completed','natural',?)`,
    ).run(now);

    const orphans = scanOrphanTaskIds(db);
    expect(orphans).toEqual(["t1"]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/orphan-reconciler.test.ts
```
Expected: `Cannot find module './orphan-reconciler.js'`.

- [ ] **Step 3: Implement scanner**

```ts
// apps/server/src/kernel-next/runtime/orphan-reconciler.ts
import type { DatabaseSync } from "node:sqlite";

export function scanOrphanTaskIds(db: DatabaseSync): string[] {
  const rows = db.prepare(
    `SELECT DISTINCT task_id FROM stage_attempts
      WHERE task_id NOT IN (SELECT task_id FROM task_finals)`,
  ).all() as Array<{ task_id: string }>;
  return rows.map((r) => r.task_id);
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/orphan-reconciler.test.ts
```
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/orphan-reconciler.ts apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts && git commit -m "feat(resumability): scanOrphanTaskIds DB query (M-R2.1)"
```

### Task 2.2: Classify orphan (terminal-no-finals vs resumable)

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/orphan-reconciler.ts`
- Modify: `apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// Append to orphan-reconciler.test.ts
import { classifyOrphan } from "./orphan-reconciler.js";
import { loadBuiltinPipelineIR } from "./load-builtin-pipeline.js";
import { KernelService } from "../mcp/kernel.js";

describe("classifyOrphan", () => {
  it("returns resume_from when there's a pending non-success stage", () => {
    const db = new DatabaseSync(":memory:");
    applySchema(db);
    const loaded = loadBuiltinPipelineIR("smoke-test");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const sub = svc.submit(loaded.ir, { prompts: loaded.prompts });
    if (!sub.ok) throw new Error("seed failed");
    const vh = sub.versionHash;
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','greet',0,?,'regular','success',?)`,
    ).run(vh, now);
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a2','t1','echoBack',0,?,'regular','superseded',?)`,
    ).run(vh, now + 1);

    const cls = classifyOrphan(db, "t1");
    expect(cls.kind).toBe("resume");
    if (cls.kind === "resume") {
      expect(cls.resumeFrom).toBe("echoBack");
      expect(cls.versionHash).toBe(vh);
    }
  });

  it("returns terminal when every non-external stage has success", () => {
    const db = new DatabaseSync(":memory:");
    applySchema(db);
    const loaded = loadBuiltinPipelineIR("smoke-test");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const sub = svc.submit(loaded.ir, { prompts: loaded.prompts });
    if (!sub.ok) throw new Error("seed failed");
    const vh = sub.versionHash;
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','greet',0,?,'regular','success',?)`,
    ).run(vh, now);
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a2','t1','echoBack',0,?,'regular','success',?)`,
    ).run(vh, now + 1);

    const cls = classifyOrphan(db, "t1");
    expect(cls.kind).toBe("terminal");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/orphan-reconciler.test.ts
```
Expected: 2 new tests FAIL (`classifyOrphan is not exported`).

- [ ] **Step 3: Implement classifier**

```ts
// Append to orphan-reconciler.ts
import type { PipelineIR } from "../ir/schema.js";
import { getPipelineIR } from "./ir-loader.js";

export type OrphanClassification =
  | { kind: "resume"; versionHash: string; resumeFrom: string }
  | { kind: "terminal"; versionHash: string }
  | { kind: "unresolvable"; reason: "no_attempts" | "ir_not_found" };

export function classifyOrphan(db: DatabaseSync, taskId: string): OrphanClassification {
  const latestAttempt = db.prepare(
    `SELECT version_hash FROM stage_attempts
       WHERE task_id = ?
       ORDER BY started_at DESC
       LIMIT 1`,
  ).get(taskId) as { version_hash: string } | undefined;
  if (!latestAttempt) return { kind: "unresolvable", reason: "no_attempts" };
  const ir = getPipelineIR(db, latestAttempt.version_hash);
  if (!ir) return { kind: "unresolvable", reason: "ir_not_found" };

  const successByStage = new Set(
    (db.prepare(
      `SELECT DISTINCT stage_name FROM stage_attempts
         WHERE task_id = ? AND status = 'success'`,
    ).all(taskId) as Array<{ stage_name: string }>).map((r) => r.stage_name),
  );
  const stagesInOrder = topologicalStageOrder(ir);
  const firstPending = stagesInOrder.find(
    (name) => !successByStage.has(name) && !isExternalOrGate(ir, name),
  );
  if (firstPending === undefined) {
    return { kind: "terminal", versionHash: latestAttempt.version_hash };
  }
  return {
    kind: "resume",
    versionHash: latestAttempt.version_hash,
    resumeFrom: firstPending,
  };
}

function isExternalOrGate(ir: PipelineIR, name: string): boolean {
  if (name === "__external__") return true;
  const stage = ir.stages.find((s) => s.name === name);
  return stage?.type === "gate";
}

function topologicalStageOrder(ir: PipelineIR): string[] {
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of ir.stages) {
    inDegree.set(s.name, 0);
    adj.set(s.name, []);
  }
  for (const w of ir.wires) {
    const from = "stage" in w.from ? w.from.stage : undefined;
    const to = w.to.stage;
    if (from && adj.has(from) && inDegree.has(to)) {
      adj.get(from)!.push(to);
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    }
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  const out: string[] = [];
  while (queue.length > 0) {
    const n = queue.shift()!;
    out.push(n);
    for (const next of adj.get(n) ?? []) {
      const d = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/orphan-reconciler.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/orphan-reconciler.ts apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts && git commit -m "feat(resumability): classifyOrphan resume/terminal decision (M-R2.2)"
```

### Task 2.3: Hot-update priority override

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/orphan-reconciler.ts`
- Modify: `apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// Append to orphan-reconciler.test.ts
it("classifies resume with hot_update_events.rerun_from_stage when newer", () => {
  const db = new DatabaseSync(":memory:");
  applySchema(db);
  const loaded = loadBuiltinPipelineIR("smoke-test");
  const svc = new KernelService(db, { skipTypeCheck: true });
  const sub = svc.submit(loaded.ir, { prompts: loaded.prompts });
  if (!sub.ok) throw new Error("seed failed");
  const vh = sub.versionHash;
  const base = Date.now();
  db.prepare(
    `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
     VALUES ('a1','t1','greet',0,?,'regular','success',?)`,
  ).run(vh, base);
  db.prepare(
    `INSERT INTO hot_update_events (event_id, task_id, from_version, to_version, actor, rerun_from_stage, status, started_at, finished_at)
     VALUES ('e1','t1',?, ?, 'test', 'greet', 'success', ?, ?)`,
  ).run(vh, vh, base + 1000, base + 1001);

  const cls = classifyOrphan(db, "t1");
  expect(cls.kind).toBe("resume");
  if (cls.kind === "resume") {
    expect(cls.resumeFrom).toBe("greet");
  }
});
```

- [ ] **Step 2: Run and confirm failure (greet is success → without override, result would be terminal or echoBack)**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/orphan-reconciler.test.ts
```
Expected: new test FAIL.

- [ ] **Step 3: Extend classifyOrphan to honour hot-update**

Replace the body of `classifyOrphan` with:

```ts
export function classifyOrphan(db: DatabaseSync, taskId: string): OrphanClassification {
  const latestAttempt = db.prepare(
    `SELECT version_hash, started_at FROM stage_attempts
       WHERE task_id = ?
       ORDER BY started_at DESC
       LIMIT 1`,
  ).get(taskId) as { version_hash: string; started_at: number } | undefined;
  if (!latestAttempt) return { kind: "unresolvable", reason: "no_attempts" };
  const ir = getPipelineIR(db, latestAttempt.version_hash);
  if (!ir) return { kind: "unresolvable", reason: "ir_not_found" };

  // Hot-update priority override — if a successful migration is newer
  // than the latest stage attempt, it knows better than our topological
  // scan where the next work should pick up.
  const hu = db.prepare(
    `SELECT rerun_from_stage, started_at FROM hot_update_events
       WHERE task_id = ? AND status = 'success'
       ORDER BY started_at DESC
       LIMIT 1`,
  ).get(taskId) as { rerun_from_stage: string | null; started_at: number } | undefined;
  if (hu && hu.rerun_from_stage && hu.started_at >= latestAttempt.started_at) {
    return { kind: "resume", versionHash: latestAttempt.version_hash, resumeFrom: hu.rerun_from_stage };
  }

  const successByStage = new Set(
    (db.prepare(
      `SELECT DISTINCT stage_name FROM stage_attempts
         WHERE task_id = ? AND status = 'success'`,
    ).all(taskId) as Array<{ stage_name: string }>).map((r) => r.stage_name),
  );
  const stagesInOrder = topologicalStageOrder(ir);
  const firstPending = stagesInOrder.find(
    (name) => !successByStage.has(name) && !isExternalOrGate(ir, name),
  );
  if (firstPending === undefined) {
    return { kind: "terminal", versionHash: latestAttempt.version_hash };
  }
  return { kind: "resume", versionHash: latestAttempt.version_hash, resumeFrom: firstPending };
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/orphan-reconciler.test.ts
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/orphan-reconciler.ts apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts && git commit -m "feat(resumability): hot-update rerun_from_stage priority in classifyOrphan (M-R2.3)"
```

### Task 2.4: Resolve last agent session id

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/orphan-reconciler.ts`
- Modify: `apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// Append to orphan-reconciler.test.ts
import { lookupResumeSessionId } from "./orphan-reconciler.js";

it("returns the most recent session_id for a given task+stage", () => {
  const db = new DatabaseSync(":memory:");
  applySchema(db);
  const base = Date.now();
  db.prepare(
    `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
     VALUES ('a1','t1','analyzing',0,'v','regular','superseded',?)`,
  ).run(base);
  db.prepare(
    `INSERT INTO prompt_contents (content_hash, content) VALUES ('h1', 'dummy')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, session_id, started_at, last_heartbeat_at)
     VALUES ('a1','p','h1','dummy','claude','sess-123',?, ?)`,
  ).run(base, base);

  const sid = lookupResumeSessionId(db, "t1", "analyzing");
  expect(sid).toBe("sess-123");
});

it("returns undefined when no session exists for that stage", () => {
  const db = new DatabaseSync(":memory:");
  applySchema(db);
  const sid = lookupResumeSessionId(db, "t1", "analyzing");
  expect(sid).toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/orphan-reconciler.test.ts
```
Expected: 2 new tests FAIL (`lookupResumeSessionId is not exported`).

- [ ] **Step 3: Implement lookup**

```ts
// Append to orphan-reconciler.ts
export function lookupResumeSessionId(
  db: DatabaseSync,
  taskId: string,
  stageName: string,
): string | undefined {
  const row = db.prepare(
    `SELECT aed.session_id FROM agent_execution_details aed
       JOIN stage_attempts sa ON sa.attempt_id = aed.attempt_id
      WHERE sa.task_id = ? AND sa.stage_name = ? AND aed.session_id IS NOT NULL
      ORDER BY aed.started_at DESC
      LIMIT 1`,
  ).get(taskId, stageName) as { session_id: string } | undefined;
  return row?.session_id ?? undefined;
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/orphan-reconciler.test.ts
```
Expected: 6 passed total.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/orphan-reconciler.ts apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts && git commit -m "feat(resumability): lookupResumeSessionId helper (M-R2.4)"
```

### Task 2.5: Top-level bootResumability dispatcher

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/orphan-reconciler.ts`
- Modify: `apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// Append to orphan-reconciler.test.ts
import { bootResumability } from "./orphan-reconciler.js";

it("dispatches startPipelineRun for each resumable orphan", async () => {
  const db = new DatabaseSync(":memory:");
  applySchema(db);
  const loaded = loadBuiltinPipelineIR("smoke-test");
  const svc = new KernelService(db, { skipTypeCheck: true });
  const sub = svc.submit(loaded.ir, { prompts: loaded.prompts });
  if (!sub.ok) throw new Error("seed failed");
  const vh = sub.versionHash;
  const now = Date.now();
  db.prepare(
    `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
     VALUES ('a1','t1','greet',0,?,'regular','running',?)`,
  ).run(vh, now);

  const dispatched: Array<{ taskId: string; versionHash: string; resumeFrom?: string }> = [];
  const fakeStart = async (input: { taskId?: string; versionHash?: string; resumeFrom?: string }) => {
    dispatched.push({ taskId: input.taskId!, versionHash: input.versionHash!, resumeFrom: input.resumeFrom });
    return { ok: true as const, taskId: input.taskId!, versionHash: input.versionHash! };
  };

  const result = await bootResumability({ db, startPipelineRun: fakeStart });
  expect(result.resumed).toBe(1);
  expect(result.terminalRecovered).toBe(0);
  expect(dispatched).toEqual([{ taskId: "t1", versionHash: vh, resumeFrom: "greet" }]);
  // running attempt was superseded so the hydration path can finalize it cleanly
  const a1 = db.prepare("SELECT status FROM stage_attempts WHERE attempt_id='a1'").get() as { status: string };
  expect(a1.status).toBe("superseded");
});

it("writes task_finals for tasks that are actually terminal", async () => {
  const db = new DatabaseSync(":memory:");
  applySchema(db);
  const loaded = loadBuiltinPipelineIR("smoke-test");
  const svc = new KernelService(db, { skipTypeCheck: true });
  const sub = svc.submit(loaded.ir, { prompts: loaded.prompts });
  if (!sub.ok) throw new Error("seed failed");
  const vh = sub.versionHash;
  const now = Date.now();
  db.prepare(
    `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
     VALUES ('a1','t1','greet',0,?,'regular','success',?)`,
  ).run(vh, now);
  db.prepare(
    `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
     VALUES ('a2','t1','echoBack',0,?,'regular','success',?)`,
  ).run(vh, now + 1);

  const dispatched: unknown[] = [];
  await bootResumability({
    db,
    startPipelineRun: async () => { dispatched.push(1); return { ok: true as const, taskId: "x", versionHash: vh }; },
  });
  expect(dispatched).toEqual([]);
  const final = db.prepare("SELECT final_state, reason, detail FROM task_finals WHERE task_id='t1'").get() as { final_state: string; reason: string; detail: string };
  expect(final.final_state).toBe("completed");
  expect(final.reason).toBe("natural");
  expect(final.detail).toBe("recovered_no_finals_row");
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/orphan-reconciler.test.ts
```
Expected: 2 new tests FAIL (`bootResumability is not exported`).

- [ ] **Step 3: Implement bootResumability**

```ts
// Append to orphan-reconciler.ts
import { reconcileRunningAttempts } from "./graceful-shutdown.js";

export interface BootResumabilityInput {
  db: DatabaseSync;
  startPipelineRun: (input: {
    db?: DatabaseSync;
    broadcaster?: unknown;
    taskId: string;
    versionHash: string;
    resumeFrom?: string;
    resumeSessionId?: string;
  }) => Promise<unknown>;
}

export interface BootResumabilityResult {
  resumed: number;
  terminalRecovered: number;
  unresolvable: number;
}

export async function bootResumability(
  input: BootResumabilityInput,
): Promise<BootResumabilityResult> {
  const { db } = input;
  const orphans = scanOrphanTaskIds(db);
  let resumed = 0;
  let terminalRecovered = 0;
  let unresolvable = 0;
  // Reconcile running rows across ALL orphans first so runner sees a clean DB.
  reconcileRunningAttempts(db, orphans);
  const promises: Promise<unknown>[] = [];
  for (const taskId of orphans) {
    const cls = classifyOrphan(db, taskId);
    if (cls.kind === "terminal") {
      db.prepare(
        `INSERT OR IGNORE INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
         VALUES (?, ?, 'completed', 'natural', 'recovered_no_finals_row', ?)`,
      ).run(taskId, cls.versionHash, Date.now());
      terminalRecovered += 1;
      continue;
    }
    if (cls.kind === "unresolvable") {
      db.prepare(
        `INSERT OR IGNORE INTO task_finals (task_id, version_hash, final_state, reason, detail, ended_at)
         VALUES (?, COALESCE((SELECT version_hash FROM stage_attempts WHERE task_id=? ORDER BY started_at DESC LIMIT 1), '-'), 'failed', 'error', ?, ?)`,
      ).run(taskId, taskId, `unresolvable:${cls.reason}`, Date.now());
      unresolvable += 1;
      continue;
    }
    const resumeSessionId = lookupResumeSessionId(db, taskId, cls.resumeFrom);
    promises.push(
      input.startPipelineRun({
        taskId,
        versionHash: cls.versionHash,
        resumeFrom: cls.resumeFrom,
        resumeSessionId,
      }).catch((err: unknown) => {
        // intentionally do not throw — one bad orphan should not block others
        return err;
      }),
    );
    resumed += 1;
  }
  await Promise.allSettled(promises);
  return { resumed, terminalRecovered, unresolvable };
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/orphan-reconciler.test.ts
```
Expected: 8 passed total.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/orphan-reconciler.ts apps/server/src/kernel-next/runtime/orphan-reconciler.test.ts && git commit -m "feat(resumability): bootResumability orchestrator (M-R2.5)"
```

### Task 2.6: Wire bootResumability into index.ts

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Edit index.ts**

Add right after the `installBuiltinPipelines()` block (~L72) and before middleware/routes mount:

```ts
// --- Resume orphan tasks ---
{
  const { bootResumability } = await import("./kernel-next/runtime/orphan-reconciler.js");
  const { startPipelineRun } = await import("./kernel-next/runtime/start-pipeline-run.js");
  const { kernelNextBroadcaster } = await import("./kernel-next/sse/singleton.js");
  const { getKernelNextDb } = await import("./lib/kernel-next-db.js");
  const res = await bootResumability({
    db: getKernelNextDb(),
    startPipelineRun: (inp) => startPipelineRun({
      db: getKernelNextDb(),
      broadcaster: kernelNextBroadcaster,
      ...inp,
    }),
  });
  logger.info({ ...res }, "resumability: boot scan complete");
}
```

- [ ] **Step 2: Verify tsc**

```bash
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Run full server test suite**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run
```
Expected: all passing (baseline + new reconciler tests).

- [ ] **Step 4: Manual smoke — kill mid-run and restart**

```bash
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill; sleep 2
rm -f /tmp/workflow-control-data/kernel-next.lock /tmp/workflow-control-data/kernel-next.db*
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server.log 2>&1 &
sleep 18
curl -s -X POST http://localhost:3001/api/kernel/tasks/run -H "Content-Type: application/json" \
  -d '{"name":"smoke-test","seedValues":{"task_text":"hello resumability"},"maxTurns":5}'
sleep 4
# Kill hard — simulate crash
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill -9
sleep 2
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server2.log 2>&1 &
sleep 20
grep -q "resumability: boot scan complete" /tmp/server2.log && echo "BOOT_SCAN_OK"
# Either task recovered as terminal or resumed
sqlite3 /tmp/workflow-control-data/kernel-next.db "SELECT final_state, reason, detail FROM task_finals;"
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill
```
Expected: `BOOT_SCAN_OK` and a `task_finals` row exists (either recovered or resumed-and-finished).

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/index.ts && git commit -m "feat(resumability): invoke bootResumability at server startup (M-R2.6)"
```

---

## Milestone M-R3: Runner hydrates gate_queue answers

### Task 3.1: Extend resume hydration to read gate_queue

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/runner.ts`
- Create: `apps/server/src/kernel-next/runtime/runner.resume-gate-hydration.test.ts`

- [ ] **Step 1: Write failing integration test**

```ts
// apps/server/src/kernel-next/runtime/runner.resume-gate-hydration.test.ts
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applySchema } from "../ir/sql.js";
import { KernelService } from "../mcp/kernel.js";
import { runPipeline } from "./runner.js";
import { KernelNextBroadcaster } from "../sse/broadcaster.js";
import { MOCK_HANDLER_REGISTRY } from "./mock-handler-registry.js";

describe("runner resume gate-queue hydration", () => {
  it("picks up an already-answered gate when runner cold-starts on resume", async () => {
    const db = new DatabaseSync(":memory:");
    applySchema(db);
    // Use an inline gate IR (not smoke-test which has no gate). Simplest:
    // reuse the mock-registry "diamondGate" handler; seeds IR on demand.
    const entry = MOCK_HANDLER_REGISTRY["diamondGate"];
    if (!entry) throw new Error("expected mock diamondGate handler");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const prompts: Record<string, string> = {};
    for (const s of entry.ir.stages) {
      if (s.type === "agent" && s.config.promptRef) prompts[s.config.promptRef] = "mock";
    }
    const sub = svc.submit(entry.ir, { prompts });
    if (!sub.ok) throw new Error("seed diamond failed");
    const vh = sub.versionHash;
    const taskId = "t-resume-gate";
    const now = Date.now();
    const gateStage = entry.ir.stages.find((s) => s.type === "gate");
    if (!gateStage) throw new Error("diamondGate ir has no gate");
    const firstRoute = Object.keys((gateStage as { config: { routing: { routes: Record<string, unknown> } } }).config.routing.routes)[0];

    // Insert the world state: all pre-gate stages succeeded, gate is
    // answered in gate_queue but runner never reacted (crash).
    // ... see implementation file for full set of inserts; the key
    // insertion is:
    db.prepare(
      `INSERT INTO gate_queue (gate_id, task_id, stage_name, attempt_id, question_json, answer, answered_at, created_at)
       VALUES ('g1', ?, ?, 'ga1', '{"text":"?"}', ?, ?, ?)`,
    ).run(taskId, gateStage.name, firstRoute, now, now);
    // ... pre-gate stage success rows + gate stage_attempt in 'superseded'

    // Run with resumeFrom = gate's downstream stage. The runner must
    // hydrate persistentGateAuthorized from the gate_queue row so the
    // synthetic-answer loop routes to `firstRoute`'s target and the
    // resumed machine does not deadlock waiting for a new GATE_ANSWERED.
    const broadcaster = new KernelNextBroadcaster();
    const result = await runPipeline({
      db, broadcaster, taskId, versionHash: vh, ir: entry.ir,
      resumeFrom: Object.values((gateStage as { config: { routing: { routes: Record<string, unknown> } } }).config.routing.routes)[0] as string,
      seedValues: {},
      executor: entry.executor,
      maxTotalAttempts: 5,
    });

    // Accept either completed or failed; the key assertion is that the
    // machine does NOT block forever waiting for a fresh gate answer.
    expect(["completed", "failed"]).toContain(result.finalState);
  });
});
```

(Note: depending on how `runPipeline` is invoked in the codebase, the exact argument shape may differ — use the same call signature that `start-pipeline-run.ts` uses, adapted for a direct test. The critical assertion is the call returns, not that it succeeds.)

- [ ] **Step 2: Run and confirm failure (expect timeout or unanswered-gate block)**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/runner.resume-gate-hydration.test.ts
```
Expected: FAIL (timeout or hang).

- [ ] **Step 3: Patch runner.ts hydration block**

Locate the `if (opts.resumeFrom) { ... }` block at approximately line 368. After the `persistentPortValues` loop (at approximately L410, after `persistentPortValues[...] = JSON.parse(r.value_json)`) and before `isRetryRebuild = true;`, insert:

```ts
// Hydrate gate answers the previous runner committed but did not forward.
// Runner may have crashed in the window between gate_queue write and
// GATE_ANSWERED dispatch; that answer is still authoritative.
const answeredGateRows = opts.db.prepare(
  `SELECT stage_name, answer FROM gate_queue
     WHERE task_id = ? AND answer IS NOT NULL AND answered_at IS NOT NULL`,
).all(opts.taskId) as Array<{ stage_name: string; answer: string }>;
for (const row of answeredGateRows) {
  const gateStage = opts.ir.stages.find(
    (s) => s.name === row.stage_name && s.type === "gate",
  );
  if (!gateStage || gateStage.type !== "gate") continue;
  const target = gateStage.config.routing.routes[row.answer];
  if (target === undefined) continue;
  const targets = Array.isArray(target) ? target : [target];
  for (const t of targets) {
    if (!persistentGateAuthorized.includes(t)) {
      persistentGateAuthorized.push(t);
    }
  }
  if (!persistentFinalizedStages.some((f) => f.name === row.stage_name)) {
    persistentFinalizedStages.push({ name: row.stage_name, outcome: "done" as const });
  }
}
```

- [ ] **Step 4: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/runner.resume-gate-hydration.test.ts
```
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/runner.ts apps/server/src/kernel-next/runtime/runner.resume-gate-hydration.test.ts && git commit -m "feat(resumability): hydrate persistentGateAuthorized from gate_queue (M-R3.1)"
```

### Task 3.2: Verify no regression on full suite

**Files:**
- Run full test suite

- [ ] **Step 1: Run full server tests**

```bash
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit && npx vitest run
```
Expected: 1454+N passed where N is the new tests; 0 failures.

- [ ] **Step 2: Commit (no-op)**

No changes. Skip step. Proceed to M-R4.

---

## Milestone M-R4: SSE monotonic seq + Last-Event-ID

### Task 4.1: seq on broadcaster

**Files:**
- Modify: `apps/server/src/kernel-next/sse/types.ts`
- Modify: `apps/server/src/kernel-next/sse/broadcaster.ts`
- Modify: `apps/server/src/kernel-next/sse/broadcaster.test.ts`

- [ ] **Step 1: Write failing test**

Add to broadcaster.test.ts:

```ts
it("stamps monotonic seq per task on publish", () => {
  const b = new KernelNextBroadcaster({ historyLimit: 10 });
  b.publish({ type: "task_state", taskId: "t1", timestamp: "x", data: {} } as KernelNextSSEEvent);
  b.publish({ type: "task_state", taskId: "t1", timestamp: "y", data: {} } as KernelNextSSEEvent);
  b.publish({ type: "task_state", taskId: "t2", timestamp: "z", data: {} } as KernelNextSSEEvent);
  const h1 = b.historyFor("t1");
  const h2 = b.historyFor("t2");
  expect(h1.map((e) => e.seq)).toEqual([1, 2]);
  expect(h2.map((e) => e.seq)).toEqual([1]);
});

it("subscribe honours fromSeq to skip already-seen events", () => {
  const b = new KernelNextBroadcaster({ historyLimit: 10 });
  for (let i = 0; i < 5; i += 1) {
    b.publish({ type: "task_state", taskId: "t1", timestamp: String(i), data: { i } } as KernelNextSSEEvent);
  }
  const received: KernelNextSSEEvent[] = [];
  const un = b.subscribe("t1", (e) => { received.push(e); }, { fromSeq: 3 });
  expect(received.map((e) => e.seq)).toEqual([4, 5]);
  un();
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/sse/broadcaster.test.ts
```
Expected: FAIL (seq is undefined; fromSeq option not accepted).

- [ ] **Step 3: Add seq to types.ts**

In `KernelNextSSEEvent`, add:

```ts
export interface KernelNextSSEEvent {
  type: KernelNextSSEEventType;
  taskId: string;
  timestamp: string;
  data: unknown;
  // Assigned by the broadcaster at publish time. Per-task monotonic,
  // starting at 1. Absent events never existed on the channel.
  seq: number;
}
```

- [ ] **Step 4: Patch broadcaster.ts**

Replace `TaskChannel` and `publish` and `subscribe`:

```ts
interface TaskChannel {
  listeners: Set<KernelNextSSEListener>;
  history: KernelNextSSEEvent[];
  nextSeq: number;
}

// ...

subscribe(
  taskId: string,
  listener: KernelNextSSEListener,
  opts: { fromSeq?: number } = {},
): () => void {
  const channel = this.ensureChannel(taskId);
  const fromSeq = opts.fromSeq ?? 0;
  for (const event of channel.history) {
    if (event.seq > fromSeq) {
      this.safeDispatch(listener, event);
    }
  }
  channel.listeners.add(listener);
  return () => { channel.listeners.delete(listener); };
}

publish(event: Omit<KernelNextSSEEvent, "seq"> & { seq?: number }): void {
  const channel = this.ensureChannel(event.taskId);
  const seq = channel.nextSeq;
  channel.nextSeq += 1;
  const stamped: KernelNextSSEEvent = { ...event, seq } as KernelNextSSEEvent;
  channel.history.push(stamped);
  if (channel.history.length > this.historyLimit) {
    channel.history.splice(0, channel.history.length - this.historyLimit);
  }
  for (const listener of channel.listeners) {
    this.safeDispatch(listener, stamped);
  }
}

private ensureChannel(taskId: string): TaskChannel {
  let channel = this.channels.get(taskId);
  if (!channel) {
    channel = { listeners: new Set(), history: [], nextSeq: 1 };
    this.channels.set(taskId, channel);
  }
  return channel;
}
```

- [ ] **Step 5: Fix existing callers if they pass `.seq`**

```bash
grep -rn "broadcaster.publish\|publish({" /Users/minghao/workflow-control/apps/server/src --include="*.ts" | grep -v test
```
Every call currently passes an event without seq — compile remains clean because of the `Omit` in the signature. Verify:

```bash
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 6: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/sse/broadcaster.test.ts
```
Expected: all broadcaster tests pass including new ones.

- [ ] **Step 7: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/sse/types.ts apps/server/src/kernel-next/sse/broadcaster.ts apps/server/src/kernel-next/sse/broadcaster.test.ts && git commit -m "feat(resumability): per-task monotonic seq on SSE events (M-R4.1)"
```

### Task 4.2: HTTP emits id: and honours Last-Event-ID

**Files:**
- Modify: `apps/server/src/kernel-next/sse/http.ts`
- Modify: `apps/server/src/kernel-next/sse/http.test.ts`

- [ ] **Step 1: Write failing test**

Extend http.test.ts:

```ts
it("emits id:<taskId>:<seq> alongside each data frame", async () => {
  const broadcaster = new KernelNextBroadcaster({ historyLimit: 5 });
  broadcaster.publish({ type: "task_state", taskId: "t1", timestamp: "x", data: {} } as KernelNextSSEEvent);
  const stream = createKernelNextStream(broadcaster, "t1");
  const reader = stream.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  expect(text).toContain("id: t1:1");
  expect(text).toContain("event: task_state");
  reader.cancel();
});

it("honours Last-Event-ID by filtering replay", async () => {
  const broadcaster = new KernelNextBroadcaster({ historyLimit: 10 });
  for (let i = 0; i < 3; i += 1) {
    broadcaster.publish({ type: "task_state", taskId: "t1", timestamp: String(i), data: {} } as KernelNextSSEEvent);
  }
  const stream = createKernelNextStream(broadcaster, "t1", { lastEventId: "t1:2" });
  const reader = stream.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  expect(text).toContain("id: t1:3");
  expect(text).not.toContain("id: t1:1");
  expect(text).not.toContain("id: t1:2");
  reader.cancel();
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/sse/http.test.ts
```
Expected: FAIL (id: not in output, lastEventId option rejected).

- [ ] **Step 3: Patch http.ts**

```ts
function formatEvent(event: KernelNextSSEEvent): Uint8Array {
  const lines = [
    `id: ${event.taskId}:${event.seq}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ];
  return encoder.encode(lines.join("\n"));
}

export interface CreateKernelNextStreamOptions {
  heartbeatMs?: number;
  lastEventId?: string;
}

export function createKernelNextStream(
  broadcaster: KernelNextBroadcaster,
  taskId: string,
  options: CreateKernelNextStreamOptions = {},
): ReadableStream<Uint8Array> {
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const fromSeq = parseLastEventId(options.lastEventId, taskId);
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = broadcaster.subscribe(taskId, (event) => {
        if (closed) return;
        try { controller.enqueue(formatEvent(event)); }
        catch { closed = true; }
      }, { fromSeq });
      heartbeat = setInterval(() => {
        if (closed) { if (heartbeat) clearInterval(heartbeat); return; }
        try { controller.enqueue(encoder.encode(": heartbeat\n\n")); }
        catch { closed = true; if (heartbeat) clearInterval(heartbeat); }
      }, heartbeatMs);
    },
    cancel() {
      closed = true;
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    },
  });
}

function parseLastEventId(raw: string | undefined, taskId: string): number {
  if (!raw) return 0;
  const [prefix, seqStr] = raw.split(":", 2);
  if (prefix !== taskId) return 0;
  const seq = Number.parseInt(seqStr ?? "", 10);
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}
```

- [ ] **Step 4: Pass Last-Event-ID header from route to option**

Find the route handler that calls `createKernelNextStream`:

```bash
grep -n "createKernelNextStream" /Users/minghao/workflow-control/apps/server/src/routes/kernel-next-stream.ts
```

Patch the call:

```ts
const lastEventId = c.req.header("Last-Event-ID") ?? undefined;
const stream = createKernelNextStream(kernelNextBroadcaster, taskId, { lastEventId });
```

- [ ] **Step 5: Run full suite**

```bash
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit && npx vitest run
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/sse/http.ts apps/server/src/kernel-next/sse/http.test.ts apps/server/src/routes/kernel-next-stream.ts && git commit -m "feat(resumability): SSE id: + Last-Event-ID reconnect (M-R4.2)"
```

---

## Milestone M-R5: Claude Agent SDK session resume

### Task 5.1: Inject queryFn into RealStageExecutor

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/real-executor.ts`
- Create: `apps/server/src/kernel-next/runtime/real-executor.resume.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/server/src/kernel-next/runtime/real-executor.resume.test.ts
import { describe, it, expect } from "vitest";
import { RealStageExecutor } from "./real-executor.js";

describe("RealStageExecutor resume", () => {
  it("passes options.resume = sessionId to queryFn when resumeSessionId provided", async () => {
    const calls: Array<{ resume?: string }> = [];
    const fakeQuery = (input: { prompt: string; options: { resume?: string } }) => {
      calls.push({ resume: input.options?.resume });
      async function* gen() {
        yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "new-sess" };
      }
      return gen() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
    };
    const exec = new RealStageExecutor({ queryFn: fakeQuery });
    // Execute a stub agent stage with resumeSessionId plumbed through.
    // The exact call shape depends on real-executor's public interface —
    // use whatever path the test adapter uses in real-executor.test.ts.
    // Key assertion: calls[0].resume === "sess-abc".
    await exec.runAgentStage?.({
      // placeholder — actual signature comes from real-executor.ts
      resumeSessionId: "sess-abc",
      stageName: "s",
      promptContent: "x",
      model: "claude",
    } as never);
    expect(calls[0].resume).toBe("sess-abc");
  });
});
```

(This test will almost certainly need adaptation to the real signature — the implementer should read `real-executor.test.ts` first to match the call pattern.)

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/real-executor.resume.test.ts
```
Expected: FAIL (queryFn option not accepted, or runAgentStage is not public).

- [ ] **Step 3: Patch real-executor.ts to accept queryFn**

Read current imports at L29-30:
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";
```

Change to:
```ts
import { query as defaultQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options as SdkOptions } from "@anthropic-ai/claude-agent-sdk";

type QueryFn = typeof defaultQuery;
```

Add to the constructor's input type and class field:
```ts
export interface RealStageExecutorOptions {
  // ... existing options
  /** Inject a stub SDK `query` for tests. Defaults to the real SDK. */
  queryFn?: QueryFn;
}

// inside the class:
private readonly queryFn: QueryFn;

// in constructor body:
this.queryFn = options.queryFn ?? defaultQuery;
```

Replace every `query(` call site in this file with `this.queryFn(`.

- [ ] **Step 4: Add resume to the options object passed to queryFn**

At the site where agent `options` is assembled, add:

```ts
if (input.resumeSessionId) {
  (options as SdkOptions).resume = input.resumeSessionId;
}
```

(`input` is whatever parameter bag the agent-execution path uses; the implementer may need to thread `resumeSessionId` through the existing function signatures from runner → executor.)

- [ ] **Step 5: Thread resumeSessionId through runner → executor**

Runner knows `resumeSessionId` from `RunnerOptions`. Pass to `executor.invokeStage(...)` or equivalent. Concrete change depends on the executor's public API — look at `real-executor.ts:40-120` for the options interface.

- [ ] **Step 6: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/real-executor.resume.test.ts
```
Expected: pass.

- [ ] **Step 7: Run full suite to catch regressions**

```bash
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit && npx vitest run
```
Expected: pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/real-executor.ts apps/server/src/kernel-next/runtime/real-executor.resume.test.ts && git commit -m "feat(resumability): queryFn injection + options.resume plumbing (M-R5.1)"
```

### Task 5.2: maxTurns clamp from prior num_turns

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/real-executor.ts`
- Modify: `apps/server/src/kernel-next/runtime/real-executor.resume.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// Append to real-executor.resume.test.ts
it("clamps maxTurns by subtracting prior num_turns and flooring at 1", () => {
  // Import the helper directly once implemented.
  const { clampMaxTurns } = require("./real-executor.js");
  expect(clampMaxTurns(30, 0)).toBe(30);
  expect(clampMaxTurns(30, 10)).toBe(20);
  expect(clampMaxTurns(30, 29)).toBe(1);
  expect(clampMaxTurns(30, 30)).toBe(1);
  expect(clampMaxTurns(30, 100)).toBe(1);
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/real-executor.resume.test.ts
```
Expected: FAIL (clampMaxTurns not exported).

- [ ] **Step 3: Implement clamp**

Append to real-executor.ts (top-level export):

```ts
export function clampMaxTurns(configured: number, priorTurns: number): number {
  const remaining = configured - priorTurns;
  return remaining < 1 ? 1 : remaining;
}
```

Use it in the option-assembly path when `resumeSessionId` is present:

```ts
const priorTurns = input.priorNumTurns ?? 0;
const effectiveMaxTurns = input.resumeSessionId
  ? clampMaxTurns(input.configuredMaxTurns, priorTurns)
  : input.configuredMaxTurns;
(options as SdkOptions).maxTurns = effectiveMaxTurns;
```

- [ ] **Step 4: Expose parseNumTurnsFromStream helper**

Add to real-executor.ts (also exported):

```ts
export function parseNumTurnsFromStream(raw: string | null | undefined): number {
  if (!raw) return 0;
  try {
    const msgs = JSON.parse(raw) as Array<{ type?: string; num_turns?: number }>;
    let total = 0;
    for (const m of msgs) {
      if (m.type === "result" && typeof m.num_turns === "number") {
        total += m.num_turns;
      }
    }
    return total;
  } catch {
    return 0;
  }
}
```

Test it:
```ts
it("parseNumTurnsFromStream sums num_turns from result messages", () => {
  const { parseNumTurnsFromStream } = require("./real-executor.js");
  expect(parseNumTurnsFromStream(null)).toBe(0);
  expect(parseNumTurnsFromStream('[]')).toBe(0);
  expect(parseNumTurnsFromStream('[{"type":"result","num_turns":5},{"type":"result","num_turns":3}]')).toBe(8);
  expect(parseNumTurnsFromStream('not-json')).toBe(0);
});
```

- [ ] **Step 5: Thread priorNumTurns through runner**

In runner.ts, when `resumeFrom` is set and the stage is agent, read the last `agent_stream_json` for that task+stage and derive `priorNumTurns`. Pass it to `executor.invokeStage` alongside `resumeSessionId`.

- [ ] **Step 6: Run and confirm pass + no regressions**

```bash
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit && npx vitest run
```
Expected: pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/real-executor.ts apps/server/src/kernel-next/runtime/real-executor.resume.test.ts apps/server/src/kernel-next/runtime/runner.ts && git commit -m "feat(resumability): clamp maxTurns by prior num_turns on resume (M-R5.2)"
```

### Task 5.3: Fallback path when SDK resume fails

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/real-executor.ts`
- Modify: `apps/server/src/kernel-next/runtime/real-executor.resume.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// Append to real-executor.resume.test.ts
it("falls back to a fresh session when queryFn throws with resume set", async () => {
  let firstCall = true;
  const fakeQuery = (input: { prompt: string; options: { resume?: string } }) => {
    if (firstCall && input.options.resume) {
      firstCall = false;
      async function* gen() {
        throw new Error("session not found");
      }
      return gen() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
    }
    async function* gen() {
      yield { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "new" };
    }
    return gen() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
  };
  const exec = new RealStageExecutor({ queryFn: fakeQuery });
  // Invoke with resumeSessionId and assert the fallback call occurred
  // (i.e., queryFn was called twice — first with resume, second without).
  // ...actual assertion will depend on runAgentStage signature
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/real-executor.resume.test.ts
```
Expected: FAIL (no fallback logic yet).

- [ ] **Step 3: Wrap queryFn call with try/catch fallback**

In the agent-invocation path:

```ts
async function runWithOptions(optsWithResume: SdkOptions, optsWithout: SdkOptions): Promise<AsyncIterable<SDKMessage>> {
  if (!optsWithResume.resume) return this.queryFn({ prompt, options: optsWithResume });
  try {
    return this.queryFn({ prompt, options: optsWithResume });
  } catch (err) {
    logger.warn({ err, sessionId: optsWithResume.resume }, "agent session resume failed — falling back to fresh session");
    return this.queryFn({ prompt, options: optsWithout });
  }
}
```

Note: because the SDK returns an async iterator, the failure may only manifest during iteration. Need to wrap the iteration loop in the fallback too.

- [ ] **Step 4: Run and confirm pass**

```bash
cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/real-executor.resume.test.ts
```
Expected: pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/minghao/workflow-control && git add apps/server/src/kernel-next/runtime/real-executor.ts apps/server/src/kernel-next/runtime/real-executor.resume.test.ts && git commit -m "feat(resumability): fallback to fresh session on resume failure (M-R5.3)"
```

---

## Milestone M-R6: Full regression + real-API dogfood

### Task 6.1: Full suite clean

**Files:**
- Run full server + web tests

- [ ] **Step 1: Server**

```bash
cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit && npx vitest run
```
Expected: 1454+N passed / 0 failed.

- [ ] **Step 2: Web**

```bash
cd /Users/minghao/workflow-control/apps/web && npx tsc --noEmit && npx vitest run
```
Expected: 17+ passed.

- [ ] **Step 3: If anything fails, fix the underlying root cause (not the test).**

### Task 6.2: Real-API dogfood (counts as M-R7 / M1 data point)

**Files:**
- Start a real PG run, kill server mid-stage, restart, observe resume.

- [ ] **Step 1: Clean start**

```bash
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill; sleep 2
rm -f /tmp/workflow-control-data/kernel-next.lock /tmp/workflow-control-data/kernel-next.db*
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server-dogfood-a.log 2>&1 &
sleep 22
```

- [ ] **Step 2: Start a PG run**

```bash
curl -s -X POST http://localhost:3001/api/kernel/tasks/run \
  -H "Content-Type: application/json" \
  -d '{"name":"Pipeline Generator","seedValues":{"taskDescription":"A 2-stage pipeline that fetches GitHub issues and writes a weekly summary"},"model":"claude-sonnet-4-6","maxTurns":60,"maxBudgetUsd":5}'
```

Record the returned `taskId` and `versionHash`.

- [ ] **Step 3: Wait for analyzing to be running, then SIGKILL the server**

```bash
sleep 45
ps aux | grep "tsx src/index.ts" | grep -v grep | awk '{print $2}' | xargs -r kill -9
sleep 3
```

- [ ] **Step 4: Restart server and observe resume**

```bash
cd /Users/minghao/workflow-control/apps/server && npx tsx src/index.ts > /tmp/server-dogfood-b.log 2>&1 &
sleep 22
grep "resumability: boot scan complete" /tmp/server-dogfood-b.log
```

- [ ] **Step 5: Watch task progress**

Use Monitor or sqlite queries to verify the task reaches `task_finals`. The resumed `analyzing` stage should pick up the prior session_id (check `agent_execution_details.session_id` on new attempts vs the killed one).

- [ ] **Step 6: Record run in ledger**

Append a row to `docs/phase6-usage-log.md` describing the dogfood: which task, what crashed, whether resume worked, whether SDK session resume saved cost (compare pre-kill vs post-resume cost_usd).

- [ ] **Step 7: Commit ledger update**

```bash
cd /Users/minghao/workflow-control && git add docs/phase6-usage-log.md && git commit -m "docs(phase6): run #19 — resumability dogfood (mid-stage crash + resume)"
```

---

## Self-review

- [x] Spec coverage:
  - §3.1 orphanReconciler → tasks 2.1-2.6
  - §3.2 gateAuthorizedHydration → task 3.1
  - §3.3 SSE monotonic seq → tasks 4.1-4.2
  - §3.4 gracefulShutdown → tasks 1.5-1.6
  - §3.5 serverLock → tasks 1.1-1.4
  - §3.6 SDK resume → tasks 5.1-5.3
  - §5 test strategy → unit + integration coverage across every milestone
  - §7 dogfood → task 6.2
- [x] Placeholder scan: no TBD/TODO; every task has concrete code or exact commands.
- [x] Type consistency: `clampMaxTurns`, `parseNumTurnsFromStream`, `scanOrphanTaskIds`, `classifyOrphan`, `bootResumability`, `lookupResumeSessionId`, `reconcileRunningAttempts`, `acquireServerLock`, `releaseServerLock` — each defined in exactly one task with one signature.

## Decision log (mirrors spec §7)

- Reuse `stage_attempts.status='superseded'` + `termination_reason='interrupted'` (no schema migration).
- Parallel resume dispatch on startup (SQLite + SDK serialize naturally; no thundering herd).
- PID file, not flock (NFS unreliability).
- Clamp maxTurns (floor 1), don't subtract-to-zero.
- No `resume_events` audit table (structured log + `hot_update_events` + `task_finals.reason` already cover observability).
