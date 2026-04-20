// Maps legacy store_schema to kernel-next port outputs + an entry
// directory for resolving downstream reads.
// Spec: docs/superpowers/specs/2026-04-20-legacy-yaml-converter-design.md §5.3.

import type { PortIR } from "../ir/schema.js";
import type { ConverterDiagnostic, ConverterWarning } from "./types.js";

export interface EntryDescriptor {
  producerStage: string;
  fields: PortIR[];
}

export type MapStoreSchemaResult =
  | {
      ok: true;
      stageOutputs: Map<string, PortIR[]>;
      entryDirectory: Map<string, EntryDescriptor>;
      warnings: ConverterWarning[];
    }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

// Legacy type -> kernel-next PortIR.type (TS type source).
// `downgrade: true` emits a LEGACY_TYPE_DOWNGRADED warning per occurrence.
const TYPE_MAP: Record<string, { ts: string; downgrade: boolean }> = {
  string: { ts: "string", downgrade: false },
  "string[]": { ts: "string[]", downgrade: false },
  number: { ts: "number", downgrade: false },
  boolean: { ts: "boolean", downgrade: false },
  markdown: { ts: "string", downgrade: true },
  object: { ts: "Record<string, unknown>", downgrade: true },
  "object[]": { ts: "Record<string, unknown>[]", downgrade: true },
};

interface LegacyInput {
  stages?: Array<{ name: string }>;
  store_schema?: Record<string, {
    produced_by: string;
    fields?: Record<string, { type: string }>;
  }>;
}

export function mapStoreSchemaToPorts(legacy: LegacyInput): MapStoreSchemaResult {
  const stageOutputs = new Map<string, PortIR[]>();
  const entryDirectory = new Map<string, EntryDescriptor>();
  const warnings: ConverterWarning[] = [];
  const diagnostics: ConverterDiagnostic[] = [];

  const stageNames = new Set((legacy.stages ?? []).map((s) => s.name));
  const schema = legacy.store_schema ?? {};

  for (const [entryName, entry] of Object.entries(schema)) {
    if (!stageNames.has(entry.produced_by)) {
      diagnostics.push({
        code: "STORE_ENTRY_PRODUCER_MISSING",
        message: `store_schema['${entryName}'].produced_by='${entry.produced_by}' is not a declared stage`,
        context: { entry: entryName, producer: entry.produced_by },
      });
      continue;
    }

    const fields = entry.fields ?? {};
    const ports: PortIR[] = [];
    for (const [fieldName, field] of Object.entries(fields)) {
      const mapping = TYPE_MAP[field.type];
      if (!mapping) {
        diagnostics.push({
          code: "UNSUPPORTED_FIELD_TYPE",
          message: `store_schema['${entryName}'].fields['${fieldName}'].type='${field.type}' is not supported`,
          context: { entry: entryName, field: fieldName, type: field.type },
        });
        continue;
      }
      ports.push({ name: fieldName, type: mapping.ts });
      if (mapping.downgrade) {
        warnings.push({
          code: "LEGACY_TYPE_DOWNGRADED",
          message: `legacy type '${field.type}' downgraded to '${mapping.ts}'`,
          context: { entry: entryName, field: fieldName, from: field.type, to: mapping.ts },
        });
      }
    }

    const existing = stageOutputs.get(entry.produced_by) ?? [];
    stageOutputs.set(entry.produced_by, existing.concat(ports));
    entryDirectory.set(entryName, { producerStage: entry.produced_by, fields: ports });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, stageOutputs, entryDirectory, warnings };
}
