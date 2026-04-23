"use client";

// Pipeline DAG renderer (P7.1 / D21).
//
// Thin wrapper around @xyflow/react with a custom node component that
// color-codes by stage type, surfaces badges (fanout / MCP / sub-agent),
// and — when `stageStates` is passed — animates the currently executing
// stage while tinting done/error states. Layout is pre-computed by the
// `irToFlow` adapter (dagre) so this component is purely presentational.
//
// Props are deliberately narrow: the parent owns IR + stageStates. The
// graph is mount-once-and-memoize — we recompute nodes/edges on IR or
// state changes but reactflow's internal store handles pan/zoom on its
// own (no controlled mode needed here).

import { ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import {
  irToFlow,
  type StageNodeData,
  type PipelineIRLike,
  type StageState,
} from "../lib/ir-to-flow";

export interface PipelineGraphProps {
  ir: PipelineIRLike;
  /** Per-stage execution state; absent stages fall back to "idle". */
  stageStates?: Record<string, StageState>;
  /** Fires when the user clicks a stage node. Passed the stage name. */
  onNodeClick?: (stageName: string) => void;
  /** Graph container height in px. Defaults to 520 — enough to show a
   *  typical 5-8 stage pipeline without scrolling. */
  height?: number;
}

type StageNode = Node<StageNodeData>;

// --- Node view ---
//
// Tailwind is used for the usual reasons (co-located styles, no global
// CSS namespace pollution). Every visual state maps to a distinct
// border + background combination so color-blind users can also
// distinguish executing/done/error via the badge text below the label.
function StageNodeView({ data, selected }: NodeProps<StageNode>) {
  const state = data.state;

  const borderColor =
    state === "error" ? "border-red-500"
    : state === "executing" ? "border-blue-500 animate-pulse"
    : state === "done" ? "border-green-500"
    : data.stageType === "external" ? "border-gray-400 border-dashed"
    : "border-slate-300";

  const bg =
    state === "error" ? "bg-red-50"
    : state === "done" ? "bg-green-50"
    : data.stageType === "gate" ? "bg-amber-50"
    : data.stageType === "script" ? "bg-purple-50"
    : data.stageType === "external" ? "bg-gray-50"
    : "bg-white";

  // State badge — only rendered when a live state is present. Keeps
  // the static /pipelines/[name] view uncluttered.
  const stateBadge =
    state === "executing" ? (
      <span className="rounded bg-blue-100 px-1 text-[10px] font-semibold uppercase text-blue-800">
        running
      </span>
    )
    : state === "done" ? (
      <span className="rounded bg-green-100 px-1 text-[10px] font-semibold uppercase text-green-800">
        done
      </span>
    )
    : state === "error" ? (
      <span className="rounded bg-red-100 px-1 text-[10px] font-semibold uppercase text-red-800">
        error
      </span>
    )
    : null;

  return (
    <div
      className={`w-[220px] rounded-lg border-2 ${borderColor} ${bg} px-3 py-2 shadow-sm ${selected ? "ring-2 ring-blue-300" : ""}`}
    >
      {/* Handles: reactflow needs explicit input/output handles for edges
          to render correctly. LR layout → left handle = input, right = output. */}
      {data.stageType !== "external" && (
        <Handle type="target" position={Position.Left} className="!bg-slate-400" />
      )}
      <Handle type="source" position={Position.Right} className="!bg-slate-400" />

      <div className="flex flex-wrap items-center gap-1 overflow-hidden">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          {data.stageType}
        </span>
        {data.fanout && (
          <span className="rounded bg-orange-100 px-1 text-[10px] font-semibold text-orange-800">
            FANOUT
          </span>
        )}
        {data.mcpCount > 0 && (
          <span className="rounded bg-indigo-100 px-1 text-[10px] font-semibold text-indigo-800">
            MCP×{data.mcpCount}
          </span>
        )}
        {data.subAgentCount > 0 && (
          <span className="rounded bg-teal-100 px-1 text-[10px] font-semibold text-teal-800">
            SUB×{data.subAgentCount}
          </span>
        )}
        {stateBadge}
      </div>

      <div className="mt-1 truncate font-mono text-sm font-semibold text-slate-800">
        {data.label}
      </div>
      {data.promptRef && (
        <div
          className="mt-0.5 truncate font-mono text-[10px] text-slate-400"
          title={data.promptRef}
        >
          {data.promptRef}
        </div>
      )}
      {data.moduleId && (
        <div
          className="mt-0.5 truncate font-mono text-[10px] text-slate-400"
          title={data.moduleId}
        >
          {data.moduleId}
        </div>
      )}
    </div>
  );
}

// nodeTypes is referentially stable — reactflow warns if this object
// changes identity on every render (it forces an internal remount).
const nodeTypes = { stageNode: StageNodeView } as const;

export function PipelineGraph({
  ir,
  stageStates,
  onNodeClick,
  height = 520,
}: PipelineGraphProps) {
  const { nodes, edges } = useMemo(() => {
    const base = irToFlow(ir);
    if (!stageStates) return base;
    // Project stageStates into each node's data.state. Unknown stages
    // default to "idle" so the node render branch stays well-typed.
    return {
      ...base,
      nodes: base.nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          state: stageStates[n.id] ?? "idle",
        },
      })),
      // Animate edges whose target is currently executing. This is a
      // cheap "data is flowing in" hint — no extra SSE wiring needed.
      edges: base.edges.map((e) => ({
        ...e,
        animated: stageStates[e.target] === "executing",
      })),
    };
  }, [ir, stageStates]);

  return (
    <div
      style={{ width: "100%", height }}
      className="rounded border border-gray-200 bg-slate-50"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        onNodeClick={(_, n) => onNodeClick?.(n.id)}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#94a3b8" },
        }}
        // Interaction defaults tuned for a read-only inspection view:
        // allow pan/zoom, block node drag + edge editing so the layout
        // dagre computed is stable.
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background gap={16} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const d = n.data as StageNodeData;
            if (d.state === "error") return "#ef4444";
            if (d.state === "executing") return "#3b82f6";
            if (d.state === "done") return "#22c55e";
            if (d.stageType === "gate") return "#fef3c7";
            if (d.stageType === "script") return "#f3e8ff";
            if (d.stageType === "external") return "#f9fafb";
            return "#ffffff";
          }}
        />
      </ReactFlow>
    </div>
  );
}
