// Maps legacy runtime.reads to kernel-next WireIR[].
// Spec: docs/superpowers/specs/2026-04-20-legacy-yaml-converter-design.md §5.6.
//
// For each (localKey → sourceKey) entry in reads:
//   - sourceKey in entryDirectory  → one wire per declared field on the
//     producing stage (legacy "entry" spans multiple ports)
//   - sourceKey in externalKeys    → single external wire keyed by the
//     external port name (inputs/ports share the same name by §5.6)
//   - otherwise                    → STAGE_READS_UNKNOWN_KEY

import type { WireIR } from "../ir/schema.js";
import type { ConverterDiagnostic } from "./types.js";
import type { EntryDescriptor } from "./map-store-schema.js";

export type MapWiresResult =
  | { ok: true; wires: WireIR[] }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

interface LegacyStage {
  name?: string;
  type?: string;
  runtime?: { reads?: Record<string, string> };
}

export function mapReadsToWires(
  legacy: { stages?: LegacyStage[] },
  entryDirectory: Map<string, EntryDescriptor>,
  externalKeys: Set<string>,
): MapWiresResult {
  const wires: WireIR[] = [];
  const diagnostics: ConverterDiagnostic[] = [];

  for (const s of legacy.stages ?? []) {
    if (s.type !== "agent" && s.type !== "script") continue;
    const name = s.name!;
    const reads = s.runtime?.reads ?? {};
    for (const sourceKey of Object.values(reads)) {
      if (entryDirectory.has(sourceKey)) {
        const entry = entryDirectory.get(sourceKey)!;
        for (const f of entry.fields) {
          wires.push({
            from: { source: "stage", stage: entry.producerStage, port: f.name },
            to: { stage: name, port: f.name },
          });
        }
      } else if (externalKeys.has(sourceKey)) {
        wires.push({
          from: { source: "external", port: sourceKey },
          to: { stage: name, port: sourceKey },
        });
      } else {
        diagnostics.push({
          code: "STAGE_READS_UNKNOWN_KEY",
          message: `stage '${name}' reads '${sourceKey}' which is not a store_schema entry or injected_context key`,
          context: { stage: name, sourceKey },
        });
      }
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, wires };
}
