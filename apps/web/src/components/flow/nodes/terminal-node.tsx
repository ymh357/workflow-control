"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import type { TerminalNodeData } from "../types";

type TerminalNodeType = Node<TerminalNodeData, "terminal">;

const statusClasses = {
  done: "border-green-500 bg-green-950/50 text-green-300",
  current: "border-yellow-400 bg-yellow-950/50 text-yellow-300 animate-pulse",
  pending: "border-zinc-600 bg-zinc-900 text-zinc-400",
};

const TerminalNode = ({ data }: NodeProps<TerminalNodeType>) => {
  const isStart = data.label === "Start";
  const compact = data.compact;
  const status = data.status ?? "pending";
  const cls = statusClasses[status];

  return (
    <div
      className={`flex items-center justify-center rounded-full border-2 ${cls} ${
        compact ? "text-[9px] font-bold" : "text-xs font-bold"
      }`}
      style={{ width: compact ? 80 : 100, height: compact ? 28 : 36 }}
    >
      {data.label}
      {isStart ? (
        <Handle type="source" position={Position.Bottom} className="!bg-zinc-500 !w-2 !h-2 !border-0" />
      ) : (
        <Handle type="target" position={Position.Top} className="!bg-zinc-500 !w-2 !h-2 !border-0" />
      )}
    </div>
  );
};

export default TerminalNode;
