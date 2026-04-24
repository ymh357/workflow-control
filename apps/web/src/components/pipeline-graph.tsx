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
    state === "error" ? "border-red-500/70"
    : state === "executing" ? "border-blue-500 animate-pulse"
    : state === "done" ? "border-emerald-500/70"
    : data.stageType === "external" ? "border-zinc-600 border-dashed"
    : data.stageType === "gate" ? "border-amber-500/50"
    : data.stageType === "script" ? "border-purple-500/50"
    : "border-zinc-600";

  // State-driven bg takes priority over stage-type bg so the pulsing
  // blue border has a coherent background during live execution (gate
  // amber + pulsing blue border was visually dissonant).
  const bg =
    state === "error" ? "bg-red-950/50"
    : state === "executing" ? "bg-blue-950/50"
    : state === "done" ? "bg-emerald-950/40"
    : data.stageType === "gate" ? "bg-amber-950/30"
    : data.stageType === "script" ? "bg-purple-950/30"
    : data.stageType === "external" ? "bg-zinc-900/50"
    : "bg-zinc-900";

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
        <Handle type="target" position={Position.Left} className="!bg-zinc-500" />
      )}
      <Handle type="source" position={Position.Right} className="!bg-zinc-500" />

      <div className="flex flex-wrap items-center gap-1 overflow-hidden">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
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

      <div className="mt-1 truncate font-mono text-sm font-semibold text-zinc-100">
        {data.label}
      </div>
      {data.promptRef && (
        <div
          className="mt-0.5 truncate font-mono text-[10px] text-zinc-500"
          title={data.promptRef}
        >
          {data.promptRef}
        </div>
      )}
      {data.moduleId && (
        <div
          className="mt-0.5 truncate font-mono text-[10px] text-zinc-500"
          title={data.moduleId}
        >
          {data.moduleId}
        </div>
      )}
      {((data.inputs && data.inputs.length > 0) ||
        (data.outputs && data.outputs.length > 0)) && (
        <div className="mt-1 space-y-0.5 text-[9px] leading-tight">
          {data.inputs && data.inputs.length > 0 && (
            <div>
              <span className="font-semibold uppercase tracking-wide text-zinc-500">in: </span>
              <span className="text-zinc-300">
                {data.inputs.map((p, i) => (
                  <span
                    key={p.name}
                    className="whitespace-nowrap"
                    title={p.description ? `${p.name}: ${p.type}\n\n${p.description}` : `${p.name}: ${p.type}`}
                  >
                    {i > 0 && <span className="text-zinc-600">, </span>}
                    <span className={p.description ? "underline decoration-dotted" : ""}>
                      {p.name}
                    </span>
                  </span>
                ))}
              </span>
            </div>
          )}
          {data.outputs && data.outputs.length > 0 && (
            <div>
              <span className="font-semibold uppercase tracking-wide text-zinc-500">out: </span>
              <span className="text-zinc-300">
                {data.outputs.map((p, i) => (
                  <span
                    key={p.name}
                    className="whitespace-nowrap"
                    title={p.description ? `${p.name}: ${p.type}\n\n${p.description}` : `${p.name}: ${p.type}`}
                  >
                    {i > 0 && <span className="text-zinc-600">, </span>}
                    <span className={p.description ? "underline decoration-dotted" : ""}>
                      {p.name}
                    </span>
                  </span>
                ))}
              </span>
            </div>
          )}
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
      role="img"
      aria-label={`Pipeline DAG: ${ir.name} (${ir.stages.length} stages)`}
      style={{ width: "100%", height }}
      className="bg-zinc-950"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        colorMode="dark"
        onNodeClick={(_, n) => onNodeClick?.(n.id)}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#71717a" },
          style: { stroke: "#52525b" },
        }}
        // Interaction defaults tuned for a read-only inspection view:
        // allow pan/zoom, block node drag + edge editing so the layout
        // dagre computed is stable.
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background gap={16} size={1} color="#27272a" />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          bgColor="#0a0a0a"
          maskColor="rgba(0,0,0,0.6)"
          nodeStrokeColor="#52525b"
          nodeColor={(n) => {
            const d = n.data as StageNodeData;
            if (d.state === "error") return "#7f1d1d";
            if (d.state === "executing") return "#1e3a8a";
            if (d.state === "done") return "#14532d";
            if (d.stageType === "gate") return "#451a03";
            if (d.stageType === "script") return "#3b0764";
            if (d.stageType === "external") return "#27272a";
            return "#18181b";
          }}
        />
      </ReactFlow>
    </div>
  );
}
