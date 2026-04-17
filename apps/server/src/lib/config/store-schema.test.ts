import { describe, it, expect } from "vitest";
import { deriveStageWrites, deriveStageOutputs, getAllSchemaKeys } from "./store-schema.js";
import type { StoreSchema } from "./types.js";

const schema: StoreSchema = {
  analysis: {
    produced_by: "analyze",
    description: "Analysis output",
    fields: {
      title: { type: "string", description: "Title", required: true },
      modules: { type: "string[]", description: "Modules" },
    },
    assertions: ["value.title and len(value.title) > 0"],
  },
  plan: {
    produced_by: "plan-implementation",
    fields: {
      tasks: { type: "object[]", description: "Task list", required: true },
    },
    additional_properties: true,
  },
};

describe("deriveStageWrites", () => {
  it("returns write declarations for the given stage", () => {
    const writes = deriveStageWrites(schema, "analyze");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      key: "analysis",
      assertions: ["value.title and len(value.title) > 0"],
    });
  });

  it("returns empty array when stage produces nothing", () => {
    expect(deriveStageWrites(schema, "unknown-stage")).toEqual([]);
  });

  it("omits assertions when none defined", () => {
    const writes = deriveStageWrites(schema, "plan-implementation");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({ key: "plan" });
  });
});

describe("deriveStageOutputs", () => {
  it("returns StageOutputSchema for the given stage", () => {
    const outputs = deriveStageOutputs(schema, "analyze");
    expect(outputs).toBeDefined();
    expect(outputs!.analysis).toBeDefined();
    expect(outputs!.analysis.type).toBe("object");
    expect(outputs!.analysis.fields).toHaveLength(2);
    expect(outputs!.analysis.fields[0].key).toBe("title");
    expect(outputs!.analysis.fields[0].type).toBe("string");
  });

  it("returns undefined when stage produces nothing", () => {
    expect(deriveStageOutputs(schema, "unknown-stage")).toBeUndefined();
  });

  it("returns minimal schema when fields are not defined", () => {
    const s: StoreSchema = { data: { produced_by: "fetcher" } };
    const outputs = deriveStageOutputs(s, "fetcher");
    expect(outputs).toBeDefined();
    expect(outputs!.data.fields).toEqual([]);
  });
});

describe("getAllSchemaKeys", () => {
  it("returns all top-level keys", () => {
    const keys = getAllSchemaKeys(schema);
    expect(keys).toEqual(new Set(["analysis", "plan"]));
  });
});
