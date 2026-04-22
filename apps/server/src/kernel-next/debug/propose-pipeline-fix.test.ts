import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { buildFixSuggestions, proposePipelineFix } from "./propose-pipeline-fix.js";
import { initKernelNextSchema, insertPipelineVersion } from "../ir/sql.js";
import { versionHash } from "../ir/canonical.js";
import type { TaskFailureReport } from "../../lib/debug-queries.js";
import type { PipelineIR } from "../ir/schema.js";

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
