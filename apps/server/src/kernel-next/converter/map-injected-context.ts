// Maps legacy injected_context[] and structured external_inputs{} to kernel-next externalInputs.
// Spec: docs/superpowers/specs/2026-04-20-legacy-yaml-converter-design.md §5.4.
//
// Two source formats are supported:
//   injected_context: [name, ...]           — legacy array, type defaults to "unknown"
//   external_inputs: { name: { type, ... }} — structured dict with optional type annotation

import type { PortIR } from "../ir/schema.js";
import type { ConverterDiagnostic, ConverterWarning } from "./types.js";

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const RESERVED_SENTINEL = "__external__";

// Valid PortIR types as defined in the IR schema.
const VALID_PORT_TYPES = new Set(["string", "number", "boolean", "object", "unknown"]);

export type MapInjectedContextResult =
  | { ok: true; externalInputs: PortIR[]; externalKeys: Set<string>; warnings: ConverterWarning[] }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

interface ExternalInputEntry {
  type?: string;
  description?: string;
  required?: boolean;
}

interface LegacyInput {
  injected_context?: string[];
  external_inputs?: Record<string, ExternalInputEntry>;
  store_schema?: Record<string, unknown>;
}

export function mapInjectedContext(legacy: LegacyInput): MapInjectedContextResult {
  const storeKeys = new Set(Object.keys(legacy.store_schema ?? {}));
  const externalInputs: PortIR[] = [];
  const externalKeys = new Set<string>();
  const warnings: ConverterWarning[] = [];
  const diagnostics: ConverterDiagnostic[] = [];

  // Helper: validate and register one external input entry.
  function registerEntry(entry: string, type: PortIR["type"], source: "injected_context" | "external_inputs"): void {
    if (entry === RESERVED_SENTINEL) {
      diagnostics.push({
        code: "INJECTED_CONTEXT_NAME_INVALID",
        message: `${source} entry '${entry}' uses the reserved sentinel name`,
        context: { entry },
      });
      return;
    }
    if (!IDENTIFIER_RE.test(entry)) {
      diagnostics.push({
        code: "INJECTED_CONTEXT_NAME_INVALID",
        message: `${source} entry '${entry}' is not a valid kernel-next identifier`,
        context: { entry },
      });
      return;
    }
    if (externalKeys.has(entry)) {
      diagnostics.push({
        code: "DUPLICATE_EXTERNAL_INPUT_NAME",
        message: `${source} entry '${entry}' is declared more than once`,
        context: { entry },
      });
      return;
    }
    if (storeKeys.has(entry)) {
      diagnostics.push({
        code: "EXTERNAL_INPUT_COLLIDES_WITH_STAGE",
        message: `${source} entry '${entry}' collides with a store_schema key`,
        context: { entry },
      });
      return;
    }
    externalInputs.push({ name: entry, type });
    externalKeys.add(entry);
    if (type === "unknown") {
      warnings.push({
        code: "INJECTED_CONTEXT_UNTYPED",
        message: `${source} '${entry}' mapped as externalInput with type 'unknown'`,
        context: { entry },
      });
    }
  }

  // Process legacy injected_context[] array.
  for (const entry of legacy.injected_context ?? []) {
    registerEntry(entry, "unknown", "injected_context");
  }

  // Process structured external_inputs{} dict (new format, preferred).
  for (const [name, def] of Object.entries(legacy.external_inputs ?? {})) {
    const rawType = def?.type ?? "unknown";
    const resolvedType: PortIR["type"] = VALID_PORT_TYPES.has(rawType)
      ? (rawType as PortIR["type"])
      : "unknown";
    if (rawType !== "unknown" && !VALID_PORT_TYPES.has(rawType)) {
      warnings.push({
        code: "EXTERNAL_INPUT_TYPE_UNKNOWN",
        message: `external_inputs '${name}' declared type '${rawType}' is not a known PortIR type; defaulting to 'unknown'`,
        context: { entry: name, declaredType: rawType },
      });
    }
    registerEntry(name, resolvedType, "external_inputs");
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, externalInputs, externalKeys, warnings };
}
