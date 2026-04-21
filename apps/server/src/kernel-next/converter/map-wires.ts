// Maps legacy runtime.reads to kernel-next WireIR[].
// Spec: docs/superpowers/specs/2026-04-20-legacy-yaml-converter-design.md §5.6.
//
// For each (localKey → sourceKey) entry in reads:
//   - sourceKey is an entry name (no dot)  → one wire per declared field
//     on the producing stage, each wire.to.port = field name (entry-level
//     reads expand into multiple input ports, one per declared field).
//   - sourceKey is dotted (entry.field)    → single wire targeting a port
//     named after the localKey. The agent sees a variable whose name
//     matches its reads declaration.
//   - sourceKey in externalKeys            → single external wire whose
//     to.port = localKey (agent sees the declared variable name).
//   - otherwise                            → STAGE_READS_UNKNOWN_KEY

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
    for (const [localKey, sourceKey] of Object.entries(reads)) {
      if (entryDirectory.has(sourceKey)) {
        const entry = entryDirectory.get(sourceKey)!;
        const isDottedField = sourceKey.includes(".");
        for (const f of entry.fields) {
          wires.push({
            from: { source: "stage", stage: entry.producerStage, port: f.name },
            // Dotted-field read collapses to a single wire whose target
            // port name = localKey. Entry-level read keeps the historical
            // expand-by-field-name behavior so existing hand-ported IR
            // (smoke-test, tech-research) remains hash-identical.
            to: { stage: name, port: isDottedField ? localKey : f.name },
          });
        }
      } else if (externalKeys.has(sourceKey)) {
        wires.push({
          from: { source: "external", port: sourceKey },
          to: { stage: name, port: localKey },
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
