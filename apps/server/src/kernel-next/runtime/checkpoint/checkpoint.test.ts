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
  it("undefined config → enabled=false (no implicit capture of server cwd)", () => {
    const r = resolveCheckpointConfig(undefined);
    expect(r.enabled).toBe(false);
    // Fallback workdir is still process.cwd() in case `enabled` is
    // later toggled on at runtime, but no capture fires while disabled.
    expect(r.workdir).toBe(process.cwd());
    expect(r.maxDiffBytes).toBe(DEFAULT_MAX_DIFF_BYTES);
    expect(r.timeouts).toEqual(DEFAULT_CHECKPOINT_TIMEOUTS);
  });

  it("explicit workdir → enabled=true by default", () => {
    const r = resolveCheckpointConfig({ workdir: "/tmp/agent-wt" });
    expect(r.enabled).toBe(true);
    expect(r.workdir).toBe("/tmp/agent-wt");
  });

  it("explicit enabled=false overrides workdir-based default", () => {
    const r = resolveCheckpointConfig({ workdir: "/tmp/agent-wt", enabled: false });
    expect(r.enabled).toBe(false);
  });

  it("explicit enabled=true without workdir still enables (caller opted in)", () => {
    const r = resolveCheckpointConfig({ enabled: true });
    expect(r.enabled).toBe(true);
    expect(r.workdir).toBe(process.cwd());
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
