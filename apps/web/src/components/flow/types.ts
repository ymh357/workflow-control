import type { StageTokenUsage } from "@workflow-control/shared";

export interface StageCostInfo {
  costUsd: number;
  durationMs: number;
  tokenUsage?: StageTokenUsage;
}

export interface StageNodeData extends Record<string, unknown> {
  label: string;
  stageType: "agent" | "script" | "condition" | "human_confirm" | "pipeline" | "foreach";
  stageName: string;
  entryIndex: number;
  // Edit mode
  isSelected?: boolean;
  // Runtime mode
  status?: "done" | "current" | "pending";
  cost?: StageCostInfo;
  // Data flow
  writes?: string[];
  reads?: string[];
  // Type-specific: condition
  branches?: Array<{ when?: string; default?: boolean; to?: string }>;
  // Type-specific: gate
  rejectTo?: string;
  maxFeedbackLoops?: number;
  // Type-specific: pipeline
  pipelineName?: string;
  // Type-specific: foreach
  items?: string;
  concurrency?: number;
  errorMode?: string;
  collectTo?: string;
  // Common
  engine?: string;
  compact?: boolean;
}

export interface TerminalNodeData extends Record<string, unknown> {
  label: "Start" | "Completed";
  status?: "done" | "current" | "pending";
  compact?: boolean;
}

export interface ParallelGroupData extends Record<string, unknown> {
  label: string;
  groupName: string;
  status?: "done" | "current" | "pending";
  compact?: boolean;
}
