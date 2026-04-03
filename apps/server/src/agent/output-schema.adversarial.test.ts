import { describe, it, expect } from "vitest";
import { outputSchemaToJsonSchema } from "./output-schema.js";
import type { StageOutputSchema } from "../lib/config-loader.js";

describe("outputSchemaToJsonSchema – adversarial", () => {
  it("handles deeply nested object fields (3 levels)", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [
          {
            key: "level1",
            type: "object",
            description: "L1",
            fields: [
              {
                key: "level2",
                type: "object",
                description: "L2",
                fields: [
                  { key: "leaf", type: "string", description: "Leaf" },
                ],
              },
            ],
          },
        ],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const l1 = (result.properties as any).data.properties.level1;
    expect(l1.type).toBe("object");
    expect(l1.properties.level2.type).toBe("object");
    expect(l1.properties.level2.properties.leaf).toEqual({
      type: "string",
      description: "Leaf",
    });
  });

  it("handles field with type 'object' and empty fields array (no nested props)", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [
          { key: "meta", type: "object", description: "Empty obj", fields: [] },
        ],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const meta = (result.properties as any).data.properties.meta;
    // fields is [] which is falsy for .length (0), so should return bare object
    expect(meta).toEqual({ type: "object", description: "Empty obj" });
  });

  it("handles field with undefined description", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [
          { key: "noDesc", type: "string", description: undefined as any },
        ],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const prop = (result.properties as any).data.properties.noDesc;
    expect(prop.type).toBe("string");
    expect(prop.description).toBeUndefined();
  });

  it("handles store key with fields set to null (treated as falsy)", () => {
    const outputs = {
      analysis: { type: "object", fields: null },
    } as unknown as StageOutputSchema;
    const result = outputSchemaToJsonSchema(outputs);
    expect((result.properties as any).analysis).toEqual({ type: "object" });
  });

  it("preserves field order within properties", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [
          { key: "zebra", type: "string", description: "Z" },
          { key: "alpha", type: "string", description: "A" },
          { key: "middle", type: "number", description: "M" },
        ],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const keys = Object.keys((result.properties as any).data.properties);
    expect(keys).toEqual(["zebra", "alpha", "middle"]);
  });

  it("handles duplicate field keys (last wins)", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [
          { key: "dup", type: "string", description: "first" },
          { key: "dup", type: "number", description: "second" },
        ],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const prop = (result.properties as any).data.properties.dup;
    expect(prop.type).toBe("number");
    expect(prop.description).toBe("second");
  });

  it("handles string[] inside nested object", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [
          {
            key: "wrapper",
            type: "object",
            description: "W",
            fields: [
              { key: "tags", type: "string[]", description: "Tags" },
            ],
          },
        ],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const tags = (result.properties as any).data.properties.wrapper.properties.tags;
    expect(tags).toEqual({ type: "array", items: { type: "string" }, description: "Tags" });
  });
});
