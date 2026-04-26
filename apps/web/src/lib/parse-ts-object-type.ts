// Tiny parser for the subset of TypeScript object-literal type syntax
// that the pipeline-generator commonly emits in IR externalInputs:
//
//   { name: string; age: number; tags: string[]; nested?: { a: boolean } }
//
// Handles primitive leaves (string / number / boolean), arrays of
// primitives, optional fields (`?:`), and one level of nested objects.
// Anything more exotic — union types, generics, indexed access,
// imported names — falls through to a "raw" verdict so the launcher
// can drop back to the JSON textarea.
//
// 2026-04-27 B-launch dialog UX.

export type FieldType =
  | { kind: "string"; optional: boolean }
  | { kind: "number"; optional: boolean }
  | { kind: "boolean"; optional: boolean }
  | { kind: "string-array"; optional: boolean }
  | { kind: "number-array"; optional: boolean }
  | { kind: "object"; optional: boolean; fields: ObjectField[] }
  | { kind: "raw"; optional: boolean };

export interface ObjectField {
  name: string;
  type: FieldType;
}

export type ParseResult =
  | { kind: "object"; fields: ObjectField[] }
  | { kind: "primitive"; type: "string" | "number" | "boolean" }
  | { kind: "primitive-array"; element: "string" | "number" }
  | { kind: "raw" };

/**
 * Parse a type-literal string. Returns:
 *   - "object" with fields if it's a `{ ... }` literal we understand
 *   - "primitive" / "primitive-array" for simple top-level cases
 *   - "raw" for anything we don't recognize (caller drops to textarea)
 */
export const parseObjectType = (raw: string): ParseResult => {
  const trimmed = raw.trim();

  // Top-level primitives.
  if (trimmed === "string") return { kind: "primitive", type: "string" };
  if (trimmed === "number") return { kind: "primitive", type: "number" };
  if (trimmed === "boolean") return { kind: "primitive", type: "boolean" };
  if (trimmed === "string[]") return { kind: "primitive-array", element: "string" };
  if (trimmed === "number[]") return { kind: "primitive-array", element: "number" };

  // Top-level object literal. Must start with { and end with }.
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return { kind: "raw" };
  }

  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return { kind: "object", fields: [] };

  const fieldStrings = splitTopLevelFields(inner);
  if (fieldStrings === null) return { kind: "raw" };

  const fields: ObjectField[] = [];
  for (const f of fieldStrings) {
    const parsed = parseField(f);
    if (parsed === null) return { kind: "raw" };
    fields.push(parsed);
  }
  return { kind: "object", fields };
};

/**
 * Split top-level fields by `;` or `,`, respecting nested braces. Returns
 * null if braces are unbalanced (caller treats as raw).
 */
const splitTopLevelFields = (inner: string): string[] | null => {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of inner) {
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth < 0) return null;
    }
    if (depth === 0 && (ch === ";" || ch === ",")) {
      const t = current.trim();
      if (t.length > 0) out.push(t);
      current = "";
    } else {
      current += ch;
    }
  }
  if (depth !== 0) return null;
  const last = current.trim();
  if (last.length > 0) out.push(last);
  return out;
};

const parseField = (s: string): ObjectField | null => {
  // Match `name?: type` or `name: type`. Names can include letters,
  // digits, underscores, and dollar signs (TS identifier rules).
  const m = s.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(\?)?\s*:\s*(.+)$/);
  if (!m) return null;
  const [, name, optMark, typeStr] = m;
  const optional = optMark === "?";
  const type = parseFieldType(typeStr!.trim(), optional);
  if (type === null) return null;
  return { name: name!, type };
};

const parseFieldType = (raw: string, optional: boolean): FieldType | null => {
  if (raw === "string") return { kind: "string", optional };
  if (raw === "number") return { kind: "number", optional };
  if (raw === "boolean") return { kind: "boolean", optional };
  if (raw === "string[]") return { kind: "string-array", optional };
  if (raw === "number[]") return { kind: "number-array", optional };
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const inner = raw.slice(1, -1).trim();
    if (inner.length === 0) return { kind: "object", optional, fields: [] };
    const parts = splitTopLevelFields(inner);
    if (parts === null) return null;
    const nested: ObjectField[] = [];
    for (const p of parts) {
      const f = parseField(p);
      if (f === null) return null;
      nested.push(f);
    }
    return { kind: "object", optional, fields: nested };
  }
  // Unknown shape — bail to raw so the field renders as a JSON textarea.
  return { kind: "raw", optional };
};
