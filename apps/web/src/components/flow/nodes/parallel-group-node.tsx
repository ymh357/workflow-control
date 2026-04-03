"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import type { ParallelGroupData } from "../types";

type ParallelGroupNodeType = Node<ParallelGroupData, "parallelGroup">;

const statusBorder: Record<string, string> = {
  done: "border-green-700/50",
  current: "border-yellow-600/50",
  pending: "border-zinc-700/50",
};

const ParallelGroupNode = ({ data }: NodeProps<ParallelGroupNodeType>) => {
  const compact = data.compact;
  const border = data.status ? statusBorder[data.status] : "border-emerald-700/50";

  return (
    <div
      className={`rounded-lg border-2 border-dashed ${border} bg-emerald-950/10 w-full h-full relative`}
    >
      <div className={`${compact ? "px-1.5 py-0.5 text-[7px]" : "px-2 py-1 text-[9px]"} font-bold uppercase tracking-wider text-emerald-500/70`}>
        {data.label}
      </div>
      <Handle type="target" position={Position.Top} className="!bg-zinc-600 !w-2 !h-2 !border-0" />
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-600 !w-2 !h-2 !border-0" />
    </div>
  );
};

export default ParallelGroupNode;
