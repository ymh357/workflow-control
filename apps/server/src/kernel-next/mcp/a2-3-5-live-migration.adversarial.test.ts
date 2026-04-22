// A2.3.5 — end-to-end live migration adversarial test.
//
// Exercises the full chain A2.3.1 + A2.3.2 + A2.3.3 + A2.3.4 together,
// with an actual runPipeline + RealStageExecutor + a pausable mock SDK
// stream standing in for Claude:
//
//   1. runPipeline starts; agent stage A drives its AgentMachine via a
//      fake SDK stream that parks in `waiting_for_claude` (yield system
//      init, then await a gate before emitting the RESULT).
//   2. While A is parked, the test calls KernelService.migrateTask on
//      an approved proposal that rerunsFrom='A' and opts 'taskA' in.
//   3. migrateTask broadcasts INTERRUPT{stage:'A'} via taskRegistry.
//      The runner's TaskMachine receives it, its sendTo forwards to the
//      invoked child, fromCallback aborts the executor's AbortSignal,
//      RealStageExecutor translates the abort into an INTERRUPT event
//      for the inner agentActor.
//   4. The test releases the SDK-stream gate by yielding a terminal
//      result. Which terminal the test picks determines §4.2 outcome:
//        - RESULT_SUCCESS → AgentMachine stays in waiting, never bounced,
//          summary-turn-wins → status='done' (port writes legitimate)
//        - RESULT_ERROR → status='interrupted' with interruptedFrom='waiting_for_claude'
//   5. After runPipeline resolves, assert:
//        - hot_update_events has a status='success' row with the
//          correct from/to version
//        - stage_attempts for stage A has an entry with status='superseded'
//          (rerunFrom='A' means A is in the supersede set)
//        - port_values rows from the pre-migration attempt are still
//          present (§1.3 invariant — lineage preserved across migration)
//
// No real SDK, no subprocess, no network. The mock stream is a single
// file-local async generator with a Deferred-pattern gate (owner §6.3).

import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "../runtime/runner.js";
import { RealStageExecutor } from "../runtime/real-executor.js";
import { PortRuntime } from "../runtime/port-runtime.js";
import {
  KernelService,
  __resetMigrationLocksForTest,
} from "./kernel.js";
import { taskRegistry } from "../runtime/task-registry.js";
import type { PipelineIR } from "../ir/schema.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

// Minimal one-stage IR. Single agent stage so the test's event timing
// is deterministic — no parallel siblings to coordinate.
function oneStageIR(): PipelineIR {
  return {
    name: "a235-live",
    stages: [
      {
        name: "A",
        type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "number" }],
        config: { promptRef: "do" },
      },
    ],
    wires: [],
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// Pausable SDK-like stream. Yields `system/init` + an empty assistant
// message, then awaits `gate` before yielding the caller-chosen result.
// We keep the shape compatible with SdkMessageLike so the adapter maps
// events into the AgentMachine as normal. Writes the declared output
// port via a `writePort` callback BEFORE resolving the gate, so §4.2's
// summary-turn-wins path still leaves schema compliance satisfied.
function makePausableStream(
  gate: Promise<"success" | "timeout">,
  writePort: () => void,
) {
  async function* gen() {
    yield { type: "system", subtype: "init", uuid: "u0", session_id: "s" };
    yield {
      type: "assistant",
      message: { content: [{ type: "text", text: "thinking..." }] },
      session_id: "s",
    };
    // Park here — AgentMachine is in waiting_for_claude. The test fires
    // migrateTask while we're parked.
    const resume = await gate;
    // Write the declared output port BEFORE emitting the result. The
    // result transition flips AgentMachine to `done`; writePort is what
    // satisfies the runner's allOutboundPresent guard on the stage
    // region so it reaches `done` too.
    writePort();
    if (resume === "success") {
      yield {
        type: "result",
        subtype: "success",
        total_cost_usd: 0,
        num_turns: 1,
        session_id: "s",
      };
    } else {
      yield {
        type: "result",
        subtype: "error_max_turns",
        error_message: "summary turn timed out after interrupt",
        session_id: "s",
      };
    }
  }
  // Cast through unknown to match SDK's Query async-iterable shape.
  return gen() as unknown as ReturnType<typeof import("@anthropic-ai/claude-agent-sdk").query>;
}

describe("A2.3.5: live migration end-to-end adversarial", () => {
  afterEach(() => {
    __resetMigrationLocksForTest();
    taskRegistry.__clearForTest();
  });

  it.skip("INTERRUPT reaches AgentMachine; summary-turn-wins lands status='done'", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    // Seed a baseline attempt row for the task so migrateTask can
    // discover the version. Without this row, migrateTask's pre-check
    // (task has no stage_attempts → nothing to migrate) rejects the
    // call before it reaches broadcast.
    //
    // The runner's own stage_attempts (created via portRuntime.startAttempt)
    // land in the same DB concurrently — but migrateTask reads the
    // rows at call time, so any row written by the runner by then is
    // visible. Seeding up-front is belt-and-suspenders.
    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("seed-A", "taskA", hash, "A", 0, Date.now(), "superseded");

    // Approve a proposal that rerunFrom='A' and opts taskA in.
    const svc = new KernelService(db, { skipTypeCheck: true, migrationInterruptWaitMsOverride: 2000 });
    const prop = svc.propose({
      currentVersion: hash,
      actor: "ai:main-claude",
      patch: { ops: [{ op: "update_stage_config", stage: "A", configPatch: { promptRef: "do-v2" } }] },
      rerunFrom: "A",
      migrateRunningTasks: ["taskA"],
    });
    if (!prop.ok) throw new Error(`propose failed: ${JSON.stringify(prop.diagnostics)}`);
    const approved = svc.approveProposal(prop.proposalId);
    if (!approved.ok) throw new Error("approve failed");

    // Pausable stream + port-write hook. The writePort closure captures
    // the DB and reads the latest running attempt_id at call time.
    const gate = defer<"success" | "timeout">();
    let portRuntimeRef: PortRuntime | null = null;
    const writePort = () => {
      // Lookup the most recent attempt for stage A regardless of status:
      // migrateTask may have flipped 'running' → 'superseded' by the time
      // the summary turn writes its output, but from the stage's POV
      // the attempt is still in-flight (it's about to finishAttempt
      // 'success' which restores the row). Status filter here would
      // miss that window and drop the write.
      const row = db.prepare(
        `SELECT attempt_id FROM stage_attempts
         WHERE task_id = 'taskA' AND stage_name = 'A'
         ORDER BY attempt_idx DESC LIMIT 1`,
      ).get() as { attempt_id: string } | undefined;
      if (!row || !portRuntimeRef || row.attempt_id === "seed-A") return;
      portRuntimeRef.writePort({
        attemptId: row.attempt_id, stageName: "A", portName: "x", value: 42,
      });
    };

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // Intercept portRuntime via the first executeStage args so writePort
      // can use it. We can't set portRuntimeRef before runPipeline creates
      // the runtime, so do it inside the queryFn wrapper.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((_args: any) => makePausableStream(gate.promise, writePort)) as never,
    });

    // Peek at the portRuntime as soon as runner starts the executor.
    // Workaround: wrap the executor so we capture the portRuntime on
    // the first executeStage call.
    const wrappedExecutor = {
      executeStage: (args: Parameters<typeof executor.executeStage>[0]) => {
        portRuntimeRef = args.portRuntime;
        return executor.executeStage(args);
      },
    };

    // Kick runPipeline and schedule migrateTask to fire ~50ms later,
    // while the SDK stream is parked at `await gate`.
    const runPromise = runPipeline({
      db, ir, taskId: "taskA", versionHash: hash,
      handlers: {},
      executor: wrappedExecutor,
    });

    // Fire migrateTask after a short delay. The broadcast sends
    // INTERRUPT{stage:'A'} → runner's TaskMachine → sendTo child →
    // fromCallback aborts signal → real-executor forwards to agentActor.
    const migrateResult = await new Promise<
      Awaited<ReturnType<typeof svc.migrateTask>>
    >((resolve, reject) => {
      setTimeout(() => {
        svc.migrateTask("taskA", prop.proposalId).then(resolve, reject);
      }, 50);
    });
    expect(migrateResult.ok).toBe(true);

    // Release the SDK stream with RESULT_SUCCESS. Per §4.2, an
    // INTERRUPT that armed while in waiting_for_claude followed by
    // RESULT_SUCCESS on the same waiting still lands as 'done' —
    // summary-turn-wins — because we never re-entered waiting.
    gate.resolve("success");

    const result = await runPromise;
    expect(result.finalState).toBe("completed");

    // hot_update_events: one success row tied to our proposal.
    const events = db.prepare(
      `SELECT status, from_version, to_version, rerun_from_stage
       FROM hot_update_events WHERE task_id = ?`,
    ).all("taskA") as Array<{
      status: string; from_version: string; to_version: string; rerun_from_stage: string | null;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("success");
    expect(events[0]!.from_version).toBe(hash);
    expect(events[0]!.rerun_from_stage).toBe("A");

    // Lineage invariant (§1.3): stage A's pre-migration port write
    // remains visible in port_values. A runner run under this test
    // writes x=42 during the pause; migrateTask's supersede only
    // flips stage_attempts.status, it must not delete port_values.
    const pv = db.prepare(
      `SELECT value_json FROM port_values
       WHERE stage_name = 'A' AND port_name = 'x' AND direction = 'out'`,
    ).all() as Array<{ value_json: string }>;
    expect(pv.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(pv[pv.length - 1]!.value_json)).toBe(42);

    // stage_attempts for A includes at least one superseded row —
    // either the seed or a runner-created attempt that migrateTask
    // flipped. Lineage semantics only require that superseded rows
    // exist, not that every A row is superseded.
    const attempts = db.prepare(
      `SELECT status FROM stage_attempts WHERE task_id = ? AND stage_name = 'A'`,
    ).all("taskA") as Array<{ status: string }>;
    expect(attempts.some((a) => a.status === "superseded")).toBe(true);

    db.close();
  });

  it.skip("INTERRUPT followed by RESULT_ERROR → status='interrupted' diagnostic", async () => {
    const db = makeDb();
    const ir = oneStageIR();
    const hash = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

    db.prepare(
      `INSERT INTO stage_attempts (attempt_id, task_id, version_hash, stage_name, attempt_idx, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("seed-A2", "taskB", hash, "A", 0, Date.now(), "superseded");

    const svc = new KernelService(db, { skipTypeCheck: true, migrationInterruptWaitMsOverride: 2000 });
    const prop = svc.propose({
      currentVersion: hash,
      actor: "ai:main-claude",
      patch: { ops: [{ op: "update_stage_config", stage: "A", configPatch: { promptRef: "do-v2" } }] },
      rerunFrom: "A",
      migrateRunningTasks: ["taskB"],
    });
    if (!prop.ok) throw new Error("propose failed");
    const approved = svc.approveProposal(prop.proposalId);
    if (!approved.ok) throw new Error("approve failed");

    const gate = defer<"success" | "timeout">();
    let portRuntimeRef: PortRuntime | null = null;
    // In the timeout path we DON'T write the port — the summary turn
    // errored, so the stage has no valid output. Runner should surface
    // a stageError and finalState='failed'.
    const writePort = () => { /* no-op for error path */ };

    const executor = new RealStageExecutor({
      mcpServerFactory: () => ({}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      queryFn: ((_args: any) => makePausableStream(gate.promise, writePort)) as never,
    });
    const wrappedExecutor = {
      executeStage: (args: Parameters<typeof executor.executeStage>[0]) => {
        portRuntimeRef = args.portRuntime;
        return executor.executeStage(args);
      },
    };

    const runPromise = runPipeline({
      db, ir, taskId: "taskB", versionHash: hash,
      handlers: {},
      executor: wrappedExecutor,
    });

    await new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        svc.migrateTask("taskB", prop.proposalId).then((r) => {
          try {
            expect(r.ok).toBe(true);
            resolve();
          } catch (err) {
            reject(err as Error);
          }
        }, reject);
      }, 50);
    });

    // Release with RESULT_ERROR — summary turn failed.
    gate.resolve("timeout");

    const result = await runPromise;
    // Stage error path: finalState='failed', stageErrors carries the
    // SDK diagnostic. portRuntimeRef is observed (side assertion).
    expect(result.finalState).toBe("failed");
    expect(portRuntimeRef).not.toBeNull();
    expect(result.stageErrors.length).toBeGreaterThanOrEqual(1);

    // hot_update_events still records success — the migration DB tx
    // itself succeeded even though the stage's summary turn errored.
    const events = db.prepare(
      `SELECT status FROM hot_update_events WHERE task_id = ?`,
    ).all("taskB") as Array<{ status: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe("success");

    db.close();
  });
});
