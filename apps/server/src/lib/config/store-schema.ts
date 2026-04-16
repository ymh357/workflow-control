import type {
  StoreSchema, StoreSchemaEntry, StoreSchemaField,
  WriteDeclaration, StageOutputSchema, OutputFieldSchema,
} from "./types.js";

/**
 * Derive WriteDeclaration[] for a given stage from the pipeline's store_schema.
 * A stage "produces" all keys where produced_by matches the stage name.
 */
export function deriveStageWrites(schema: StoreSchema, stageName: string): WriteDeclaration[] {
  const writes: WriteDeclaration[] = [];
  for (const [key, entry] of Object.entries(schema)) {
    if (entry.produced_by !== stageName) continue;
    if (entry.assertions?.length) {
      writes.push({ key, assertions: entry.assertions });
    } else {
      writes.push({ key });
    }
  }
  return writes;
}

/**
 * Derive StageOutputSchema for a given stage from the pipeline's store_schema.
 */
export function deriveStageOutputs(schema: StoreSchema, stageName: string): StageOutputSchema | undefined {
  const outputs: StageOutputSchema = {};
  let found = false;
  for (const [key, entry] of Object.entries(schema)) {
    if (entry.produced_by !== stageName) continue;
    found = true;
    const fields: OutputFieldSchema[] = [];
    if (entry.fields) {
      for (const [fieldKey, fieldDef] of Object.entries(entry.fields)) {
        fields.push(schemaFieldToOutputField(fieldKey, fieldDef));
      }
    }
    outputs[key] = {
      type: "object",
      label: entry.description,
      fields,
    };
  }
  return found ? outputs : undefined;
}

function schemaFieldToOutputField(key: string, field: StoreSchemaField): OutputFieldSchema {
  const result: OutputFieldSchema = {
    key,
    type: field.type,
    description: field.description ?? key,
  };
  if (field.fields) {
    result.fields = Object.entries(field.fields).map(
      ([k, f]) => schemaFieldToOutputField(k, f),
    );
  }
  if (field.display_hint) result.display_hint = field.display_hint;
  if (field.hidden) result.hidden = field.hidden;
  return result;
}

export function getAllSchemaKeys(schema: StoreSchema): Set<string> {
  return new Set(Object.keys(schema));
}

export type { StoreSchema };
