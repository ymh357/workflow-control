import { describe, it, expect } from "vitest";
import type { StoreSchemaEntry } from "../lib/config/types.js";
import { renderBySchema } from "./schema-renderer.js";

function entry(fields: StoreSchemaEntry["fields"]): StoreSchemaEntry {
  return { produced_by: "stage", fields };
}

describe("renderBySchema — scalars", () => {
  it("renders string field inline without fences", () => {
    const result = renderBySchema(
      { name: "alpha" },
      entry({ name: { type: "string" } }),
      "Design",
    );
    expect(result.body).toContain("### Design");
    expect(result.body).toContain("- name: alpha");
    expect(result.body).not.toContain("```");
    expect(result.schemaComplete).toBe(true);
  });

  it("renders number and boolean", () => {
    const result = renderBySchema(
      { count: 42, enabled: true },
      entry({
        count: { type: "number" },
        enabled: { type: "boolean" },
      }),
      "X",
    );
    expect(result.body).toContain("- count: 42");
    expect(result.body).toContain("- enabled: true");
  });

  it("skips null and undefined fields", () => {
    const result = renderBySchema(
      { name: "alpha", missing: null, absent: undefined },
      entry({
        name: { type: "string" },
        missing: { type: "string" },
        absent: { type: "string" },
      }),
      "X",
    );
    expect(result.body).toContain("- name: alpha");
    expect(result.body).not.toContain("missing");
    expect(result.body).not.toContain("absent");
  });

  it("skips hidden fields", () => {
    const result = renderBySchema(
      { visible: "v", secret: "s" },
      entry({
        visible: { type: "string" },
        secret: { type: "string", hidden: true },
      }),
      "X",
    );
    expect(result.body).toContain("visible");
    expect(result.body).not.toContain("secret");
  });
});

describe("renderBySchema — markdown", () => {
  it("renders markdown raw under a sub-heading", () => {
    const markdown = "## Stage 1\n- Type: agent\n- Writes: [x]";
    const result = renderBySchema(
      { design: markdown },
      entry({ design: { type: "markdown" } }),
      "Design",
    );
    expect(result.body).toContain("#### design");
    expect(result.body).toContain("## Stage 1");
    expect(result.body).toContain("- Type: agent");
    // Markdown is NOT wrapped in json fences — preserves original formatting.
    expect(result.body).not.toContain("```json");
  });

  it("non-string markdown value falls back to scalar rendering", () => {
    const result = renderBySchema(
      { design: 123 },
      entry({ design: { type: "markdown" } }),
      "X",
    );
    expect(result.body).toContain("- design: 123");
  });
});

describe("renderBySchema — string[]", () => {
  it("joins under 10 items on one line", () => {
    const result = renderBySchema(
      { tags: ["a", "b", "c"] },
      entry({ tags: { type: "string[]" } }),
      "X",
    );
    expect(result.body).toContain("- tags: a, b, c");
    expect(result.body).not.toContain("total");
  });

  it("truncates above 10 items with total count", () => {
    const tags = Array.from({ length: 15 }, (_, i) => `t${i}`);
    const result = renderBySchema(
      { tags },
      entry({ tags: { type: "string[]" } }),
      "X",
    );
    expect(result.body).toContain("t0, t1, t2, t3, t4, t5, t6, t7, t8, t9");
    expect(result.body).toContain("... (15 total)");
  });

  it("empty list renders explicitly", () => {
    const result = renderBySchema(
      { tags: [] },
      entry({ tags: { type: "string[]" } }),
      "X",
    );
    expect(result.body).toContain("- tags: (empty list)");
  });
});

describe("renderBySchema — nested object", () => {
  it("recurses into declared nested fields", () => {
    const result = renderBySchema(
      { meta: { author: "yu", version: 2 } },
      entry({
        meta: {
          type: "object",
          fields: {
            author: { type: "string" },
            version: { type: "number" },
          },
        },
      }),
      "X",
    );
    expect(result.body).toContain("- meta:");
    expect(result.body).toContain("- author: yu");
    expect(result.body).toContain("- version: 2");
    expect(result.schemaComplete).toBe(true);
  });

  it("object without nested fields falls through to JSON", () => {
    const result = renderBySchema(
      { pipeline: { complex: { nested: true } } },
      entry({
        pipeline: { type: "object" },
      }),
      "X",
    );
    expect(result.body).toContain("```json");
    expect(result.body).toContain('"nested": true');
    expect(result.schemaComplete).toBe(false);
  });
});

describe("renderBySchema — object[]", () => {
  it("renders first 5 items as structured fields", () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      name: `s${i}`,
      type: "agent",
    }));
    const result = renderBySchema(
      { stages: items },
      entry({
        stages: {
          type: "object[]",
          fields: {
            name: { type: "string" },
            type: { type: "string" },
          },
        },
      }),
      "X",
    );
    expect(result.body).toContain("[0]");
    expect(result.body).toContain("[1]");
    expect(result.body).toContain("[2]");
    expect(result.body).toContain("- name: s0");
    expect(result.body).toContain("- name: s2");
    expect(result.body).not.toContain("total items");
  });

  it("truncates to 5 with total count marker", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ name: `s${i}` }));
    const result = renderBySchema(
      { stages: items },
      entry({
        stages: {
          type: "object[]",
          fields: { name: { type: "string" } },
        },
      }),
      "X",
    );
    expect(result.body).toContain("[0]");
    expect(result.body).toContain("[4]");
    expect(result.body).not.toContain("[5]");
    expect(result.body).toContain("... (12 total items, showing 5)");
  });

  it("object[] without item fields falls through to JSON with array truncation", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({ i }));
    const result = renderBySchema(
      { items },
      entry({ items: { type: "object[]" } }),
      "X",
    );
    expect(result.body).toContain("```json");
    expect(result.body).toContain("... (25 total items)");
    expect(result.schemaComplete).toBe(false);
  });

  it("empty object[] renders explicitly", () => {
    const result = renderBySchema(
      { items: [] },
      entry({
        items: { type: "object[]", fields: { x: { type: "string" } } },
      }),
      "X",
    );
    expect(result.body).toContain("- items: (empty list)");
  });
});

describe("renderBySchema — edge cases", () => {
  it("null/undefined value renders (empty)", () => {
    const result = renderBySchema(
      null,
      entry({ x: { type: "string" } }),
      "X",
    );
    expect(result.body).toBe("\n### X\n(empty)");
  });

  it("scalar value at entry level renders inline", () => {
    const result = renderBySchema("hello", entry({}), "Msg");
    expect(result.body).toBe("\n### Msg\nhello");
  });

  it("entry without fields falls through to JSON", () => {
    const result = renderBySchema(
      { a: 1, b: 2 },
      { produced_by: "s" } as StoreSchemaEntry,
      "X",
    );
    expect(result.body).toContain("```json");
    expect(result.schemaComplete).toBe(false);
  });

  it("deep nesting stops at maxDepth with a marker", () => {
    // Build a 3-level nested schema but cap depth at 1.
    const result = renderBySchema(
      { a: { b: { c: "deep" } } },
      entry({
        a: {
          type: "object",
          fields: {
            b: {
              type: "object",
              fields: { c: { type: "string" } },
            },
          },
        },
      }),
      "X",
      { maxDepth: 1 },
    );
    expect(result.body).toContain("max depth exceeded");
    expect(result.schemaComplete).toBe(false);
  });

  it("markdown field at nested level renders as #### sub-heading", () => {
    const result = renderBySchema(
      { wrapper: { note: "## inside" } },
      entry({
        wrapper: {
          type: "object",
          fields: {
            note: { type: "markdown" },
          },
        },
      }),
      "X",
    );
    expect(result.body).toContain("#### note");
    expect(result.body).toContain("## inside");
  });
});
