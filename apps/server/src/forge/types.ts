// Domain types for Forge. No runtime logic - purely shape definitions
// shared across modules.

export interface SessionRow {
  sessionId: string;
  cwd: string;
  jsonlPath: string;
  byteOffset: number;
  firstSeenAt: number;
  lastEventAt: number;
  status: "active" | "quiescent" | "distilled" | "distillation_failed" | "skipped";
  eventCount: number;
  skipReason: string | null;
}

export type SessionEventRole = "user" | "assistant" | "tool_use" | "tool_result" | "system";

export interface SessionEvent {
  sessionId: string;
  seq: number;
  ts: number;
  role: SessionEventRole;
  textExcerpt: string | null;
  textHash: string | null;
  textLength: number | null;
  toolName: string | null;
  toolArgsExcerpt: string | null;
}

export type EpisodeOutcome = "completed" | "abandoned" | "partial" | "exploratory";

export interface EpisodeStep {
  stageKind: "agent" | "tool" | "decision";
  description: string;
  inputs?: string[];
  outputs?: string[];
  toolCalls?: string[];
}

export interface SessionEpisode {
  episodeId: string;
  sessionId: string;
  startSeq: number;
  endSeq: number;
  intent: string;
  outcome: EpisodeOutcome;
  steps: EpisodeStep[];
  rationale: string;
  pipelineAble: boolean;
  createdAt: number;
}

export interface EpisodeSignature {
  episodeId: string;
  embedding: Float32Array;
  embeddingModel: string;
  embeddingDim: number;
  signatureKey: string;
  createdAt: number;
}

export type ClusterStatus = "forming" | "ripe" | "synthesized" | "adopted" | "dismissed";

export interface EpisodeCluster {
  clusterId: string;
  centroid: Float32Array;
  centroidModel: string;
  memberCount: number;
  distinctSessionCount: number;
  distinctDayCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  status: ClusterStatus;
  suppressedUntil: number | null;
}

export interface ClusterMember {
  clusterId: string;
  episodeId: string;
  addedAt: number;
  cosine: number;
}

export type DryRunStatus = "pending" | "passed" | "failed" | "skipped";

export interface PipelineCandidate {
  candidateId: string;
  clusterId: string;
  irJson: string;
  promptsJson: string;
  dryRunStatus: DryRunStatus;
  dryRunDiagnosticsJson: string | null;
  synthTaskId: string | null;
  generatedAt: number;
  adoptedVersionHash: string | null;
  adoptedAt: number | null;
  dismissedAt: number | null;
  dismissedReason: string | null;
}

export interface RedactionHit {
  kind: string;
  startIndex: number;
  endIndex: number;
}
