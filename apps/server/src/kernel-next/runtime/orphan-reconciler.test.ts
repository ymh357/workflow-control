import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema } from "../ir/sql.js";
import { scanOrphanTaskIds, classifyOrphan, lookupResumeSessionId, bootResumability } from "./orphan-reconciler.js";
import { loadBuiltinPipelineIR } from "./load-builtin-pipeline.js";
import { KernelService } from "../mcp/kernel.js";

describe("scanOrphanTaskIds", () => {
  it("returns task ids with attempts but no task_finals row", async () => {
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

  it("returns empty array when every task has task_finals", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const orphans = scanOrphanTaskIds(db);
    expect(orphans).toEqual([]);
  });
});

describe("classifyOrphan", () => {
  it("returns resume with firstPending when there's a non-success stage", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const loaded = loadBuiltinPipelineIR("smoke-test");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const sub = await svc.submit(loaded.ir, { prompts: loaded.prompts });
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

  it("honours hot_update_events.rerun_from_stage when newer than latest attempt", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const loaded = loadBuiltinPipelineIR("smoke-test");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const sub = await svc.submit(loaded.ir, { prompts: loaded.prompts });
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

  it("returns terminal when every agent stage has a success row", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const loaded = loadBuiltinPipelineIR("smoke-test");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const sub = await svc.submit(loaded.ir, { prompts: loaded.prompts });
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

  it("topo sort skips gate-feedback edges so a pipeline with reject-loop wires has a real root", async () => {
    // Regression for 2026-04-26 dogfood Finding 12: pipeline-generator's
    // own IR has a wire `awaitingConfirm.__gate_feedback__ → analyzing.rejectionFeedback`
    // (the canonical reject-feedback loop). Without skipping that edge,
    // the topo sort sees a cycle (analyzing → awaitingConfirm → analyzing),
    // every stage's inDegree becomes ≥1, the initial topo queue is empty,
    // and `firstPending` is undefined → classifyOrphan returns `terminal`
    // → boot reconciler writes task_finals(completed/natural) over a task
    // whose work is genuinely incomplete. Here we hand-build a 3-stage IR
    // that mirrors that topology and assert classify still returns resume.
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const svc = new KernelService(db, { skipTypeCheck: true });
    // Hand-build a pipeline: scope (agent) → confirm (gate) → next (agent)
    // with a feedback wire confirm.__gate_feedback__ → scope.feedbackInput
    const ir = {
      name: "feedback-loop-pipeline",
      externalInputs: [{ name: "seed", type: "string" }],
      stages: [
        {
          name: "scope",
          type: "agent" as const,
          inputs: [
            { name: "seed", type: "string" },
            { name: "feedbackInput", type: "string" },
          ],
          outputs: [{ name: "result", type: "string" }],
          config: { promptRef: "p/scope" },
        },
        {
          name: "confirm",
          type: "gate" as const,
          inputs: [{ name: "__gate_signal", type: "unknown" }],
          outputs: [],
          config: {
            question: { text: "approve?" },
            routing: { routes: { approve: "next", reject: "scope" } },
          },
        },
        {
          name: "next",
          type: "agent" as const,
          inputs: [{ name: "x", type: "string" }],
          outputs: [{ name: "y", type: "string" }],
          config: { promptRef: "p/next" },
        },
      ],
      wires: [
        { from: { source: "external" as const, port: "seed" }, to: { stage: "scope", port: "seed" } },
        { from: { source: "stage" as const, stage: "scope", port: "result" }, to: { stage: "confirm", port: "__gate_signal" } },
        { from: { source: "stage" as const, stage: "scope", port: "result" }, to: { stage: "next", port: "x" } },
        // The reject-feedback wire that creates the apparent cycle:
        { from: { source: "stage" as const, stage: "confirm", port: "__gate_feedback__" }, to: { stage: "scope", port: "feedbackInput" } },
      ],
    };
    const sub = await svc.submit(ir, { prompts: { "p/scope": "x", "p/next": "x" } });
    if (!sub.ok) throw new Error("submit: " + JSON.stringify(sub.diagnostics));

    const vh = sub.versionHash;
    const now = Date.now();
    // scope succeeded, confirm gate succeeded, next NOT run yet.
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','scope',0,?,'regular','success',?)`,
    ).run(vh, now);
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a2','t1','confirm',0,?,'regular','success',?)`,
    ).run(vh, now + 1);

    const cls = classifyOrphan(db, "t1");
    expect(cls.kind).toBe("resume");
    if (cls.kind === "resume") {
      expect(cls.resumeFrom).toBe("next");
    }
  });

  // Invariant lock-in (2026-04-27 handoff §2.1): if a stage_attempt is
  // status='error' AND port_values rows exist tied to that attempt
  // (e.g. a leaked SDK subprocess wrote outputs after the attempt was
  // marked terminal), classifyOrphan must STILL classify the task as
  // resume from THAT stage, never advance past it. F22 prevents the
  // race in practice by aborting the SDK on error, but the invariant
  // matters because the reconciler's correctness must not depend on
  // executor-level discipline.
  it("resumes from error stage even when port_values rows exist for that attempt", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const loaded = loadBuiltinPipelineIR("smoke-test");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const sub = await svc.submit(loaded.ir, { prompts: loaded.prompts });
    if (!sub.ok) throw new Error("seed failed");
    const vh = sub.versionHash;
    const now = Date.now();
    // greet ended in error; echoBack never started.
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','greet',0,?,'regular','error',?)`,
    ).run(vh, now);
    // Simulate the leaked-SDK race: port_values rows tied to the error
    // attempt, written AFTER the row's status was set to 'error'.
    db.prepare(
      `INSERT INTO port_values (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
       VALUES ('pv1','a1','greet','greeting','out', ?, ?)`,
    ).run(JSON.stringify("hello"), now + 100_000);

    const cls = classifyOrphan(db, "t1");
    expect(cls.kind).toBe("resume");
    if (cls.kind === "resume") {
      expect(cls.resumeFrom).toBe("greet");
    }
  });

  // Same invariant but with a downstream stage having NO attempt yet —
  // the canonical round-9-style failure mode. Without F22 the leaked
  // writes happen on the upstream stage's attempt; the runner advanced
  // past it because XState's parallel onDone fires when every region
  // is in any final state (including `error`). The reconciler is the
  // safety net: it must surface the un-succeeded stage as the resume
  // pointer regardless of which downstream attempts also exist.
  it("resumes from error stage even with downstream attempts present", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const loaded = loadBuiltinPipelineIR("smoke-test");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const sub = await svc.submit(loaded.ir, { prompts: loaded.prompts });
    if (!sub.ok) throw new Error("seed failed");
    const vh = sub.versionHash;
    const now = Date.now();
    // greet failed, echoBack also has an attempt (the round-9 pattern).
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','greet',0,?,'regular','error',?)`,
    ).run(vh, now);
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a2','t1','echoBack',0,?,'regular','error',?)`,
    ).run(vh, now + 200_000);

    const cls = classifyOrphan(db, "t1");
    expect(cls.kind).toBe("resume");
    if (cls.kind === "resume") {
      // Topological order puts greet before echoBack; greet is firstPending.
      expect(cls.resumeFrom).toBe("greet");
    }
  });
});

describe("lookupResumeSessionId", () => {
  it("returns the most recent session_id for a given task+stage", async () => {
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

  it("returns undefined when no agent session exists for that stage", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const sid = lookupResumeSessionId(db, "t1", "analyzing");
    expect(sid).toBeUndefined();
  });
});

describe("bootResumability", () => {
  it("dispatches startPipelineRun for each resumable orphan", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const loaded = loadBuiltinPipelineIR("smoke-test");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const sub = await svc.submit(loaded.ir, { prompts: loaded.prompts });
    if (!sub.ok) throw new Error("seed failed");
    const vh = sub.versionHash;
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','greet',0,?,'regular','running',?)`,
    ).run(vh, now);

    const dispatched: Array<{ taskId: string; versionHash: string; resumeFrom?: string }> = [];
    const fakeStart = async (input: { taskId: string; versionHash: string; resumeFrom?: string }) => {
      dispatched.push({ taskId: input.taskId, versionHash: input.versionHash, resumeFrom: input.resumeFrom });
      return { ok: true as const, taskId: input.taskId, versionHash: input.versionHash };
    };

    const result = await bootResumability({ db, startPipelineRun: fakeStart });
    expect(result.resumed).toBe(1);
    expect(result.terminalRecovered).toBe(0);
    expect(dispatched).toEqual([{ taskId: "t1", versionHash: vh, resumeFrom: "greet" }]);
    const a1 = db.prepare("SELECT status FROM stage_attempts WHERE attempt_id='a1'").get() as { status: string };
    expect(a1.status).toBe("superseded");
  });

  it("writes task_finals for tasks that are actually terminal", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const loaded = loadBuiltinPipelineIR("smoke-test");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const sub = await svc.submit(loaded.ir, { prompts: loaded.prompts });
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
    const res = await bootResumability({
      db,
      startPipelineRun: async () => { dispatched.push(1); return { ok: true as const, taskId: "x", versionHash: vh }; },
    });
    expect(res.terminalRecovered).toBe(1);
    expect(res.resumed).toBe(0);
    expect(dispatched).toEqual([]);
    const final = db.prepare("SELECT final_state, reason, detail FROM task_finals WHERE task_id='t1'").get() as { final_state: string; reason: string; detail: string };
    expect(final.final_state).toBe("completed");
    expect(final.reason).toBe("natural");
    expect(final.detail).toBe("recovered_no_finals_row");
  });

  it("forwards tscPath to startPipelineRun for resumed orphans", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const loaded = loadBuiltinPipelineIR("smoke-test");
    const svc = new KernelService(db, { skipTypeCheck: true });
    const sub = await svc.submit(loaded.ir, { prompts: loaded.prompts });
    if (!sub.ok) throw new Error("seed failed");
    const vh = sub.versionHash;
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','greet',0,?,'regular','running',?)`,
    ).run(vh, now);

    const dispatched: Array<{ tscPath?: string }> = [];
    const fakeStart = async (input: { taskId: string; versionHash: string; resumeFrom?: string; resumeSessionId?: string; tscPath?: string }) => {
      dispatched.push({ tscPath: input.tscPath });
      return { ok: true as const, taskId: input.taskId, versionHash: input.versionHash };
    };

    await bootResumability({ db, startPipelineRun: fakeStart, tscPath: "/path/to/tsc" });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.tscPath).toBe("/path/to/tsc");
  });

  it("writes task_finals(failed) for unresolvable orphans", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
       VALUES ('a1','t1','s1',0,'missing-vh','regular','running',?)`,
    ).run(now);

    const dispatched: unknown[] = [];
    const res = await bootResumability({
      db,
      startPipelineRun: async () => { dispatched.push(1); return { ok: true as const, taskId: "x", versionHash: "x" }; },
    });
    expect(res.unresolvable).toBe(1);
    expect(dispatched).toEqual([]);
    const final = db.prepare("SELECT final_state, reason FROM task_finals WHERE task_id='t1'").get() as { final_state: string; reason: string };
    expect(final.final_state).toBe("failed");
    expect(final.reason).toBe("error");
  });
});

// --- BUG-1 regression: unanswered gate must not be classified as terminal.
//
// Real-world repro: external Claude Code session starts a pipeline via
// start_pipeline_generator. The runner reaches `awaitingConfirm` gate
// and blocks. While the user considers the answer, DEFAULT_RUN_TIMEOUT_MS
// expires — runner throws, finally-block unregisters the dispatcher and
// writes task_finals? NO: the throw happens before the task_finals write,
// so task_finals is missing. Server keeps running. On next boot scan
// orphan-reconciler sees a task with:
//   - stage_attempts: upstream stage(s) success
//   - gate_queue: gate row with answer IS NULL  (gate never answered)
//   - post-gate stages: no attempt rows
// `classifyOrphan` iterates topologically; isSkippable returns true for
// ALL gate stages → gate never qualifies as firstPending. Post-gate
// stages DO qualify. But when bootResumability resumes from a post-gate
// stage, the resumed runner has no gateAuthorizedTargets for the
// post-gate stage (the gate was never answered), so the post-gate stage
// sits in `waiting` forever. Worse: if EVERY remaining stage happens
// to be skippable, classifyOrphan returns `terminal`, and the task is
// force-completed without ever running the gated work.
//
// This test pins the bug: a single-chain pipeline where the ONLY
// remaining non-success stage is the unanswered gate → should resume
// the gate (or surface error), must never be classified as terminal.

import { PipelineIRSchema } from "../ir/schema.js";
import { insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";

function parseGateIR() {
  return PipelineIRSchema.parse({
    name: "gate-only-chain",
    externalInputs: [{ name: "seed", type: "string" }],
    stages: [
      {
        name: "A", type: "agent",
        inputs: [{ name: "seed", type: "string" }],
        outputs: [{ name: "trigger", type: "string" }],
        config: { promptRef: "p" },
      },
      {
        name: "gate1", type: "gate",
        inputs: [{ name: "__gate_signal", type: "unknown" }],
        outputs: [],
        config: {
          question: { text: "?" },
          routing: { routes: { approve: "after", reject: "A" } },
        },
      },
      {
        name: "after", type: "agent",
        inputs: [{ name: "trigger", type: "string" }],
        outputs: [{ name: "done", type: "string" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { source: "external", port: "seed" }, to: { stage: "A", port: "seed" } },
      { from: { stage: "A", port: "trigger" }, to: { stage: "gate1", port: "__gate_signal" } },
      { from: { stage: "A", port: "trigger" }, to: { stage: "after", port: "trigger" } },
    ],
  });
}

describe("classifyOrphan — gate regression (BUG-1)", () => {
  it("does NOT classify an unanswered gate+downstream as terminal", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = parseGateIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const now = Date.now();
    // Upstream succeeded.
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at, ended_at)
       VALUES ('a1','t-gate','A',0,?,'regular','success',?,?)`,
    ).run(vh, now, now + 1);
    // Gate_queue row exists but not answered. Post-gate stage has no
    // attempt. No task_finals row.

    const cls = classifyOrphan(db, "t-gate");
    // Unanswered gate stays in the candidate set → resume points at the
    // gate itself so the rebuilt runner re-enters gate `executing` and
    // re-emits gate_opened. Post-gate stages must NOT be selected while
    // their upstream gate is still open (authorization would be missing).
    expect(cls).toEqual({
      kind: "resume",
      versionHash: vh,
      resumeFrom: "gate1",
    });
  });

  it("treats an answered gate as skippable (existing behavior)", async () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = parseGateIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at, ended_at)
       VALUES ('a1','t-gate','A',0,?,'regular','success',?,?)`,
    ).run(vh, now, now + 1);
    // Gate queue row with answer set → the gate is resolved; a downstream
    // stage is the correct resume target.
    db.prepare(
      `INSERT INTO gate_queue (gate_id, task_id, stage_name, attempt_id, question_json, created_at, answer, answered_at)
       VALUES ('g1','t-gate','gate1','a1','{"text":"?"}',?,'approve',?)`,
    ).run(now, now + 2);

    const cls = classifyOrphan(db, "t-gate");
    expect(cls).toEqual({
      kind: "resume",
      versionHash: vh,
      resumeFrom: "after",
    });
  });
});

// F17: tasks with unresolved secret_gate_queue rows must not auto-resume.
describe("classifyOrphan — secret_pending (F17)", () => {
  it("classifies a task with unresolved secret_gate_queue as secret_pending (no auto-resume)", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = parseGateIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });

    const taskId = "t-orphan-secret";
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES ('a1', ?, ?, 'A', 0, ?, 'secret_pending')`,
    ).run(taskId, vh, Date.now());
    db.prepare(
      `INSERT INTO secret_gate_queue (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at)
       VALUES ('sg-orphan', ?, 'A', 'a1', '["KEY"]', ?)`,
    ).run(taskId, Date.now());

    const cls = classifyOrphan(db, taskId);
    expect(cls.kind).toBe("secret_pending");
  });

  it("does NOT classify secret_pending when all secret_gate_queue rows are resolved", () => {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    const ir = parseGateIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });

    const taskId = "t-orphan-secret-resolved";
    const now = Date.now();
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES ('a1', ?, ?, 'A', 0, ?, 'success')`,
    ).run(taskId, vh, now);
    db.prepare(
      `INSERT INTO secret_gate_queue (secret_gate_id, task_id, stage_name, attempt_id, required_keys, created_at, resolved_at)
       VALUES ('sg-resolved', ?, 'A', 'a1', '["KEY"]', ?, ?)`,
    ).run(taskId, now, now + 1000);

    const cls = classifyOrphan(db, taskId);
    // Resolved secret gate → normal classification; next stage is pending
    expect(cls.kind).not.toBe("secret_pending");
  });
});
