import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { scanOrphanTaskIds, classifyOrphan, lookupResumeSessionId } from "./orphan-reconciler.js";
import { loadBuiltinPipelineIR } from "./load-builtin-pipeline.js";
import { KernelService } from "../mcp/kernel.js";

describe("scanOrphanTaskIds", () => {
  it("returns task ids with attempts but no task_finals row", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
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

  it("returns empty array when every task has task_finals", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const orphans = scanOrphanTaskIds(db);
    expect(orphans).toEqual([]);
  });
});

describe("classifyOrphan", () => {
  it("returns resume with firstPending when there's a non-success stage", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
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

  it("honours hot_update_events.rerun_from_stage when newer than latest attempt", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
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
       VALUES ('e1','t1',?,?,'test','greet','success',?,?)`,
    ).run(vh, vh, base + 1000, base + 1001);

    const cls = classifyOrphan(db, "t1");
    expect(cls.kind).toBe("resume");
    if (cls.kind === "resume") {
      expect(cls.resumeFrom).toBe("greet");
    }
  });

  it("returns terminal when every agent stage has a success row", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
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

describe("lookupResumeSessionId", () => {
  it("returns the most recent session_id for a given task+stage", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const base = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','analyzing',0,'v','regular','superseded',?)`,
    ).run(base);
    db.prepare(
      `INSERT INTO prompt_contents (content_hash, content, created_at) VALUES ('h1','dummy',?)`,
    ).run(base);
    db.prepare(
      `INSERT INTO agent_execution_details (attempt_id, prompt_ref, prompt_content_hash, prompt_content, model, session_id, started_at, last_heartbeat_at)
       VALUES ('a1','p','h1','dummy','claude','sess-123',?, ?)`,
    ).run(base, base);

    const sid = lookupResumeSessionId(db, "t1", "analyzing");
    expect(sid).toBe("sess-123");
  });

  it("returns undefined when no agent session exists for that stage", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const sid = lookupResumeSessionId(db, "t1", "analyzing");
    expect(sid).toBeUndefined();
  });
});
