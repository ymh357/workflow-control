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
import { unwrapParallelBlocks } from "./unwrap-parallel-blocks.js";
import { mapHumanConfirmGates } from "./map-human-confirm-gates.js";
import { rewriteRetryBackTo } from "./rewrite-retry-back-to.js";

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

  // Stage 2: unwrap parallel blocks into a flat stage array.
  const unwrapRes = unwrapParallelBlocks(
    legacy as { stages?: unknown[] } as Parameters<typeof unwrapParallelBlocks>[0],
  );
  if (!unwrapRes.ok) return { ok: false, diagnostics: unwrapRes.diagnostics };

  // Stage 3: store_schema → ports. Pass a synthetic object with the flat
  // stage array so producer cross-references resolve against flattened names.
  const storeRes = mapStoreSchemaToPorts(
    { ...legacy, stages: unwrapRes.flat } as any,
  );
  if (!storeRes.ok) return { ok: false, diagnostics: storeRes.diagnostics };
  warnings.push(...storeRes.warnings);

  // Stage 4: injected_context → externalInputs.
  const ctxRes = mapInjectedContext(legacy as any);
  if (!ctxRes.ok) return { ok: false, diagnostics: ctxRes.diagnostics };
  warnings.push(...ctxRes.warnings);

  // Stage 5: human_confirm → gate. The gate mapper needs a map keyed
  // by FIRST-INNER-STAGE-NAME so it can detect when a human_confirm is
  // followed by a parallel block (in which case the approve target
  // widens to the full set of flattened block members). unwrap's
  // blockMembers is keyed by BLOCK NAME, so we remap here.
  const membersByFirstStage = new Map<string, string[]>();
  for (const [blockName, members] of unwrapRes.blockMembers.entries()) {
    const first = unwrapRes.blockMap.get(blockName);
    if (first !== undefined && members.length > 0) {
      membersByFirstStage.set(first, members);
    }
  }
  const gatesRes = mapHumanConfirmGates(unwrapRes.flat, membersByFirstStage);
  if (!gatesRes.ok) return { ok: false, diagnostics: gatesRes.diagnostics };

  // Stage 6: stages (now consumes the unwrapped + gate-mapped flat array).
  const stagesRes = mapStagesToIR(
    { stages: gatesRes.stages as unknown as Parameters<typeof mapStagesToIR>[0]["stages"] },
    storeRes.stageOutputs, storeRes.entryDirectory, ctxRes.externalKeys,
  );
  if (!stagesRes.ok) return { ok: false, diagnostics: stagesRes.diagnostics };
  warnings.push(...stagesRes.warnings);

  // Stage 7: rewrite script.retry.back_to pointing at a parallel block
  // name to the block's first inner stage. Slice C extracts runtime.retry
  // into ScriptStage.config.retry; until then this pass is a no-op (no
  // stage has config.retry yet), but it's wired in now so legacy-yaml.ts
  // doesn't need changing in Slice C.
  const stageNames = new Set(stagesRes.stages.map(s => s.name));
  const rewriteRes = rewriteRetryBackTo(
    stagesRes.stages, unwrapRes.blockMap, stageNames,
  );
  if (!rewriteRes.ok) return { ok: false, diagnostics: rewriteRes.diagnostics };
  warnings.push(...rewriteRes.warnings);

  // Stage 8: wires from reads. mapReadsToWires skips gate stages
  // (only processes agent/script), so passing the full post-gate array
  // is safe. We pass a synthetic shape with the flat array so wire
  // resolution follows the real topology after parallel block flattening.
  const wiresRes = mapReadsToWires(
    { ...legacy, stages: gatesRes.stages } as any,
    storeRes.entryDirectory, ctxRes.externalKeys,
  );
  if (!wiresRes.ok) return { ok: false, diagnostics: wiresRes.diagnostics };

  // Stage 9: pipeline-level ignored fields → warnings (unchanged).
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
  // Pipeline-level `claude_md` was originally spec'd as a fatal
  // UNSUPPORTED_FEATURE (see §5.7). Downgraded 2026-04-21 to a warning
  // so writer-style pipelines declaring a global constraint file can
  // still be converted; kernel-next agents will run without the global
  // file injected (quality degradation, not functional failure).
  if ("claude_md" in legacy) {
    warnings.push({
      code: "LEGACY_FIELD_IGNORED",
      message:
        "claude_md pipeline-level constraints ignored — kernel-next does not inject global claude.md files",
      context: { field: "claude_md" },
    });
  }

  const ir: PipelineIR = {
    name: typeof legacy.name === "string" ? legacy.name : "unnamed-pipeline",
    stages: rewriteRes.stages,
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
