"use client";

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";

interface BranchEdgeData {
  label?: string;
  isReject?: boolean;
  isRetry?: boolean;
  isBranch?: boolean;
}

const BranchEdge = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) => {
  const edgeData = (data ?? {}) as BranchEdgeData;

  // Use bezier for back-jumps (target above source) for smoother curves
  const isBackJump = targetY < sourceY;
  const pathFn = isBackJump ? getBezierPath : getSmoothStepPath;

  const [edgePath, labelX, labelY] = pathFn({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    ...(isBackJump ? {} : { borderRadius: 12 }),
  });

  let strokeColor = "#52525b"; // zinc-600
  let strokeDasharray: string | undefined;
  let labelBg = "bg-zinc-800/90 border-zinc-700/50";
  let labelText = "text-zinc-300";

  if (edgeData.isReject) {
    strokeColor = "#ef4444";
    strokeDasharray = "6 4";
    labelBg = "bg-red-950/90 border-red-800/50";
    labelText = "text-red-300";
  } else if (edgeData.isRetry) {
    strokeColor = "#f97316";
    strokeDasharray = "6 4";
    labelBg = "bg-orange-950/90 border-orange-800/50";
    labelText = "text-orange-300";
  } else if (edgeData.isBranch) {
    strokeColor = "#ca8a04";
    labelBg = "bg-yellow-950/90 border-yellow-800/50";
    labelText = "text-yellow-200";
  }

  const label = edgeData.label;
  const truncatedLabel = label && label.length > 28 ? label.slice(0, 28) + "..." : label;

  // Position label near source (25% along path) instead of midpoint to avoid node overlap
  const t = 0.25;
  const adjustedLabelX = sourceX + (labelX - sourceX) * t * 2;
  const adjustedLabelY = sourceY + (labelY - sourceY) * t * 2;

  // For back-jumps, offset horizontally to avoid overlapping the curve
  const labelOffsetX = isBackJump ? (sourceX > targetX ? 30 : -30) : 0;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth: 1.5,
          strokeDasharray,
        }}
        markerEnd={markerEnd}
      />
      {truncatedLabel && (
        <EdgeLabelRenderer>
          <div
            className={`absolute rounded-md ${labelBg} px-2 py-0.5 text-[10px] font-medium ${labelText} border pointer-events-none whitespace-nowrap shadow-sm z-10`}
            style={{
              transform: `translate(-50%, -50%) translate(${adjustedLabelX + labelOffsetX}px,${adjustedLabelY}px)`,
            }}
          >
            {truncatedLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
};

export default BranchEdge;
