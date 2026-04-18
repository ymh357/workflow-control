import { describe, it, expect } from "vitest";
import { evaluateSchemaShape, formatShapeFeedback } from "./schema-shape-validator.js";
import type { StoreSchema } from "../lib/config/types.js";

describe("evaluateSchemaShape", () => {
  const schema: StoreSchema = {
    analysis: {
      produced_by: "analyze",
      fields: {
        title: { type: "string", required: true },
        risk: { type: "string" },
        files: { type: "string[]" },
        score: { type: "number" },
      },
    },
    plan: {
      produced_by: "analyze",
      additional_properties: true,
      fields: {
        steps: { type: "object[]", fields: { name: { type: "string", required: true } } },
      },
    },
  };

  it("returns no failures when value conforms", () => {
    const failures = evaluateSchemaShape(
      "analyze",
      { analysis: { title: "t", risk: "low", files: ["a.ts"], score: 1 } },
      schema,
      ["analysis"],
    );
    expect(failures).toEqual([]);
  });

  it("flags missing required field", () => {
    const failures = evaluateSchemaShape(
      "analyze",
      { analysis: { risk: "low" } },
      schema,
      ["analysis"],
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].path).toBe("analysis.title");
    expect(failures[0].reason).toContain("required");
  });

  it("flags wrong primitive type", () => {
    const failures = evaluateSchemaShape(
      "analyze",
      { analysis: { title: "t", score: "high" } },
      schema,
      ["analysis"],
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].path).toBe("analysis.score");
    expect(failures[0].reason).toContain("expected number");
  });

  it("flags wrong string[] shape", () => {
    const failures = evaluateSchemaShape(
      "analyze",
      { analysis: { title: "t", files: [1, 2] } },
      schema,
      ["analysis"],
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].path).toBe("analysis.files");
    expect(failures[0].reason).toContain("expected string[]");
  });

  it("rejects unknown fields by default (additional_properties false)", () => {
    const failures = evaluateSchemaShape(
      "analyze",
      { analysis: { title: "t", extra: "stuff" } },
      schema,
      ["analysis"],
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].path).toBe("analysis.extra");
    expect(failures[0].reason).toContain("unknown field");
  });

  it("allows extras when additional_properties: true", () => {
    const failures = evaluateSchemaShape(
      "analyze",
      { plan: { steps: [{ name: "a" }], extra: "ok" } },
      schema,
      ["plan"],
    );
    expect(failures).toEqual([]);
  });

  it("validates object[] item fields", () => {
    const failures = evaluateSchemaShape(
      "analyze",
      { plan: { steps: [{}, { name: "ok" }] } },
      schema,
      ["plan"],
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].path).toBe("plan.steps[0].name");
  });

  it("rejects non-object top-level value", () => {
    const failures = evaluateSchemaShape(
      "analyze",
      { analysis: "hello" } as Record<string, unknown>,
      schema,
      ["analysis"],
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toContain("expected an object");
  });

  it("skips keys the stage does not produce", () => {
    const otherStageSchema: StoreSchema = {
      foo: { produced_by: "other-stage", fields: { v: { type: "string", required: true } } },
    };
    const failures = evaluateSchemaShape(
      "analyze",
      { foo: {} },
      otherStageSchema,
      ["foo"],
    );
    expect(failures).toEqual([]);
  });

  it("skips missing top-level key (handled elsewhere)", () => {
    const failures = evaluateSchemaShape("analyze", {}, schema, ["analysis"]);
    expect(failures).toEqual([]);
  });

  it("treats markdown as string", () => {
    const s: StoreSchema = {
      doc: { produced_by: "writer", fields: { body: { type: "markdown", required: true } } },
    };
    const ok = evaluateSchemaShape("writer", { doc: { body: "# hi" } }, s, ["doc"]);
    expect(ok).toEqual([]);
    const bad = evaluateSchemaShape("writer", { doc: { body: 42 } }, s, ["doc"]);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toContain("markdown");
  });

  it("returns empty when schema is undefined", () => {
    expect(evaluateSchemaShape("x", { a: 1 }, undefined, ["a"])).toEqual([]);
  });
});

describe("formatShapeFeedback", () => {
  it("renders a human-readable feedback string", () => {
    const msg = formatShapeFeedback([
      { key: "analysis", path: "analysis.title", reason: "required field is missing" },
      { key: "analysis", path: "analysis.score", reason: "expected number, got string" },
    ]);
    expect(msg).toContain("store_schema shape");
    expect(msg).toContain("analysis.title");
    expect(msg).toContain("analysis.score");
    expect(msg).toContain("Fix these fields");
  });
});
