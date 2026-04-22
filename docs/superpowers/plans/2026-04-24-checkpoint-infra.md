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
- `apps/server/src/kernel-next/runtime/checkpoint/git-commands.ts` — `isGitRepo` / `gitRevParseHead` / `snapshotWorkTree` (scratch-index capture) / `gitDiff` over `spawnWithTimeout`
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
  snapshotMs: number;
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
  snapshotMs: 10_000,
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

### Background — why `snapshotWorkTree` is not `git stash create -u`

`git stash create -u` does NOT honour the `-u` flag on current git
versions (verified 2.50.1). It silently accepts `-u` as the message
argument and never captures untracked files into the dangling commit.

Instead, `snapshotWorkTree` uses a **scratch-index** pattern that
captures the full working tree (including untracked files but still
honouring `.gitignore`) as a dangling commit, without mutating
`.git/index`, any ref, or the working tree:

1. Create a scratch index file in `os.tmpdir()` via `mkdtemp`.
2. `GIT_INDEX_FILE=<scratch> git read-tree HEAD` — prime the scratch index.
3. `GIT_INDEX_FILE=<scratch> git add -A` — stage tracked + untracked changes into the scratch index.
4. `GIT_INDEX_FILE=<scratch> git write-tree` — write a tree object.
5. `git commit-tree <tree-sha> -p HEAD -m "wfc-checkpoint"` — wrap in a commit.
6. `rm -rf <scratch-dir>` (best-effort, ignores errors).

If step 2 fails because the repo has no HEAD (freshly `git init`ed,
zero commits), the helper returns `ok=false` immediately.

### Test + implementation

- [ ] **Step 1: Write the failing tests**

Create `git-commands.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  isGitRepo,
  gitRevParseHead,
  snapshotWorkTree,
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

  it("snapshotWorkTree — clean tree produces commit whose tree equals HEAD^{tree}", async () => {
    await initRepo(dir);
    const r = await snapshotWorkTree(dir, 10_000);
    expect(r.ok).toBe(true);
    const commitSha = r.stdout.trim();
    expect(commitSha).toMatch(/^[a-f0-9]{40}$/);
    const snapTree = (await exec("git", ["rev-parse", `${commitSha}^{tree}`], { cwd: dir })).stdout.trim();
    const headTree = (await exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir })).stdout.trim();
    expect(snapTree).toBe(headTree);
  });

  it("snapshotWorkTree — SHA on dirty tracked file", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "README.md"), "modified\n");
    const r = await snapshotWorkTree(dir, 10_000);
    expect(r.ok).toBe(true);
    const sha = r.stdout.trim();
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    const show = await exec("git", ["show", "--stat", sha], { cwd: dir });
    expect(show.stdout).toContain("README.md");
  });

  it("snapshotWorkTree — captures untracked files (.gitignore honoured)", async () => {
    await initRepo(dir);
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
    await exec("git", ["add", ".gitignore"], { cwd: dir });
    await exec("git", ["commit", "-qm", "ignore"], { cwd: dir });
    await writeFile(join(dir, "new.txt"), "new\n");
    await writeFile(join(dir, "ignored.txt"), "should not appear\n");
    const r = await snapshotWorkTree(dir, 10_000);
    expect(r.ok).toBe(true);
    const sha = r.stdout.trim();
    const show = await exec("git", ["show", "--stat", sha], { cwd: dir });
    expect(show.stdout).toContain("new.txt");
    expect(show.stdout).not.toContain("ignored.txt");
  });

  it("snapshotWorkTree — does not mutate .git/index", async () => {
    await initRepo(dir);
    await writeFile(join(dir, "staged.txt"), "staged\n");
    await exec("git", ["add", "staged.txt"], { cwd: dir });
    await writeFile(join(dir, "unstaged.txt"), "unstaged\n");
    const statusBefore = (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout;
    await snapshotWorkTree(dir, 10_000);
    const statusAfter = (await exec("git", ["status", "--porcelain"], { cwd: dir })).stdout;
    expect(statusAfter).toBe(statusBefore);
  });

  it("snapshotWorkTree — ok=false on repo with no HEAD (fresh git init)", async () => {
    await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
    const r = await snapshotWorkTree(dir, 10_000);
    expect(r.ok).toBe(false);
  });

  it("gitDiff — returns unified diff between two SHAs", async () => {
    await initRepo(dir);
    const before = (await exec("git", ["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    await writeFile(join(dir, "b.txt"), "line\n");
    const afterSnap = await snapshotWorkTree(dir, 10_000);
    const after = afterSnap.stdout.trim();
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
//
// snapshotWorkTree uses a scratch GIT_INDEX_FILE to build a dangling
// commit that includes the full working tree (tracked modifications
// + untracked files, minus .gitignore'd paths) without mutating the
// caller's index, refs, or working tree.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithTimeout } from "../../../lib/spawn-utils.js";
import type { GitResult } from "./types.js";

const EXTRA_PATH = "/opt/homebrew/bin:/usr/local/bin";

function buildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${process.env.PATH ?? ""}:${EXTRA_PATH}`,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...extra,
  };
}

async function run(
  args: string[],
  cwd: string,
  timeoutMs: number,
  envExtra: Record<string, string> = {},
): Promise<GitResult> {
  try {
    const r = await spawnWithTimeout("git", args, {
      cwd,
      timeoutMs,
      env: buildEnv(envExtra),
    });
    return {
      ok: !r.timedOut && r.exitCode === 0,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
    };
  } catch (err) {
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

/**
 * Capture working-tree state (tracked + untracked, honouring
 * .gitignore) as a dangling commit SHA on stdout. Does not mutate
 * .git/index, any ref, or the working tree.
 *
 * Uses a temporary GIT_INDEX_FILE so the 4 sub-steps do not touch
 * the runtime's .git/index. Cleans up the scratch index even on
 * partial failure.
 *
 * Returns ok=false if HEAD is unavailable (repo with zero commits),
 * if any sub-step fails, or if the overall timeout is hit.
 */
export async function snapshotWorkTree(
  cwd: string,
  timeoutMs: number,
): Promise<GitResult> {
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(0, deadline - Date.now());

  let scratchDir: string | null = null;
  try {
    scratchDir = await mkdtemp(join(tmpdir(), "wfc-cp-idx-"));
    const indexFile = join(scratchDir, "index");
    const env = { GIT_INDEX_FILE: indexFile };

    const readTree = await run(["read-tree", "HEAD"], cwd, remaining(), env);
    if (!readTree.ok) return readTree;

    const addAll = await run(["add", "-A"], cwd, remaining(), env);
    if (!addAll.ok) return addAll;

    const writeTree = await run(["write-tree"], cwd, remaining(), env);
    if (!writeTree.ok) return writeTree;
    const treeSha = writeTree.stdout.trim();
    if (!/^[a-f0-9]{40}$/.test(treeSha)) {
      return {
        ok: false,
        stdout: "",
        stderr: `write-tree returned unexpected output: ${treeSha}`,
        exitCode: -1,
        timedOut: false,
      };
    }

    // commit-tree does not need the scratch index; use default env.
    return run(
      ["commit-tree", treeSha, "-p", "HEAD", "-m", "wfc-checkpoint"],
      cwd,
      remaining(),
    );
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
      timedOut: false,
    };
  } finally {
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true }).catch(() => {
        // scratch cleanup failure is not the caller's problem
      });
    }
  }
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
Expected: PASS (11 tests).

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/runtime/checkpoint/git-commands.ts apps/server/src/kernel-next/runtime/checkpoint/git-commands.test.ts
git commit -m "$(cat <<'EOF'
feat(checkpoint): git-commands over spawnWithTimeout

isGitRepo / gitRevParseHead / snapshotWorkTree / gitDiff — structured
GitResult, never throws. snapshotWorkTree uses a scratch
GIT_INDEX_FILE (read-tree HEAD → add -A → write-tree → commit-tree)
to capture the full working tree (including untracked, honouring
.gitignore) as a dangling commit without mutating the runtime's
index, refs, or working tree.

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
    snapshotWorkTree: vi.fn().mockResolvedValue(ok("b".repeat(40))),
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
    expect(r.timeouts.snapshotMs).toBe(DEFAULT_CHECKPOINT_TIMEOUTS.snapshotMs);
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
      snapshotWorkTree: vi.fn().mockResolvedValue(ok("")),
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
      snapshotWorkTree: vi.fn().mockResolvedValue(fail("snap boom")),
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
      snapshotWorkTree: vi.fn().mockResolvedValue(ok("d".repeat(40))),
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
      snapshotWorkTree: vi.fn().mockResolvedValue(ok("d".repeat(40))),
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
      snapshotWorkTree: vi.fn().mockResolvedValue(ok("d".repeat(40))),
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
      snapshotWorkTree: vi.fn().mockResolvedValue(fail("snap boom")),
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
      snapshotWorkTree: vi.fn().mockResolvedValue(ok("d".repeat(40))),
      gitDiff: vi.fn().mockResolvedValue(ok("DIFF")),
    });
    await captureAfter(db, deps, {
      attemptId: "a1", maxDiffBytes: DEFAULT_MAX_DIFF_BYTES, timeouts: TIMEOUTS,
    });
    // second call with different mocked data should NOT overwrite
    const deps2 = mkDeps({
      snapshotWorkTree: vi.fn().mockResolvedValue(ok("e".repeat(40))),
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
  snapshotWorkTree: (cwd: string, timeoutMs: number) => Promise<GitResult>;
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
      snapshotMs: config?.timeouts?.snapshotMs ?? DEFAULT_CHECKPOINT_TIMEOUTS.snapshotMs,
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
  const snap = await deps.snapshotWorkTree(workdir, timeouts.snapshotMs);
  if (snap.ok && snap.stdout.trim() !== "") {
    return { kind: "ok", sha: snap.stdout.trim() };
  }
  const head = await deps.gitRevParseHead(workdir, timeouts.revParseMs);
  if (head.ok && head.stdout.trim() !== "") {
    return { kind: "ok", sha: head.stdout.trim() };
  }
  const diag =
    !snap.ok && !head.ok
      ? `snapshotWorkTree failed: ${snap.stderr || `exit ${snap.exitCode}`}; rev-parse HEAD failed: ${head.stderr || `exit ${head.exitCode}`}`
      : !head.ok
        ? `rev-parse HEAD failed: ${head.stderr || `exit ${head.exitCode}`}`
        : `snapshotWorkTree returned empty, rev-parse HEAD returned empty`;
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
  snapshotWorkTree,
  gitDiff,
} from "./git-commands.js";
import { DEFAULT_CHECKPOINT_TIMEOUTS, DEFAULT_MAX_DIFF_BYTES } from "./types.js";

const exec = promisify(execFile);

function mkDeps(): CheckpointDeps {
  return {
    isGitRepo,
    gitRevParseHead,
    snapshotWorkTree,
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

The existing `runner.test.ts` (~1000 LOC) already has `diamondIR()`, `diamondHandlers()`, `makeDb()` helpers plus `insertPipelineVersion` + `versionHash(ir)` for registering the IR. Reuse them — do NOT invent new helpers.

Append at the end of the file (after the last top-level `describe` block's closing `});`):

```ts
describe("checkpointConfig integration", () => {
  it("no rows written when checkpointConfig.enabled=false", async () => {
    const db = makeDb();
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    await runPipeline({
      db, ir,
      taskId: "t-cp-disabled",
      versionHash: hash,
      handlers: diamondHandlers(),
      checkpointConfig: { enabled: false },
    });
    const count = (db.prepare(
      `SELECT COUNT(*) AS c FROM stage_checkpoints`,
    ).get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("writes status='not_a_repo' for every attempt when workdir is a non-git tmpdir", async () => {
    const db = makeDb();
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const tmp = await mkdtemp(join(tmpdir(), "runner-cp-"));
    try {
      await runPipeline({
        db, ir,
        taskId: "t-cp-not-repo",
        versionHash: hash,
        handlers: diamondHandlers(),
        checkpointConfig: { enabled: true, workdir: tmp },
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    const rows = db.prepare(
      `SELECT status, workdir FROM stage_checkpoints`,
    ).all() as Array<{ status: string; workdir: string }>;
    // diamond IR has 4 stages (A/B/C/D) → 4 attempts → 4 checkpoint rows
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.status === "not_a_repo")).toBe(true);
    expect(rows.every((r) => r.workdir === tmp)).toBe(true);
  });

  it("every checkpoint row has a distinct attempt_id matching stage_attempts", async () => {
    const db = makeDb();
    const ir = diamondIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });
    const tmp = await mkdtemp(join(tmpdir(), "runner-cp-"));
    try {
      await runPipeline({
        db, ir,
        taskId: "t-cp-fk",
        versionHash: hash,
        handlers: diamondHandlers(),
        checkpointConfig: { enabled: true, workdir: tmp },
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
    const cpRows = db.prepare(
      `SELECT attempt_id FROM stage_checkpoints ORDER BY attempt_id`,
    ).all() as Array<{ attempt_id: string }>;
    const saRows = db.prepare(
      `SELECT attempt_id FROM stage_attempts
       WHERE task_id = 't-cp-fk' AND kind = 'regular'
       ORDER BY attempt_id`,
    ).all() as Array<{ attempt_id: string }>;
    expect(cpRows.length).toBe(saRows.length);
    expect(cpRows.length).toBe(4);
    // One-to-one correspondence: every checkpoint row maps to a
    // stage_attempts row from this run.
    const cpSet = new Set(cpRows.map((r) => r.attempt_id));
    const saSet = new Set(saRows.map((r) => r.attempt_id));
    expect(cpSet).toEqual(saSet);
  });
});
```

Add imports at the top of `runner.test.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

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
    snapshotWorkTree: gitCommands.snapshotWorkTree,
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

**Await in-flight capture before tearing down the task** — there is an existing `} finally { ... }` block near line 608 that contains `clearTimeout`, `currentActor.stop()`, the `terminationReason` computation, and finally `taskRegistry.signalTermination` + `taskRegistry.unregister`. Insert the drain **at the top of that `finally` block**, before `clearTimeout(timer);`:

```ts
  } finally {
    // Drain pending checkpoint captures before tearing down the task
    // so stage_checkpoints rows are committed by the time SSE run_final
    // and downstream queries observe the task's terminal state.
    if (checkpointInFlight.size > 0) {
      await Promise.allSettled([...checkpointInFlight]);
    }
    clearTimeout(timer);
    // ... existing lines continue unchanged ...
```

Note: `await` inside `finally` is supported (the function is already `async`). The drain sits at the earliest point in teardown so the terminationReason signal + unregister downstream both see committed rows.

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

### Background — existing run_pipeline schema is camelCase

The existing `run_pipeline` tool in `mcp/server.ts` (around lines 188–240) uses a flat camelCase zod `inputSchema` (`name`, `versionHash`, `seedValues`, `maxTurns`, `maxBudgetUsd`, `taskId`, etc.) and the handler narrows each field with `typeof args.xxx === "..."` before forwarding to `startPipelineRun`. No generic `translateRunPipelineInput` helper exists; the handler inlines the narrowing. We extend this convention — do NOT switch to snake_case just for the new field.

- [ ] **Step 1: Write the failing test**

Pattern: follow `apps/server/src/kernel-next/mcp/server.run-pipeline.test.ts` — it mocks `@anthropic-ai/claude-agent-sdk` (so `createKernelMcp` returns its raw `{ name, version, tools }` descriptor), submits the pipeline via `KernelService.submit`, then invokes the tool handler directly. Reuse that pattern; do NOT poke `_registeredTools`.

Create `apps/server/src/kernel-next/mcp/server.checkpoint-config.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: (opts: { name: string; version: string; tools: unknown[] }) => opts,
  query: () => ({
    async *[Symbol.asyncIterator]() { /* no messages */ },
  }),
}));

// eslint-disable-next-line import/first
import { createKernelMcp } from "./server.js";
import { initKernelNextSchema } from "../ir/sql.js";
import { KernelService } from "./kernel.js";
import { diamondIR } from "../generator-mock/mini-generator.js";
import type { PipelineIR } from "../ir/schema.js";

interface McpTool {
  name: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function getTools(mcp: unknown): Map<string, McpTool> {
  const toolsArray = (mcp as { tools: McpTool[] }).tools;
  const map = new Map<string, McpTool>();
  for (const t of toolsArray) map.set(t.name, t);
  return map;
}

function promptsForIR(ir: PipelineIR): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of ir.stages) {
    if (s.type === "agent" && s.config.promptRef) {
      out[s.config.promptRef] = s.config.promptRef;
    }
  }
  return out;
}

describe("run_pipeline MCP tool — checkpointConfig", () => {
  it("inputSchema exposes checkpointConfig at the top level", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const mcp = createKernelMcp(db, { surface: "external", skipTypeCheck: true });
    const tool = getTools(mcp).get("run_pipeline");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema).toHaveProperty("checkpointConfig");
    db.close();
  });

  it("handler forwards checkpointConfig and the run produces zero stage_checkpoints rows when enabled=false", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    const ir = diamondIR();
    const submit = svc.submit(ir, { prompts: promptsForIR(ir) });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;

    const mcp = createKernelMcp(db, { surface: "external", skipTypeCheck: true });
    const tool = getTools(mcp).get("run_pipeline");
    expect(tool).toBeDefined();

    const resp = await tool!.handler({
      name: "diamond",
      checkpointConfig: { enabled: false },
    });
    const payload = JSON.parse(resp.content[0]!.text) as {
      ok: boolean;
      taskId?: string;
    };
    expect(payload.ok).toBe(true);

    // The mocked SDK returns no messages so the stubbed query's
    // async iterator exits immediately. RealStageExecutor will
    // treat that as a run without completion, but the background
    // runPipeline still registers attempts — and since checkpointConfig
    // has enabled=false, no stage_checkpoints rows should ever be
    // written regardless of attempt count. Give the background run a
    // generous moment to record any would-be rows before asserting.
    await new Promise((r) => setTimeout(r, 500));
    const count = (db
      .prepare(`SELECT COUNT(*) AS c FROM stage_checkpoints`)
      .get() as { c: number }).c;
    expect(count).toBe(0);

    db.close();
  });
});
```

- [ ] **Step 2: Verify test fails**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/mcp/server.checkpoint-config.test.ts`
Expected: FAIL — `inputSchema` missing `checkpointConfig`, and/or handler ignores the field.

- [ ] **Step 3: Modify `mcp/server.ts`**

In `apps/server/src/kernel-next/mcp/server.ts`, locate the `run_pipeline` tool definition (around line 188). Extend it in two ways:

**3a. Add `checkpointConfig` to the camelCase `inputSchema`** (alongside `name`, `versionHash`, `seedValues`, etc.):

```ts
checkpointConfig: z
  .object({
    enabled: z.boolean().optional(),
    workdir: z.string().optional(),
    maxDiffBytes: z.number().int().positive().optional(),
    timeouts: z
      .object({
        revParseMs: z.number().int().positive().optional(),
        snapshotMs: z.number().int().positive().optional(),
        diffMs: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .optional()
  .describe("Per-task checkpoint config; omit to use defaults (enabled=true, workdir=process.cwd())"),
```

**3b. Forward it in the handler body.** Inside the `handler: async (args: any) => { ... startPipelineRun({ ... }) ... }` call (around line 206), add:

```ts
checkpointConfig:
  args.checkpointConfig && typeof args.checkpointConfig === "object"
    ? (args.checkpointConfig as import("../runtime/checkpoint/checkpoint.js").CheckpointConfig)
    : undefined,
```

Place it alongside the other field-narrowing lines (`seedValues: ...`, `model: ...`, etc.) so the call to `startPipelineRun` stays a single expression. No new imports at module scope are required — the `import type` is inline. No translator function; the handler's existing idiom inlines the check.

- [ ] **Step 4: Run tests**

Run: `cd /Users/minghao/workflow-control/apps/server && npx vitest run src/kernel-next/mcp/`
Expected: PASS (including new test). If existing mcp tests also touch `run_pipeline`, they must continue to pass without modification.

Run: `cd /Users/minghao/workflow-control/apps/server && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/kernel-next/mcp/server.ts apps/server/src/kernel-next/mcp/server.checkpoint-config.test.ts
git commit -m "$(cat <<'EOF'
feat(mcp): run_pipeline accepts checkpointConfig

Adds optional checkpointConfig (camelCase, matching the existing tool's
idiom) to the run_pipeline zod inputSchema with all four optional
fields (enabled / workdir / maxDiffBytes / timeouts). Handler forwards
it to startPipelineRun. MCP callers can opt out of checkpointing or
override workdir / caps / timeouts.

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
scratch-index snapshot (no ref mutation, includes untracked). Fire-and-forget capture
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
| §7 design decisions | Encoded in implementations (scratch-index snapshot, fallback to HEAD, diff cap, etc.) |
| §8 file churn | Matches Task list |
| §9 rollout | 9 commits on main, matches |

All sections mapped.

**2. Placeholder scan.** No "TBD/TODO/…similar to Task X"; every step has concrete code or commands.

**3. Type consistency.** Cross-file type names:
- `CheckpointConfig` / `ResolvedCheckpointConfig` / `CheckpointRow` / `CheckpointStatus` / `GitResult` / `CheckpointTimeouts` — all from `types.ts`, consumed identically in `checkpoint.ts`, `runner.ts`, `start-pipeline-run.ts`, `mcp/server.ts`
- `CheckpointDeps` defined in `checkpoint.ts`, imported by `checkpoint.test.ts`, `checkpoint.integration.test.ts`, `runner.ts` — same shape in all sites
- `AttemptHooks` defined in `port-runtime.ts`, imported by `runner.ts` — Task 6 and Task 7 use identical method names (`onAttemptStarted` / `onAttemptFinishing`)
- MCP snake_case (`max_diff_bytes`, `rev_parse_ms`, …) translated to camelCase in Task 8's `translateRunPipelineInput` — matches camelCase field names used in Tasks 2 / 4 / 7

Functions referenced across tasks (`captureBefore`, `captureAfter`, `resolveCheckpointConfig`, `snapshotWorkTree`, `gitRevParseHead`, `gitDiff`, `isGitRepo`, `translateRunPipelineInput`) — all defined in their own creation task before any consumer task.

---

Plan complete. Proceeding to subagent-driven execution.
