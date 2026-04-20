// Entry point for legacy YAML → kernel-next IR conversion.
// Implementation is built task-by-task; this file orchestrates the
// pure mappers from map-store-schema.ts / map-injected-context.ts /
// map-stages.ts / map-wires.ts (added in tasks 2.2-2.6).

import YAML from "yaml";
import { dirname, join } from "node:path";
import type { ConvertOptions, ConversionResult } from "./types.js";

export function convertLegacyYaml(
  yamlText: string,
  opts?: ConvertOptions,
): ConversionResult {
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      diagnostics: [
        { code: "YAML_PARSE_ERROR", message, context: { raw: yamlText.slice(0, 200) } },
      ],
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      diagnostics: [{ code: "LEGACY_SCHEMA_INVALID", message: "YAML root is not an object" }],
    };
  }
  // Subsequent tasks (2.2 onwards) flesh out the rest. For now return
  // a sentinel diagnostic so the entry-point test surface exists.
  void opts;
  return {
    ok: false,
    diagnostics: [
      { code: "LEGACY_SCHEMA_INVALID", message: "converter not yet implemented (stub)" },
    ],
  };
}

// Helper retained here for later tasks to import (Task 2.6 uses it).
export function promptRootFromYamlPath(yamlFilePath: string | undefined): string | undefined {
  if (!yamlFilePath) return undefined;
  return join(dirname(yamlFilePath), "prompts");
}
