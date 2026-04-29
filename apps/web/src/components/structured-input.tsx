"use client";

import { parseObjectType, type FieldType, type ObjectField } from "../lib/parse-ts-object-type";

interface StructuredInputProps {
  /** TS-style type literal (e.g. `{ name: string; tags: string[] }`). */
  typeStr: string;
  /** Current value as JSON string — same channel the dialog already uses. */
  value: string;
  /** Updated JSON string is propagated up. */
  onChange: (next: string) => void;
}

/**
 * Renders a structured form when `typeStr` parses as a known object
 * literal; otherwise falls through to a JSON textarea (the legacy
 * behavior). The form's state is the JSON string itself — we parse on
 * the way in, render fields, and re-stringify on every change. This
 * keeps the dialog's submit code path unchanged: it still receives
 * a JSON string and runs JSON.parse on it.
 *
 * 2026-04-27 B-launch dialog UX.
 */
export const StructuredInput = ({ typeStr, value, onChange }: StructuredInputProps): React.ReactElement => {
  const parsed = parseObjectType(typeStr);

  // Fallback: raw JSON textarea (the legacy launcher behavior).
  if (parsed.kind === "raw") {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="JSON value"
        rows={3}
        className="mt-1 w-full rounded border border-strong bg-page px-2 py-1.5 font-mono text-xs text-primary placeholder:text-muted focus:border-strong focus:outline-none"
      />
    );
  }

  // Top-level primitives — handled by the dialog's existing single-line
  // input, but we expose them here too so the component is self-contained.
  if (parsed.kind === "primitive") {
    return (
      <input
        type={parsed.type === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-strong bg-page px-2 py-1.5 text-sm text-primary focus:border-strong focus:outline-none"
      />
    );
  }

  if (parsed.kind === "primitive-array") {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`["a", "b", "c"]`}
        rows={2}
        className="mt-1 w-full rounded border border-strong bg-page px-2 py-1.5 font-mono text-xs text-primary focus:border-strong focus:outline-none"
      />
    );
  }

  // parsed.kind === "object" — render the structured form.
  // Decode current value as JSON object (or empty object on parse fail).
  let current: Record<string, unknown> = {};
  if (value.trim().length > 0) {
    try {
      const v = JSON.parse(value);
      if (v && typeof v === "object" && !Array.isArray(v)) current = v as Record<string, unknown>;
    } catch { /* fall through with empty object */ }
  }

  const updateField = (name: string, next: unknown): void => {
    const merged = { ...current, [name]: next };
    // Drop undefined keys so the JSON stays clean.
    for (const k of Object.keys(merged)) {
      if (merged[k] === undefined) delete merged[k];
    }
    onChange(JSON.stringify(merged));
  };

  return (
    <div className="mt-1 space-y-2 rounded border border-default bg-page p-2">
      {parsed.fields.map((f) => (
        <FieldRow key={f.name} field={f} value={current[f.name]} onChange={(v) => updateField(f.name, v)} />
      ))}
    </div>
  );
};

interface FieldRowProps {
  field: ObjectField;
  value: unknown;
  onChange: (next: unknown) => void;
}

const FieldRow = ({ field, value, onChange }: FieldRowProps): React.ReactElement => {
  const t = field.type;
  return (
    <label className="block text-xs">
      <span className="font-mono text-secondary">
        {field.name}
        {t.optional && <span className="text-muted">?</span>}
        <span className="ml-2 text-muted">{describeType(t)}</span>
      </span>
      <FieldEditor type={t} value={value} onChange={onChange} />
    </label>
  );
};

const describeType = (t: FieldType): string => {
  switch (t.kind) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    case "string-array": return "string[]";
    case "number-array": return "number[]";
    case "object": return "{ … }";
    case "raw": return "?";
  }
};

interface EditorProps<V = unknown> {
  type: FieldType;
  value: V;
  onChange: (next: unknown) => void;
}

const FieldEditor = ({ type, value, onChange }: EditorProps): React.ReactElement => {
  switch (type.kind) {
    case "string":
      return (
        <input
          type="text"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" && type.optional ? undefined : e.target.value)}
          className="mt-1 w-full rounded border border-strong bg-page px-2 py-1 text-xs text-primary focus:border-strong focus:outline-none"
        />
      );
    case "number":
      return (
        <input
          type="number"
          value={typeof value === "number" ? String(value) : ""}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") {
              onChange(type.optional ? undefined : 0);
              return;
            }
            const n = Number(raw);
            onChange(Number.isFinite(n) ? n : raw);
          }}
          className="mt-1 w-full rounded border border-strong bg-page px-2 py-1 text-xs text-primary focus:border-strong focus:outline-none"
        />
      );
    case "boolean":
      return (
        <select
          value={value === true ? "true" : value === false ? "false" : ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") onChange(type.optional ? undefined : false);
            else onChange(v === "true");
          }}
          className="mt-1 w-full rounded border border-strong bg-page px-2 py-1 text-xs text-primary focus:border-strong focus:outline-none"
        >
          {type.optional && <option value="">(unset)</option>}
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      );
    case "string-array":
    case "number-array": {
      const arr = Array.isArray(value) ? value : [];
      // Render as comma-separated text for ergonomics; convert on commit.
      const text = arr.join(", ");
      return (
        <input
          type="text"
          value={text}
          onChange={(e) => {
            const parts = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            if (type.kind === "number-array") {
              onChange(parts.map((p) => {
                const n = Number(p);
                return Number.isFinite(n) ? n : p;
              }));
            } else {
              onChange(parts);
            }
          }}
          placeholder="comma, separated, values"
          className="mt-1 w-full rounded border border-strong bg-page px-2 py-1 font-mono text-xs text-primary focus:border-strong focus:outline-none"
        />
      );
    }
    case "object": {
      // Nested object — render its fields recursively.
      const nestedCurrent: Record<string, unknown> =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const updateNested = (name: string, v: unknown): void => {
        const merged = { ...nestedCurrent, [name]: v };
        for (const k of Object.keys(merged)) {
          if (merged[k] === undefined) delete merged[k];
        }
        onChange(merged);
      };
      return (
        <div className="mt-1 space-y-2 rounded border border-default bg-page p-2">
          {type.fields.map((sub) => (
            <FieldRow
              key={sub.name}
              field={sub}
              value={nestedCurrent[sub.name]}
              onChange={(v) => updateNested(sub.name, v)}
            />
          ))}
        </div>
      );
    }
    case "raw":
      return (
        <input
          type="text"
          value={typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder="JSON or string"
          className="mt-1 w-full rounded border border-strong bg-page px-2 py-1 font-mono text-xs text-primary focus:border-strong focus:outline-none"
        />
      );
  }
};
