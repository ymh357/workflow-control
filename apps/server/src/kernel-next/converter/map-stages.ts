// Maps legacy stages[] to kernel-next StageIR[].
// Spec: docs/superpowers/specs/2026-04-22-converter-extension-pipeline-generator-design.md §3.3.
//
// Accepts: type: "agent" | "script" | "gate".
// Parallel wrappers, human_confirm → gate transformation handled
// upstream by unwrapParallelBlocks + mapHumanConfirmGates.
// runtime.retry → ScriptStage.config.retry extraction (Slice C) with
// LEGACY_FIELD_IGNORED for malformed or incomplete specs (out-of-bounds
// max_retries, missing back_to, etc.).
// runtime.agents → AgentStage.config.subAgents
// extraction (Slice D) with SUB_AGENT_INVALID for malformed shapes.
// Still rejected: foreach, fanout, runtime.compensation, unknown
// stage types.

import type { PortIR, StageIR, SubAgentDef } from "../ir/schema.js";
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
    // mapHumanConfirmGates. Inputs are preserved from the upstream
    // mapper because a gate may carry a synthetic predecessor-signal
    // port (see map-human-confirm-gates.ts); outputs remain empty.
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
      const gateInputs = (s as unknown as { inputs?: PortIR[] }).inputs ?? [];
      stages.push({
        name, type: "gate", inputs: gateInputs, outputs: [],
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

    // Derive inputs from runtime.reads.
    // Entry-level read  (sourceKey = entry name): expand into one port per
    //                    declared field, preserving field names.
    // Dotted-field read (sourceKey = entry.field): single port whose name
    //                    is the localKey; type inherits the referenced
    //                    field's type.
    // External read:     single port named after the localKey, type unknown.
    const reads = s.runtime?.reads ?? {};
    const inputs: PortIR[] = [];
    let readsErrored = false;
    for (const [localKey, sourceKey] of Object.entries(reads)) {
      if (entryDirectory.has(sourceKey)) {
        const isDottedField = sourceKey.includes(".");
        if (isDottedField) {
          const field = entryDirectory.get(sourceKey)!.fields[0]!;
          if (!inputs.some((p) => p.name === localKey)) {
            inputs.push({ name: localKey, type: field.type });
          }
        } else {
          for (const f of entryDirectory.get(sourceKey)!.fields) {
            if (!inputs.some((p) => p.name === f.name)) inputs.push({ ...f });
          }
        }
      } else if (externalKeys.has(sourceKey)) {
        if (!inputs.some((p) => p.name === localKey)) {
          inputs.push({ name: localKey, type: "unknown" });
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
      let subAgents: SubAgentDef[] | undefined;
      if (s.runtime?.agents !== undefined) {
        const rawAgents = s.runtime.agents;
        if (typeof rawAgents !== "object" ||
            Array.isArray(rawAgents) ||
            rawAgents === null) {
          diagnostics.push({
            code: "SUB_AGENT_INVALID",
            message: `stage '${name}': runtime.agents must be an object map of name → def`,
            context: { stage: name, got: Array.isArray(rawAgents) ? "array" : typeof rawAgents },
          });
          continue;
        }
        const collected: SubAgentDef[] = [];
        let hadInvalid = false;
        for (const [saName, rawDef] of Object.entries(rawAgents as Record<string, unknown>)) {
          if (!rawDef || typeof rawDef !== "object" || Array.isArray(rawDef)) {
            diagnostics.push({
              code: "SUB_AGENT_INVALID",
              message: `stage '${name}': sub-agent '${saName}' must be an object`,
              context: { stage: name, subAgent: saName },
            });
            hadInvalid = true;
            continue;
          }
          const d = rawDef as Record<string, unknown>;
          const description = d.description;
          const prompt = d.prompt;
          if (typeof description !== "string" || description.length === 0) {
            diagnostics.push({
              code: "SUB_AGENT_INVALID",
              message: `stage '${name}': sub-agent '${saName}' missing or empty description`,
              context: { stage: name, subAgent: saName },
            });
            hadInvalid = true;
            continue;
          }
          if (typeof prompt !== "string" || prompt.length === 0) {
            diagnostics.push({
              code: "SUB_AGENT_INVALID",
              message: `stage '${name}': sub-agent '${saName}' missing or empty prompt`,
              context: { stage: name, subAgent: saName },
            });
            hadInvalid = true;
            continue;
          }
          const tools = Array.isArray(d.tools)
            ? d.tools.filter((t): t is string => typeof t === "string")
            : undefined;
          const model = d.model === "sonnet" || d.model === "opus" ||
                        d.model === "haiku" || d.model === "inherit"
            ? d.model
            : undefined;
          const maxTurns = typeof d.maxTurns === "number" &&
                           Number.isInteger(d.maxTurns) && d.maxTurns > 0
            ? d.maxTurns
            : undefined;
          collected.push({
            name: saName,
            description,
            prompt,
            ...(tools ? { tools } : {}),
            ...(model ? { model } : {}),
            ...(maxTurns !== undefined ? { maxTurns } : {}),
          });
        }
        if (hadInvalid) continue;
        if (collected.length > 0) subAgents = collected;
      }
      stages.push({
        name,
        type: "agent",
        inputs,
        outputs,
        config: {
          promptRef: `system/${systemPrompt}`,
          ...(subAgents ? { subAgents } : {}),
        },
      });
    } else {
      const moduleId = s.runtime?.script_id ?? "";
      let retry: { maxRetries: number; backToStage: string } | undefined;
      if (s.runtime?.retry) {
        const rr = s.runtime.retry;
        const rawMax = rr.max_retries ?? rr.max_attempts;
        const backTo = rr.back_to;
        if (typeof rawMax !== "number" ||
            !Number.isInteger(rawMax) ||
            rawMax < 1 ||
            rawMax > 10) {
          warnings.push({
            code: "LEGACY_FIELD_IGNORED",
            message: `stage '${name}' runtime.retry ignored: requires max_retries (1..10) or max_attempts (1..10)`,
            context: { stage: name, field: "retry" },
          });
        } else if (typeof backTo !== "string" || backTo.length === 0) {
          warnings.push({
            code: "LEGACY_FIELD_IGNORED",
            message: `stage '${name}' runtime.retry ignored: requires back_to (retry count without restart target is not supported)`,
            context: { stage: name, field: "retry" },
          });
        } else {
          retry = { maxRetries: rawMax, backToStage: backTo };
        }
      }
      stages.push({
        name,
        type: "script",
        inputs,
        outputs,
        config: {
          moduleId,
          ...(retry ? { retry } : {}),
        },
      });
    }
  }

  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, stages, warnings };
}
