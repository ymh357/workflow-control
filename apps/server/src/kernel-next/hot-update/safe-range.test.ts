import { describe, it, expect } from "vitest";
import { classifySafeRange } from "./safe-range.js";
import type { PipelineDiff, Impact } from "./types.js";

const emptyDiff: PipelineDiff = {
  stages: { added: [], removed: [], modified: [] },
  wires: { added: [], removed: [] },
  routing: { gateRoutingChanged: [] },
  categoryUnion: [],
};

const emptyImpact: Impact = {
  activeTasks: [],
  newSubmissionsOk: true,
  schemaDriftIssues: [],
};

describe("classifySafeRange", () => {
  it("empty diff → safe/empty", () => {
    const v = classifySafeRange(emptyDiff, emptyImpact);
    expect(v.verdict).toBe("safe");
    expect(v.category).toBe("empty");
  });

  it("promptOnly → safe", () => {
    const d: PipelineDiff = {
      ...emptyDiff,
      stages: {
        added: [], removed: [],
        modified: [{
          stageName: "a", type: "agent",
          changes: { promptRef: { before: "old", after: "new" } },
          category: "promptOnly",
        }],
      },
      categoryUnion: ["promptOnly"],
    };
    const v = classifySafeRange(d, emptyImpact);
    expect(v.verdict).toBe("safe");
    expect(v.category).toBe("promptOnly");
  });

  it("structural → unsafe", () => {
    const d: PipelineDiff = {
      ...emptyDiff,
      stages: {
        added: [{ name: "x", type: "agent", config: { promptRef: "p" }, inputs: [], outputs: [] }],
        removed: [], modified: [],
      },
      categoryUnion: ["structural"],
    };
    const v = classifySafeRange(d, emptyImpact);
    expect(v.verdict).toBe("unsafe");
    expect(v.category).toBe("structural");
    expect(v.reasons.length).toBeGreaterThan(0);
  });

  it("promptOnly + schemaDriftIssues → unsafe", () => {
    const d: PipelineDiff = {
      ...emptyDiff,
      stages: {
        added: [], removed: [],
        modified: [{
          stageName: "a", type: "agent",
          changes: { promptRef: { before: "old", after: "new" } },
          category: "promptOnly",
        }],
      },
      categoryUnion: ["promptOnly"],
    };
    const impact: Impact = {
      ...emptyImpact,
      schemaDriftIssues: [{
        kind: "port_type_change_with_live_values",
        stageName: "a", portName: "out",
        details: "string → number",
      }],
    };
    const v = classifySafeRange(d, impact);
    expect(v.verdict).toBe("unsafe");
    expect(v.reasons.some((r) => r.includes("drift"))).toBe(true);
  });

  it("promptOnly + non-resumable active task → unsafe", () => {
    const d: PipelineDiff = {
      ...emptyDiff,
      stages: {
        added: [], removed: [],
        modified: [{
          stageName: "a", type: "agent",
          changes: { promptRef: { before: "old", after: "new" } },
          category: "promptOnly",
        }],
      },
      categoryUnion: ["promptOnly"],
    };
    const impact: Impact = {
      ...emptyImpact,
      activeTasks: [{
        taskId: "t1", currentStage: "a",
        affectedStages: ["a"], resumable: false,
        blockingReasons: ["current stage removed"],
      }],
    };
    const v = classifySafeRange(d, impact);
    expect(v.verdict).toBe("unsafe");
    expect(v.reasons.some((r) => r.includes("resumable"))).toBe(true);
  });
});
