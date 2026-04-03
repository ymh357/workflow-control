"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import type { StageNodeData } from "../types";

type ConditionNodeType = Node<StageNodeData, "condition">;

const statusColors: Record<string, { stroke: string; fill: string }> = {
  done: { stroke: "#16a34a", fill: "rgba(20,83,45,0.4)" },
  current: { stroke: "#facc15", fill: "rgba(113,63,18,0.4)" },
  pending: { stroke: "#3f3f46", fill: "rgba(39,39,42,0.4)" },
};

const ConditionNode = ({ data }: NodeProps<ConditionNodeType>) => {
  const compact = data.compact;

  const colors = data.status
    ? statusColors[data.status]
    : data.isSelected
      ? { stroke: "#3b82f6", fill: "rgba(30,58,138,0.3)" }
      : { stroke: "#854d0e", fill: "rgba(113,63,18,0.25)" };

  if (compact) {
    const size = 64;
    const half = size / 2;
    const inset = 2;
    return (
      <div className="relative" style={{ width: size, height: size }}>
        <svg className="absolute inset-0" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <polygon
            points={`${half},${inset} ${size - inset},${half} ${half},${size - inset} ${inset},${half}`}
            fill={colors.fill} stroke={colors.stroke} strokeWidth="2"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
          <span className="text-[9px] font-bold text-yellow-400">C</span>
          <span className="text-[8px] max-w-[36px] text-yellow-200/80 truncate text-center leading-tight font-medium">{data.label}</span>
        </div>
        <Handle type="target" position={Position.Top} className="!bg-yellow-600 !w-2 !h-2 !border-0" style={{ top: 0 }} />
        <Handle type="source" position={Position.Bottom} className="!bg-yellow-600 !w-2 !h-2 !border-0" style={{ bottom: 0 }} />
        <Handle type="source" position={Position.Left} id="left" className="!bg-yellow-600 !w-2 !h-2 !border-0" style={{ left: 0 }} />
        <Handle type="source" position={Position.Right} id="right" className="!bg-yellow-600 !w-2 !h-2 !border-0" style={{ right: 0 }} />
      </div>
    );
  }

  // Full mode: rectangle with branch list
  const branches = data.branches ?? [];
  const borderCls = data.status
    ? (statusColors[data.status] ? `border-[${statusColors[data.status].stroke}]` : "border-zinc-700")
    : data.isSelected ? "border-blue-500 ring-1 ring-blue-500/30" : "border-yellow-700/60";

  return (
    <div
      className={`rounded-md border-2 border-l-4 border-l-yellow-500 ${borderCls} bg-yellow-950/20 px-3 py-2`}
      style={{
        width: 280,
        borderColor: colors.stroke,
      }}
    >
      <Handle type="target" position={Position.Top} className="!bg-yellow-600 !w-2 !h-2 !border-0" />
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-bold text-yellow-400 bg-yellow-900/40 rounded px-1 py-0.5 shrink-0">Condition</span>
        <span className="text-[11px] font-semibold text-zinc-100 truncate">{data.label}</span>
      </div>
      {branches.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {branches.map((b, i) => {
            const label = b.default ? "default" : (b.when ?? "?");
            return (
              <div key={i} className="flex items-center gap-1 text-[8px] leading-tight">
                <span className="text-yellow-500 shrink-0">&rarr;</span>
                <span className="text-yellow-300/60 min-w-0 break-all">{label}</span>
                <span className="text-zinc-600 shrink-0">&rarr;</span>
                <span className="text-zinc-300 font-medium shrink-0">{b.to ?? "next"}</span>
              </div>
            );
          })}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-yellow-600 !w-2 !h-2 !border-0" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-yellow-600 !w-2 !h-2 !border-0" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-yellow-600 !w-2 !h-2 !border-0" />
    </div>
  );
};

export default ConditionNode;
