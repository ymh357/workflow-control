// A7 acceptance: one non-trivial pipeline runs end-to-end on
// kernel-next and exercises all three stage primitives + fanout +
// gate routing + wire guards + lineage.
//
// Pipeline shape (tech-research-like, modelled after the preserved
// `tech-research` builtin in roadmap §4):
//
//   SRC                      agent  → { topic, candidates[] }
//    │
//    ├─ candidates[] ──► EVAL (fanout agent) — per-candidate score
//    │                        → { score }
//    │
//    └─ topic ──────────► TOPIC_ECHO (agent, sanity check)
//                              │
//   EVAL (aggregated) ─────────┤
//                              ▼
//                           FILTER (agent) — keep candidates with score > 5
//                              │   outputs { selected[] }
//                              ▼
//                            GATE (gate) — "ready to summarise?"
//                              │
//                   yes ──► SUMMARY
//                   no  ──► REVIEW
//
// Wire guard: FILTER → SUMMARY only fires when FILTER.selected.length > 0.
// Gate routing: GATE with yes/no routes SUMMARY / REVIEW exclusively.
//
// We use MockStageExecutor (handlers-based) as the underlying stage
// body — no real SDK, no CLI, no network. The scenario still exercises
// every mechanical kernel-next primitive:
//   - parallel fan-out on SRC (EVAL fanout + TOPIC_ECHO branch)
//   - fanout virtual attempts + per-element lineage
//   - wire guards drop dead branches
//   - gate routing exclusivity picks one target
//   - get_task_status transitions through running → gated → completed

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import { runPipeline } from "./runner.js";
import { queryLineage } from "../mcp/lineage.js";
import { KernelService } from "../mcp/kernel.js";
import type { PipelineIR } from "../ir/schema.js";
import type { StageHandlerMap } from "./mock-executor.js";

interface Candidate {
  id: string;
  title: string;
}

function techResearchIR(): PipelineIR {
  return {
    name: "tech-research-a7",
    stages: [
      {
        name: "SRC",
        type: "agent",
        inputs: [],
        outputs: [
          { name: "candidates", type: "{ id: string; title: string }[]" },
          { name: "topic_out", type: "string" },
        ],
        config: { promptRef: "gather-candidates" },
      },
      {
        name: "EVAL",
        type: "agent",
        fanout: { input: "candidate" },
        inputs: [{ name: "candidate", type: "{ id: string; title: string }" }],
        outputs: [{ name: "score", type: "{ id: string; score: number }" }],
        config: { promptRef: "score-candidate" },
      },
      {
        name: "TOPIC_ECHO",
        type: "agent",
        inputs: [{ name: "topic", type: "string" }],
        outputs: [{ name: "echoed", type: "string" }],
        config: { promptRef: "echo-topic" },
      },
      {
        name: "FILTER",
        type: "agent",
        inputs: [
          { name: "scores", type: "{ id: string; score: number }[]" },
          { name: "pool", type: "{ id: string; title: string }[]" },
        ],
        outputs: [
          { name: "selected", type: "{ id: string; title: string; score: number }[]" },
        ],
        config: { promptRef: "select-top-candidates" },
      },
      {
        name: "GATE",
        type: "gate",
        inputs: [
          { name: "selected", type: "{ id: string; title: string; score: number }[]" },
        ],
        outputs: [],
        config: {
          question: { text: "ready to summarise?", options: ["yes", "no"] },
          routing: { routes: { yes: "SUMMARY", no: "REVIEW" } },
        },
      },
      {
        name: "SUMMARY",
        type: "agent",
        inputs: [
          { name: "selected", type: "{ id: string; title: string; score: number }[]" },
        ],
        outputs: [{ name: "report", type: "string" }],
        config: { promptRef: "summary" },
      },
      {
        name: "REVIEW",
        type: "agent",
        inputs: [
          { name: "selected", type: "{ id: string; title: string; score: number }[]" },
        ],
        outputs: [{ name: "note", type: "string" }],
        config: { promptRef: "review" },
      },
    ],
    wires: [
      // SRC.candidates fans out into EVAL.candidate (runner iterates the array)
      { from: { stage: "SRC", port: "candidates" }, to: { stage: "EVAL", port: "candidate" } },
      // SRC.candidates also feeds FILTER.pool (the pool to re-join with scores)
      { from: { stage: "SRC", port: "candidates" }, to: { stage: "FILTER", port: "pool" } },
      { from: { stage: "SRC", port: "topic_out" }, to: { stage: "TOPIC_ECHO", port: "topic" } },
      // EVAL aggregates into FILTER.scores as an array
      { from: { stage: "EVAL", port: "score" }, to: { stage: "FILTER", port: "scores" } },
      // FILTER.selected feeds the gate — guard ensures we only proceed with
      // a non-empty selection.
      {
        from: { stage: "FILTER", port: "selected" },
        to: { stage: "GATE", port: "selected" },
        guard: "value.length > 0",
      },
      // Gate routing targets wire from FILTER.selected so both branches can
      // read the full selection (but only the gate-picked branch activates).
      { from: { stage: "FILTER", port: "selected" }, to: { stage: "SUMMARY", port: "selected" } },
      { from: { stage: "FILTER", port: "selected" }, to: { stage: "REVIEW", port: "selected" } },
    ],
  };
}

function seededHandlers(): StageHandlerMap {
  return {
    SRC: () => ({
      candidates: [
        { id: "c1", title: "react" },
        { id: "c2", title: "vue" },
        { id: "c3", title: "svelte" },
        { id: "c4", title: "angular" },
      ],
      topic_out: "initial",
    }),
    EVAL: (inputs) => {
      const c = inputs.candidate as Candidate;
      const score = c.id === "c1" ? 9 : c.id === "c2" ? 7 : c.id === "c3" ? 8 : 3;
      return { score: { id: c.id, score } };
    },
    TOPIC_ECHO: (inputs) => ({ echoed: `topic=${inputs.topic as string}` }),
    FILTER: (inputs) => {
      const scores = inputs.scores as Array<{ id: string; score: number }>;
      const pool = inputs.pool as Candidate[];
      const scoreMap = new Map(scores.map((s) => [s.id, s.score]));
      const joined = pool
        .map((c) => ({ ...c, score: scoreMap.get(c.id) ?? 0 }))
        .filter((r) => r.score > 5)
        .sort((a, b) => b.score - a.score);
      return { selected: joined };
    },
    SUMMARY: (inputs) => {
      const sel = inputs.selected as Array<{ title: string; score: number }>;
      return { report: sel.map((s) => `${s.title}(${s.score})`).join(" > ") };
    },
    REVIEW: () => ({ note: "no summary path taken" }),
  };
}

async function driveGateAnswer(
  db: DatabaseSync,
  taskId: string,
  answer: string,
): Promise<void> {
  const kernel = new KernelService(db, { skipTypeCheck: true });
  // Poll briefly for the gate row to appear (pipeline has to reach GATE).
  const deadline = Date.now() + 5000;
  let gateId: string | undefined;
  while (!gateId && Date.now() < deadline) {
    const gates = kernel.listGates({ taskId, answered: false });
    if (gates.length > 0) gateId = gates[0]!.gateId;
    else await new Promise((r) => setTimeout(r, 20));
  }
  if (!gateId) {
    // Debug: dump what happened so far.
    const attempts = db.prepare(
      `SELECT stage_name, status FROM stage_attempts WHERE task_id = ?`,
    ).all(taskId) as Array<{ stage_name: string; status: string }>;
    // eslint-disable-next-line no-console
    console.log("no gate for", taskId, "; attempts=", attempts);
    throw new Error("gate did not appear within 5s");
  }
  const result = kernel.answerGate(gateId, answer);
  if (!result.ok) throw new Error(`answerGate failed: ${JSON.stringify(result.diagnostics)}`);

  // Mirror MCP handler: dispatch GATE_ANSWERED via task registry.
  const { taskRegistry } = await import("./task-registry.js");
  const dispatcher = taskRegistry.get(taskId);
  if (!dispatcher) throw new Error("no dispatcher registered for task");
  dispatcher.send({
    type: "GATE_ANSWERED",
    gateId: result.gateId,
    stageName: result.stageName,
    answer: result.answer,
    targetStage: result.targetStage,
  });
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initKernelNextSchema(db);
  return db;
}

describe("A7 debug: pipeline reaches FILTER", () => {
  it("reaches FILTER (sanity check — no gate, no timing)", async () => {
    const db = makeDb();
    try {
      const fullIR = techResearchIR();
      // Trim: drop GATE + SUMMARY + REVIEW so the run completes without
      // a gate answer. Keep everything up to FILTER.
      const ir: PipelineIR = {
        ...fullIR,
        stages: fullIR.stages.filter((s) => ["SRC", "EVAL", "TOPIC_ECHO", "FILTER"].includes(s.name)),
        wires: fullIR.wires.filter((w) =>
          ["SRC", "EVAL", "TOPIC_ECHO", "FILTER"].includes(w.from.stage) &&
          ["SRC", "EVAL", "TOPIC_ECHO", "FILTER"].includes(w.to.stage)
        ),
      };
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const result = await runPipeline({
        db, ir, taskId: "sanity", versionHash: hash,
        handlers: seededHandlers(),
      }, 20_000);

      expect(result.finalState).toBe("completed");
      const sel = result.portValues["FILTER.selected"] as Array<{ id: string; score: number }>;
      expect(sel.map((s) => s.id)).toEqual(["c1", "c3", "c2"]);
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("A7: tech-research-style end-to-end pipeline", () => {
  it("SRC → fanout EVAL → FILTER → GATE(yes) → SUMMARY; REVIEW skipped", async () => {
    const db = makeDb();
    try {
      const ir = techResearchIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const taskId = "tr-yes";
      const runPromise = runPipeline({
        db, ir, taskId, versionHash: hash,
        handlers: seededHandlers(),
      }, 45_000);

      await driveGateAnswer(db, taskId, "yes");

      const result = await runPromise;
      expect(result.finalState).toBe("completed");
      expect(result.stageErrors).toEqual([]);

      // Fanout produced 4 EVAL attempts (one per candidate) + 1
      // aggregate attempt that persists the T[] to port_values.
      const evalAttempts = db.prepare(
        `SELECT COUNT(*) AS n FROM stage_attempts
         WHERE task_id = ? AND stage_name = 'EVAL'`,
      ).get(taskId) as { n: number };
      expect(evalAttempts.n).toBe(5);

      // FILTER.selected holds the aggregated top candidates.
      const selected = result.portValues["FILTER.selected"] as Array<{
        id: string; title: string; score: number;
      }>;
      expect(selected.map((s) => s.id)).toEqual(["c1", "c3", "c2"]);

      // SUMMARY ran; REVIEW did NOT (gate routing exclusivity).
      expect(result.portValues["SUMMARY.report"]).toBe("react(9) > svelte(8) > vue(7)");
      expect(result.portValues["REVIEW.note"]).toBeUndefined();

      // Lineage: SRC.candidates feeds 4 downstream reads (EVAL × 4 via
      // fanout) + 1 FILTER.pool read.
      const candidateReads = db.prepare(
        `SELECT pv.stage_name, pv.port_name FROM port_values pv
         JOIN stage_attempts sa ON sa.attempt_id = pv.attempt_id
         WHERE pv.direction = 'in' AND sa.task_id = ?
           AND pv.stage_name IN ('EVAL', 'FILTER')
           AND pv.port_name IN ('candidate', 'pool')
         ORDER BY pv.stage_name, pv.port_name`,
      ).all(taskId) as Array<{ stage_name: string; port_name: string }>;
      const counts = candidateReads.reduce<Record<string, number>>((acc, r) => {
        const k = `${r.stage_name}.${r.port_name}`;
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
      expect(counts["EVAL.candidate"]).toBe(4);
      expect(counts["FILTER.pool"]).toBe(1);

      // TOPIC_ECHO ran in parallel (lineage independent from EVAL).
      expect(result.portValues["TOPIC_ECHO.echoed"]).toBe("topic=initial");
    } finally {
      db.close();
    }
  }, 60_000);

  it("GATE(no) routes to REVIEW exclusively; SUMMARY never runs", async () => {
    const db = makeDb();
    try {
      const ir = techResearchIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const taskId = "tr-no";
      const runPromise = runPipeline({
        db, ir, taskId, versionHash: hash,
        handlers: seededHandlers(),
      }, 30_000);

      await driveGateAnswer(db, taskId, "no");

      const result = await runPromise;
      expect(result.finalState).toBe("completed");

      // REVIEW ran, SUMMARY did not — gate routing exclusivity.
      expect(result.portValues["REVIEW.note"]).toBe("no summary path taken");
      expect(result.portValues["SUMMARY.report"]).toBeUndefined();

      // Both SUMMARY and REVIEW had inbound wires that delivered (same
      // FILTER.selected). Only REVIEW should have a stage_attempt.
      const attempts = db.prepare(
        `SELECT stage_name FROM stage_attempts WHERE task_id = ? ORDER BY stage_name`,
      ).all(taskId) as Array<{ stage_name: string }>;
      const names = attempts.map((r) => r.stage_name);
      expect(names).toContain("REVIEW");
      expect(names).not.toContain("SUMMARY");
    } finally {
      db.close();
    }
  }, 60_000);

  it("query_lineage report is well-formed for the final SUMMARY output", async () => {
    const db = makeDb();
    try {
      const ir = techResearchIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const taskId = "tr-lin";
      const runPromise = runPipeline({
        db, ir, taskId, versionHash: hash,
        handlers: seededHandlers(),
      }, 30_000);
      await driveGateAnswer(db, taskId, "yes");
      const result = await runPromise;
      expect(result.finalState).toBe("completed");

      const report = queryLineage(db, { stage: "SUMMARY", port: "report", taskId });
      expect(report.latestWrite).not.toBeNull();
      expect(report.latestWrite!.valuePreview).toContain("react(9)");
    } finally {
      db.close();
    }
  }, 60_000);

  it("get_task_status transitions running → gated → completed", async () => {
    const db = makeDb();
    try {
      const ir = techResearchIR();
      const hash = versionHash(ir);
      insertPipelineVersion(db, ir, { versionHash: hash, tsSource: "" });

      const taskId = "tr-status";
      const svc = new KernelService(db, { skipTypeCheck: true });
      const runPromise = runPipeline({
        db, ir, taskId, versionHash: hash,
        handlers: seededHandlers(),
      }, 30_000);

      // Poll for 'gated' status — this is the distinctive state we
      // want to observe before answering.
      const deadline = Date.now() + 5000;
      let sawGated = false;
      while (Date.now() < deadline) {
        const s = svc.getTaskStatus(taskId);
        if (s.status === "gated") { sawGated = true; break; }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(sawGated).toBe(true);

      await driveGateAnswer(db, taskId, "yes");
      const result = await runPromise;
      expect(result.finalState).toBe("completed");

      const after = svc.getTaskStatus(taskId);
      expect(after.status).toBe("completed");
    } finally {
      db.close();
    }
  }, 60_000);
});
