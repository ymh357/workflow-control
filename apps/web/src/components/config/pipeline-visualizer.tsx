"use client";

import PipelineFlowGraph from "@/components/flow/pipeline-flow-graph";
import type { PipelineStageEntry } from "@/lib/pipeline-types";

interface PipelineVisualizerProps {
  pipeline: {
    name: string;
    stages: PipelineStageEntry[];
  };
  selectedStageName?: string;
  onNodeClick?: (stageName: string, entryIndex: number) => void;
}

const PipelineVisualizer = ({ pipeline, selectedStageName, onNodeClick }: PipelineVisualizerProps) => {
  return (
    <PipelineFlowGraph
      entries={pipeline.stages}
      mode="edit"
      selectedStageName={selectedStageName}
      onNodeClick={onNodeClick}
      className="w-full h-full"
    />
  );
};

export default PipelineVisualizer;
