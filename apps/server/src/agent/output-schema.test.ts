import { describe, it, expect } from "vitest";
import { outputSchemaToJsonSchema } from "./output-schema.js";
import type { StageOutputSchema } from "../lib/config-loader.js";

describe("outputSchemaToJsonSchema", () => {
  it("returns empty properties for empty outputs", () => {
    const result = outputSchemaToJsonSchema({} as StageOutputSchema);
    expect(result).toEqual({ type: "object", properties: {} });
  });

  it("handles a store key with no fields", () => {
    const outputs = {
      analysis: { type: "object" as const, fields: [] },
    } satisfies StageOutputSchema;
    expect(result()).toEqual({
      type: "object",
      properties: { analysis: { type: "object" } },
    });

    function result() {
      return outputSchemaToJsonSchema(outputs);
    }
  });

  it("handles a store key with undefined fields", () => {
    // fields may be omitted entirely
    const outputs = { analysis: {} } as unknown as StageOutputSchema;
    const result = outputSchemaToJsonSchema(outputs);
    expect(result).toEqual({
      type: "object",
      properties: { analysis: { type: "object" } },
    });
  });

  it("converts a single string field", () => {
    const outputs: StageOutputSchema = {
      result: {
        type: "object",
        fields: [{ key: "summary", type: "string", description: "A summary" }],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    expect(result).toEqual({
      type: "object",
      properties: {
        result: {
          type: "object",
          properties: {
            summary: { type: "string", description: "A summary" },
          },
        },
      },
    });
  });

  it("converts number, boolean, string[], markdown types", () => {
    const outputs: StageOutputSchema = {
      metrics: {
        type: "object",
        fields: [
          { key: "count", type: "number", description: "Total count" },
          { key: "valid", type: "boolean", description: "Is valid" },
          { key: "tags", type: "string[]", description: "Tag list" },
          { key: "report", type: "markdown", description: "Markdown report" },
        ],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const props = (result.properties as any).metrics.properties;

    expect(props.count).toEqual({ type: "number", description: "Total count" });
    expect(props.valid).toEqual({ type: "boolean", description: "Is valid" });
    expect(props.tags).toEqual({
      type: "array",
      items: { type: "string" },
      description: "Tag list",
    });
    expect(props.report).toEqual({ type: "string", description: "Markdown report" });
  });

  it("converts object type without nested fields", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [{ key: "meta", type: "object", description: "Metadata" }],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const props = (result.properties as any).data.properties;
    expect(props.meta).toEqual({ type: "object", description: "Metadata" });
  });

  it("converts object type with nested fields", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [
          {
            key: "config",
            type: "object",
            description: "Config object",
            fields: [
              { key: "name", type: "string", description: "Config name" },
              { key: "enabled", type: "boolean", description: "Is enabled" },
            ],
          },
        ],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const configSchema = (result.properties as any).data.properties.config;
    expect(configSchema.type).toBe("object");
    expect(configSchema.description).toBe("Config object");
    expect(configSchema.properties).toEqual({
      name: { type: "string", description: "Config name" },
      enabled: { type: "boolean", description: "Is enabled" },
    });
  });

  it("converts object[] without nested fields", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [{ key: "items", type: "object[]", description: "Item list" }],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const props = (result.properties as any).data.properties;
    expect(props.items).toEqual({
      type: "array",
      items: { type: "object" },
      description: "Item list",
    });
  });

  it("converts object[] with nested fields", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [
          {
            key: "files",
            type: "object[]",
            description: "File list",
            fields: [
              { key: "path", type: "string", description: "File path" },
              { key: "status", type: "boolean", description: "Passed" },
            ],
          },
        ],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const filesSchema = (result.properties as any).data.properties.files;
    expect(filesSchema.type).toBe("array");
    expect(filesSchema.items).toEqual({
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
        status: { type: "boolean", description: "Passed" },
      },
    });
  });

  it("defaults unknown type to string", () => {
    const outputs: StageOutputSchema = {
      data: {
        type: "object",
        fields: [
          { key: "weird", type: "foobar" as any, description: "Unknown type" },
        ],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const props = (result.properties as any).data.properties;
    expect(props.weird).toEqual({ type: "string", description: "Unknown type" });
  });

  it("handles multiple store keys with multiple fields", () => {
    const outputs: StageOutputSchema = {
      analysis: {
        type: "object",
        fields: [
          { key: "summary", type: "string", description: "Summary" },
          { key: "score", type: "number", description: "Score" },
        ],
      },
      plan: {
        type: "object",
        fields: [
          { key: "steps", type: "string[]", description: "Steps" },
        ],
      },
    };
    const result = outputSchemaToJsonSchema(outputs);
    const properties = result.properties as any;
    expect(Object.keys(properties)).toEqual(["analysis", "plan"]);
    expect(Object.keys(properties.analysis.properties)).toEqual(["summary", "score"]);
    expect(Object.keys(properties.plan.properties)).toEqual(["steps"]);
  });
});
