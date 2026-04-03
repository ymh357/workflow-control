"use client";

import { forwardRef } from "react";
import PipelineFlowGraph from "@/components/flow/pipeline-flow-graph";
import type { PipelineFlowGraphHandle } from "@/components/flow/pipeline-flow-graph";
import type { PipelineStageEntry } from "@/lib/pipeline-types";

export type { PipelineFlowGraphHandle };

interface PipelineVisualizerProps {
  pipeline: {
    name: string;
    stages: PipelineStageEntry[];
  };
  selectedStageName?: string;
  onNodeClick?: (stageName: string, entryIndex: number) => void;
}

const PipelineVisualizer = forwardRef<PipelineFlowGraphHandle, PipelineVisualizerProps>(
  ({ pipeline, selectedStageName, onNodeClick }, ref) => {
    return (
      <PipelineFlowGraph
        ref={ref}
        entries={pipeline.stages}
        mode="edit"
        selectedStageName={selectedStageName}
        onNodeClick={onNodeClick}
        className="w-full h-full"
      />
    );
  },
);

PipelineVisualizer.displayName = "PipelineVisualizer";

export default PipelineVisualizer;
