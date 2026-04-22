// A4 propose_pipeline_fix — given a TaskFailureReport from
// analyzeTaskFailure, produce actionable pipeline-change suggestions.
//
// Scope boundary:
//   * This is a RULE-BASED analyzer. It does NOT call a language model.
//     The intent is to surface non-actionable failure patterns as
//     concrete, human/AI readable suggestions that a subsequent step
//     (e.g. a Claude session) can turn into a real IRPatch.
//   * Suggestions may optionally include a `proposedPatch` when the
//     rule has enough information to synthesise a deterministic IR
//     change. Most rules leave this undefined — patch construction is
//     an AI-driven step that lives in future milestones.
//   * AI-driven suggestion synthesis is a future drop-in: the
//     top-level `proposePipelineFix` function exposes a
//     `suggestionGenerator` extension point. When unset, rule-based
//     `buildFixSuggestions` runs alone. A registered generator can
//     append further suggestions.
//
// Failure kinds handled today:
//   stuck_open      — stage attempt still 'running' with a stale
//                     heartbeat. Suggest adding heartbeat watchdogs /
//                     max-turn caps; operator may need to kill the task.
//   error_status    — stage ended with status='error'. Suggest
//                     reviewing the stage prompt / inputs; optionally
//                     add retry.
//   error_in_stream — agent stream body contained an error marker.
//                     Strongly suggests prompt-quality issues. Suggest
//                     sharpening the prompt or adding invariants.
//   interrupted     — benign if expected (hot-update); not a pipeline
//                     defect. info-level.
//   superseded      — look at the later attempt for the true outcome.
//   zero_attempts   — nothing ran; upstream selector likely wrong.

import type { DatabaseSync } from "node:sqlite";
import type { PipelineIR, IRPatch } from "../ir/schema.js";
import { getPipelineIR } from "../ir/sql.js";
import type { TaskFailureReport, FailureHint } from "../../lib/debug-queries.js";
import { logger } from "../../lib/logger.js";

export type FixSuggestionKind =
  | "stuck_open"
  | "error_status"
  | "error_in_stream"
  | "interrupted"
  | "superseded"
  | "zero_attempts";

export interface FixSuggestion {
  kind: FixSuggestionKind;
  targetStage: string;
  severity: "info" | "warn" | "error";
  description: string;
  rationale: string;
  /** Optional deterministic IR patch — most rules leave this undefined. */
  proposedPatch?: IRPatch;
}

export interface ProposePipelineFixResult {
  taskId: string;
  found: boolean;
  versionHash: string | null;
  sourceReport: TaskFailureReport;
  suggestions: FixSuggestion[];
}

export interface ProposePipelineFixInput {
  db: DatabaseSync;
  taskId: string;
  /**
   * Optional: the caller already ran analyzeTaskFailure for this task.
   * Supplying it here avoids double-reading kernel-next.db.
   */
  report: TaskFailureReport;
}

/**
 * Integration wrapper: combines a supplied TaskFailureReport with the
 * pipeline IR the task ran against, then runs buildFixSuggestions to
 * produce structural fix proposals.
 *
 * Why require the caller to pass the report?
 *   analyzeTaskFailure reads from the global kernel-next.db singleton;
 *   we avoid a second implicit read by letting the MCP layer (or a
 *   test harness) inject the report it already has. The function is
 *   db-parameterised only for IR lookup + (future) version_hash
 *   resolution.
 */
export function proposePipelineFix(
  input: ProposePipelineFixInput,
): ProposePipelineFixResult {
  const { db, taskId, report } = input;
  if (!report.found) {
    return { taskId, found: false, versionHash: null, sourceReport: report, suggestions: [] };
  }

  // Resolve the version_hash of the MOST RECENT attempt for this task.
  // This is the pipeline version the task is currently running under.
  // If the pipeline was hot-updated mid-run, different attempts may
  // reference different version_hashes; the latest wins because that's
  // the IR future attempts will execute against.
  const vhRow = db.prepare(
    `SELECT version_hash FROM stage_attempts
     WHERE task_id = ?
     ORDER BY started_at DESC
     LIMIT 1`,
  ).get(taskId) as { version_hash: string } | undefined;

  if (!vhRow) {
    return {
      taskId,
      found: true,
      versionHash: null,
      sourceReport: report,
      suggestions: [],
    };
  }

  const ir = getPipelineIR(db, vhRow.version_hash);
  if (!ir) {
    return {
      taskId,
      found: true,
      versionHash: vhRow.version_hash,
      sourceReport: report,
      suggestions: [],
    };
  }

  return {
    taskId,
    found: true,
    versionHash: vhRow.version_hash,
    sourceReport: report,
    suggestions: buildFixSuggestions(report, ir),
  };
}

/**
 * Pure core: map a TaskFailureReport + the current IR to a list of
 * suggestions. The IR is needed to drop suggestions whose target stage
 * no longer exists (task ran against an older version).
 */
export function buildFixSuggestions(
  report: TaskFailureReport,
  ir: PipelineIR,
): FixSuggestion[] {
  if (!report.found) return [];
  const stageNames = new Set(ir.stages.map((s) => s.name));
  const out: FixSuggestion[] = [];
  for (const h of report.hints) {
    if (!stageNames.has(h.stageName)) continue;
    const s = hintToSuggestion(h);
    if (s) out.push(s);
  }
  return out;
}

function hintToSuggestion(h: FailureHint): FixSuggestion | null {
  switch (h.kind) {
    case "stuck_open":
      return {
        kind: "stuck_open",
        targetStage: h.stageName,
        severity: "warn",
        description:
          `Stage '${h.stageName}' has an open attempt with a stale heartbeat. ` +
          `Likely the agent is stuck or the writer died without closing the row.`,
        rationale:
          "A running attempt that stops heartbeating indicates either (a) the agent is genuinely stalled " +
          "(consider a max-turn cap, a sub-agent decomposition, or adding verify_commands that short-circuit " +
          "hangs), or (b) the writer process died after starting the row. For (b) the next attempt for this " +
          "stage will fence the stale one; the suggestion is primarily to prevent (a).",
      };
    case "error_status":
      return {
        kind: "error_status",
        targetStage: h.stageName,
        severity: "error",
        description:
          `Stage '${h.stageName}' ended with status='error'. ` +
          `Inspect the last attempt's tool calls + agent stream for root cause.`,
        rationale:
          "A stage that errors out points at one of: bad inputs from upstream, an under-specified prompt, " +
          "a missing sub-agent, or an MCP tool mismatch. If this failure repeats across retries, the stage " +
          "design itself (prompt / subAgents / invariants) likely needs revision rather than more retries.",
      };
    case "error_in_stream":
      return {
        kind: "error_in_stream",
        targetStage: h.stageName,
        severity: "warn",
        description:
          `Stage '${h.stageName}' produced error-shaped output in its agent stream. ` +
          `The textual content hints at a prompt-level issue.`,
        rationale:
          "An error-marker string in the agent's stream body (rather than in the termination_reason) often " +
          "indicates the prompt elicited an error explanation instead of the intended structured output. " +
          "Consider sharpening the prompt's output schema description or adding explicit invariants / " +
          "verify_commands to catch the bad shape.",
      };
    case "interrupted":
      return {
        kind: "interrupted",
        targetStage: h.stageName,
        severity: "info",
        description:
          `Stage '${h.stageName}' was interrupted mid-stream.`,
        rationale:
          "Interruptions are the expected mechanism for hot-updates and user cancellations. No pipeline " +
          "change is necessary unless interruptions are happening unintentionally (in which case inspect " +
          "the hot_update_events table or the task cancel path).",
      };
    case "superseded":
      return {
        kind: "superseded",
        targetStage: h.stageName,
        severity: "info",
        description:
          `Stage '${h.stageName}' has a superseded attempt — the real outcome is on a later attempt_idx.`,
        rationale:
          "Superseded attempts are artefacts of retries or hot-update supersedence; they are not pipeline " +
          "defects. The analyzer emits this hint so the investigator knows to ignore the row.",
      };
    case "zero_attempts":
      return {
        kind: "zero_attempts",
        targetStage: h.stageName || "<unknown>",
        severity: "warn",
        description:
          `No stage_attempts rows were found for the task.`,
        rationale:
          "A task that has no attempt rows either never started (scheduler bug) or had all attempts pruned. " +
          "This is usually a wiring / configuration problem upstream of the pipeline itself.",
      };
  }
}

// ---------------------------------------------------------------------------
// AI-driven patch synthesis (opt-in)
// ---------------------------------------------------------------------------

/**
 * Pluggable synthesiser. Given a suggestion + pipeline context, returns a
 * concrete IRPatch the caller might apply, or null if the synthesiser
 * couldn't produce one. Implementations are free to call a real language
 * model, use a cached table, or return null on every call.
 *
 * The integration point (proposePipelineFixWithAi) calls this once per
 * non-info suggestion in parallel. Errors are swallowed — the suggestion
 * still ships without a patch rather than failing the whole report.
 */
export interface AiPatchSynthesizer {
  synthesize(ctx: {
    suggestion: FixSuggestion;
    ir: PipelineIR;
  }): Promise<IRPatch | null>;
}

export interface ProposePipelineFixAiInput extends ProposePipelineFixInput {
  aiPatchSynthesizer: AiPatchSynthesizer;
}

/**
 * Same as proposePipelineFix, but for every non-info suggestion asks the
 * synthesiser to produce a concrete IRPatch and attaches it to
 * suggestion.proposedPatch. Safe range: only update_stage_config patches
 * are accepted (roadmap §7.2 B4 — AI-driven changes are restricted to
 * prompt / reads / writes / budget on existing stages). Any rogue patch
 * shape is rejected and the suggestion goes out without a patch.
 */
export async function proposePipelineFixWithAi(
  input: ProposePipelineFixAiInput,
): Promise<ProposePipelineFixResult> {
  const base = proposePipelineFix(input);
  if (!base.found || base.suggestions.length === 0) return base;

  const ir = base.sourceReport.found
    ? getPipelineIR(input.db, base.versionHash ?? "")
    : null;
  if (!ir) return base;

  const augmented = await Promise.all(
    base.suggestions.map(async (s) => {
      if (s.severity === "info") return s;
      try {
        const patch = await input.aiPatchSynthesizer.synthesize({
          suggestion: s, ir,
        });
        if (!patch) return s;
        if (!isSafeRangePatch(patch)) {
          logger.warn(
            { stage: s.targetStage, kind: s.kind, patch },
            "[propose_pipeline_fix] AI patch rejected — outside safe range",
          );
          return s;
        }
        return { ...s, proposedPatch: patch };
      } catch (err) {
        logger.warn(
          { stage: s.targetStage, kind: s.kind, err: (err as Error).message },
          "[propose_pipeline_fix] AI synth threw; suggestion shipped without a patch",
        );
        return s;
      }
    }),
  );

  return { ...base, suggestions: augmented };
}

// AgentStage.config keys that the AI synthesiser layer is permitted
// to mutate. Must stay in sync with claude-sdk-patch-synthesizer's
// parser allowedKeys and schema.ts AgentStageSchema.config. Adding a
// new field here without updating the parser would silently let
// unvalidated patches through.
const SAFE_CONFIG_KEYS = new Set<string>(["promptRef", "subAgents"]);

function isSafeRangePatch(patch: IRPatch): boolean {
  if (!patch || !Array.isArray(patch.ops) || patch.ops.length === 0) return false;
  for (const op of patch.ops) {
    if (op.op !== "update_stage_config") return false;
    const cp = (op as { configPatch?: unknown }).configPatch;
    if (!cp || typeof cp !== "object") return false;
    for (const k of Object.keys(cp as Record<string, unknown>)) {
      if (!SAFE_CONFIG_KEYS.has(k)) return false;
    }
  }
  return true;
}
