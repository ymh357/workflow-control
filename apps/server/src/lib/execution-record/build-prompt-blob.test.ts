import { describe, it, expect } from "vitest";
import {
  resolveReadsSnapshot,
  buildPromptBlob,
  parseWritesFromResult,
  buildScratchPadSnapshot,
} from "./build-prompt-blob.js";

describe("resolveReadsSnapshot", () => {
  it("returns empty object when reads is undefined", () => {
    expect(resolveReadsSnapshot(undefined, { a: 1 })).toEqual({});
  });

  it("returns empty object when store is undefined", () => {
    expect(resolveReadsSnapshot({ x: "a" }, undefined)).toEqual({});
  });

  it("resolves simple key", () => {
    expect(
      resolveReadsSnapshot({ title: "analysis.title" }, {
        analysis: { title: "T" },
      }),
    ).toEqual({ title: "T" });
  });

  it("strips leading store. prefix", () => {
    expect(
      resolveReadsSnapshot({ title: "store.analysis.title" }, {
        analysis: { title: "T" },
      }),
    ).toEqual({ title: "T" });
  });

  it("omits keys that resolve to undefined (not present in store)", () => {
    expect(
      resolveReadsSnapshot(
        { title: "analysis.title", missing: "nope.path" },
        { analysis: { title: "T" } },
      ),
    ).toEqual({ title: "T" });
  });

  it("preserves complex value types (arrays, objects)", () => {
    const store = {
      analysis: {
        tags: ["a", "b"],
        nested: { n: 1 },
      },
    };
    expect(resolveReadsSnapshot({ tags: "analysis.tags" }, store)).toEqual({
      tags: ["a", "b"],
    });
    expect(
      resolveReadsSnapshot({ nested: "analysis.nested" }, store),
    ).toEqual({ nested: { n: 1 } });
  });
});

describe("buildPromptBlob", () => {
  it("builds the full shape with defaults for omitted fields", () => {
    const blob = buildPromptBlob({
      tier1: "T1",
      systemPromptFull: "FULL",
      stagePrompt: "SP",
    });
    expect(blob).toEqual({
      tier1: "T1",
      systemPromptFull: "FULL",
      stagePrompt: "SP",
      invariants: [],
      fragments: [],
      outputSchema: null,
    });
  });

  it("preserves explicit invariants / fragments / outputSchema", () => {
    const blob = buildPromptBlob({
      tier1: "",
      systemPromptFull: "",
      stagePrompt: "",
      invariants: ["inv-a"],
      fragments: [{ id: "f1", contentHash: "h1" }],
      outputSchema: { type: "object" },
    });
    expect(blob.invariants).toEqual(["inv-a"]);
    expect(blob.fragments).toEqual([{ id: "f1", contentHash: "h1" }]);
    expect(blob.outputSchema).toEqual({ type: "object" });
  });
});

describe("buildScratchPadSnapshot", () => {
  it("returns null for empty / undefined input", () => {
    expect(buildScratchPadSnapshot(undefined)).toBeNull();
    expect(buildScratchPadSnapshot([])).toBeNull();
  });

  it("serializes entries into finalNote with null opening + empty precompactEvents", () => {
    const result = buildScratchPadSnapshot([
      {
        stage: "analyze",
        timestamp: "2026-04-18T00:00:00Z",
        category: "note",
        content: "first",
      },
      {
        stage: "implement",
        timestamp: "2026-04-18T00:05:00Z",
        category: "decision",
        content: "second",
      },
    ]);
    expect(result).not.toBeNull();
    expect(result!.openingNote).toBeNull();
    expect(result!.precompactEvents).toEqual([]);
    expect(result!.finalNote).toContain("[analyze/note @ 2026-04-18T00:00:00Z] first");
    expect(result!.finalNote).toContain(
      "[implement/decision @ 2026-04-18T00:05:00Z] second",
    );
  });
});

describe("parseWritesFromResult", () => {
  it("returns null for empty input", () => {
    expect(parseWritesFromResult("")).toBeNull();
    expect(parseWritesFromResult(undefined)).toBeNull();
    expect(parseWritesFromResult("   ")).toBeNull();
  });

  it("parses raw JSON object", () => {
    expect(parseWritesFromResult('{"a":1,"b":"c"}')).toEqual({
      a: 1,
      b: "c",
    });
  });

  it("returns null for JSON array (writes must be an object)", () => {
    expect(parseWritesFromResult("[1,2,3]")).toBeNull();
  });

  it("parses fenced JSON with optional json tag", () => {
    expect(
      parseWritesFromResult(
        'here is the output:\n```json\n{"x":true}\n```\ndone',
      ),
    ).toEqual({ x: true });
    expect(
      parseWritesFromResult("preamble\n```\n{\"y\":2}\n```\n"),
    ).toEqual({ y: 2 });
  });

  it("returns null when no JSON can be extracted", () => {
    expect(parseWritesFromResult("Just some prose, no JSON here.")).toBeNull();
  });

  it("returns null when fenced content is not a JSON object", () => {
    expect(
      parseWritesFromResult("```\nnot json at all\n```"),
    ).toBeNull();
  });
});
