// API DTOs for /api/forge/* endpoints.
//
// IMPORTANT: a single Claude Code session typically contains MULTIPLE
// pipeline-able episodes (the user did N distinct things in one
// session). The analyze response surfaces ALL of them — one
// recommendation per pipeline-able episode — so the user sees every
// automation candidate, not just the one biggest task.

import type { SessionEpisode } from "../types.js";

export interface AnalyzeRequest {
  /**
   * Either sessionId (resolved against forge.db sessions table) OR
   * jsonlPath (absolute filesystem path) OR neither (auto-detect
   * most recent session under the configured projects root).
   */
  sessionId?: string;
  jsonlPath?: string;
}

/**
 * Per-episode recommendation. The session as a whole has 0..N of
 * these — one per pipeline-able episode the distillation agent
 * found. Episodes the agent marked `pipeline_able: false` are listed
 * separately under `skippedEpisodes` for transparency but get no
 * recommendation.
 */
export type PerEpisodeRecommendation =
  | UseExistingRec
  | CreateNewRec;

export interface UseExistingRec {
  kind: "use-existing";
  episode: SessionEpisode;
  pipelineName: string;
  versionHash: string;
  cosine: number;
  why: string;
  runUrl: string;
  alternatives: Array<{ pipelineName: string; versionHash: string; cosine: number }>;
}

export interface CreateNewRec {
  kind: "create-new";
  episode: SessionEpisode;
  proposal: {
    suggestedName: string;
    intent: string;
    // NOTE: `description` field intentionally omitted — it duplicated
    // 99% of `pipelineGeneratorPrompt` (the prompt embeds the same
    // intent + steps verbatim with a header). Callers wanting a human
    // paragraph should build it from intent + step descriptions.
    pipelineGeneratorPrompt: string;
    suggestedExternalInputs: Array<{ name: string; type: string; description: string }>;
    nearestExisting: Array<{ pipelineName: string; cosine: number }>;
    whyNotExisting: string;
  };
}

export interface SkippedEpisode {
  episode: SessionEpisode;
  reason: string;
}

export type AnalyzeResponse =
  | AnalyzeOk
  | AnalyzeNoPattern
  | AnalyzeError;

export interface AnalyzeBase {
  sessionId: string;
  jsonlPath: string;
  /**
   * Raw Claude Code project-dir name (e.g. "-Users-minghao-foo").
   * Intentionally NOT decoded — the encoding loses literal-hyphen
   * info, so any decode would silently mangle paths whose original
   * directory name contained hyphens (real example:
   * /Users/minghao/workflow-control). Callers / UIs should display
   * `cwd` as-is and (optionally) use `projectDirEncoded` to label
   * it as "encoded session project".
   */
  cwd: string;
  /** Always true. Marks `cwd` as the raw encoded form per above. */
  projectDirEncoded: true;
  episodeCount: number;
  truncated: boolean;
  embeddingModel: string;
}

export interface AnalyzeOk extends AnalyzeBase {
  kind: "ok";
  /** One per pipeline-able episode. Order: matches first, then create-new. */
  recommendations: PerEpisodeRecommendation[];
  /** Episodes the distiller said are NOT pipeline-able (one-off debug etc). */
  skippedEpisodes: SkippedEpisode[];
  /**
   * Summary counts for quick UI rendering / MCP text output.
   */
  summary: {
    useExistingCount: number;
    createNewCount: number;
    skippedCount: number;
  };
}

export interface AnalyzeNoPattern extends AnalyzeBase {
  kind: "no-pattern";
  reason: string;
}

export interface AnalyzeError {
  kind: "error";
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
