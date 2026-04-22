# Checkpoint Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture `before_sha` + `after_sha` + cached `git diff` per `stage_attempts.attempt_id`, completing roadmap §6.1 A1 field #7 (worktree diff) that was deferred in Stage 6.

**Architecture:** New `stage_checkpoints` SQLite table FK'd to `stage_attempts`. A `runtime/checkpoint/` module with pure functions (`captureBefore` / `captureAfter`) driven by injected git-commands dependencies. `PortRuntime` gains optional fire-and-forget hooks (`onAttemptStarted` / `onAttemptFinishing`); `runPipeline` wires them up and awaits all in-flight capture promises before run-final. Failures never abort a stage — every path has a diagnostic fallback.

**Tech Stack:** TypeScript, node:sqlite, `lib/spawn-utils.ts` for git subprocesses, `vitest` for unit + integration tests.

**Spec:** `docs/superpowers/specs/2026-04-24-checkpoint-infra-design.md`

---

## File Structure

**New files:**
- `apps/server/src/kernel-next/runtime/checkpoint/types.ts` — `CheckpointStatus`, `CheckpointConfig`, `CheckpointRow`, `GitResult`
- `apps/server/src/kernel-next/runtime/checkpoint/git-commands.ts` — `isGitRepo` / `gitRevParseHead` / `gitStashCreate` / `gitDiff` over `spawnWithTimeout`
- `apps/server/src/kernel-next/runtime/checkpoint/checkpoint.ts` — `captureBefore` / `captureAfter` / `resolveCheckpointConfig` / `buildCheckpointDeps`
- `apps/server/src/kernel-next/runtime/checkpoint/checkpoint.test.ts` — unit tests (mock `execGit`)
- `apps/server/src/kernel-next/runtime/checkpoint/checkpoint.integration.test.ts` — end-to-end with real tmp git repo

**Modified files:**
- `apps/server/src/kernel-next/ir/sql.ts` — add `stage_checkpoints` DDL + indices
- `apps/server/src/kernel-next/runtime/port-runtime.ts` — add `AttemptHooks` interface + optional 5th constructor param
- `apps/server/src/kernel-next/runtime/runner.ts` — accept `checkpointConfig`, build hooks, track in-flight promises, await before resolving run-final
- `apps/server/src/kernel-next/runtime/start-pipeline-run.ts` — forward `checkpointConfig` through
- `apps/server/src/kernel-next/runtime/runner.test.ts` — add 3 integration cases for checkpoint hooks
- `apps/server/src/kernel-next/mcp/server.ts` — extend `run_pipeline` MCP tool schema with `checkpoint_config`
- `docs/product-roadmap.md` — mark A1 field #7 as landed in Phase 4.5 Step 1

**New doc:**
- `docs/superpowers/plans/2026-04-24-checkpoint-infra-done-handoff.md` (Task 9)

---

## Task 1: Schema — `stage_checkpoints` table

**Files:**
- Modify: `apps/server/src/kernel-next/ir/sql.ts` (append before the closing template literal)

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/kernel-next/ir/sql.checkpoint.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "./sql.js";

describe("stage_checkpoints table", () => {
  it("creates table with expected columns and CHECK on status", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);

    const columns = db
      .prepare(`PRAGMA table_info(stage_checkpoints)`)
      .all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

    expect(byName.attempt_id).toBeDefined();
    expect(byName.attempt_id?.pk).toBe(1);
    expect(byName.workdir?.notnull).toBe(1);
    expect(byName.before_sha).toBeDefined();
    expect(byName.after_sha).toBeDefined();
    expect(byName.diff_text).toBeDefined();
    expect(byName.diff_bytes).toBeDefined();
    expect(byName.status?.notnull).toBe(1);
    expect(byName.diagnostic).toBeDefined();
    expect(byName.captured_before_at?.notnull).toBe(1);
    expect(byName.captured_after_at).toBeDefined();
  });

  it("enforces status CHECK constraint", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    db.exec("PRAGMA foreign_keys = OFF");

    expect(() =>
      db.prepare(
        `INSERT INTO stage_checkpoints
         (attempt_id, workdir, status, captured_before_at)
         VALUES (?, ?, ?, ?)`,
      ).run("a1", "/tmp", "bogus_status", 1),
    ).toThrow(/CHECK/);

    // valid status accepted
    expect(() =>
      db.prepare(
        `INSERT INTO stage_checkpoints
         (attempt_id, workdir, status, captured_before_at)
         VALUES (?, ?, ?, ?)`,
      ).run("a2", "/tmp", "capturing", 1),
    ).not.toThrow();
  });

  it("cascades on stage_attempts delete", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    db.exec("PRAGMA foreign_keys = ON");

    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
       VALUES ('a1','t1','v1','s1',1,1,'running','regular')`,
    ).run();
    db.prepare(
      `INSERT INTO stage_checkpoints
       (attempt_id, workdir, status, captured_before_at)
       VALUES ('a1', '/tmp', 'capturing', 1)`,
    ).run();

    db.prepare(`DELETE FROM stage_attempts WHERE attempt_id = ?`).run("a1");
    const count = (db.prepare(
      `SELECT COUNT(*) AS c FROM stage_checkpoints WHERE attempt_id = ?`,
    ).get("a1") as { c: number }).c;
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/ir/sql.checkpoint.test.ts`
Expected: FAIL — `no such table: stage_checkpoints`.

- [ ] **Step 3: Append DDL to `sql.ts`**

Open `apps/server/src/kernel-next/ir/sql.ts`. Find the existing closing backtick of the `KERNEL_NEXT_SCHEMA_SQL` constant (after the `agent_execution_details` index on `last_heartbeat_at`, around line 190). Insert **before** the closing backtick:

```sql

CREATE TABLE IF NOT EXISTS stage_checkpoints (
  attempt_id          TEXT PRIMARY KEY
                      REFERENCES stage_attempts(attempt_id) ON DELETE CASCADE,
  workdir             TEXT NOT NULL,
  before_sha          TEXT,
  after_sha           TEXT,
  diff_text           TEXT,
  diff_bytes          INTEGER,
  status              TEXT NOT NULL CHECK (status IN (
                        'capturing',
                        'captured',
                        'before_failed',
                        'after_failed',
                        'not_a_repo',
                        'disabled',
                        'diff_too_large'
                      )),
  diagnostic          TEXT,
  captured_before_at  INTEGER NOT NULL,
  captured_after_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sc_status
  ON stage_checkpoints(status);
CREATE INDEX IF NOT EXISTS idx_sc_has_diff
  ON stage_checkpoints(attempt_id)
  WHERE diff_text IS NOT NULL;
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/ir/sql.checkpoint.test.ts`
Expected: PASS (3 tests).

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/ir/sql.ts apps/server/src/kernel-next/ir/sql.checkpoint.test.ts
git commit -m "$(cat <<'EOF'
feat(checkpoint): stage_checkpoints DDL + FK + status CHECK

New table with attempt_id PK (CASCADE from stage_attempts), 7 status
enum values, status + partial has_diff indices. Foundation for
Phase 4.5 Step 1 (A1 field #7).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `checkpoint/types.ts`

**Files:**
- Create: `apps/server/src/kernel-next/runtime/checkpoint/types.ts`

- [ ] **Step 1: Create the types file**

```ts
// Checkpoint module — shared types.
//
// Row lifecycle:
//   capturing       → captureBefore inserted, waiting for captureAfter
//   captured        → captureAfter completed happy-path
//   before_failed   → captureBefore could not resolve before_sha (terminal)
//   after_failed    → captureBefore OK; captureAfter saw error
//   not_a_repo      → workdir exists but is not a git repository (terminal)
//   disabled        → workdir missing at hook-fire time (terminal)
//   diff_too_large  → diff exceeded MAX_DIFF_BYTES cap; before/after SHAs kept

export type CheckpointStatus =
  | "capturing"
  | "captured"
  | "before_failed"
  | "after_failed"
  | "not_a_repo"
  | "disabled"
  | "diff_too_large";

export interface CheckpointTimeouts {
  revParseMs: number;
  stashCreateMs: number;
  diffMs: number;
}

export interface CheckpointConfig {
  enabled?: boolean;
  workdir?: string;
  maxDiffBytes?: number;
  timeouts?: Partial<CheckpointTimeouts>;
}

export interface ResolvedCheckpointConfig {
  enabled: boolean;
  workdir: string;
  maxDiffBytes: number;
  timeouts: CheckpointTimeouts;
}

export interface CheckpointRow {
  attempt_id: string;
  workdir: string;
  before_sha: string | null;
  after_sha: string | null;
  diff_text: string | null;
  diff_bytes: number | null;
  status: CheckpointStatus;
  diagnostic: string | null;
  captured_before_at: number;
  captured_after_at: number | null;
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export const DEFAULT_CHECKPOINT_TIMEOUTS: CheckpointTimeouts = {
  revParseMs: 5_000,
  stashCreateMs: 10_000,
  diffMs: 10_000,
};

export const DEFAULT_MAX_DIFF_BYTES = 5 * 1024 * 1024;
```

- [ ] **Step 2: Verify tsc**

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/kernel-next/runtime/checkpoint/types.ts
git commit -m "$(cat <<'EOF'
feat(checkpoint): types module — status enum + config + row shape

Defines CheckpointStatus (7 variants), CheckpointConfig with optional
overrides + ResolvedCheckpointConfig with all-defaults-filled,
CheckpointRow matching table shape, GitResult for git-commands, and
DEFAULT_CHECKPOINT_TIMEOUTS / DEFAULT_MAX_DIFF_BYTES constants.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `checkpoint/git-commands.ts`

**Files:**
- Create: `apps/server/src/kernel-next/runtime/checkpoint/git-commands.ts`
- Create: `apps/server/src/kernel-next/runtime/checkpoint/git-commands.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `git-commands.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  isGitRepo,
  gitRevParseHead,
  gitStashCreate,
  gitDiff,
} from "./git-commands.js";

const exec = promisify(execFile);

async function initRepo(dir: string) {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-qm", "init"], { cwd: dir });
}

describe("git-commands", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "checkpoint-git-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("isGitRepo — returns true for initialised repo", async () => {
    await initRepo(dir);
    expect(await isGitRepo(dir, 5_000)).toBe(true);
  });

  it("isGitRepo — returns false for plain tmpdir", async () => {
    expect(await isGitRepo(dir, 5_000)).toBe(false);
  });

  it("isGitRepo — returns false for non-existent path", async () => {
    expect(await isGitRepo(join(dir, "nope"), 5_000)).toBe(false);
  });

  it("gitRevParseHead — returns SHA on HEAD", async () => {
    await initRepo(dir);
    const r = await gitRevParseHead(dir, 5_000);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
  });

  it("gitRevParseHead — ok=false on bare dir (no HEAD)", async () => {
    const r = await gitRevParseHead(dir, 5_000);
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("gitStashCreate — empty stdout on clean tree", async () => {
    await initRepo(dir);
    const r = await gitStashCreate(dir, 10_000);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe("");
  });

  it("gitStashCreate — SHA on dirty tree", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "a.txt"), "change\n");
    const r = await gitStashCreate(dir, 10_000);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
  });

  it("gitStashCreate — includes untracked (-u)", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "new.txt"), "new\n");
    const r = await gitStashCreate(dir, 10_000);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toMatch(/^[a-f0-9]{40}$/);
    const sha = r.stdout.trim();
    const show = await exec("git", ["show", "--stat", sha], { cwd: dir });
    expect(show.stdout).toContain("new.txt");
  });

  it("gitDiff — returns unified diff between two SHAs", async () => {
    await initRepo(dir);
    const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    await writeFile(join(dir, "b.txt"), "line\n");
    const afterStash = await gitStashCreate(dir, 10_000);
    const after = afterStash.stdout.trim();
    const r = await gitDiff(dir, before, after, 10_000);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("b.txt");
    expect(r.stdout).toContain("+line");
  });

  it("gitDiff — ok=false on invalid SHA", async () => {
    await initRepo(dir);
    const r = await gitDiff(dir, "deadbeef", "cafef00d", 10_000);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/checkpoint/git-commands.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `git-commands.ts`**

```ts
// Minimal, structured wrappers around git subcommands used by the
// checkpoint module. None throw — failure always surfaces as ok=false
// on GitResult. All respect per-call timeouts via spawnWithTimeout.

import { spawnWithTimeout } from "../../../lib/spawn-utils.js";
import type { GitResult } from "./types.js";

const EXTRA_PATH = "/opt/homebrew/bin:/usr/local/bin";

function buildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${process.env.PATH ?? ""}:${EXTRA_PATH}`,
    // Ensure predictable output regardless of user's git config.
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

async function run(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<GitResult> {
  try {
    const r = await spawnWithTimeout("git", args, {
      cwd,
      timeoutMs,
      env: buildEnv(),
    });
    return {
      ok: !r.timedOut && r.exitCode === 0,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
    };
  } catch (err) {
    // spawnWithTimeout itself rarely throws (spawn failure). Represent
    // it as a non-ok GitResult so callers don't need try/catch.
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
      timedOut: false,
    };
  }
}

export async function isGitRepo(cwd: string, timeoutMs: number): Promise<boolean> {
  const r = await run(["rev-parse", "--is-inside-work-tree"], cwd, timeoutMs);
  return r.ok && r.stdout.trim() === "true";
}

export async function gitRevParseHead(
  cwd: string,
  timeoutMs: number,
): Promise<GitResult> {
  return run(["rev-parse", "HEAD"], cwd, timeoutMs);
}

export async function gitStashCreate(
  cwd: string,
  timeoutMs: number,
): Promise<GitResult> {
  // `-u` includes untracked files. Clean tree → empty stdout, exit 0.
  return run(["stash", "create", "-u"], cwd, timeoutMs);
}

export async function gitDiff(
  cwd: string,
  from: string,
  to: string,
  timeoutMs: number,
): Promise<GitResult> {
  return run(["diff", "--no-color", from, to], cwd, timeoutMs);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/checkpoint/git-commands.test.ts`
Expected: PASS (10 tests).

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/runtime/checkpoint/git-commands.ts apps/server/src/kernel-next/runtime/checkpoint/git-commands.test.ts
git commit -m "$(cat <<'EOF'
feat(checkpoint): git-commands over spawnWithTimeout

isGitRepo / gitRevParseHead / gitStashCreate / gitDiff — structured
GitResult, never throws, uses `git stash create -u` to produce
dangling commit SHAs without mutating refs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `checkpoint/checkpoint.ts` — core capture logic (unit-tested)

**Files:**
- Create: `apps/server/src/kernel-next/runtime/checkpoint/checkpoint.ts`
- Create: `apps/server/src/kernel-next/runtime/checkpoint/checkpoint.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `checkpoint.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../ir/sql.js";
import {
  captureBefore,
  captureAfter,
  resolveCheckpointConfig,
} from "./checkpoint.js";
import type { CheckpointDeps, GitResult } from "./checkpoint.js";
import {
  DEFAULT_CHECKPOINT_TIMEOUTS,
  DEFAULT_MAX_DIFF_BYTES,
} from "./types.js";

function mkDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  db.exec("PRAGMA foreign_keys = OFF");
  return db;
}

function insertAttempt(db: DatabaseSync, attemptId: string) {
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
     VALUES (?, 't1', 'v1', 's1', 1, 1, 'running', 'regular')`,
  ).run(attemptId);
}

function ok(stdout: string): GitResult {
  return { ok: true, stdout, stderr: "", exitCode: 0, timedOut: false };
}
function fail(stderr: string, exit = 1): GitResult {
  return { ok: false, stdout: "", stderr, exitCode: exit, timedOut: false };
}

function mkDeps(overrides: Partial<CheckpointDeps> = {}): CheckpointDeps {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    gitRevParseHead: vi.fn().mockResolvedValue(ok("a".repeat(40))),
    gitStashCreate: vi.fn().mockResolvedValue(ok("b".repeat(40))),
    gitDiff: vi.fn().mockResolvedValue(ok("diff body")),
    pathExists: vi.fn().mockResolvedValue(true),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

const TIMEOUTS = DEFAULT_CHECKPOINT_TIMEOUTS;

describe("resolveCheckpointConfig", () => {
  it("fills defaults", () => {
    const r = resolveCheckpointConfig(undefined);
    expect(r.enabled).toBe(true);
    expect(r.workdir).toBe(process.cwd());
    expect(r.maxDiffBytes).toBe(DEFAULT_MAX_DIFF_BYTES);
    expect(r.timeouts).toEqual(DEFAULT_CHECKPOINT_TIMEOUTS);
  });

  it("respects explicit overrides", () => {
    const r = resolveCheckpointConfig({
      enabled: false,
      workdir: "/x",
      maxDiffBytes: 1,
      timeouts: { revParseMs: 999 },
    });
    expect(r.enabled).toBe(false);
    expect(r.workdir).toBe("/x");
    expect(r.maxDiffBytes).toBe(1);
    expect(r.timeouts.revParseMs).toBe(999);
    expect(r.timeouts.stashCreateMs).toBe(DEFAULT_CHECKPOINT_TIMEOUTS.stashCreateMs);
  });
});

describe("captureBefore", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = mkDb();
    insertAttempt(db, "a1");
  });

  it("happy path — writes status='capturing' with stash SHA", async () => {
    const deps = mkDeps();
    await captureBefore(db, deps, { attemptId: "a1", workdir: "/repo", timeouts: TIMEOUTS });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("capturing");
    expect(row.before_sha).toBe("b".repeat(40));
    expect(row.workdir).toBe("/repo");
    expect(row.captured_before_at).toBe(1_700_000_000_000);
  });

  it("clean tree — stash returns empty, falls back to rev-parse HEAD", async () => {
    const deps = mkDeps({
      gitStashCreate: vi.fn().mockResolvedValue(ok("")),
      gitRevParseHead: vi.fn().mockResolvedValue(ok("c".repeat(40))),
    });
    await captureBefore(db, deps, { attemptId: "a1", workdir: "/repo", timeouts: TIMEOUTS });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("capturing");
    expect(row.before_sha).toBe("c".repeat(40));
  });

  it("workdir missing — status='disabled'", async () => {
    const deps = mkDeps({ pathExists: vi.fn().mockResolvedValue(false) });
    await captureBefore(db, deps, { attemptId: "a1", workdir: "/gone", timeouts: TIMEOUTS });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("disabled");
    expect(row.before_sha).toBeNull();
    expect(row.diagnostic).toContain("workdir");
  });

  it("not a git repo — status='not_a_repo'", async () => {
    const deps = mkDeps({ isGitRepo: vi.fn().mockResolvedValue(false) });
    await captureBefore(db, deps, { attemptId: "a1", workdir: "/plain", timeouts: TIMEOUTS });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("not_a_repo");
  });

  it("both stash and rev-parse fail — status='before_failed' with diagnostic", async () => {
    const deps = mkDeps({
      gitStashCreate: vi.fn().mockResolvedValue(fail("stash boom")),
      gitRevParseHead: vi.fn().mockResolvedValue(fail("head boom")),
    });
    await captureBefore(db, deps, { attemptId: "a1", workdir: "/repo", timeouts: TIMEOUTS });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("before_failed");
    expect(row.diagnostic).toContain("head boom");
  });

  it("second call is a no-op (PK collision swallowed)", async () => {
    const deps = mkDeps();
    await captureBefore(db, deps, { attemptId: "a1", workdir: "/repo", timeouts: TIMEOUTS });
    await captureBefore(db, deps, { attemptId: "a1", workdir: "/repo", timeouts: TIMEOUTS });
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM stage_checkpoints`).get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe("captureAfter", () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = mkDb();
    insertAttempt(db, "a1");
  });

  async function seedCapturing(workdir = "/repo") {
    const deps = mkDeps();
    await captureBefore(db, deps, { attemptId: "a1", workdir, timeouts: TIMEOUTS });
  }

  it("no prior row — no-op", async () => {
    const deps = mkDeps();
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: TIMEOUTS,
    });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get();
    expect(row).toBeUndefined();
  });

  it("happy path — fills after_sha + diff_text + bytes + status='captured'", async () => {
    await seedCapturing();
    const deps = mkDeps({
      gitStashCreate: vi.fn().mockResolvedValue(ok("d".repeat(40))),
      gitDiff: vi.fn().mockResolvedValue(ok("DIFF")),
    });
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: TIMEOUTS,
    });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("captured");
    expect(row.after_sha).toBe("d".repeat(40));
    expect(row.diff_text).toBe("DIFF");
    expect(row.diff_bytes).toBe(4);
    expect(row.captured_after_at).toBe(1_700_000_000_000);
  });

  it("diff over cap — status='diff_too_large', diff_text=null, diff_bytes kept", async () => {
    await seedCapturing();
    const big = "x".repeat(1024);
    const deps = mkDeps({
      gitStashCreate: vi.fn().mockResolvedValue(ok("d".repeat(40))),
      gitDiff: vi.fn().mockResolvedValue(ok(big)),
    });
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: 100, timeouts: TIMEOUTS,
    });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("diff_too_large");
    expect(row.after_sha).toBe("d".repeat(40));
    expect(row.diff_text).toBeNull();
    expect(row.diff_bytes).toBe(1024);
    expect(row.diagnostic).toContain("diff exceeded");
  });

  it("diff command fails — status='after_failed', after_sha kept, diff_text=null", async () => {
    await seedCapturing();
    const deps = mkDeps({
      gitStashCreate: vi.fn().mockResolvedValue(ok("d".repeat(40))),
      gitDiff: vi.fn().mockResolvedValue(fail("diff boom")),
    });
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: TIMEOUTS,
    });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("after_failed");
    expect(row.after_sha).toBe("d".repeat(40));
    expect(row.diff_text).toBeNull();
    expect(row.diagnostic).toContain("diff boom");
  });

  it("after SHA resolution fails — status='after_failed', after_sha=null", async () => {
    await seedCapturing();
    const deps = mkDeps({
      gitStashCreate: vi.fn().mockResolvedValue(fail("stash boom")),
      gitRevParseHead: vi.fn().mockResolvedValue(fail("head boom")),
    });
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: TIMEOUTS,
    });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("after_failed");
    expect(row.after_sha).toBeNull();
    expect(row.diff_text).toBeNull();
  });

  it("second call is no-op (row already 'captured')", async () => {
    await seedCapturing();
    const deps = mkDeps({
      gitStashCreate: vi.fn().mockResolvedValue(ok("d".repeat(40))),
      gitDiff: vi.fn().mockResolvedValue(ok("DIFF")),
    });
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: TIMEOUTS,
    });
    // second call with different mocked data should NOT overwrite
    const deps2 = mkDeps({
      gitStashCreate: vi.fn().mockResolvedValue(ok("e".repeat(40))),
      gitDiff: vi.fn().mockResolvedValue(ok("DIFF2")),
    });
    await captureAfter(db, deps2, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: TIMEOUTS,
    });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.after_sha).toBe("d".repeat(40));
    expect(row.diff_text).toBe("DIFF");
  });

  it("prior status terminal (not_a_repo) — captureAfter no-ops", async () => {
    const deps = mkDeps({ isGitRepo: vi.fn().mockResolvedValue(false) });
    await captureBefore(db, deps, { attemptId: "a1", workdir: "/repo", timeouts: TIMEOUTS });
    const depsAfter = mkDeps();
    await captureAfter(db, depsAfter, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: TIMEOUTS,
    });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("not_a_repo");
    expect(row.after_sha).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/checkpoint/checkpoint.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `checkpoint.ts`**

```ts
// Checkpoint capture — pure coordination layer between git-commands,
// sqlite, and the runner's PortRuntime hooks.
//
// Two write phases:
//   captureBefore: fires on attempt start, INSERTs a row. Terminal
//                  statuses (not_a_repo, disabled, before_failed) end
//                  the checkpoint here; 'capturing' means captureAfter
//                  may still fire.
//   captureAfter : UPDATEs the row with after_sha / diff_text / final
//                  status. No-op when row doesn't exist, or when the
//                  row has already left the 'capturing' state.
//
// Invariant: these functions never throw. Every DB / git failure is
// captured in the row's diagnostic column or swallowed via logger.warn.

import type { DatabaseSync } from "node:sqlite";
import { logger } from "../../../lib/logger.js";
import type {
  CheckpointConfig,
  CheckpointTimeouts,
  GitResult,
  ResolvedCheckpointConfig,
} from "./types.js";
import {
  DEFAULT_CHECKPOINT_TIMEOUTS,
  DEFAULT_MAX_DIFF_BYTES,
} from "./types.js";

export type { CheckpointConfig, GitResult, ResolvedCheckpointConfig } from "./types.js";

export interface CheckpointDeps {
  isGitRepo: (cwd: string, timeoutMs: number) => Promise<boolean>;
  gitRevParseHead: (cwd: string, timeoutMs: number) => Promise<GitResult>;
  gitStashCreate: (cwd: string, timeoutMs: number) => Promise<GitResult>;
  gitDiff: (cwd: string, from: string, to: string, timeoutMs: number) => Promise<GitResult>;
  pathExists: (p: string) => Promise<boolean>;
  now: () => number;
}

export function resolveCheckpointConfig(
  config: CheckpointConfig | undefined,
): ResolvedCheckpointConfig {
  return {
    enabled: config?.enabled ?? true,
    workdir: config?.workdir ?? process.cwd(),
    maxDiffBytes: config?.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
    timeouts: {
      revParseMs: config?.timeouts?.revParseMs ?? DEFAULT_CHECKPOINT_TIMEOUTS.revParseMs,
      stashCreateMs: config?.timeouts?.stashCreateMs ?? DEFAULT_CHECKPOINT_TIMEOUTS.stashCreateMs,
      diffMs: config?.timeouts?.diffMs ?? DEFAULT_CHECKPOINT_TIMEOUTS.diffMs,
    },
  };
}

/**
 * Phase 1: INSERT a stage_checkpoints row describing the pre-attempt
 * state. Terminal statuses short-circuit Phase 2; otherwise row sits
 * at status='capturing' awaiting captureAfter.
 */
export async function captureBefore(
  db: DatabaseSync,
  deps: CheckpointDeps,
  args: {
    attemptId: string;
    workdir: string;
    timeouts: CheckpointTimeouts;
  },
): Promise<void> {
  const { attemptId, workdir, timeouts } = args;
  try {
    const exists = await deps.pathExists(workdir);
    if (!exists) {
      insertRow(db, {
        attempt_id: attemptId,
        workdir,
        status: "disabled",
        diagnostic: `workdir not found: ${workdir}`,
        before_sha: null,
        captured_before_at: deps.now(),
      });
      return;
    }

    const isRepo = await deps.isGitRepo(workdir, timeouts.revParseMs);
    if (!isRepo) {
      insertRow(db, {
        attempt_id: attemptId,
        workdir,
        status: "not_a_repo",
        diagnostic: null,
        before_sha: null,
        captured_before_at: deps.now(),
      });
      return;
    }

    const beforeSha = await resolveSha(deps, workdir, timeouts);
    if (beforeSha.kind === "error") {
      insertRow(db, {
        attempt_id: attemptId,
        workdir,
        status: "before_failed",
        diagnostic: beforeSha.diagnostic,
        before_sha: null,
        captured_before_at: deps.now(),
      });
      return;
    }

    insertRow(db, {
      attempt_id: attemptId,
      workdir,
      status: "capturing",
      diagnostic: null,
      before_sha: beforeSha.sha,
      captured_before_at: deps.now(),
    });
  } catch (err) {
    logger.warn(
      { attemptId, err: err instanceof Error ? err.message : String(err) },
      "[checkpoint] captureBefore swallowed error",
    );
  }
}

/**
 * Phase 2: UPDATE the row with after_sha, diff_text, and final status.
 * No-op if row missing or row has already progressed past 'capturing'.
 */
export async function captureAfter(
  db: DatabaseSync,
  deps: CheckpointDeps,
  args: {
    attemptId: string;
    maxDiffBytes: number;
    timeouts: CheckpointTimeouts;
  },
): Promise<void> {
  const { attemptId, maxDiffBytes, timeouts } = args;
  try {
    const row = db
      .prepare(
        `SELECT workdir, before_sha, status FROM stage_checkpoints WHERE attempt_id = ?`,
      )
      .get(attemptId) as
      | { workdir: string; before_sha: string | null; status: string }
      | undefined;
    if (!row) return;
    if (row.status !== "capturing") return;
    if (row.before_sha == null) return;

    const afterSha = await resolveSha(deps, row.workdir, timeouts);
    if (afterSha.kind === "error") {
      db.prepare(
        `UPDATE stage_checkpoints
         SET status = 'after_failed',
             after_sha = NULL,
             diff_text = NULL,
             diagnostic = ?,
             captured_after_at = ?
         WHERE attempt_id = ?`,
      ).run(afterSha.diagnostic, deps.now(), attemptId);
      return;
    }

    const diffRes = await deps.gitDiff(
      row.workdir, row.before_sha, afterSha.sha, timeouts.diffMs,
    );
    if (!diffRes.ok) {
      db.prepare(
        `UPDATE stage_checkpoints
         SET status = 'after_failed',
             after_sha = ?,
             diff_text = NULL,
             diagnostic = ?,
             captured_after_at = ?
         WHERE attempt_id = ?`,
      ).run(
        afterSha.sha,
        `git diff failed: ${diffRes.stderr || `exit ${diffRes.exitCode}`}`,
        deps.now(),
        attemptId,
      );
      return;
    }

    const diffText = diffRes.stdout;
    const diffBytes = Buffer.byteLength(diffText);
    if (diffBytes > maxDiffBytes) {
      db.prepare(
        `UPDATE stage_checkpoints
         SET status = 'diff_too_large',
             after_sha = ?,
             diff_text = NULL,
             diff_bytes = ?,
             diagnostic = ?,
             captured_after_at = ?
         WHERE attempt_id = ?`,
      ).run(
        afterSha.sha,
        diffBytes,
        `diff exceeded maxDiffBytes (${diffBytes} > ${maxDiffBytes})`,
        deps.now(),
        attemptId,
      );
      return;
    }

    db.prepare(
      `UPDATE stage_checkpoints
       SET status = 'captured',
           after_sha = ?,
           diff_text = ?,
           diff_bytes = ?,
           captured_after_at = ?
       WHERE attempt_id = ?`,
    ).run(afterSha.sha, diffText, diffBytes, deps.now(), attemptId);
  } catch (err) {
    logger.warn(
      { attemptId, err: err instanceof Error ? err.message : String(err) },
      "[checkpoint] captureAfter swallowed error",
    );
  }
}

// ---- Helpers -------------------------------------------------------

type ShaResult =
  | { kind: "ok"; sha: string }
  | { kind: "error"; diagnostic: string };

async function resolveSha(
  deps: CheckpointDeps,
  workdir: string,
  timeouts: CheckpointTimeouts,
): Promise<ShaResult> {
  const stash = await deps.gitStashCreate(workdir, timeouts.stashCreateMs);
  if (stash.ok && stash.stdout.trim() !== "") {
    return { kind: "ok", sha: stash.stdout.trim() };
  }
  const head = await deps.gitRevParseHead(workdir, timeouts.revParseMs);
  if (head.ok && head.stdout.trim() !== "") {
    return { kind: "ok", sha: head.stdout.trim() };
  }
  const diag =
    !stash.ok && !head.ok
      ? `stash create failed: ${stash.stderr || `exit ${stash.exitCode}`}; rev-parse HEAD failed: ${head.stderr || `exit ${head.exitCode}`}`
      : !head.ok
        ? `rev-parse HEAD failed: ${head.stderr || `exit ${head.exitCode}`}`
        : `stash create returned empty, rev-parse HEAD returned empty`;
  return { kind: "error", diagnostic: diag };
}

function insertRow(
  db: DatabaseSync,
  row: {
    attempt_id: string;
    workdir: string;
    status: string;
    diagnostic: string | null;
    before_sha: string | null;
    captured_before_at: number;
  },
): void {
  try {
    db.prepare(
      `INSERT INTO stage_checkpoints
       (attempt_id, workdir, before_sha, status, diagnostic, captured_before_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      row.attempt_id,
      row.workdir,
      row.before_sha,
      row.status,
      row.diagnostic,
      row.captured_before_at,
    );
  } catch (err) {
    // PK collision on duplicate captureBefore is expected; any other
    // failure is swallowed here and surfaces via logger above.
    logger.warn(
      { attemptId: row.attempt_id, err: err instanceof Error ? err.message : String(err) },
      "[checkpoint] INSERT stage_checkpoints failed",
    );
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/checkpoint/checkpoint.test.ts`
Expected: PASS (all cases).

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/runtime/checkpoint/checkpoint.ts apps/server/src/kernel-next/runtime/checkpoint/checkpoint.test.ts
git commit -m "$(cat <<'EOF'
feat(checkpoint): captureBefore / captureAfter with DI + never-throw

Two-phase write: Phase 1 INSERTs the row (terminal statuses short-
circuit Phase 2); Phase 2 UPDATEs with after_sha + diff. resolveSha
falls back stash -> rev-parse HEAD. All errors land in diagnostic
column, never propagate. Includes resolveCheckpointConfig that fills
defaults (enabled=true, workdir=cwd, 5MiB cap, 5/10/10s timeouts).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `checkpoint/checkpoint.integration.test.ts` — real tmp git repo

**Files:**
- Create: `apps/server/src/kernel-next/runtime/checkpoint/checkpoint.integration.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, appendFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../../ir/sql.js";
import { captureBefore, captureAfter } from "./checkpoint.js";
import type { CheckpointDeps } from "./checkpoint.js";
import {
  isGitRepo,
  gitRevParseHead,
  gitStashCreate,
  gitDiff,
} from "./git-commands.js";
import { DEFAULT_CHECKPOINT_TIMEOUTS, DEFAULT_MAX_DIFF_BYTES } from "./types.js";

const exec = promisify(execFile);

function mkDeps(): CheckpointDeps {
  return {
    isGitRepo,
    gitRevParseHead,
    gitStashCreate,
    gitDiff,
    pathExists: async (p) => access(p).then(() => true).catch(() => false),
    now: () => Date.now(),
  };
}

function mkDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    `INSERT INTO stage_attempts
     (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status, kind)
     VALUES ('a1', 't1', 'v1', 's1', 1, 1, 'running', 'regular')`,
  ).run();
  return db;
}

async function initRepo(dir: string) {
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await exec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "README.md"), "initial\n");
  await exec("git", ["add", "."], { cwd: dir });
  await exec("git", ["commit", "-qm", "init"], { cwd: dir });
}

describe("checkpoint integration (real git)", () => {
  let dir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "checkpoint-e2e-"));
    db = mkDb();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("end-to-end dirty tree: diff_text contains modified file", async () => {
    await initRepo(dir);
    const deps = mkDeps();
    await captureBefore(db, deps, { attemptId: "a1", workdir: dir, timeouts: DEFAULT_CHECKPOINT_TIMEOUTS });
    // modify tracked file between hooks
    await appendFile(join(dir, "README.md"), "added line\n");
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: DEFAULT_CHECKPOINT_TIMEOUTS,
    });

    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("captured");
    expect(row.before_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(row.after_sha).toMatch(/^[a-f0-9]{40}$/);
    expect(row.diff_text).toContain("README.md");
    expect(row.diff_text).toContain("+added line");
  });

  it("untracked files captured (-u)", async () => {
    await initRepo(dir);
    const deps = mkDeps();
    await captureBefore(db, deps, { attemptId: "a1", workdir: dir, timeouts: DEFAULT_CHECKPOINT_TIMEOUTS });
    await writeFile(join(dir, "fresh.txt"), "hello\n");
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: DEFAULT_CHECKPOINT_TIMEOUTS,
    });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("captured");
    expect(row.diff_text).toContain("fresh.txt");
  });

  it("clean tree both ends: before_sha equals after_sha, diff empty", async () => {
    await initRepo(dir);
    const deps = mkDeps();
    await captureBefore(db, deps, { attemptId: "a1", workdir: dir, timeouts: DEFAULT_CHECKPOINT_TIMEOUTS });
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: DEFAULT_CHECKPOINT_TIMEOUTS,
    });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("captured");
    expect(row.before_sha).toBe(row.after_sha);
    expect(row.diff_text).toBe("");
  });

  it("not a repo: captureBefore writes status='not_a_repo', captureAfter no-ops", async () => {
    // dir exists but is never `git init`ed
    const deps = mkDeps();
    await captureBefore(db, deps, { attemptId: "a1", workdir: dir, timeouts: DEFAULT_CHECKPOINT_TIMEOUTS });
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: DEFAULT_CHECKPOINT_TIMEOUTS,
    });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("not_a_repo");
    expect(row.before_sha).toBeNull();
    expect(row.after_sha).toBeNull();
  });

  it("diff after git reset: reflects reset state (post vs before_sha)", async () => {
    await initRepo(dir);
    const deps = mkDeps();
    // stage some change before the attempt starts
    await appendFile(join(dir, "README.md"), "pre-attempt change\n");
    await captureBefore(db, deps, { attemptId: "a1", workdir: dir, timeouts: DEFAULT_CHECKPOINT_TIMEOUTS });
    // agent makes further changes, then undoes them entirely
    await writeFile(join(dir, "extra.txt"), "tmp\n");
    await exec("git", ["checkout", "--", "README.md"], { cwd: dir });
    await rm(join(dir, "extra.txt"));
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: DEFAULT_CHECKPOINT_TIMEOUTS,
    });
    const row = db.prepare(`SELECT * FROM stage_checkpoints WHERE attempt_id='a1'`).get() as any;
    expect(row.status).toBe("captured");
    // after_sha reflects clean state (falls back to HEAD since stash-create
    // of a clean tree returns empty). diff from before_sha (which had the
    // pre-attempt change) to HEAD shows the REMOVAL of that change.
    expect(row.diff_text).toContain("pre-attempt change");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/checkpoint/checkpoint.integration.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/kernel-next/runtime/checkpoint/checkpoint.integration.test.ts
git commit -m "$(cat <<'EOF'
test(checkpoint): end-to-end with real tmp git repos

5 scenarios: dirty tracked file, untracked addition, clean tree,
non-repo workdir, reset-to-clean. Uses mkdtemp + git init + real
git subprocesses — validates the integration of git-commands,
checkpoint.ts, and sqlite schema under real conditions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `PortRuntime` — add optional `AttemptHooks`

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/port-runtime.ts`
- Modify: `apps/server/src/kernel-next/runtime/port-runtime.test.ts` (add 2 cases)

- [ ] **Step 1: Write failing tests**

Append to `apps/server/src/kernel-next/runtime/port-runtime.test.ts` (inside the top-level `describe`, before the closing `});`):

```ts
  describe("AttemptHooks", () => {
    it("invokes onAttemptStarted with attemptId after INSERT", () => {
      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);
      const seen: string[] = [];
      const dispatcher = { send: () => {} };
      const rt = new PortRuntime(db, dispatcher, "regular", undefined, {
        onAttemptStarted: (attemptId) => seen.push(attemptId),
      });
      const { attemptId } = rt.startAttempt({
        taskId: "t1", versionHash: "v1", stageName: "s1",
      });
      expect(seen).toEqual([attemptId]);
      // Row must already be in the DB when the hook fires so a
      // checkpoint INSERT with FK passes.
      const row = db.prepare(
        `SELECT attempt_id FROM stage_attempts WHERE attempt_id = ?`,
      ).get(attemptId);
      expect(row).toBeDefined();
    });

    it("invokes onAttemptFinishing with attemptId before UPDATE", () => {
      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);
      const dispatcher = { send: () => {} };
      let sawRunning = false;
      const rt = new PortRuntime(db, dispatcher, "regular", undefined, {
        onAttemptFinishing: (attemptId) => {
          const row = db.prepare(
            `SELECT status FROM stage_attempts WHERE attempt_id = ?`,
          ).get(attemptId) as { status: string } | undefined;
          // At hook-fire time, the UPDATE hasn't landed yet, so status
          // should still be 'running'.
          if (row?.status === "running") sawRunning = true;
        },
      });
      const { attemptId } = rt.startAttempt({
        taskId: "t1", versionHash: "v1", stageName: "s1",
      });
      rt.finishAttempt(attemptId, "success");
      expect(sawRunning).toBe(true);
    });
  });
```

Add imports at the top of the file if missing:

```ts
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
```

(If the file already has these imports, skip.)

- [ ] **Step 2: Run to verify fail**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/port-runtime.test.ts -t "AttemptHooks"`
Expected: FAIL — constructor does not accept 5th argument.

- [ ] **Step 3: Modify `port-runtime.ts`**

Edit `apps/server/src/kernel-next/runtime/port-runtime.ts`:

**Add the `AttemptHooks` interface** (insert after the `PortWrittenHook` interface declaration, around line 83):

```ts
// Fire-and-forget hooks invoked by startAttempt / finishAttempt so the
// runner can thread checkpoint capture (and any future observational
// side-effect) around the lifecycle without the PortRuntime having to
// know about it. Hooks return `void` and MUST handle their own errors
// — PortRuntime does not await or catch.
export interface AttemptHooks {
  onAttemptStarted?: (attemptId: string, args: StartAttemptArgs) => void;
  onAttemptFinishing?: (attemptId: string) => void;
}
```

**Change the constructor signature** — find the existing constructor (lines ~85–101) and add a 5th parameter:

```ts
  constructor(
    private readonly db: DatabaseSync,
    private readonly dispatcher: EventDispatcher,
    private readonly defaultKind: AttemptKind = "regular",
    private readonly onPortWritten?: PortWrittenHook,
    private readonly hooks: AttemptHooks = {},
  ) {}
```

**Fire `onAttemptStarted` at the end of `startAttempt`** — replace the existing `return { attemptId, attemptIdx };` line with:

```ts
    if (this.hooks.onAttemptStarted) {
      try {
        this.hooks.onAttemptStarted(attemptId, args);
      } catch (err) {
        // Synchronous hook errors must not break startAttempt.
        // Hook owners handle their own async errors internally.
      }
    }
    return { attemptId, attemptIdx };
```

**Fire `onAttemptFinishing` at the top of `finishAttempt`** — inside `finishAttempt`, BEFORE the `this.db.prepare(\`UPDATE stage_attempts ...\`)` call:

```ts
  finishAttempt(
    attemptId: string,
    status: AttemptStatus,
    errorMessage?: string,
    options?: { silent?: boolean },
  ): void {
    if (this.hooks.onAttemptFinishing) {
      try {
        this.hooks.onAttemptFinishing(attemptId);
      } catch (err) {
        // see startAttempt — swallow synchronous errors
      }
    }

    this.db.prepare(
      `UPDATE stage_attempts SET ended_at = ?, status = ? WHERE attempt_id = ?`,
    ).run(Date.now(), status, attemptId);
    // ...rest unchanged
```

- [ ] **Step 4: Run all port-runtime tests**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/port-runtime.test.ts`
Expected: PASS (all existing + 2 new cases).

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/runtime/port-runtime.ts apps/server/src/kernel-next/runtime/port-runtime.test.ts
git commit -m "$(cat <<'EOF'
feat(port-runtime): AttemptHooks — onAttemptStarted / onAttemptFinishing

Optional 5th constructor argument. onAttemptStarted fires AFTER the
stage_attempts INSERT (FK target exists). onAttemptFinishing fires
BEFORE the UPDATE to 'success'/'error'/'superseded'. Both are void-
returning; PortRuntime swallows synchronous throws and never awaits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `runner.ts` + `start-pipeline-run.ts` — wire checkpoint hooks

**Files:**
- Modify: `apps/server/src/kernel-next/runtime/runner.ts`
- Modify: `apps/server/src/kernel-next/runtime/start-pipeline-run.ts`
- Modify: `apps/server/src/kernel-next/runtime/runner.test.ts` (add 3 cases)

- [ ] **Step 1: Write failing runner integration tests**

Append to `apps/server/src/kernel-next/runtime/runner.test.ts` (inside the top-level describe, before the closing `});`):

```ts
  describe("checkpointConfig integration", () => {
    it("no rows written when checkpointConfig.enabled=false", async () => {
      // Build a trivial one-stage IR with a mock handler that succeeds.
      const ir = buildSingleStageMockIR();
      const db = mkTestDb(ir);
      await runPipeline({
        db, ir,
        taskId: "t-cp-disabled",
        versionHash: ir.versionHash,
        handlers: { s1: () => ({ out1: "ok" }) },
        checkpointConfig: { enabled: false },
      });
      const count = (db.prepare(
        `SELECT COUNT(*) AS c FROM stage_checkpoints`,
      ).get() as { c: number }).c;
      expect(count).toBe(0);
    });

    it("writes status='not_a_repo' when workdir is a non-git tmpdir", async () => {
      const ir = buildSingleStageMockIR();
      const db = mkTestDb(ir);
      const tmp = await mkdtemp(join(tmpdir(), "runner-cp-"));
      try {
        await runPipeline({
          db, ir,
          taskId: "t-cp-not-repo",
          versionHash: ir.versionHash,
          handlers: { s1: () => ({ out1: "ok" }) },
          checkpointConfig: { enabled: true, workdir: tmp },
        });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      const rows = db.prepare(
        `SELECT status, workdir FROM stage_checkpoints`,
      ).all() as Array<{ status: string; workdir: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.status).toBe("not_a_repo");
      expect(rows[0]?.workdir).toBe(tmp);
    });

    it("each attempt gets its own checkpoint row", async () => {
      const ir = buildSingleStageMockIR();
      const db = mkTestDb(ir);
      const tmp = await mkdtemp(join(tmpdir(), "runner-cp-"));
      try {
        // two sequential runs share the same task chain but different
        // attempts (both run with enabled=true, non-repo).
        await runPipeline({
          db, ir,
          taskId: "t-cp-multi-1",
          versionHash: ir.versionHash,
          handlers: { s1: () => ({ out1: "ok" }) },
          checkpointConfig: { enabled: true, workdir: tmp },
        });
        await runPipeline({
          db, ir,
          taskId: "t-cp-multi-2",
          versionHash: ir.versionHash,
          handlers: { s1: () => ({ out1: "ok" }) },
          checkpointConfig: { enabled: true, workdir: tmp },
        });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      const rows = db.prepare(
        `SELECT attempt_id FROM stage_checkpoints`,
      ).all() as Array<{ attempt_id: string }>;
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const ids = new Set(rows.map((r) => r.attempt_id));
      expect(ids.size).toBe(rows.length); // all distinct
    });
  });
```

Add imports at the top of `runner.test.ts` if missing:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

**Reuse existing test helpers.** If `runner.test.ts` does not already expose `buildSingleStageMockIR` / `mkTestDb`, inspect the existing helper functions at the top of the file and use whatever single-stage IR constructor the file already uses. Do not invent new helpers — substitute with the file's native helpers and adjust the handler name / output port name to match.

- [ ] **Step 2: Run to verify fail**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/runner.test.ts -t "checkpointConfig integration"`
Expected: FAIL — `checkpointConfig` not a known option.

- [ ] **Step 3: Modify `runner.ts`**

Open `apps/server/src/kernel-next/runtime/runner.ts`.

**Add imports near the other runtime imports** (top of file):

```ts
import { access } from "node:fs/promises";
import {
  captureBefore,
  captureAfter,
  resolveCheckpointConfig,
} from "./checkpoint/checkpoint.js";
import type { CheckpointConfig, CheckpointDeps } from "./checkpoint/checkpoint.js";
import * as gitCommands from "./checkpoint/git-commands.js";
import type { AttemptHooks } from "./port-runtime.js";
```

**Extend `RunnerOptions`** — find the `RunnerOptions` interface (~line 38–70). Add a new optional field before the closing brace:

```ts
  // Phase 4.5 Step 1 — per-task checkpoint config. When omitted,
  // defaults resolve to { enabled: true, workdir: process.cwd(),
  // maxDiffBytes: 5 MiB, timeouts: {5s, 10s, 10s} }. Set
  // enabled: false to disable entirely (no stage_checkpoints rows).
  checkpointConfig?: CheckpointConfig;
```

**Build hooks + deps inside `runPipeline`** — find the `const portRuntime = new PortRuntime(...)` construction (~line 237). Replace that block with:

```ts
  // ---- Phase 4.5 Step 1: checkpoint hooks ---------------------------
  const cpConfig = resolveCheckpointConfig(opts.checkpointConfig);
  const cpDeps: CheckpointDeps = {
    isGitRepo: gitCommands.isGitRepo,
    gitRevParseHead: gitCommands.gitRevParseHead,
    gitStashCreate: gitCommands.gitStashCreate,
    gitDiff: gitCommands.gitDiff,
    pathExists: async (p) => access(p).then(() => true).catch(() => false),
    now: () => Date.now(),
  };
  const checkpointInFlight = new Set<Promise<void>>();
  const trackHook = (p: Promise<void>): void => {
    const wrapped = p.finally(() => { checkpointInFlight.delete(wrapped); });
    checkpointInFlight.add(wrapped);
  };
  const attemptHooks: AttemptHooks = cpConfig.enabled
    ? {
        onAttemptStarted: (attemptId) => trackHook(
          captureBefore(opts.db, cpDeps, {
            attemptId,
            workdir: cpConfig.workdir,
            timeouts: cpConfig.timeouts,
          }),
        ),
        onAttemptFinishing: (attemptId) => trackHook(
          captureAfter(opts.db, cpDeps, {
            attemptId,
            maxDiffBytes: cpConfig.maxDiffBytes,
            timeouts: cpConfig.timeouts,
          }),
        ),
      }
    : {};

  const portRuntime = new PortRuntime(
    opts.db,
    dispatcher,
    "regular",
    opts.broadcaster
      ? ({ stageName, portName, value }) => {
          try {
            opts.broadcaster!.publish({
              type: "port_written",
              taskId: opts.taskId,
              timestamp: new Date().toISOString(),
              data: {
                stage: stageName,
                port: portName,
                valuePreview: truncateJson(value),
              },
            });
          } catch { /* broadcaster failure must not abort the run */ }
        }
      : undefined,
    attemptHooks,
  );
```

**Await in-flight capture before returning** — find the `return finalOutcome;` (or equivalent last statement of `runPipeline` before it resolves); locate where `runPipeline` is wrapped up. Specifically, find the final `} finally { ... }` block (look for `taskRegistry.unregister(opts.taskId)`). Add **immediately before** `taskRegistry.unregister(opts.taskId)`:

```ts
    // Drain pending checkpoint captures before tearing down the task
    // so rows are committed by the time run_final fires.
    if (checkpointInFlight.size > 0) {
      await Promise.allSettled([...checkpointInFlight]);
    }
```

(If there is no existing `finally` that unregisters, place this drain step immediately before the function's final `return` statement.)

- [ ] **Step 4: Modify `start-pipeline-run.ts`**

Open `apps/server/src/kernel-next/runtime/start-pipeline-run.ts`.

**Import the type**:

```ts
import type { CheckpointConfig } from "./checkpoint/checkpoint.js";
```

**Extend `StartPipelineRunInput`** — add optional field before the closing brace:

```ts
  checkpointConfig?: CheckpointConfig;
```

**Forward it in `runPipeline` call** — find the `void runPipeline({ ... })` call inside `startPipelineRun`. Add `checkpointConfig: input.checkpointConfig,` to the options object (same block that passes db, ir, taskId, etc.).

- [ ] **Step 5: Run all runtime tests**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/runtime/`
Expected: PASS (all existing + new cases). If the 3 new runner tests fail with "buildSingleStageMockIR is not defined", substitute with the single-stage IR builder actually present in `runner.test.ts` (see Step 1's note).

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/runtime/runner.ts apps/server/src/kernel-next/runtime/start-pipeline-run.ts apps/server/src/kernel-next/runtime/runner.test.ts
git commit -m "$(cat <<'EOF'
feat(runner): checkpointConfig — wire hooks + drain on teardown

RunnerOptions.checkpointConfig (+ StartPipelineRunInput forwarding).
Builds CheckpointDeps over git-commands + fs.access + Date.now;
tracks in-flight captures via wrapped-promise set; awaits on
Promise.allSettled before task_registry.unregister so SSE run_final
fires after all checkpoint rows are committed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: MCP tool schema — `run_pipeline` accepts `checkpoint_config`

**Files:**
- Modify: `apps/server/src/kernel-next/mcp/server.ts`

- [ ] **Step 1: Read the existing `run_pipeline` tool schema**

Run: `grep -n "run_pipeline\|checkpoint_config\|CheckpointConfig" /Users/minghao/workflow-control/apps/server/src/kernel-next/mcp/server.ts | head -30`
Then `Read` the relevant region to understand the shape of the current schema (likely zod with snake_case input).

- [ ] **Step 2: Write the failing test**

Create `apps/server/src/kernel-next/mcp/server.checkpoint-config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "./kernel.js";
// The MCP server exposes tools; we exercise the KernelService surface
// that the run_pipeline tool resolves into. If the file's public helper
// is createKernelMcp, import that instead and call the handler manually.

// Minimal: verify that startPipelineRun accepts checkpointConfig
// threaded through snake_case parsing in the tool layer.
// (We test the translation, not MCP transport.)

import { startPipelineRun } from "../runtime/start-pipeline-run.js";

describe("run_pipeline tool — checkpoint_config translation", () => {
  it("forwards snake_case checkpoint_config as camelCase to startPipelineRun", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    // Seed a trivial agent-free pipeline via MOCK_HANDLER_REGISTRY.
    // For this test we rely on the fact that startPipelineRun itself
    // accepts checkpointConfig; the MCP layer only has to rename.
    // Build the translation helper at the site of the tool definition
    // and assert it produces the expected input shape.
    // If no such helper is factored out yet, write one and export it.

    // This test doubles as a placeholder that will be adapted once
    // the MCP layer is inspected. The hard requirement: when the MCP
    // tool receives { checkpoint_config: { enabled: false } }, the
    // resulting StartPipelineRunInput contains
    // { checkpointConfig: { enabled: false } }.
    //
    // Implementation: expose a `translateRunPipelineInput` function
    // from mcp/server.ts and assert directly.

    const mod = await import("./server.js");
    const translate = (mod as any).translateRunPipelineInput;
    expect(typeof translate).toBe("function");
    const out = translate({
      name: "x",
      checkpoint_config: {
        enabled: false,
        workdir: "/w",
        max_diff_bytes: 123,
        timeouts: { rev_parse_ms: 1, stash_create_ms: 2, diff_ms: 3 },
      },
    });
    expect(out.checkpointConfig).toEqual({
      enabled: false,
      workdir: "/w",
      maxDiffBytes: 123,
      timeouts: { revParseMs: 1, stashCreateMs: 2, diffMs: 3 },
    });
  });

  it("omits checkpointConfig when absent", async () => {
    const mod = await import("./server.js");
    const translate = (mod as any).translateRunPipelineInput;
    const out = translate({ name: "x" });
    expect(out.checkpointConfig).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run to verify fail**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/mcp/server.checkpoint-config.test.ts`
Expected: FAIL — `translateRunPipelineInput` is not defined.

- [ ] **Step 4: Add schema + translator to `mcp/server.ts`**

In `apps/server/src/kernel-next/mcp/server.ts`, locate the zod schema for the `run_pipeline` tool input. Add a snake_case `checkpoint_config` block:

```ts
// Near the top of the run_pipeline tool's zod input schema, alongside
// name / version_hash / seed_values / etc.:
const CheckpointConfigInputSchema = z.object({
  enabled: z.boolean().optional(),
  workdir: z.string().optional(),
  max_diff_bytes: z.number().int().positive().optional(),
  timeouts: z.object({
    rev_parse_ms: z.number().int().positive().optional(),
    stash_create_ms: z.number().int().positive().optional(),
    diff_ms: z.number().int().positive().optional(),
  }).optional(),
}).optional();

// Extend the existing run_pipeline input zod schema with:
//   checkpoint_config: CheckpointConfigInputSchema,
```

**Export the translator** (keep it colocated with the tool handler):

```ts
import type { CheckpointConfig } from "../runtime/checkpoint/checkpoint.js";
import type { StartPipelineRunInput } from "../runtime/start-pipeline-run.js";

export function translateRunPipelineInput(raw: any): Partial<StartPipelineRunInput> {
  const out: Partial<StartPipelineRunInput> = {};
  if (raw.name !== undefined) out.name = raw.name;
  if (raw.version_hash !== undefined) out.versionHash = raw.version_hash;
  if (raw.task_id !== undefined) out.taskId = raw.task_id;
  if (raw.seed_values !== undefined) out.seedValues = raw.seed_values;
  if (raw.resume_from !== undefined) out.resumeFrom = raw.resume_from;
  // …preserve existing fields as they were…

  const cp = raw.checkpoint_config;
  if (cp !== undefined) {
    const config: CheckpointConfig = {};
    if (cp.enabled !== undefined) config.enabled = cp.enabled;
    if (cp.workdir !== undefined) config.workdir = cp.workdir;
    if (cp.max_diff_bytes !== undefined) config.maxDiffBytes = cp.max_diff_bytes;
    if (cp.timeouts) {
      const t: NonNullable<CheckpointConfig["timeouts"]> = {};
      if (cp.timeouts.rev_parse_ms !== undefined) t.revParseMs = cp.timeouts.rev_parse_ms;
      if (cp.timeouts.stash_create_ms !== undefined) t.stashCreateMs = cp.timeouts.stash_create_ms;
      if (cp.timeouts.diff_ms !== undefined) t.diffMs = cp.timeouts.diff_ms;
      config.timeouts = t;
    }
    out.checkpointConfig = config;
  }
  return out;
}
```

**Inside the `run_pipeline` tool handler**, replace the ad-hoc input-to-startPipelineRun translation with:

```ts
const translated = translateRunPipelineInput(parsedInput);
const result = await startPipelineRun({
  db: this.db,
  broadcaster: this.broadcaster,
  ...translated,
});
```

(If the existing handler spreads fields by name, factor those through `translateRunPipelineInput` so the test can exercise it directly.)

- [ ] **Step 5: Run tests**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/mcp/`
Expected: PASS (including new `server.checkpoint-config.test.ts`).

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/kernel-next/mcp/server.ts apps/server/src/kernel-next/mcp/server.checkpoint-config.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): run_pipeline accepts checkpoint_config

Snake_case zod schema (max_diff_bytes, rev_parse_ms, etc.) +
exported translateRunPipelineInput that maps to the camelCase
StartPipelineRunInput shape. MCP callers can now opt out of
checkpointing or override workdir/caps/timeouts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Roadmap update + done-handoff doc

**Files:**
- Modify: `docs/product-roadmap.md`
- Create: `docs/superpowers/plans/2026-04-24-checkpoint-infra-done-handoff.md`

- [ ] **Step 1: Update roadmap A1 status**

Open `docs/product-roadmap.md`. Find the block near line 181:

```
**Status (2026-04-24 Stage 6)**: kernel-next-adapted A1 landed. Sidecar
table `agent_execution_details` in kernel-next.db captures per-attempt
prompt + tool calls + agent stream + cost + lifecycle. Legacy
`workflow.db.execution_records` table + `lib/execution-record/` module
deleted. `worktree_diff` + `scratch_pad_snapshot` not captured (deferred).
```

Replace with:

```
**Status (2026-04-24 Phase 4.5 Step 1)**: kernel-next-adapted A1 nearly
complete. Sidecar table `agent_execution_details` in kernel-next.db
captures per-attempt prompt + tool calls + agent stream + cost +
lifecycle. **A1 field #7 (worktree diff) landed in Phase 4.5 Step 1**:
new `stage_checkpoints` table FK'd to stage_attempts records
`before_sha` / `after_sha` / cached `diff_text` using
`git stash create -u` (no ref mutation). Fire-and-forget capture
via PortRuntime AttemptHooks; awaited before run_final. **Remaining:
field #8 (scratch pad + PreCompact trigger)** — Phase 4.5 Step 2.
Legacy `workflow.db.execution_records` table + `lib/execution-record/`
module deleted in Stage 6.
```

- [ ] **Step 2: Write done-handoff doc**

Create `docs/superpowers/plans/2026-04-24-checkpoint-infra-done-handoff.md`:

```markdown
# Checkpoint Infrastructure — Completion Handoff

**Date:** 2026-04-24
**Milestone:** Phase 4.5 Step 1
**Roadmap coverage:** §6.1 A1 field #7 (worktree diff)
**Branch:** main

## Milestone results

9 sequential commits:

| Task | Subject |
|---|---|
| 1 | `stage_checkpoints` DDL + FK + status CHECK |
| 2 | `checkpoint/types.ts` |
| 3 | `checkpoint/git-commands.ts` over spawnWithTimeout |
| 4 | `captureBefore` / `captureAfter` + unit tests |
| 5 | Integration tests with real tmp git repos |
| 6 | `PortRuntime` AttemptHooks |
| 7 | `runner.ts` + `start-pipeline-run.ts` wiring |
| 8 | MCP `run_pipeline` `checkpoint_config` schema |
| 9 | Roadmap update + this handoff |

## What changed

**New:**
- `apps/server/src/kernel-next/runtime/checkpoint/` (5 files, ~700 LOC)
- `stage_checkpoints` table in kernel-next.db
- `checkpoint_config` input on MCP `run_pipeline` tool

**Modified:**
- `PortRuntime` constructor gains 5th optional arg (`AttemptHooks`)
- `RunnerOptions` + `StartPipelineRunInput` gain `checkpointConfig`
- `runPipeline` awaits `Promise.allSettled(checkpointInFlight)` before task teardown

**Deleted:** none.

## Invariants preserved

- Server `tsc --noEmit` 0 errors.
- Server `vitest run` 0 failures.
- Checkpoint failures never fail a stage (every path swallows).
- Existing `agent_execution_details` surface unchanged.
- Existing runner lifecycle timings unchanged (hooks are fire-and-forget).

## Out of scope / follow-ups

- B9 (Phase 5C): "git reset to before_sha + write old diff to
  StageMemory" — reads this table, no schema change.
- A4 `replay_stage` tool — uses `before_sha` via
  `git worktree add <tmp> <sha>`.
- `workflow prune-checkpoints` CLI — pending Step 3 prune rebuild.
- Fanout per-element attempt checkpoints: captured but may produce
  many rows per fanout stage; future filter/sampling policy optional.

## Next step

**Phase 4.5 Step 2: Session memory infra (scratch pad + PreCompact
trigger capture)**. Completes A1 field #8, unlocks B12 (single-session
hot-update summary injection).
```

- [ ] **Step 3: Run full test + type-check sweep**

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: 0 errors.

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run`
Expected: all pass (1502+ tests — includes 25+ new checkpoint cases).

- [ ] **Step 4: Commit**

```bash
git add docs/product-roadmap.md docs/superpowers/plans/2026-04-24-checkpoint-infra-done-handoff.md
git commit -m "$(cat <<'EOF'
docs(checkpoint-infra): roadmap A1 #7 landed + Phase 4.5 Step 1 handoff

A1 field #7 (worktree diff) now landed via stage_checkpoints table +
PortRuntime AttemptHooks. Field #8 (scratch pad + PreCompact) is the
next step (Phase 4.5 Step 2).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage.**

| Spec § | Task(s) |
|---|---|
| §4 Schema | Task 1 |
| §5.1 types.ts | Task 2 |
| §5.2 git-commands.ts | Task 3 |
| §5.3 checkpoint.ts (core) | Task 4 |
| §5.3 integration / real git | Task 5 |
| §5.4 PortRuntime hooks | Task 6 |
| §5.5 runner.ts integration | Task 7 |
| §5.6 start-pipeline-run + MCP | Task 7 (forward) + Task 8 (schema) |
| §6.1 unit test matrix | Task 4 (~15 cases) |
| §6.2 integration tests | Task 5 (5 cases) |
| §6.3 runner integration | Task 7 (3 cases) |
| §7 design decisions | Encoded in implementations (stash create -u, fallback to HEAD, diff cap, etc.) |
| §8 file churn | Matches Task list |
| §9 rollout | 9 commits on main, matches |

All sections mapped.

**2. Placeholder scan.** No "TBD/TODO/…similar to Task X"; every step has concrete code or commands.

**3. Type consistency.** Cross-file type names:
- `CheckpointConfig` / `ResolvedCheckpointConfig` / `CheckpointRow` / `CheckpointStatus` / `GitResult` / `CheckpointTimeouts` — all from `types.ts`, consumed identically in `checkpoint.ts`, `runner.ts`, `start-pipeline-run.ts`, `mcp/server.ts`
- `CheckpointDeps` defined in `checkpoint.ts`, imported by `checkpoint.test.ts`, `checkpoint.integration.test.ts`, `runner.ts` — same shape in all sites
- `AttemptHooks` defined in `port-runtime.ts`, imported by `runner.ts` — Task 6 and Task 7 use identical method names (`onAttemptStarted` / `onAttemptFinishing`)
- MCP snake_case (`max_diff_bytes`, `rev_parse_ms`, …) translated to camelCase in Task 8's `translateRunPipelineInput` — matches camelCase field names used in Tasks 2 / 4 / 7

Functions referenced across tasks (`captureBefore`, `captureAfter`, `resolveCheckpointConfig`, `gitStashCreate`, `gitRevParseHead`, `gitDiff`, `isGitRepo`, `translateRunPipelineInput`) — all defined in their own creation task before any consumer task.

---

Plan complete. Proceeding to subagent-driven execution.
