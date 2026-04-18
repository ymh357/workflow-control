import type { StoreSchema, StoreSchemaEntry, StoreSchemaField } from "../lib/config/types.js";

export interface SchemaShapeFailure {
  key: string;
  path: string;
  reason: string;
}

/**
 * Phase 3.5 (D2): runtime shape validation against a pipeline's
 * `store_schema`. Evaluated right after JSON extraction, before
 * applyStoreUpdates, so violations become retry feedback without
 * polluting the store.
 *
 * Design decisions (see docs/store-schema-design.md §4):
 *   Q2 — `additional_properties` defaults to `false`. Extra keys are
 *        rejected unless the schema author opted in.
 *   Q4 — `markdown` is validated as `string`. The distinction exists
 *        for UI rendering, not for runtime typing.
 *
 * This validator is intentionally non-strict about nested objects when
 * a parent field declares `type: "object"` with no nested `fields`
 * schema — authors opt into nested validation by declaring nested
 * fields. Unspecified nested structure passes through.
 */
export function evaluateSchemaShape(
  stageName: string,
  parsed: Record<string, unknown>,
  schema: StoreSchema | undefined,
  declaredWriteKeys: string[],
): SchemaShapeFailure[] {
  if (!schema) return [];
  const failures: SchemaShapeFailure[] = [];

  for (const key of declaredWriteKeys) {
    const entry = schema[key];
    if (!entry) continue;
    if (entry.produced_by !== stageName) continue;

    const value = parsed[key];
    if (value === undefined) {
      // Missing-key is handled by the existing "missing required fields"
      // guard in state-builders — not our responsibility.
      continue;
    }

    validateEntry(key, key, value, entry, failures);
  }

  return failures;
}

function validateEntry(
  rootKey: string,
  path: string,
  value: unknown,
  entry: StoreSchemaEntry,
  failures: SchemaShapeFailure[],
): void {
  // Top-level entries are always objects (the "value" the stage writes
  // under this store key). We validate fields + additional_properties.
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    failures.push({
      key: rootKey,
      path,
      reason: `expected an object, got ${describeType(value)}`,
    });
    return;
  }

  const obj = value as Record<string, unknown>;
  const declaredFields = entry.fields ?? {};
  const allowExtras = entry.additional_properties === true;

  for (const [fieldName, fieldDef] of Object.entries(declaredFields)) {
    const fieldPath = `${path}.${fieldName}`;
    const fieldVal = obj[fieldName];
    if (fieldVal === undefined) {
      if (fieldDef.required) {
        failures.push({
          key: rootKey,
          path: fieldPath,
          reason: "required field is missing",
        });
      }
      continue;
    }
    validateField(rootKey, fieldPath, fieldVal, fieldDef, failures);
  }

  if (!allowExtras) {
    for (const fieldName of Object.keys(obj)) {
      if (declaredFields[fieldName] === undefined) {
        failures.push({
          key: rootKey,
          path: `${path}.${fieldName}`,
          reason: "unknown field (additional_properties is false; remove it or declare it in store_schema)",
        });
      }
    }
  }
}

function validateField(
  rootKey: string,
  path: string,
  value: unknown,
  field: StoreSchemaField,
  failures: SchemaShapeFailure[],
): void {
  const expected = field.type;
  if (!typeMatches(value, expected)) {
    failures.push({
      key: rootKey,
      path,
      reason: `expected ${expected}, got ${describeType(value)}`,
    });
    return;
  }

  if (expected === "object" && field.fields) {
    const obj = value as Record<string, unknown>;
    for (const [nestedName, nestedDef] of Object.entries(field.fields)) {
      const nestedPath = `${path}.${nestedName}`;
      const nestedVal = obj[nestedName];
      if (nestedVal === undefined) {
        if (nestedDef.required) {
          failures.push({
            key: rootKey,
            path: nestedPath,
            reason: "required nested field is missing",
          });
        }
        continue;
      }
      validateField(rootKey, nestedPath, nestedVal, nestedDef, failures);
    }
  }

  if (expected === "object[]" && field.fields) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        failures.push({
          key: rootKey,
          path: `${path}[${i}]`,
          reason: `expected object, got ${describeType(item)}`,
        });
        continue;
      }
      const itemObj = item as Record<string, unknown>;
      for (const [nestedName, nestedDef] of Object.entries(field.fields)) {
        const nestedPath = `${path}[${i}].${nestedName}`;
        const nestedVal = itemObj[nestedName];
        if (nestedVal === undefined) {
          if (nestedDef.required) {
            failures.push({
              key: rootKey,
              path: nestedPath,
              reason: "required nested field is missing",
            });
          }
          continue;
        }
        validateField(rootKey, nestedPath, nestedVal, nestedDef, failures);
      }
    }
  }
}

function typeMatches(value: unknown, expected: StoreSchemaField["type"]): boolean {
  switch (expected) {
    case "string":
    case "markdown":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "string[]":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "object[]":
      return Array.isArray(value) && value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v));
    default:
      return false;
  }
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Format shape failures into a human-readable feedback string for retry.
 */
export function formatShapeFeedback(failures: SchemaShapeFailure[]): string {
  const lines = failures.map((f) => `- ${f.path}: ${f.reason}`);
  return (
    "Your output did not match the declared store_schema shape:\n" +
    lines.join("\n") +
    "\n\nFix these fields and output the corrected JSON."
  );
}
