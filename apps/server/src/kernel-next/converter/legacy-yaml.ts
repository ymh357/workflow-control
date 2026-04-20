// Entry point for legacy YAML → kernel-next IR conversion.
// See docs/superpowers/specs/2026-04-20-legacy-yaml-converter-design.md.

import YAML from "yaml";
import { dirname, join } from "node:path";
import type { PipelineIR } from "../ir/schema.js";
import type {
  ConvertOptions, ConversionResult, ConverterWarning,
} from "./types.js";
import { mapStoreSchemaToPorts } from "./map-store-schema.js";
import { mapInjectedContext } from "./map-injected-context.js";
import { mapStagesToIR } from "./map-stages.js";
import { mapReadsToWires } from "./map-wires.js";

export function convertLegacyYaml(
  yamlText: string,
  opts?: ConvertOptions,
): ConversionResult {
  // Stage 1: parse YAML.
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
  const legacy = parsed as Record<string, unknown>;

  const warnings: ConverterWarning[] = [];

  // Stage 2: store_schema → ports.
  // Use `as any` at the boundary — each mapper enforces its own
  // structural expectations and emits diagnostics when shape is wrong.
  const storeRes = mapStoreSchemaToPorts(legacy as any);
  if (!storeRes.ok) return { ok: false, diagnostics: storeRes.diagnostics };
  warnings.push(...storeRes.warnings);

  // Stage 3: injected_context → externalInputs.
  const ctxRes = mapInjectedContext(legacy as any);
  if (!ctxRes.ok) return { ok: false, diagnostics: ctxRes.diagnostics };
  warnings.push(...ctxRes.warnings);

  // Stage 4: stages.
  const stagesRes = mapStagesToIR(
    legacy as any, storeRes.stageOutputs, storeRes.entryDirectory, ctxRes.externalKeys,
  );
  if (!stagesRes.ok) return { ok: false, diagnostics: stagesRes.diagnostics };
  warnings.push(...stagesRes.warnings);

  // Stage 5: wires from reads.
  const wiresRes = mapReadsToWires(legacy as any, storeRes.entryDirectory, ctxRes.externalKeys);
  if (!wiresRes.ok) return { ok: false, diagnostics: wiresRes.diagnostics };

  // Stage 6: pipeline-level ignored fields → warnings.
  if ("display" in legacy) {
    warnings.push({
      code: "DISPLAY_FIELDS_IGNORED",
      message: "display block ignored",
    });
  }
  if ("use_cases" in legacy) {
    warnings.push({
      code: "USE_CASES_IGNORED",
      message: "use_cases list ignored",
    });
  }

  const ir: PipelineIR = {
    name: typeof legacy.name === "string" ? legacy.name : "unnamed-pipeline",
    stages: stagesRes.stages,
    wires: wiresRes.wires,
    externalInputs: ctxRes.externalInputs,
  };

  return {
    ok: true,
    ir,
    promptRoot: promptRootFromYamlPath(opts?.yamlFilePath),
    warnings,
  };
}

export function promptRootFromYamlPath(yamlFilePath: string | undefined): string | undefined {
  if (!yamlFilePath) return undefined;
  return join(dirname(yamlFilePath), "prompts");
}
