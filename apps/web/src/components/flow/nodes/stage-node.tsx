"use client";

import { Handle, Position } from "@xyflow/react";
import type { NodeProps, Node } from "@xyflow/react";
import type { StageNodeData } from "../types";

type StageNodeType = Node<StageNodeData, "stage">;

const TYPE_COLORS: Record<string, { border: string; badge: string }> = {
  agent: { border: "border-l-blue-500", badge: "text-blue-400 bg-blue-900/40" },
  script: { border: "border-l-zinc-500", badge: "text-zinc-400 bg-zinc-800" },
  pipeline: { border: "border-l-green-500", badge: "text-green-400 bg-green-900/40" },
  foreach: { border: "border-l-orange-500", badge: "text-orange-400 bg-orange-900/40" },
};

const statusBorder: Record<string, string> = {
  done: "border-green-600/60",
  current: "border-yellow-400 animate-pulse",
  pending: "border-zinc-700",
};

const TYPE_LABEL: Record<string, string> = {
  agent: "Agent",
  script: "Script",
  pipeline: "Pipeline",
  foreach: "Foreach",
};

const StageNode = ({ data }: NodeProps<StageNodeType>) => {
  const compact = data.compact;
  const colors = TYPE_COLORS[data.stageType] ?? TYPE_COLORS.script;
  const border = data.status ? statusBorder[data.status] : (data.isSelected ? "border-blue-500 ring-1 ring-blue-500/30" : "border-zinc-700");

  // Build context lines
  const contextLines: Array<{ text: string; color: string }> = [];

  if (!compact) {
    // Data flow
    if (data.reads?.length) {
      contextLines.push({ text: `reads: ${data.reads.join(", ")}`, color: "text-cyan-500/70" });
    }
    if (data.writes?.length) {
      contextLines.push({ text: `writes: ${data.writes.join(", ")}`, color: "text-emerald-500/70" });
    }

    // Foreach specifics
    if (data.stageType === "foreach") {
      const parts: string[] = [];
      if (data.items) parts.push(data.items);
      if (data.pipelineName) parts.push(`→ ${data.pipelineName}`);
      if (parts.length) contextLines.push({ text: parts.join(" "), color: "text-orange-400/70" });
      const meta: string[] = [];
      if (data.concurrency) meta.push(`x${data.concurrency}`);
      if (data.errorMode) meta.push(data.errorMode);
      if (data.collectTo) meta.push(`→ ${data.collectTo}`);
      if (meta.length) contextLines.push({ text: meta.join(" | "), color: "text-zinc-500" });
    }

    // Pipeline specifics
    if (data.stageType === "pipeline" && data.pipelineName) {
      contextLines.push({ text: `→ ${data.pipelineName}`, color: "text-green-400/70" });
    }
  }

  return (
    <div
      className={`rounded-md border-2 border-l-4 ${colors.border} ${border} bg-zinc-900 ${
        compact ? "px-2 py-1.5" : "px-3 py-2"
      }`}
      style={{ width: compact ? 120 : 200 }}
    >
      <Handle type="target" position={Position.Top} className="!bg-zinc-500 !w-2 !h-2 !border-0" />
      <div className="flex items-center gap-1.5">
        <span className={`${compact ? "text-[8px]" : "text-[9px]"} font-bold ${colors.badge} rounded px-1 py-0.5 shrink-0`}>
          {compact ? (TYPE_LABEL[data.stageType]?.[0] ?? "S") : (TYPE_LABEL[data.stageType] ?? "Script")}
        </span>
        <span className={`${compact ? "text-[9px]" : "text-[11px]"} font-semibold text-zinc-100 truncate`}>
          {data.label}
        </span>
      </div>
      {!compact && data.engine && (
        <div className={`text-[9px] mt-0.5 font-medium uppercase ${
          data.engine === "claude" ? "text-blue-400" : data.engine === "gemini" ? "text-purple-400" : data.engine === "codex" ? "text-green-400" : "text-emerald-400"
        }`}>
          {data.engine}
        </div>
      )}
      {contextLines.map((line, i) => (
        <div key={i} className={`text-[8px] mt-0.5 ${line.color} truncate leading-tight`}>
          {line.text}
        </div>
      ))}
      <Handle type="source" position={Position.Bottom} className="!bg-zinc-500 !w-2 !h-2 !border-0" />
    </div>
  );
};

export default StageNode;
