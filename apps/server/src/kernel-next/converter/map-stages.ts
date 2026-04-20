// Maps legacy stages[] to kernel-next StageIR[].
// Spec: docs/superpowers/specs/2026-04-22-converter-extension-pipeline-generator-design.md §3.3.
//
// Accepts: type: "agent" | "script" | "gate".
// Parallel wrappers, human_confirm → gate transformation handled
// upstream by unwrapParallelBlocks + mapHumanConfirmGates.
// retry.back_to and runtime.agents emit LEGACY_FIELD_IGNORED warnings
// in Slice A; Slice C and Slice D replace those with real extractions.
// Still rejected: foreach, fanout, runtime.compensation, unknown
// stage types.

import type { PortIR, StageIR } from "../ir/schema.js";
import type { ConverterDiagnostic, ConverterWarning } from "./types.js";
import type { EntryDescriptor } from "./map-store-schema.js";

export type MapStagesResult =
  | { ok: true; stages: StageIR[]; warnings: ConverterWarning[] }
  | { ok: false; diagnostics: ConverterDiagnostic[] };

// Agent/script fields silently dropped with a per-field warning.
const IGNORED_FIELDS = [
  "effort", "max_turns", "max_budget_usd", "thinking",
  "interactive", "mcps", "claude_md",
] as const;

interface LegacyStage {
  name?: string;
  type?: string;
  parallel?: unknown;
  runtime?: {
    engine?: string;
    system_prompt?: string;
    script_id?: string;
    reads?: Record<string, string>;
    retry?: { back_to?: string; max_retries?: number; max_attempts?: number };
    compensation?: unknown;
    agents?: unknown;
    disallowed_tools?: unknown;
  };
  fanout?: unknown;
  foreach?: unknown;
  [k: string]: unknown;
}

export function mapStagesToIR(
  legacy: { stages?: LegacyStage[] },
  stageOutputs: Map<string, PortIR[]>,
  entryDirectory: Map<string, EntryDescriptor>,
  externalKeys: Set<string>,
): MapStagesResult {
  const stages: StageIR[] = [];
  const warnings: ConverterWarning[] = [];
  const diagnostics: ConverterDiagnostic[] = [];

  for (const s of legacy.stages ?? []) {
    // Foreach / fanout → unsupported.
    if (s.foreach || s.fanout) {
      diagnostics.push({
        code: "UNSUPPORTED_FEATURE",
        message: `stage '${s.name}' uses foreach/fanout, unsupported by the converter`,
        context: { stage: s.name },
      });
      continue;
    }
    if (s.type !== "agent" && s.type !== "script" && s.type !== "gate") {
      diagnostics.push({
        code: "UNSUPPORTED_FEATURE",
        message: `stage '${s.name}' has unsupported type '${s.type}'`,
        context: { stage: s.name, type: s.type },
      });
      continue;
    }
    if (s.runtime?.compensation) {
      diagnostics.push({
        code: "UNSUPPORTED_FEATURE",
        message: `stage '${s.name}' declares runtime.compensation (unsupported)`,
        context: { stage: s.name },
      });
      continue;
    }
    // Gate stage: config lifted verbatim. Shape guaranteed by upstream
    // mapHumanConfirmGates; no reads/outputs derivation needed.
    if (s.type === "gate") {
      const name = s.name!;
      const cfg = (s as unknown as { config?: unknown }).config;
      if (!cfg) {
        diagnostics.push({
          code: "LEGACY_SCHEMA_INVALID",
          message: `gate stage '${name}' is missing config (expected { question, routing })`,
          context: { stage: name },
        });
        continue;
      }
      stages.push({
        name, type: "gate", inputs: [], outputs: [],
        config: cfg as never,  // Shape guaranteed by upstream mapHumanConfirmGates.
      } as StageIR);
      continue;
    }

    const name = s.name!;
    // Emit ignored-field warnings.
    for (const field of IGNORED_FIELDS) {
      if (field in s) {
        warnings.push({
          code: "LEGACY_FIELD_IGNORED",
          message: `stage '${name}' field '${field}' ignored by kernel-next converter`,
          context: { stage: name, field },
        });
      }
    }
    if (s.runtime?.disallowed_tools) {
      warnings.push({
        code: "LEGACY_FIELD_IGNORED",
        message: `stage '${name}' runtime.disallowed_tools ignored`,
        context: { stage: name, field: "disallowed_tools" },
      });
    }

    // Slice A placeholder: runtime.retry will be extracted into
    // ScriptStage.config.retry by map-stages in Slice C. For now,
    // warn and drop.
    if (s.runtime?.retry) {
      warnings.push({
        code: "LEGACY_FIELD_IGNORED",
        message: `stage '${name}' runtime.retry ignored (Slice A placeholder; will be extracted in Slice C)`,
        context: { stage: name, field: "retry" },
      });
    }

    // Slice A placeholder: runtime.agents will be extracted into
    // AgentStage.config.subAgents by map-stages in Slice D.
    if (s.runtime?.agents) {
      warnings.push({
        code: "LEGACY_FIELD_IGNORED",
        message: `stage '${name}' runtime.agents ignored (Slice A placeholder; will be extracted in Slice D)`,
        context: { stage: name, field: "agents" },
      });
    }

    // Derive inputs from runtime.reads.
    const reads = s.runtime?.reads ?? {};
    const inputs: PortIR[] = [];
    let readsErrored = false;
    for (const sourceKey of Object.values(reads)) {
      if (entryDirectory.has(sourceKey)) {
        for (const f of entryDirectory.get(sourceKey)!.fields) {
          if (!inputs.some((p) => p.name === f.name)) inputs.push({ ...f });
        }
      } else if (externalKeys.has(sourceKey)) {
        if (!inputs.some((p) => p.name === sourceKey)) {
          inputs.push({ name: sourceKey, type: "unknown" });
        }
      } else {
        diagnostics.push({
          code: "STAGE_READS_UNKNOWN_KEY",
          message: `stage '${name}' reads '${sourceKey}' which is not a store_schema entry or injected_context key`,
          context: { stage: name, sourceKey },
        });
        readsErrored = true;
      }
    }
    if (readsErrored) continue;

    const outputs = stageOutputs.get(name) ?? [];

    if (s.type === "agent") {
      const systemPrompt = s.runtime?.system_prompt ?? "";
      stages.push({
        name,
        type: "agent",
        inputs,
        outputs,
        config: { promptRef: `system/${systemPrompt}` },
      });
    } else {
      const moduleId = s.runtime?.script_id ?? "";
      stages.push({
        name,
        type: "script",
        inputs,
        outputs,
        config: { moduleId },
      });
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, stages, warnings };
}
