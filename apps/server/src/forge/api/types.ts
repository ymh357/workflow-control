// API DTOs for /api/forge/* endpoints.

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

export type AnalyzeResponse =
  | AnalyzeUseExisting
  | AnalyzeCreateNew
  | AnalyzeNoPattern
  | AnalyzeError;

export interface AnalyzeBase {
  sessionId: string;
  jsonlPath: string;
  cwd: string;
  episodeCount: number;
  episodes: SessionEpisode[];
  truncated: boolean;
  embeddingModel: string;
}

export interface AnalyzeUseExisting extends AnalyzeBase {
  kind: "use-existing";
  recommendation: {
    pipelineName: string;
    versionHash: string;
    cosine: number;
    why: string;
    runUrl: string;
  };
  /**
   * Top-K matches above and at the recommendation; the user can
   * still override and adopt-new, in which case Forge returns
   * `kind: "create-new"` on a follow-up call with `forceCreate: true`.
   */
  alternatives: Array<{ pipelineName: string; versionHash: string; cosine: number }>;
}

export interface AnalyzeCreateNew extends AnalyzeBase {
  kind: "create-new";
  proposal: {
    suggestedName: string;
    intent: string;
    description: string;
    /**
     * The text the user can paste verbatim to pipeline-generator
     * (or pipe via the MCP run_pipeline tool) to create a real
     * pipeline. Already abstracted — includes "the file the user
     * wants to refactor" not literal paths.
     */
    pipelineGeneratorPrompt: string;
    suggestedExternalInputs: Array<{ name: string; type: string; description: string }>;
    nearestExisting: Array<{ pipelineName: string; cosine: number }>;
    whyNotExisting: string;
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
