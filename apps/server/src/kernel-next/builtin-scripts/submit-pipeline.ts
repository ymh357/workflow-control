// submit_pipeline_passthrough — deterministic builtin script that submits
// an in-memory IR + prompts dict to the kernel via KernelService.submit.
//
// Created in continuation 8 (2026-04-29) to replace the LLM-driven
// persisting stage in pipeline-generator. The agent-form persisting was
// unreliable (observed in 0G dogfood: agent stripped sampleInputs from
// inline scripts on the second submit attempt, blocking the entire
// pipeline). Replacing it with a deterministic script removes the LLM
// from the verbatim-transport role entirely.
//
// Why this isn't a "regular" builtin script in builtin-scripts/index.ts:
//   - ScriptModuleContext intentionally does NOT expose `db` to scripts
//     (security boundary; inline scripts authored by AI must not get
//     direct DB access). KernelService.submit needs the live SQLite
//     handle. The factory pattern here injects db via closure rather
//     than via ctx — only the kernel itself can construct the resolver.
//   - This module is composed into the resolver's modules dict at
//     start-pipeline-run.ts, alongside BUILTIN_SCRIPT_MODULES.

import type { DatabaseSync } from "node:sqlite";
import type { ScriptModule } from "../runtime/script-module-resolver.js";
import { KernelService } from "../mcp/kernel.js";

export interface SubmitPipelinePassthroughInputs {
  ir: unknown;                              // PipelineIR JSON object
  prompts?: Record<string, string>;         // optional, defaults to {}
  subIrs?: unknown[];                       // optional sub-pipeline IRs
  subPrompts?: Array<Record<string, string>>; // optional sub prompts (index-aligned)
}

export interface SubmitPipelinePassthroughOutputs {
  versionHash: string;                      // canonical content hash for main pipeline
  subVersionHashes: string[];               // sub-pipeline versionHashes (index order)
  pipelineId: string;                       // kebab-case slug from ir.name
  pipelineName: string;                     // ir.name as submitted
}

/**
 * Build the submit_pipeline_passthrough script module bound to a specific
 * kernel-next DB handle. Called from start-pipeline-run.ts when assembling
 * the script-module resolver for a task. Each task gets its own bound
 * instance so the script never escapes the per-task DB scope.
 */
export function buildSubmitPipelinePassthrough(db: DatabaseSync): ScriptModule {
  return {
    async run(inputs) {
      const ir = inputs.ir;
      if (ir === undefined || ir === null || typeof ir !== "object") {
        throw new Error(
          `submit_pipeline_passthrough: input 'ir' is required and must be an object (got ${typeof ir})`,
        );
      }
      const promptsRaw = inputs.prompts;
      let prompts: Record<string, string> | undefined;
      if (promptsRaw === undefined || promptsRaw === null) {
        prompts = {};
      } else if (typeof promptsRaw === "object" && !Array.isArray(promptsRaw)) {
        prompts = promptsRaw as Record<string, string>;
      } else {
        throw new Error(
          `submit_pipeline_passthrough: input 'prompts' must be an object when set (got ${typeof promptsRaw})`,
        );
      }

      const svc = new KernelService(db);

      // Sub-pipelines first (if any) — main IR may reference them by
      // name, and the kernel resolves names against pipeline_versions
      // at run time, so they need to exist before main submit.
      const subIrsRaw = inputs.subIrs;
      const subIrs: unknown[] = Array.isArray(subIrsRaw) ? subIrsRaw : [];
      const subPromptsRaw = inputs.subPrompts;
      const subPrompts: Array<Record<string, string>> = Array.isArray(subPromptsRaw)
        ? (subPromptsRaw as Array<Record<string, string>>)
        : [];
      const subVersionHashes: string[] = [];
      for (let i = 0; i < subIrs.length; i++) {
        const subIr = subIrs[i];
        const subPrompt = subPrompts[i] ?? {};
        const subRes = await svc.submit(subIr, { prompts: subPrompt });
        if (!subRes.ok) {
          const summary = subRes.diagnostics
            .map((d) => `${d.code}${d.message ? ": " + d.message : ""}`)
            .join("; ");
          throw new Error(`submit_pipeline failed for sub-pipeline[${i}]: ${summary}`);
        }
        subVersionHashes.push(subRes.versionHash);
      }

      const result = await svc.submit(ir, { prompts });
      if (!result.ok) {
        // Surface the validator's diagnostic codes verbatim so the
        // caller (or downstream consumer) can decide whether to retry,
        // edit the IR, or fail. We do NOT swallow into a generic
        // "submit failed" — the diagnostic stack is the whole point.
        const summary = result.diagnostics
          .map((d) => `${d.code}${d.message ? ": " + d.message : ""}`)
          .join("; ");
        throw new Error(`submit_pipeline failed: ${summary}`);
      }

      const irRecord = ir as { name?: unknown };
      const irName = typeof irRecord.name === "string" ? irRecord.name : "";
      const pipelineName = irName || "unnamed-pipeline";
      const pipelineId = pipelineName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        || "unnamed-pipeline";

      return {
        versionHash: result.versionHash,
        subVersionHashes,
        pipelineId,
        pipelineName,
      };
    },
  };
}
