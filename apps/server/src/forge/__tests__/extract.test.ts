import { describe, it, expect } from "vitest";
import { extractEpisodes, ExtractError } from "../distillation/extract.js";

const VALID = JSON.stringify([{
  intent: "extract changelog",
  start_seq: 1,
  end_seq: 10,
  steps: [
    { stage_kind: "agent", description: "scan commits", inputs: ["git log"] },
    { stage_kind: "tool", description: "format markdown" },
  ],
  outcome: "completed",
  pipeline_able: true,
  rationale: "structured task",
}]);

describe("extractEpisodes", () => {
  it("parses valid JSON array of episodes", () => {
    const eps = extractEpisodes(VALID, "s1");
    expect(eps).toHaveLength(1);
    expect(eps[0]!.intent).toBe("extract changelog");
    expect(eps[0]!.sessionId).toBe("s1");
    expect(eps[0]!.steps).toHaveLength(2);
    expect(eps[0]!.episodeId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns empty array when agent emits []", () => {
    const eps = extractEpisodes("[]", "s1");
    expect(eps).toEqual([]);
  });

  it("extracts JSON array from prose wrapper", () => {
    const wrapped = `Here are the episodes I found:\n\n${VALID}\n\nThat's all.`;
    const eps = extractEpisodes(wrapped, "s1");
    expect(eps).toHaveLength(1);
    expect(eps[0]!.intent).toBe("extract changelog");
  });

  it("throws EXTRACT_BAD_JSON for malformed JSON", () => {
    expect(() => extractEpisodes("not json {", "s1")).toThrow(ExtractError);
    try { extractEpisodes("not json {", "s1"); }
    catch (e) {
      expect((e as ExtractError).code).toBe("EXTRACT_BAD_JSON");
    }
  });

  it("throws EXTRACT_SCHEMA_FAIL when episode missing required field", () => {
    const broken = JSON.stringify([{ intent: "test", start_seq: 0 }]);
    expect(() => extractEpisodes(broken, "s1")).toThrow(ExtractError);
    try { extractEpisodes(broken, "s1"); }
    catch (e) {
      expect((e as ExtractError).code).toBe("EXTRACT_SCHEMA_FAIL");
    }
  });

  it("throws EXTRACT_SCHEMA_FAIL when outcome enum is invalid", () => {
    const broken = JSON.stringify([{
      intent: "i", start_seq: 0, end_seq: 1, steps: [],
      outcome: "bogus", pipeline_able: false, rationale: "r",
    }]);
    expect(() => extractEpisodes(broken, "s1")).toThrow(ExtractError);
    try { extractEpisodes(broken, "s1"); }
    catch (e) {
      expect((e as ExtractError).code).toBe("EXTRACT_SCHEMA_FAIL");
    }
  });

  it("preserves step optional fields", () => {
    const eps = extractEpisodes(VALID, "s1");
    expect(eps[0]!.steps[0]!.inputs).toEqual(["git log"]);
    expect(eps[0]!.steps[1]!.inputs).toBeUndefined();
  });

  it("uses provided sessionId on every episode", () => {
    const multi = JSON.stringify([
      { intent: "a", start_seq: 0, end_seq: 1, steps: [], outcome: "completed", pipeline_able: true, rationale: "r" },
      { intent: "b", start_seq: 2, end_seq: 3, steps: [], outcome: "abandoned", pipeline_able: false, rationale: "r" },
    ]);
    const eps = extractEpisodes(multi, "session-123");
    expect(eps).toHaveLength(2);
    expect(eps[0]!.sessionId).toBe("session-123");
    expect(eps[1]!.sessionId).toBe("session-123");
  });
});
