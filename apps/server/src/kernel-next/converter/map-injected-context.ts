// Maps legacy injected_context[] to kernel-next externalInputs.
// Spec: docs/superpowers/specs/2026-04-20-legacy-yaml-converter-design.md §5.4.

import type { PortIR } from "../ir/schema.js";
import type { ConverterDiagnostic, ConverterWarning } from "./types.js";

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const RESERVED_SENTINEL = "__external__";

export type MapInjectedContextResult =
  | { ok: true; externalInputs: PortIR[]; externalKeys: Set<string>; warnings: ConverterWarning[] }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

interface LegacyInput {
  injected_context?: string[];
  store_schema?: Record<string, unknown>;
}

export function mapInjectedContext(legacy: LegacyInput): MapInjectedContextResult {
  const entries = legacy.injected_context ?? [];
  const storeKeys = new Set(Object.keys(legacy.store_schema ?? {}));
  const externalInputs: PortIR[] = [];
  const externalKeys = new Set<string>();
  const warnings: ConverterWarning[] = [];
  const diagnostics: ConverterDiagnostic[] = [];

  for (const entry of entries) {
    if (entry === RESERVED_SENTINEL) {
      diagnostics.push({
        code: "INJECTED_CONTEXT_NAME_INVALID",
        message: `injected_context entry '${entry}' uses the reserved sentinel name`,
        context: { entry },
      });
      continue;
    }
    if (!IDENTIFIER_RE.test(entry)) {
      diagnostics.push({
        code: "INJECTED_CONTEXT_NAME_INVALID",
        message: `injected_context entry '${entry}' is not a valid kernel-next identifier`,
        context: { entry },
      });
      continue;
    }
    if (externalKeys.has(entry)) {
      diagnostics.push({
        code: "DUPLICATE_EXTERNAL_INPUT_NAME",
        message: `injected_context entry '${entry}' is declared more than once`,
        context: { entry },
      });
      continue;
    }
    if (storeKeys.has(entry)) {
      diagnostics.push({
        code: "EXTERNAL_INPUT_COLLIDES_WITH_STAGE",
        message: `injected_context entry '${entry}' collides with a store_schema key`,
        context: { entry },
      });
      continue;
    }
    externalInputs.push({ name: entry, type: "unknown" });
    externalKeys.add(entry);
    warnings.push({
      code: "INJECTED_CONTEXT_UNTYPED",
      message: `injected_context '${entry}' mapped as externalInput with type 'unknown'`,
      context: { entry },
    });
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, externalInputs, externalKeys, warnings };
}
