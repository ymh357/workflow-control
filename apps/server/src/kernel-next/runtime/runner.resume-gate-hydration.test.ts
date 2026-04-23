// M-R3: Verify runner resume hydrates persistentGateAuthorized from
// gate_queue.answer rows. Scenario: gate was answered (committed to
// gate_queue) but the runner crashed before dispatching GATE_ANSWERED
// into the machine — i.e. in-memory state never recorded the approval.
// On resume, the answer must still route correctly.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import { PipelineIRSchema } from "../ir/schema.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

function parseIR(raw: unknown): PipelineIR {
  return PipelineIRSchema.parse(raw) as unknown as PipelineIR;
}

function gateIR(): PipelineIR {
  return parseIR({
    name: "gate-resume-hydration",
    externalInputs: [{ name: "seed", type: "string" }],
    stages: [
      {
        name: "entry", type: "agent",
        inputs: [{ name: "seed", type: "string" }],
        outputs: [{ name: "payload", type: "string" }],
        config: { promptRef: "p" },
      },
      {
        name: "gate1", type: "gate",
        inputs: [{ name: "__gate_signal", type: "unknown" }],
        outputs: [],
        config: {
          question: { text: "?" },
          routing: { routes: { approve: "after", reject: "entry" } },
        },
      },
      {
        name: "after", type: "agent",
        inputs: [{ name: "payload", type: "string" }],
        outputs: [{ name: "done", type: "string" }],
        config: { promptRef: "p" },
      },
    ],
    wires: [
      { from: { source: "external", port: "seed" }, to: { stage: "entry", port: "seed" } },
      { from: { stage: "entry", port: "payload" }, to: { stage: "gate1", port: "__gate_signal" } },
      { from: { stage: "entry", port: "payload" }, to: { stage: "after", port: "payload" } },
    ],
  });
}

describe("runner resume hydrates gate_queue.answer", () => {
  it(
    "machine completes without re-asking the gate when gate_queue has an answered row",
    { timeout: 15_000 },
    async () => {
      const db = new DatabaseSync(":memory:");
      initKernelNextSchema(db);
      const ir = gateIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const taskId = "t-gate-resume";
      const now = Date.now();

      // Simulate the pre-crash world: entry completed with payload
      // written, gate_queue row carries answer='approve' but the
      // runner never dispatched GATE_ANSWERED before it was killed.
      db.prepare(
        `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
         VALUES ('ext', ?, '__external__', 0, ?, 'external', 'success', ?)`,
      ).run(taskId, hash, now);
      db.prepare(
        `INSERT INTO port_values (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
         VALUES ('v-ext', 'ext', '__external__', 'seed', 'out', '"hello"', ?)`,
      ).run(now);

      db.prepare(
        `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
         VALUES ('a-entry', ?, 'entry', 0, ?, 'regular', 'success', ?)`,
      ).run(taskId, hash, now + 10);
      db.prepare(
        `INSERT INTO port_values (value_id, attempt_id, stage_name, port_name, direction, value_json, written_at)
         VALUES ('v-payload', 'a-entry', 'entry', 'payload', 'out', '"data"', ?)`,
      ).run(now + 20);

      // Gate stage_attempt marked superseded (simulates graceful
      // shutdown reconcile), and gate_queue row carries the answer.
      db.prepare(
        `INSERT INTO stage_attempts (attempt_id, task_id, stage_name, attempt_idx, version_hash, kind, status, started_at)
         VALUES ('g-att', ?, 'gate1', 0, ?, 'regular', 'superseded', ?)`,
      ).run(taskId, hash, now + 30);
      db.prepare(
        `INSERT INTO gate_queue (gate_id, task_id, stage_name, attempt_id, question_json, answer, answered_at, created_at)
         VALUES ('gq-1', ?, 'gate1', 'g-att', '{"text":"?"}', 'approve', ?, ?)`,
      ).run(taskId, now + 40, now + 30);

      // Now resume. Handlers: entry must NOT re-run because it is
      // success already; after MUST run because it is still pending.
      let afterRan = false;
      const handlers: StageHandlerMap = {
        entry: () => { throw new Error("entry must not re-run on resume"); },
        after: () => { afterRan = true; return { done: "yes" }; },
      };

      const r = await runPipeline({
        db, ir, taskId, versionHash: hash, handlers,
        resumeFrom: "after",
        seedValues: { seed: "hello" },
      }, 10_000);

      expect(r.finalState).toBe("completed");
      expect(afterRan).toBe(true);
    },
  );
});
