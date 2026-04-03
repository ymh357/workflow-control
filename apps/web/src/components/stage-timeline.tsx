"use client";

import type { PipelineStageEntry } from "@/lib/pipeline-types";
import type { StageCostInfo } from "@/components/flow/types";
import type { StageTokenUsage } from "@workflow-control/shared";
import PipelineFlowGraph from "@/components/flow/pipeline-flow-graph";

interface StageTimelineProps {
  currentStatus: string;
  stageCosts: Record<string, StageCostInfo>;
  stageSessionIds?: Record<string, string>;
  pipelineStages?: PipelineStageEntry[];
  onStageClick?: (stageName: string) => void;
}

const StageTimeline = ({ currentStatus, stageCosts, stageSessionIds, pipelineStages, onStageClick }: StageTimelineProps) => {
  if (!pipelineStages?.length) return null;

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/50 overflow-hidden" data-testid="stage-timeline">
      <PipelineFlowGraph
        entries={pipelineStages}
        mode="runtime"
        currentStatus={currentStatus}
        stageCosts={stageCosts}
        onStageClick={onStageClick}
        compact
      />
    </div>
  );
};

export default StageTimeline;
export type { StageCostInfo, StageTokenUsage };
