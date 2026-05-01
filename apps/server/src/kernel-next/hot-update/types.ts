// Shared types for kernel-next/hot-update/ — Stage 5A.
// Pure type definitions; no runtime code.

import type {
  PipelineIR, StageIR, WireIR, PortIR, GateRouting,
} from "../ir/schema.js";

export interface PortTypeChange {
  port: string;
  beforeType: string;
  afterType: string;
}

export interface StageDiffChanges {
  promptRef?:     { before: string; after: string };
  moduleId?:      { before: string; after: string };
  // D'-3: script stages may switch between registry-backed and
  // inline-source variants; a variant change is surfaced separately
  // from moduleId / moduleSource content changes.
  scriptSource?:  { before: "registry" | "inline"; after: "registry" | "inline" };
  moduleSource?:  { before: string; after: string };
  question?:      { before: unknown; after: unknown };
  inputs?:        { added: PortIR[]; removed: PortIR[]; typeChanged: PortTypeChange[] };
  outputs?:       { added: PortIR[]; removed: PortIR[]; typeChanged: PortTypeChange[] };
}

export interface StageDiff {
  stageName: string;
  type: "agent" | "script" | "gate";
  changes: StageDiffChanges;
  category: "promptOnly" | "portsOnly" | "budgetOnly" | "structural";
}

export interface PipelineDiff {
  stages: {
    added:    StageIR[];
    removed:  { name: string; stage: StageIR }[];
    modified: StageDiff[];
  };
  wires: {
    added:   WireIR[];
    removed: WireIR[];
  };
  routing: {
    gateRoutingChanged: {
      stageName: string;
      before: GateRouting;
      after:  GateRouting;
    }[];
  };
  categoryUnion: Array<"promptOnly" | "portsOnly" | "budgetOnly" | "structural">;
}

export interface TaskImpact {
  taskId: string;
  currentStage: string | null;
  affectedStages: string[];
  resumable: boolean;
  blockingReasons: string[];
}

export interface SchemaDriftIssue {
  kind:
    | "port_type_change_with_live_values"
    | "removed_stage_with_downstream_readers"
    | "removed_output_with_active_consumers";
  stageName: string;
  portName?: string;
  details: string;
}

export interface Impact {
  activeTasks: TaskImpact[];
  newSubmissionsOk: boolean;
  schemaDriftIssues: SchemaDriftIssue[];
}

export interface SafeRangeVerdict {
  verdict: "safe" | "unsafe";
  category: "promptOnly" | "portsOnly" | "budgetOnly" | "structural" | "empty";
  reasons: string[];
}

export interface DryRunInput {
  currentVersion: string;
  patch: import("../ir/schema.js").IRPatch;
  rerunFrom?: string | null;
  migrateRunningTasks?: "all" | "none" | string[];
  // Bug 39 (c12+ review): when the proposal includes prompts, the
  // dry-run must hash IR + prompts via pipelineVersionHash so the
  // returned proposedVersion matches what the real propose() would
  // persist. Pre-fix dry-run always returned versionHash(ir) which
  // diverged from propose() for any prompt-laden proposal — callers
  // comparing the two saw a phantom version mismatch.
  prompts?: Record<string, string>;
}

export type DryRunResult =
  | {
      ok: true;
      diff: PipelineDiff;
      impact: Impact;
      safeRange: SafeRangeVerdict;
      wouldAutoApprove: boolean;
      proposedVersion: string;
    }
  | {
      ok: false;
      diagnostics: import("../ir/schema.js").Diagnostic[];
    };
