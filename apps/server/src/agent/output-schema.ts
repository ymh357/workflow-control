import type { StageOutputSchema, OutputFieldSchema } from "../lib/config-loader.js";

function fieldToJsonSchema(field: OutputFieldSchema): Record<string, unknown> {
  switch (field.type) {
    case "string":
    case "markdown":
      return { type: "string", description: field.description };
    case "number":
      return { type: "number", description: field.description };
    case "boolean":
      return { type: "boolean", description: field.description };
    case "string[]":
      return { type: "array", items: { type: "string" }, description: field.description };
    case "object":
      if (field.fields?.length) {
        const props: Record<string, unknown> = {};
        for (const f of field.fields) props[f.key] = fieldToJsonSchema(f);
        return { type: "object", properties: props, description: field.description };
      }
      return { type: "object", description: field.description };
    case "object[]": {
      const itemSchema: Record<string, unknown> = { type: "object" };
      if (field.fields?.length) {
        const props: Record<string, unknown> = {};
        for (const f of field.fields) props[f.key] = fieldToJsonSchema(f);
        itemSchema.properties = props;
      }
      return { type: "array", items: itemSchema, description: field.description };
    }
    default:
      return { type: "string", description: field.description };
  }
}

export function outputSchemaToJsonSchema(outputs: StageOutputSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(outputs)) {
    if (!schema.fields?.length) {
      properties[key] = { type: "object" };
      continue;
    }
    const innerProps: Record<string, unknown> = {};
    for (const field of schema.fields) {
      innerProps[field.key] = fieldToJsonSchema(field);
    }
    properties[key] = { type: "object", properties: innerProps };
  }
  return { type: "object", properties };
}
