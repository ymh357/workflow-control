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
