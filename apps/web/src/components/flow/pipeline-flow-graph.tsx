"use client";

import { useMemo, useCallback } from "react";
import { ReactFlow, Background, MiniMap, MarkerType } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { PipelineStageEntry } from "@/lib/pipeline-types";
import type { StageCostInfo, StageNodeData } from "./types";
import { buildPipelineGraph } from "./graph-builder";
import { nodeTypes, edgeTypes } from "./node-types";

export interface PipelineFlowGraphProps {
  entries: PipelineStageEntry[];
  mode: "edit" | "runtime";
  // Edit
  selectedStageName?: string;
  onNodeClick?: (stageName: string, entryIndex: number) => void;
  // Runtime
  currentStatus?: string;
  stageCosts?: Record<string, StageCostInfo>;
  onStageClick?: (stageName: string) => void;
  // Style
  compact?: boolean;
  className?: string;
}

const defaultEdgeOptions = {
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#52525b" },
};

const PipelineFlowGraph = ({
  entries,
  mode,
  selectedStageName,
  onNodeClick,
  currentStatus,
  stageCosts,
  onStageClick,
  compact = false,
  className,
}: PipelineFlowGraphProps) => {
  const { nodes, edges } = useMemo(
    () =>
      buildPipelineGraph({
        entries,
        mode,
        currentStatus,
        stageCosts,
        selectedStageName,
        compact,
      }),
    [entries, mode, currentStatus, stageCosts, selectedStageName, compact],
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: { id: string; data: Record<string, unknown> }) => {
      const data = node.data as Partial<StageNodeData>;
      if (!data.stageName) return;
      if (mode === "edit" && onNodeClick) {
        onNodeClick(data.stageName, data.entryIndex ?? 0);
      } else if (mode === "runtime" && onStageClick) {
        if (data.status !== "pending") {
          onStageClick(data.stageName);
        }
      }
    },
    [mode, onNodeClick, onStageClick],
  );

  return (
    <div className={`${compact ? "min-h-[100px] max-h-[200px]" : "w-full h-full min-h-[300px]"} ${className ?? ""}`}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: compact ? 0.15 : 0.15, maxZoom: compact ? 1.5 : 1, minZoom: 0.3 }}
        minZoom={0.3}
        maxZoom={2}
        panOnDrag={!compact}
        zoomOnScroll={!compact}
        zoomOnPinch={!compact}
        zoomOnDoubleClick={false}
        nodesDraggable={!compact}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        className="bg-transparent"
      >
        {!compact && <Background color="#27272a" gap={20} />}
        {!compact && (
          <MiniMap
            nodeColor={(node) => {
              if (node.type === "terminal") return "#3f3f46";
              if (node.type === "condition") return "#854d0e";
              if (node.type === "gate") return "#581c87";
              if (node.type === "parallelGroup") return "#064e3b";
              return "#1e3a5f";
            }}
            maskColor="rgb(0, 0, 0, 0.7)"
            className="!bg-zinc-950 !border-zinc-800"
          />
        )}
      </ReactFlow>
    </div>
  );
};

export default PipelineFlowGraph;
