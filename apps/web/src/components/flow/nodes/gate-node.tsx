"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import type { StageNodeData } from "../types";

type GateNodeType = Node<StageNodeData, "gate">;

const statusBorder: Record<string, string> = {
  done: "border-green-600/60",
  current: "border-yellow-400 animate-pulse",
  pending: "border-zinc-700",
};

const GateNode = ({ data }: NodeProps<GateNodeType>) => {
  const compact = data.compact;
  const border = data.status ? statusBorder[data.status] : (data.isSelected ? "border-blue-500 ring-1 ring-blue-500/30" : "border-purple-700/60");

  return (
    <div
      className={`rounded-md border-2 border-l-4 border-l-purple-500 ${border} bg-purple-950/20 ${
        compact ? "px-2 py-1.5" : "px-3 py-2"
      }`}
      style={{ width: compact ? 120 : 200 }}
    >
      <Handle type="target" position={Position.Top} className="!bg-zinc-500 !w-2 !h-2 !border-0" />
      <div className="flex items-center gap-1.5">
        <span className={`${compact ? "text-[8px]" : "text-[9px]"} font-bold text-purple-400 bg-purple-900/40 rounded px-1 py-0.5 shrink-0`}>
          {compact ? "H" : "Gate"}
        </span>
        <span className={`${compact ? "text-[9px]" : "text-[11px]"} font-semibold text-zinc-100 truncate`}>
          {data.label}
        </span>
        <svg className={`${compact ? "w-2.5 h-2.5" : "w-3.5 h-3.5"} text-purple-400 shrink-0 ml-auto`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
      {!compact && (
        <div className="mt-1 space-y-0.5">
          {data.rejectTo && (
            <div className="flex items-center gap-1 text-[8px] leading-tight">
              <span className="text-red-400 shrink-0">reject &rarr;</span>
              <span className="text-zinc-300 font-medium">{data.rejectTo}</span>
            </div>
          )}
          {!data.rejectTo && (
            <div className="text-[8px] text-zinc-500 leading-tight">reject &rarr; error</div>
          )}
          {data.maxFeedbackLoops != null && (
            <div className="text-[8px] text-zinc-500 leading-tight">
              max {data.maxFeedbackLoops} loops
            </div>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-500 !w-2 !h-2 !border-0" />
    </div>
  );
};

export default GateNode;
