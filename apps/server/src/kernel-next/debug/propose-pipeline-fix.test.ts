import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  buildFixSuggestions,
  proposePipelineFix,
  proposePipelineFixWithAi,
} from "./propose-pipeline-fix.js";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import type { TaskFailureReport } from "../../lib/debug-queries.js";
import type { PipelineIR, IRPatch } from "../ir/schema.js";

function simpleIR(): PipelineIR {
  return {
    name: "p",
    stages: [
      {
        name: "A", type: "agent",
        inputs: [],
        outputs: [{ name: "x", type: "string" }],
        config: { promptRef: "p-a" },
      },
      {
        name: "B", type: "agent",
        inputs: [{ name: "x", type: "string" }],
        outputs: [{ name: "y", type: "string" }],
        config: { promptRef: "p-b" },
      },
    ],
    wires: [{ from: { stage: "A", port: "x" }, to: { stage: "B", port: "x" } }],
  };
}

function reportWithHint(
  overrides: Partial<TaskFailureReport> & {
    hintKind: TaskFailureReport["hints"][number]["kind"];
    stageName: string;
  },
): TaskFailureReport {
  return {
    taskId: "t1",
    found: true,
    totalAttempts: 1,
    totalCostUsd: 0,
    firstStartedAt: null,
    lastHeartbeatAt: null,
    stages: [],
    failingStages: [overrides.stageName],
    hints: [{
      kind: overrides.hintKind,
      stageName: overrides.stageName,
      attemptId: "a1",
      detail: "synthetic test hint",
    }],
    ...overrides,
  };
}

describe("buildFixSuggestions", () => {
  it("returns [] when the report has found=false (no attempts)", () => {
    const report: TaskFailureReport = {
      taskId: "t1", found: false, totalAttempts: 0, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [], failingStages: [], hints: [],
    };
    expect(buildFixSuggestions(report, simpleIR())).toEqual([]);
  });

  it("returns [] when there are no failing stages and no hints", () => {
    const report: TaskFailureReport = {
      taskId: "t1", found: true, totalAttempts: 1, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [], failingStages: [], hints: [],
    };
    expect(buildFixSuggestions(report, simpleIR())).toEqual([]);
  });

  it("produces a 'stuck_open' suggestion for stuck attempts", () => {
    const report = reportWithHint({ hintKind: "stuck_open", stageName: "B" });
    const suggestions = buildFixSuggestions(report, simpleIR());
    expect(suggestions.length).toBeGreaterThanOrEqual(1);
    const s = suggestions.find((x) => x.kind === "stuck_open");
    expect(s).toBeDefined();
    expect(s!.targetStage).toBe("B");
    expect(s!.severity).toBe("warn");
    expect(s!.description.toLowerCase()).toContain("heartbeat");
  });

  it("produces an 'error_status' suggestion for failed attempts + points at the failing stage", () => {
    const report = reportWithHint({ hintKind: "error_status", stageName: "B" });
    const suggestions = buildFixSuggestions(report, simpleIR());
    const s = suggestions.find((x) => x.kind === "error_status");
    expect(s).toBeDefined();
    expect(s!.targetStage).toBe("B");
    expect(s!.severity).toBe("error");
  });

  it("produces an 'error_in_stream' suggestion when the agent's stream contained an error marker", () => {
    const report = reportWithHint({ hintKind: "error_in_stream", stageName: "A" });
    const suggestions = buildFixSuggestions(report, simpleIR());
    const s = suggestions.find((x) => x.kind === "error_in_stream");
    expect(s).toBeDefined();
    // error_in_stream correlates with prompt-quality issues; rationale
    // should point at the prompt.
    expect(s!.rationale.toLowerCase()).toMatch(/prompt/);
  });

  it("'interrupted' hint is mapped to severity='info' (not a pipeline design problem)", () => {
    const report = reportWithHint({ hintKind: "interrupted", stageName: "A" });
    const suggestions = buildFixSuggestions(report, simpleIR());
    const s = suggestions.find((x) => x.kind === "interrupted");
    expect(s).toBeDefined();
    expect(s!.severity).toBe("info");
  });

  it("'superseded' hint is mapped to severity='info' (look at later attempt)", () => {
    const report = reportWithHint({ hintKind: "superseded", stageName: "B" });
    const suggestions = buildFixSuggestions(report, simpleIR());
    const s = suggestions.find((x) => x.kind === "superseded");
    expect(s).toBeDefined();
    expect(s!.severity).toBe("info");
  });

  it("drops suggestions targeting stages that no longer exist in the current IR", () => {
    // Task ran against an older IR where stage 'X' existed; the current
    // IR no longer declares 'X'. Suggestions targeting 'X' would not be
    // actionable and must be filtered.
    const report = reportWithHint({ hintKind: "error_status", stageName: "X" });
    const suggestions = buildFixSuggestions(report, simpleIR());
    expect(suggestions.every((s) => s.targetStage !== "X")).toBe(true);
  });

  it("collects multiple suggestions when the report has multiple hints", () => {
    const report: TaskFailureReport = {
      taskId: "t1", found: true, totalAttempts: 2, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [],
      failingStages: ["A", "B"],
      hints: [
        { kind: "error_status", stageName: "A", detail: "" },
        { kind: "stuck_open", stageName: "B", detail: "" },
      ],
    };
    const suggestions = buildFixSuggestions(report, simpleIR());
    expect(suggestions.length).toBeGreaterThanOrEqual(2);
    const stages = new Set(suggestions.map((s) => s.targetStage));
    expect(stages.has("A")).toBe(true);
    expect(stages.has("B")).toBe(true);
  });

  it("each suggestion has a non-empty description and rationale", () => {
    const report = reportWithHint({ hintKind: "stuck_open", stageName: "B" });
    const suggestions = buildFixSuggestions(report, simpleIR());
    for (const s of suggestions) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.rationale.length).toBeGreaterThan(0);
    }
  });
});

describe("proposePipelineFix (integration)", () => {
  function mkDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    return db;
  }

  function seedTaskAttempt(db: DatabaseSync, taskId: string, vh: string, stageName: string): void {
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, status, kind)
       VALUES (?, ?, ?, ?, 1, ?, 'error', 'regular')`,
    ).run(`att-${taskId}`, taskId, vh, stageName, Date.now());
  }

  it("found=false when the report flags no task data", () => {
    const db = mkDb();
    const report: TaskFailureReport = {
      taskId: "t0", found: false, totalAttempts: 0, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [], failingStages: [], hints: [],
    };
    const r = proposePipelineFix({ db, taskId: "t0", report });
    expect(r.found).toBe(false);
    expect(r.versionHash).toBeNull();
    expect(r.suggestions).toEqual([]);
    db.close();
  });

  it("returns suggestions keyed by the current version_hash + targeted stage names", () => {
    const db = mkDb();
    const ir = simpleIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    seedTaskAttempt(db, "t1", vh, "B");

    const report: TaskFailureReport = {
      taskId: "t1", found: true, totalAttempts: 1, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [],
      failingStages: ["B"],
      hints: [{ kind: "error_status", stageName: "B", detail: "" }],
    };
    const r = proposePipelineFix({ db, taskId: "t1", report });
    expect(r.found).toBe(true);
    expect(r.versionHash).toBe(vh);
    expect(r.suggestions.some((s) => s.targetStage === "B" && s.kind === "error_status")).toBe(true);
    db.close();
  });

  it("suggestions for stages NOT in current IR are filtered out", () => {
    const db = mkDb();
    const ir = simpleIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    seedTaskAttempt(db, "t2", vh, "A");

    // Hint targets a stage 'DEAD' that is NOT in the current IR.
    const report: TaskFailureReport = {
      taskId: "t2", found: true, totalAttempts: 1, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [],
      failingStages: ["DEAD"],
      hints: [{ kind: "error_status", stageName: "DEAD", detail: "" }],
    };
    const r = proposePipelineFix({ db, taskId: "t2", report });
    expect(r.suggestions.every((s) => s.targetStage !== "DEAD")).toBe(true);
  });
});

describe("proposePipelineFix — AI patch synthesis", () => {
  function mkDb(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    initKernelNextSchema(db);
    return db;
  }

  function seedTaskAttempt(db: DatabaseSync, taskId: string, vh: string, stageName: string): void {
    db.prepare(
      `INSERT INTO stage_attempts
       (attempt_id, task_id, version_hash, stage_name, attempt_idx,
        started_at, status, kind)
       VALUES (?, ?, ?, ?, 1, ?, 'error', 'regular')`,
    ).run(`att-${taskId}`, taskId, vh, stageName, Date.now());
  }

  it("calls the synthesizer for each suggestion and fills proposedPatch on success", async () => {
    const db = mkDb();
    const ir = simpleIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    seedTaskAttempt(db, "t-ai", vh, "B");

    const report: TaskFailureReport = {
      taskId: "t-ai", found: true, totalAttempts: 1, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [],
      failingStages: ["B"],
      hints: [{ kind: "error_status", stageName: "B", detail: "error" }],
    };

    const synthesize = async (): Promise<IRPatch | null> => ({
      ops: [{
        op: "update_stage_config",
        stage: "B",
        configPatch: { promptRef: "p-b-v2" },
      }],
    });

    const r = await proposePipelineFixWithAi({
      db, taskId: "t-ai", report,
      aiPatchSynthesizer: { synthesize },
    });
    expect(r.found).toBe(true);
    expect(r.suggestions.length).toBe(1);
    expect(r.suggestions[0]!.proposedPatch).toBeDefined();
    expect(r.suggestions[0]!.proposedPatch!.ops[0]).toMatchObject({
      op: "update_stage_config",
      stage: "B",
    });
  });

  it("synthesizer returning null leaves proposedPatch undefined on that suggestion", async () => {
    const db = mkDb();
    const ir = simpleIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    seedTaskAttempt(db, "t-null", vh, "B");
    const report: TaskFailureReport = {
      taskId: "t-null", found: true, totalAttempts: 1, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [],
      failingStages: ["B"],
      hints: [{ kind: "error_status", stageName: "B", detail: "" }],
    };
    const r = await proposePipelineFixWithAi({
      db, taskId: "t-null", report,
      aiPatchSynthesizer: { synthesize: async () => null },
    });
    expect(r.suggestions.length).toBe(1);
    expect(r.suggestions[0]!.proposedPatch).toBeUndefined();
  });

  it("synthesizer throwing does NOT break the result — suggestion still ships without a patch", async () => {
    const db = mkDb();
    const ir = simpleIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    seedTaskAttempt(db, "t-throw", vh, "B");
    const report: TaskFailureReport = {
      taskId: "t-throw", found: true, totalAttempts: 1, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [],
      failingStages: ["B"],
      hints: [{ kind: "error_status", stageName: "B", detail: "" }],
    };
    const r = await proposePipelineFixWithAi({
      db, taskId: "t-throw", report,
      aiPatchSynthesizer: {
        synthesize: async () => { throw new Error("API boom"); },
      },
    });
    expect(r.suggestions.length).toBe(1);
    expect(r.suggestions[0]!.proposedPatch).toBeUndefined();
  });

  it("synthesizer is NOT invoked for info-severity suggestions (interrupted / superseded)", async () => {
    // info-level suggestions aren't pipeline defects; do not burn API on them.
    const db = mkDb();
    const ir = simpleIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    seedTaskAttempt(db, "t-info", vh, "A");
    const report: TaskFailureReport = {
      taskId: "t-info", found: true, totalAttempts: 1, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [],
      failingStages: ["A"],
      hints: [{ kind: "interrupted", stageName: "A", detail: "" }],
    };
    const calls: number[] = [];
    const r = await proposePipelineFixWithAi({
      db, taskId: "t-info", report,
      aiPatchSynthesizer: {
        synthesize: async () => {
          calls.push(1);
          return null;
        },
      },
    });
    expect(calls.length).toBe(0);
    expect(r.suggestions[0]!.severity).toBe("info");
  });

  it("synthesizer output that is NOT an update_stage_config patch is rejected", async () => {
    // Safe range constraint (roadmap §7.2 B4): AI-driven patches are
    // limited to update_stage_config. Rogue add_stage / remove_wire
    // output is ignored.
    const db = mkDb();
    const ir = simpleIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    seedTaskAttempt(db, "t-unsafe", vh, "B");
    const report: TaskFailureReport = {
      taskId: "t-unsafe", found: true, totalAttempts: 1, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [],
      failingStages: ["B"],
      hints: [{ kind: "error_status", stageName: "B", detail: "" }],
    };
    const r = await proposePipelineFixWithAi({
      db, taskId: "t-unsafe", report,
      aiPatchSynthesizer: {
        synthesize: async () => ({
          ops: [{ op: "remove_stage", stageName: "B" }],
        }),
      },
    });
    expect(r.suggestions.length).toBe(1);
    expect(r.suggestions[0]!.proposedPatch).toBeUndefined();
  });

  it("synthesizer output with an update_stage_config containing a disallowed key is rejected", async () => {
    // Safe-range key whitelist: configPatch may only carry promptRef
    // or subAgents (the two fields AgentStageSchema.config declares).
    // Any other key — budget / reads / writes / moduleId — must be
    // rejected at the wrapper layer even if the parser let it through.
    const db = mkDb();
    const ir = simpleIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    seedTaskAttempt(db, "t-bad-key", vh, "B");
    const report: TaskFailureReport = {
      taskId: "t-bad-key", found: true, totalAttempts: 1, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [],
      failingStages: ["B"],
      hints: [{ kind: "error_status", stageName: "B", detail: "" }],
    };
    const r = await proposePipelineFixWithAi({
      db, taskId: "t-bad-key", report,
      aiPatchSynthesizer: {
        // Bypass the parser by returning an IRPatch directly. The
        // wrapper's isSafeRangePatch must still reject it because
        // "budget" is not in the AgentStage config schema.
        synthesize: async () => ({
          ops: [{
            op: "update_stage_config",
            stage: "B",
            configPatch: { budget: 1000 } as never,
          }],
        }),
      },
    });
    expect(r.suggestions.length).toBe(1);
    expect(r.suggestions[0]!.proposedPatch).toBeUndefined();
  });

  it("synthesizer output with subAgents (safe-range expanded) is accepted", async () => {
    const db = mkDb();
    const ir = simpleIR();
    const vh = versionHash(ir);
    insertPipelineVersion(db, ir, { versionHash: vh, tsSource: "" });
    seedTaskAttempt(db, "t-sa", vh, "B");
    const report: TaskFailureReport = {
      taskId: "t-sa", found: true, totalAttempts: 1, totalCostUsd: 0,
      firstStartedAt: null, lastHeartbeatAt: null,
      stages: [],
      failingStages: ["B"],
      hints: [{ kind: "error_status", stageName: "B", detail: "" }],
    };
    const r = await proposePipelineFixWithAi({
      db, taskId: "t-sa", report,
      aiPatchSynthesizer: {
        synthesize: async () => ({
          ops: [{
            op: "update_stage_config",
            stage: "B",
            configPatch: {
              subAgents: [{
                name: "scout",
                description: "ad-hoc helper",
                prompt: "Inspect inputs and summarise...",
              }],
            },
          }],
        }),
      },
    });
    expect(r.suggestions.length).toBe(1);
    expect(r.suggestions[0]!.proposedPatch).toBeDefined();
    const op = r.suggestions[0]!.proposedPatch!.ops[0]!;
    if (op.op !== "update_stage_config") throw new Error("unexpected op");
    expect(Array.isArray((op.configPatch as { subAgents?: unknown[] }).subAgents)).toBe(true);
  });
});
