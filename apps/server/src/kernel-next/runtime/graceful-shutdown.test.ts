import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { reconcileRunningAttempts } from "./graceful-shutdown.js";

describe("reconcileRunningAttempts", () => {
  it("flips running stage_attempts to superseded for listed taskIds", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
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

  it("updates agent_execution_details for superseded attempts", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','s1',0,'v','regular','running',?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO prompt_contents (content_hash, content, created_at) VALUES ('h1','dummy',?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, started_at, last_heartbeat_at)
       VALUES ('a1','p','h1','dummy','claude',?, ?)`,
    ).run(now, now);

    reconcileRunningAttempts(db, ["t1"]);

    const aed = db.prepare(
      "SELECT termination_reason, ended_at FROM agent_execution_details WHERE attempt_id='a1'",
    ).get() as { termination_reason: string; ended_at: number };
    expect(aed.termination_reason).toBe("interrupted");
    expect(aed.ended_at).toBeGreaterThan(0);
  });

  it("is a no-op when taskIds is empty", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const changed = reconcileRunningAttempts(db, []);
    expect(changed).toBe(0);
  });
});
