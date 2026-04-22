# Checkpoint Infrastructure — Design Spec

**Date:** 2026-04-24
**Milestone:** Phase 4.5 Step 1 (A1 field #7 completion)
**Author:** kernel-next maintainer
**Status:** Draft for review

---

## 1. Purpose

Capture, for every `stage_attempts` row, the git state of the agent's
working directory before and after the attempt runs:

- `before_sha` — a git commit SHA representing the working tree (including
  uncommitted + untracked changes) at the moment the attempt began.
- `after_sha` — same, at the moment the attempt finished.
- `diff_text` — cached `git diff before_sha after_sha` output.

This completes roadmap §6.1 A1 field #7 ("Worktree diff (stage 启动前 vs
结束后的 git diff)") which was marked *deferred* in Stage 6 (see
`docs/superpowers/plans/2026-04-24-execution-record-sidecar-done-handoff.md`).

## 2. Out of scope

The following are adjacent features that are **not** implemented here.
They consume this data in later milestones.

| Later milestone | How it uses checkpoints |
|---|---|
| B9 (Phase 5C: worktree 切换) | `git reset --hard before_sha` + reads diff_text from StageMemory |
| A4 `replay_stage` tool | `git worktree add <tmp> <before_sha>` to reconstruct pre-attempt state |
| A4 `compare_runs` tool | Surface `diff_text` / `diff_bytes` across runs |
| CLI `workflow prune-checkpoints` | Parallel to `prune-execution-records` |
| Fanout per-element filtering | Cap per-fanout-stage row count |

The schema is chosen so none of these require a migration; they add
read-only queries or new columns only where the current design left room.

Not in scope either:

- Creating / managing a task-level git worktree. The runner continues
  to use `process.cwd()` (or a caller-supplied `workdir`). Worktree
  lifecycle is owned by a later B9 milestone.
- Modifying existing tables. No column added to
  `agent_execution_details`, `stage_attempts`, or `port_values`.

## 3. Constraints

1. **Checkpoint failure must never fail a stage.** Every capture path
   catches its own errors and writes a diagnostic column instead of
   propagating. Stage success/error remains identical whether
   checkpointing succeeds or not.
2. **Works on non-git workdirs.** If the resolved `workdir` is not a git
   repository (or does not exist), a row is still written with
   `status='not_a_repo'` / `status='disabled'` so the absence is
   observable rather than silent.
3. **Does not mutate the user's repo.** No commits, no refs touched.
   `git stash create` (which produces a dangling commit object, does
   not push onto the stash stack, does not move any ref) is the only
   SHA-producing primitive used.
4. **Does not block the hot path longer than necessary.** Every git
   sub-call runs under a timeout (default 5 s for `rev-parse`, 10 s
   for `diff`, 10 s for `stash create`).
5. **One row per `stage_attempts.attempt_id`.** FK + UNIQUE enforced
   at schema level.

## 4. Schema

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

**Status semantics:**

Rows progress through two write phases:

- **Phase 1 (captureBefore, INSERT).** Sets initial status based on
  what happens before the attempt runs.
- **Phase 2 (captureAfter, UPDATE).** If Phase 1 ended with the
  "capturing" status (i.e. before_sha was recorded), Phase 2 may
  transition it further to `captured`, `after_failed`, or
  `diff_too_large`. If Phase 1 already terminated (e.g. `not_a_repo`),
  Phase 2 is a no-op.

| Status | Phase | before_sha | after_sha | diff_text | Meaning |
|---|---|---|---|---|---|
| `capturing` | Phase 1 → | ✓ | NULL | NULL | Before recorded; waiting for Phase 2 |
| `captured` | ← Phase 2 | ✓ | ✓ | ✓ | Happy path complete |
| `before_failed` | Phase 1 terminal | NULL | NULL | NULL | `git rev-parse` / `stash create` failed before attempt |
| `after_failed` | ← Phase 2 | ✓ | ✓ or NULL | NULL | Before succeeded; after SHA or diff failed |
| `not_a_repo` | Phase 1 terminal | NULL | NULL | NULL | `workdir` exists but is not a git repo |
| `disabled` | Phase 1 terminal | NULL | NULL | NULL | `workdir` missing (hook fired but workdir absent) |
| `diff_too_large` | ← Phase 2 | ✓ | ✓ | NULL | Diff exceeded `MAX_DIFF_BYTES` cap |

If `status='capturing'` and `captured_after_at IS NULL`, the attempt
ended without Phase 2 completing (hard crash / process kill); query
tools treat this as "incomplete checkpoint".

Note: `status='disabled'` at row level is distinct from
`checkpointConfig.enabled=false` at config level. When the config
disables the whole module, **no row is written at all**. The
`'disabled'` status is reserved for the rare per-attempt edge case
where the hook fired but the configured workdir path had disappeared
between runPipeline startup and attempt start.

## 5. Module layout

```
apps/server/src/kernel-next/runtime/checkpoint/
  types.ts                       CheckpointStatus, CheckpointConfig, CheckpointRow
  git-commands.ts                gitRevParseHead / gitStashCreate / gitDiff / isGitRepo
  checkpoint.ts                  captureBefore / captureAfter
  checkpoint.test.ts             Unit tests (mock execGit)
  checkpoint.integration.test.ts End-to-end with real tmp git repo
```

### 5.1 `types.ts`

```ts
export type CheckpointStatus =
  | 'captured'
  | 'before_failed'
  | 'after_failed'
  | 'not_a_repo'
  | 'disabled'
  | 'diff_too_large';

export interface CheckpointConfig {
  /** Default true. When false, checkpoint module is completely skipped
   *  (no row written). */
  enabled?: boolean;
  /** Working directory in which to resolve SHAs. Defaults to
   *  process.cwd() at runPipeline time. */
  workdir?: string;
  /** Cap on cached diff_text length. Default 5 MiB. Beyond this,
   *  diff_text is stored NULL and status='diff_too_large'. */
  maxDiffBytes?: number;
  /** Per-call timeouts. Defaults: revParse 5 000, stashCreate 10 000,
   *  diff 10 000. */
  timeouts?: {
    revParseMs?: number;
    stashCreateMs?: number;
    diffMs?: number;
  };
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
```

### 5.2 `git-commands.ts`

Four pure helpers over `spawnWithTimeout`. All return structured
results, never throw. `GitResult` is exported from `types.ts`.

```ts
// in types.ts
export interface GitResult {
  ok: boolean;        // true iff exit 0 and !timedOut
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

// in git-commands.ts
export async function isGitRepo(cwd: string, timeoutMs: number): Promise<boolean>;
export async function gitRevParseHead(cwd: string, timeoutMs: number): Promise<GitResult>;
export async function gitStashCreate(cwd: string, timeoutMs: number): Promise<GitResult>;
export async function gitDiff(cwd: string, from: string, to: string, timeoutMs: number): Promise<GitResult>;
```

- `isGitRepo`: `git rev-parse --is-inside-work-tree`; true iff exit 0.
- `gitStashCreate`: `git stash create -u` (untracked-inclusive). Returns
  trimmed stdout as the dangling commit SHA. **If the working tree is
  clean, stdout is empty** — caller treats this as "fall back to
  `git rev-parse HEAD`".

All helpers build env from `{ ...process.env, PATH: process.env.PATH + ':/opt/homebrew/bin:/usr/local/bin' }` (matches `lib/git.ts`
convention).

### 5.3 `checkpoint.ts`

```ts
interface CheckpointDeps {
  gitRevParseHead: typeof import('./git-commands.js').gitRevParseHead;
  gitStashCreate: typeof import('./git-commands.js').gitStashCreate;
  gitDiff: typeof import('./git-commands.js').gitDiff;
  isGitRepo: typeof import('./git-commands.js').isGitRepo;
  pathExists: (p: string) => Promise<boolean>;
  now: () => number;
}

/** Inserts the stage_checkpoints row. Called from PortRuntime
 *  onAttemptStarted hook. Never throws. */
export async function captureBefore(
  db: DatabaseSync,
  deps: CheckpointDeps,
  args: {
    attemptId: string;
    workdir: string;
    timeouts: Required<NonNullable<CheckpointConfig['timeouts']>>;
  }
): Promise<void>;

/** Updates the existing row with after_sha + diff + final status.
 *  Called from PortRuntime onAttemptFinishing hook. Never throws.
 *  If no row exists (before skipped or module error), this is a no-op. */
export async function captureAfter(
  db: DatabaseSync,
  deps: CheckpointDeps,
  args: {
    attemptId: string;
    maxDiffBytes: number;
    timeouts: Required<NonNullable<CheckpointConfig['timeouts']>>;
  }
): Promise<void>;
```

**Algorithm captureBefore:**

```
1. if !pathExists(workdir): INSERT status='disabled', diagnostic='workdir not found'; return
2. if !isGitRepo(workdir): INSERT status='not_a_repo'; return
3. stashResult = gitStashCreate(workdir)
   if stashResult.ok && stashResult.stdout.trim() != '':
       before_sha = stashResult.stdout.trim()
   else:
       headResult = gitRevParseHead(workdir)
       if !headResult.ok:
           INSERT status='before_failed', diagnostic=headResult.stderr; return
       before_sha = headResult.stdout.trim()
4. INSERT stage_checkpoints (..., before_sha, status='capturing', captured_before_at=now, ...)
5. wrap all DB ops in try/catch → logger.warn; do NOT propagate.
```

**Algorithm captureAfter:**

```
1. row = SELECT * FROM stage_checkpoints WHERE attempt_id = ?
   if !row || row.status != 'capturing' || row.before_sha == null: return
2. stashResult = gitStashCreate(row.workdir)
   if stashResult.ok && stashResult.stdout.trim() != '':
       after_sha = stashResult.stdout.trim()
   else:
       headResult = gitRevParseHead(row.workdir)
       if !headResult.ok:
           UPDATE status='after_failed', after_sha=null, captured_after_at=now; return
       after_sha = headResult.stdout.trim()
3. diffResult = gitDiff(row.workdir, row.before_sha, after_sha)
   if !diffResult.ok:
       UPDATE status='after_failed', after_sha=after_sha, diff_text=null, captured_after_at=now; return
4. diff_bytes = Buffer.byteLength(diffResult.stdout)
   if diff_bytes > maxDiffBytes:
       UPDATE status='diff_too_large', after_sha, diff_bytes, diff_text=null,
              diagnostic='diff exceeded MAX_DIFF_BYTES', captured_after_at=now
   else:
       UPDATE status='captured', after_sha, diff_text, diff_bytes, captured_after_at=now
5. all DB ops wrapped.
```

### 5.4 `port-runtime.ts` hook surface

Two optional callbacks threaded through the `PortRuntime` constructor:

```ts
export interface AttemptHooks {
  onAttemptStarted?: (attemptId: string, args: StartAttemptArgs) => void;
  onAttemptFinishing?: (attemptId: string) => void;
}
```

Hooks are **synchronous `void`-returning** from PortRuntime's
perspective — the runner wraps the async `captureBefore`/`captureAfter`
calls in adapters that track their in-flight promises internally (see
§5.5). This keeps PortRuntime unaware of async checkpoint work and
preserves existing call-site semantics.

`onAttemptFinishing` deliberately does **not** take `AttemptStatus`:
checkpoint always captures the post-attempt state regardless of
success/error/superseded. Consumers who need to correlate can join
`stage_attempts.status` via `attempt_id`.

Rules:

- **Fire-and-forget from PortRuntime's POV.** PortRuntime invokes the
  hook but does not `await` its return; the hook's own error handling
  keeps any failure out of the hot path. (Concretely: `void hook(...)`.)
- `onAttemptStarted` is called synchronously **after** the
  `stage_attempts` INSERT is committed — so the FK target exists by
  the time `captureBefore` inserts `stage_checkpoints`.
- `onAttemptFinishing` is called synchronously **before** the
  `stage_attempts` UPDATE — but because the hook is fire-and-forget,
  the UPDATE is not delayed. The hook's own async work runs in parallel
  with the rest of the lifecycle.

*Why fire-and-forget over `await`:* checkpointing is observational.
Blocking `finishAttempt` behind 10 s of git work would change the
machine's timing behaviour (downstream guard evaluation, SSE event
ordering). Fire-and-forget keeps capture asynchronous relative to the
state machine.

*What this means for tests:* integration tests that assert on
`stage_checkpoints` rows must wait for the in-flight hook before
querying. The runner exposes a `checkpointInFlight: Promise<void>`
that resolves when all pending checkpoint writes complete; tests
`await` it before inspecting rows.

### 5.5 `runner.ts` integration

`RunPipelineOpts` gains an optional field:

```ts
interface RunPipelineOpts {
  // ... existing fields
  checkpointConfig?: CheckpointConfig;
}
```

Inside `runPipeline`:

```ts
import * as gitCommands from './checkpoint/git-commands.js';
import { access } from 'node:fs/promises';

const cpConfig = resolveCheckpointConfig(opts.checkpointConfig);
//   resolves defaults: enabled=true, workdir=process.cwd(),
//   maxDiffBytes=5*1024*1024,
//   timeouts={revParseMs:5_000, stashCreateMs:10_000, diffMs:10_000}

const cpDeps: CheckpointDeps = {
  gitRevParseHead: gitCommands.gitRevParseHead,
  gitStashCreate: gitCommands.gitStashCreate,
  gitDiff: gitCommands.gitDiff,
  isGitRepo: gitCommands.isGitRepo,
  pathExists: async (p) => access(p).then(() => true).catch(() => false),
  now: () => Date.now(),
};

const checkpointInFlight = new Set<Promise<void>>();
const trackHook = (p: Promise<void>) => {
  const wrapped = p.finally(() => checkpointInFlight.delete(wrapped));
  checkpointInFlight.add(wrapped);
};

const hooks: AttemptHooks = cpConfig.enabled
  ? {
      onAttemptStarted: (attemptId) => trackHook(
        captureBefore(db, cpDeps, {
          attemptId, workdir: cpConfig.workdir, timeouts: cpConfig.timeouts,
        }),
      ),
      onAttemptFinishing: (attemptId) => trackHook(
        captureAfter(db, cpDeps, {
          attemptId, maxDiffBytes: cpConfig.maxDiffBytes, timeouts: cpConfig.timeouts,
        }),
      ),
    }
  : {};

const portRuntime = new PortRuntime(db, dispatcher, 'regular', onPortWritten, hooks);

// At end of runPipeline (before resolving the run-final promise):
await Promise.allSettled([...checkpointInFlight]);
```

`trackHook` must wrap `p.finally(...)` and store the wrapped promise.
Storing the raw `p` and calling `checkpointInFlight.delete(p)` in a
separate `.finally(...)` creates a different promise reference and
the delete would miss. The above pattern ensures the stored reference
is the one that completes.

*Why await at the end:* tests need deterministic completion; production
users also benefit from "task's checkpoints are committed by the time
the run_final event fires". 10 s worst case is acceptable at run
boundary (not at every stage boundary).

### 5.6 `start-pipeline-run.ts` + MCP surface

`StartPipelineRunInput` adds optional `checkpointConfig`; forwarded to
`runPipeline` unchanged. The MCP `run_pipeline` tool schema adds an
optional `checkpoint_config` object (snake_case per MCP convention)
parsed into camelCase before forwarding.

Default resolution order:
1. Explicit `input.checkpointConfig.workdir`
2. `process.cwd()`

## 6. Testing

### 6.1 Unit (`checkpoint.test.ts`, ~15 cases)

| Case | Mock behaviour | Assertion |
|---|---|---|
| captureBefore happy | all git OK, stash returns SHA | row.status='capturing', before_sha set |
| captureBefore clean tree | stash stdout='', rev-parse OK | row.status='capturing', row.before_sha == rev-parse SHA |
| captureBefore workdir missing | pathExists → false | row.status='disabled' |
| captureBefore not a repo | isGitRepo → false | row.status='not_a_repo' |
| captureBefore rev-parse failed | both stash + rev-parse fail | row.status='before_failed', diagnostic non-null |
| captureBefore sqlite INSERT throws | mock db throws | logger.warn called, no throw out of captureBefore |
| captureAfter happy | all git OK | row updated, status='captured', diff_bytes>0 |
| captureAfter no prior row | SELECT returns null | no-op |
| captureAfter diff too large | diff stdout length > maxDiffBytes | row.status='diff_too_large', diff_text=null, diff_bytes=large |
| captureAfter diff failed | gitDiff returns exit!=0 | row.status='after_failed', after_sha set, diff_text=null |
| captureAfter after rev-parse failed | both stash + rev-parse fail | status='after_failed', after_sha=null |
| captureBefore timeout respected | timer instrumented mock | timeouts.revParseMs used |
| captureBefore twice (idempotency) | second call | second INSERT fails due to PK; logger.warn, no throw |
| captureAfter twice | second call after first set status='captured' | second call is no-op (guard `status != 'capturing'`); row unchanged |
| captureBefore with workdir containing unicode path | filesystem | path round-trips through DB unchanged |

### 6.2 Integration (`checkpoint.integration.test.ts`, ~5 cases)

Real `child_process`, real tmp git repo (`fs.mkdtemp` + `git init`).

| Case | Setup | Assertion |
|---|---|---|
| end-to-end dirty tree | init repo, write file A, captureBefore, modify A, captureAfter | diff_text contains A's diff |
| untracked files captured | init repo, captureBefore, create new file B, captureAfter | diff_text mentions B |
| clean tree both ends | init + initial commit, captureBefore, touch nothing, captureAfter | before_sha == after_sha, diff_text empty string |
| not a repo | tmp dir without `git init`, captureBefore + captureAfter | both rows: status='not_a_repo' |
| captureAfter after `git reset --hard` | stages intermediate changes, resets, captureAfter | diff reflects reset (post-state vs before_sha) |

### 6.3 Runner integration (`runner.test.ts` additions, ~3 cases)

| Case | Setup | Assertion |
|---|---|---|
| mock stage with checkpoint disabled | `checkpointConfig={enabled:false}` | no rows in stage_checkpoints |
| mock stage with real git repo | runPipeline inside tmp git repo, single mock stage | exactly 1 row, status='captured' |
| multiple attempts share same attempt_ids | mock retry, 2 attempts | 2 rows with distinct attempt_ids |

## 7. Key design decisions (recorded for future readers)

| # | Decision | Rationale |
|---|---|---|
| D1 | `git stash create -u` not `git commit -a` | No ref mutation; dangling commit GC-safe |
| D2 | Fall back to `rev-parse HEAD` when tree clean | stash create returns empty for clean tree |
| D3 | New table, not `agent_execution_details` column | Applies to script/gate stages too; isolates concerns |
| D4 | Fire-and-forget hooks, but awaited at run end | Doesn't perturb stage lifecycle timing; still deterministic for tests |
| D5 | `-u` (include untracked), no `-a` (exclude ignored) | Agents create files; ignored dirs (node_modules, build) would bloat diff |
| D6 | 5 MiB diff cap | SQLite TEXT column handles it fine; beyond is likely noise |
| D7 | Default `enabled=true` | Safe; failure paths optional-by-design |
| D8 | `FOREIGN KEY ... ON DELETE CASCADE` | checkpoint belongs-to attempt; cleaning attempts cleans this |

## 8. File churn estimate

- New: 5 files under `runtime/checkpoint/` (~400 LOC total including tests)
- Modified: `ir/sql.ts` (+25 LOC schema), `runtime/port-runtime.ts` (+30 LOC), `runtime/runner.ts` (+40 LOC), `runtime/start-pipeline-run.ts` (+5 LOC), `mcp/server.ts` (+15 LOC for the tool schema)
- Tests: unit + integration + 3 runner cases (~300 LOC)
- Zero deletions.

## 9. Rollout

Single commit chain (one per plan task) straight to `main`:

1. Schema + types
2. git-commands module
3. checkpoint.ts core + unit tests
4. PortRuntime hook surface
5. runner + start-pipeline-run integration
6. Integration + runner tests
7. MCP tool schema wiring
8. Roadmap update + handoff doc

No feature flag. No opt-in. `enabled=true` default shipped with the
merge; existing callers' behaviour is additive only.
