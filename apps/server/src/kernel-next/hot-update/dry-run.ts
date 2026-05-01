// Orchestrator — combines diff + impact + safeRange for the
// dry_run_proposal MCP tool. Writes NOTHING to the DB. Stage 5A
// design §2.1.
//
// Flow:
//   1. Load base IR from pipeline_versions (CONFLICT if missing).
//   2. Apply the patch (PATCH_APPLY_ERROR branch for invalid ops).
//   3. Run structural + DAG + store_schema validators. Type-level (tsc)
//      validation is intentionally skipped here — it spawns a subprocess
//      (~3-5s) and the actual propose path re-runs full validation at
//      commit time.
//   4. Compute diff, impact, safeRange; derive wouldAutoApprove.
//   5. Compute proposedVersion as the IR-only versionHash (matches
//      KernelService.propose — both kernel.ts §388 and this path persist
//      proposed IRs under the same hash scheme so the dry-run answer is
//      comparable with the real proposal).

import type { DatabaseSync } from "node:sqlite";
import type { Diagnostic, PipelineIR } from "../ir/schema.js";
import { applyPatch, PatchApplyError } from "../mcp/patch.js";
import { validateStructural } from "../validator/structural.js";
import { validateDag } from "../validator/dag.js";
import { validateStoreSchema } from "../validator/store-schema.js";
import { versionHash, pipelineVersionHash } from "../ir/canonical.js";
import { computePipelineDiff } from "./diff.js";
import { computeImpact } from "./impact.js";
import { classifySafeRange } from "./safe-range.js";
import type { DryRunInput, DryRunResult } from "./types.js";

export function dryRunProposal(
  db: DatabaseSync,
  input: DryRunInput,
): DryRunResult {
  // 1. Optimistic-lock check against pipeline_versions.
  const baseRow = db.prepare(
    `SELECT ir_json FROM pipeline_versions WHERE version_hash = ?`,
  ).get(input.currentVersion) as { ir_json: string } | undefined;
  if (!baseRow) {
    return {
      ok: false,
      diagnostics: [{
        code: "CONFLICT",
        message:
          `currentVersion '${input.currentVersion}' not found in pipeline_versions — base drifted`,
        context: { currentVersion: input.currentVersion },
      }],
    };
  }
  const baseIR = JSON.parse(baseRow.ir_json) as PipelineIR;

  // 2. Apply the patch. Surface PatchApplyError as a structured diagnostic.
  let proposedIR: PipelineIR;
  try {
    proposedIR = applyPatch(baseIR, input.patch);
  } catch (err) {
    if (err instanceof PatchApplyError) {
      return {
        ok: false,
        diagnostics: [{
          code: "PATCH_APPLY_ERROR",
          message: err.message,
          context: { op: err.op as unknown as Record<string, unknown> },
        }],
      };
    }
    throw err;
  }

  // 3. Validate (structural + DAG + store_schema; type-check skipped — see
  //    file header: dry-run is IR-only, doesn't emit TS).
  const diagnostics: Diagnostic[] = [];
  const structural = validateStructural(proposedIR);
  if (!structural.ok) diagnostics.push(...structural.diagnostics);
  const dag = validateDag(proposedIR);
  if (!dag.ok) diagnostics.push(...dag.diagnostics);
  const storeSchemaResult = validateStoreSchema(proposedIR);
  if (!storeSchemaResult.ok) diagnostics.push(...storeSchemaResult.diagnostics);
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  // 4. Diff + impact + safeRange. All three modules are read-only.
  const diff = computePipelineDiff(baseIR, proposedIR);
  const impact = computeImpact(
    db,
    input.currentVersion,
    proposedIR,
    input.rerunFrom,
  );
  const safeRange = classifySafeRange(diff, impact);
  const wouldAutoApprove = safeRange.verdict === "safe";

  // 5. Bug 39 (c12+ review): when the caller supplies prompts, hash
  //    IR+prompts so the dry-run answer matches what real propose()
  //    would persist. Without prompts, fall back to the IR-only hash —
  //    matches the legacy behaviour for prompt-less proposals and
  //    keeps existing fixtures stable.
  const proposedVersion =
    input.prompts !== undefined && Object.keys(input.prompts).length > 0
      ? pipelineVersionHash({ ir: proposedIR, prompts: input.prompts })
      : versionHash(proposedIR);

  return {
    ok: true,
    diff,
    impact,
    safeRange,
    wouldAutoApprove,
    proposedVersion,
  };
}
