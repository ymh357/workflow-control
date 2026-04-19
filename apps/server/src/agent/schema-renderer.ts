import type { StoreSchemaEntry, StoreSchemaField } from "../lib/config/types.js";

// Schema-driven rendering for tier1 context injection (Phase 3.6).
// Turns a store value into compact markdown based on its declared schema,
// replacing the old "pretty-print JSON and hope for the best" approach.
//
// Design notes:
// - scalars (string/number/boolean) render inline — no fences, no extra newlines.
// - markdown renders raw, preserving the author's formatting; the agent reads
//   prose in prose form, not in JSON-escaped form.
// - string[] compacts to a single line; >10 items get truncated with total count.
// - object[] / object with nested `fields` recursively render each declared
//   field. Undeclared keys on an object are silently ignored (schema is the
//   contract; agents should not rely on ghost fields).
// - object / object[] WITHOUT nested `fields` fall through to JSON so we
//   don't silently drop structured data that the schema author didn't describe.

const OBJECT_ARRAY_PREVIEW = 5;
const STRING_ARRAY_PREVIEW = 10;

export interface RenderOptions {
  // How deeply nested fields are allowed to recurse. Prevents runaway output
  // when a schema accidentally references itself via `fields`.
  maxDepth?: number;
}

export interface RenderResult {
  // The rendered markdown block including the `### {label}` heading. Callers
  // still own the token-budget decision — they receive a string and decide
  // whether to include it as-is, summarize it, or drop to a keys preview.
  body: string;
  // True when the schema fully described the value. False when we had to
  // fall through to JSON because of missing `fields`. Callers may log this
  // to flag schema gaps.
  schemaComplete: boolean;
}

export function renderBySchema(
  value: unknown,
  entry: StoreSchemaEntry,
  label: string,
  opts: RenderOptions = {},
): RenderResult {
  const maxDepth = opts.maxDepth ?? 5;

  // Top-level store entries are conceptually always object-typed (the schema
  // models store[key] as a bag of fields). But in practice we also see
  // entries where the whole value is a string/number — tolerate that.
  if (value === undefined || value === null) {
    return { body: `\n### ${label}\n(empty)`, schemaComplete: true };
  }

  if (typeof value !== "object") {
    return {
      body: `\n### ${label}\n${String(value)}`,
      schemaComplete: true,
    };
  }

  if (!entry.fields || Object.keys(entry.fields).length === 0) {
    return renderAsJson(value, label);
  }

  const lines = [`\n### ${label}`];
  let schemaComplete = true;

  for (const [fieldKey, fieldDef] of Object.entries(entry.fields)) {
    if (fieldDef.hidden) continue;
    const fieldVal = (value as Record<string, unknown>)[fieldKey];
    if (fieldVal === undefined || fieldVal === null) continue;

    const rendered = renderField(fieldKey, fieldVal, fieldDef, maxDepth);
    lines.push(rendered.body);
    if (!rendered.schemaComplete) schemaComplete = false;
  }

  return { body: lines.join("\n"), schemaComplete };
}

interface FieldRenderResult {
  body: string;
  schemaComplete: boolean;
}

function renderField(
  key: string,
  value: unknown,
  field: StoreSchemaField,
  depth: number,
): FieldRenderResult {
  if (depth <= 0) {
    return {
      body: `- ${key}: (max depth exceeded)`,
      schemaComplete: false,
    };
  }

  switch (field.type) {
    case "string":
    case "number":
    case "boolean":
      return renderScalar(key, value);

    case "markdown":
      return renderMarkdown(key, value);

    case "string[]":
      return renderStringArray(key, value);

    case "object":
      return renderNestedObject(key, value, field, depth);

    case "object[]":
      return renderObjectArray(key, value, field, depth);

    default:
      // Unreachable under current type union but guard anyway — an unknown
      // type signals the schema ran ahead of the renderer.
      return {
        body: `- ${key}: ${safeStringify(value)}`,
        schemaComplete: false,
      };
  }
}

function renderScalar(key: string, value: unknown): FieldRenderResult {
  return { body: `- ${key}: ${String(value)}`, schemaComplete: true };
}

function renderMarkdown(key: string, value: unknown): FieldRenderResult {
  if (typeof value !== "string") {
    return renderScalar(key, value);
  }
  // Emit as a sub-section so nested markdown headings don't collide with
  // the outer `### {label}` scope. `#### {key}` is the natural next level.
  return {
    body: `\n#### ${key}\n${value}`,
    schemaComplete: true,
  };
}

function renderStringArray(key: string, value: unknown): FieldRenderResult {
  if (!Array.isArray(value)) {
    return { body: `- ${key}: ${safeStringify(value)}`, schemaComplete: false };
  }
  if (value.length === 0) {
    return { body: `- ${key}: (empty list)`, schemaComplete: true };
  }
  const preview = value.slice(0, STRING_ARRAY_PREVIEW).map(String);
  const suffix = value.length > STRING_ARRAY_PREVIEW
    ? `, ... (${value.length} total)`
    : "";
  return {
    body: `- ${key}: ${preview.join(", ")}${suffix}`,
    schemaComplete: true,
  };
}

function renderNestedObject(
  key: string,
  value: unknown,
  field: StoreSchemaField,
  depth: number,
): FieldRenderResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { body: `- ${key}: ${safeStringify(value)}`, schemaComplete: false };
  }
  if (!field.fields || Object.keys(field.fields).length === 0) {
    // Schema declared "object" but didn't describe fields — fall through
    // to compact JSON rather than silently dropping the payload.
    const json = JSON.stringify(value, null, 2);
    return {
      body: `- ${key}:\n\`\`\`json\n${json}\n\`\`\``,
      schemaComplete: false,
    };
  }

  const lines = [`- ${key}:`];
  let schemaComplete = true;
  for (const [nestedKey, nestedDef] of Object.entries(field.fields)) {
    if (nestedDef.hidden) continue;
    const nestedVal = (value as Record<string, unknown>)[nestedKey];
    if (nestedVal === undefined || nestedVal === null) continue;
    const rendered = renderField(nestedKey, nestedVal, nestedDef, depth - 1);
    lines.push(indent(rendered.body));
    if (!rendered.schemaComplete) schemaComplete = false;
  }
  return { body: lines.join("\n"), schemaComplete };
}

function renderObjectArray(
  key: string,
  value: unknown,
  field: StoreSchemaField,
  depth: number,
): FieldRenderResult {
  if (!Array.isArray(value)) {
    return { body: `- ${key}: ${safeStringify(value)}`, schemaComplete: false };
  }
  if (value.length === 0) {
    return { body: `- ${key}: (empty list)`, schemaComplete: true };
  }

  if (!field.fields || Object.keys(field.fields).length === 0) {
    // No item schema — fall through to truncated JSON so we don't drop it.
    const truncated = value.length > 20
      ? [...value.slice(0, 20), `... (${value.length} total items)`]
      : value;
    const json = JSON.stringify(truncated, null, 2);
    return {
      body: `- ${key}:\n\`\`\`json\n${json}\n\`\`\``,
      schemaComplete: false,
    };
  }

  const lines = [`- ${key}:`];
  const previewCount = Math.min(value.length, OBJECT_ARRAY_PREVIEW);
  let schemaComplete = true;

  for (let i = 0; i < previewCount; i++) {
    const item = value[i];
    lines.push(indent(`[${i}]`));
    if (typeof item !== "object" || item === null) {
      lines.push(indent(indent(String(item))));
      continue;
    }
    for (const [nestedKey, nestedDef] of Object.entries(field.fields)) {
      if (nestedDef.hidden) continue;
      const nestedVal = (item as Record<string, unknown>)[nestedKey];
      if (nestedVal === undefined || nestedVal === null) continue;
      const rendered = renderField(nestedKey, nestedVal, nestedDef, depth - 1);
      lines.push(indent(indent(rendered.body)));
      if (!rendered.schemaComplete) schemaComplete = false;
    }
  }

  if (value.length > previewCount) {
    lines.push(indent(`... (${value.length} total items, showing ${previewCount})`));
  }
  return { body: lines.join("\n"), schemaComplete };
}

function renderAsJson(value: unknown, label: string): RenderResult {
  const truncated = Array.isArray(value) && value.length > 20
    ? [...value.slice(0, 20), `... (${value.length} total items)`]
    : value;
  const json = JSON.stringify(truncated, null, 2);
  return {
    body: `\n### ${label}\n\`\`\`json\n${json}\n\`\`\``,
    schemaComplete: false,
  };
}

// Indent every line by 2 spaces for nested rendering. Preserves leading
// newlines so outer block structure stays intact.
function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `  ${line}`))
    .join("\n");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
