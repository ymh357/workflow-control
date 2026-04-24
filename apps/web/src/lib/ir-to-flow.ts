// Pure adapter — converts a PipelineIR into reactflow Node[] + Edge[]
// with dagre-computed positions. No React, no DOM: keeping this module
// pure lets us unit-test layout + shape without a jsdom mount.
//
// Local IR types are duplicated from the server's Zod-inferred schema.
// The web app cannot reach into `apps/server/src/kernel-next/ir/schema`
// across the workspace boundary (the server is a Node-only package),
// so we declare a minimal structural subset here — only the fields the
// graph renderer actually reads. Extra fields on the incoming IR are
// ignored; the adapter does not validate them.

import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

// --- IR shape (structural subset) ---

export interface IRPort {
  name: string;
  type: string;
  description?: string;
}

export interface IRWireFromStage {
  source: "stage";
  stage: string;
  port: string;
}
export interface IRWireFromExternal {
  source: "external";
  port: string;
}
export interface IRWire {
  from: IRWireFromStage | IRWireFromExternal;
  to: { stage: string; port: string };
  guard?: string;
}

export interface IRMcpServerDecl {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  envKeys: string[];
}

export interface IRSubAgentDef {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
  maxTurns?: number;
}

export interface IRFanoutSpec {
  input: string;
  concurrency?: number;
}

export interface IRAgentStage {
  name: string;
  type: "agent";
  inputs: IRPort[];
  outputs: IRPort[];
  config: {
    promptRef: string;
    subAgents?: IRSubAgentDef[];
    mcpServers?: IRMcpServerDecl[];
  };
  fanout?: IRFanoutSpec;
}

export interface IRScriptStage {
  name: string;
  type: "script";
  inputs: IRPort[];
  outputs: IRPort[];
  config: {
    moduleId: string;
    retry?: unknown;
  };
  fanout?: IRFanoutSpec;
}

export interface IRGateStage {
  name: string;
  type: "gate";
  inputs: IRPort[];
  outputs: IRPort[];
  config: {
    question: unknown;
    routing: unknown;
    timeout_minutes?: number;
  };
}

export type IRStage = IRAgentStage | IRScriptStage | IRGateStage;

export interface PipelineIRLike {
  name: string;
  stages: IRStage[];
  wires: IRWire[];
  externalInputs: IRPort[];
}

// --- Rendering-facing types ---

export type StageState = "idle" | "executing" | "done" | "error";

export interface StageNodeData extends Record<string, unknown> {
  label: string;
  stageType: "agent" | "script" | "gate" | "external";
  fanout: boolean;
  subAgentCount: number;
  mcpCount: number;
  promptRef?: string;
  moduleId?: string;
  state?: StageState;
  // Port metadata for hover / expand disclosure. Kept minimal so nodes
  // stay glanceable; the detail panel pulls descriptions from here.
  inputs?: IRPort[];
  outputs?: IRPort[];
}

// Layout constants. NODE_W/NODE_H are dagre layout hints and must match
// the rendered node size in pipeline-graph.tsx (w-[220px], ~130px tall
// now that port names are listed in-node). Keeping them here avoids
// drift that would show mis-overlapped nodes.
const NODE_W = 220;
const NODE_H = 130;

// --- Stage → Node conversion ---

function stageToNode(stage: IRStage): Node<StageNodeData> {
  // Defensive: stage.config may be absent on partially-loaded IRs or
  // legacy stage rows that slipped in via external seed paths. Access
  // through a typed local so a missing config never blows up the node
  // render.
  const cfg = (stage as { config?: unknown }).config as
    | Record<string, unknown>
    | undefined;
  const inputs = Array.isArray(stage.inputs) ? stage.inputs : [];
  const outputs = Array.isArray(stage.outputs) ? stage.outputs : [];
  if (stage.type === "agent") {
    const subAgents = cfg?.subAgents as unknown[] | undefined;
    const mcpServers = cfg?.mcpServers as unknown[] | undefined;
    return {
      id: stage.name,
      type: "stageNode",
      position: { x: 0, y: 0 },
      data: {
        label: stage.name,
        stageType: "agent",
        fanout: stage.fanout !== undefined,
        subAgentCount: Array.isArray(subAgents) ? subAgents.length : 0,
        mcpCount: Array.isArray(mcpServers) ? mcpServers.length : 0,
        promptRef: typeof cfg?.promptRef === "string" ? cfg.promptRef : undefined,
        inputs,
        outputs,
      },
    };
  }
  if (stage.type === "gate") {
    return {
      id: stage.name,
      type: "stageNode",
      position: { x: 0, y: 0 },
      data: {
        label: stage.name,
        stageType: "gate",
        fanout: false,
        subAgentCount: 0,
        mcpCount: 0,
        inputs,
        outputs,
      },
    };
  }
  // script
  return {
    id: stage.name,
    type: "stageNode",
    position: { x: 0, y: 0 },
    data: {
      label: stage.name,
      stageType: "script",
      fanout: stage.fanout !== undefined,
      subAgentCount: 0,
      mcpCount: 0,
      moduleId: typeof cfg?.moduleId === "string" ? cfg.moduleId : undefined,
      inputs,
      outputs,
    },
  };
}

// --- Public API ---

export function irToFlow(
  ir: PipelineIRLike,
): { nodes: Node<StageNodeData>[]; edges: Edge[] } {
  const nodes: Node<StageNodeData>[] = (ir.stages ?? []).map(stageToNode);
  const edges: Edge[] = [];
  let hasExternalSource = false;

  const wires = ir.wires ?? [];
  for (let i = 0; i < wires.length; i++) {
    const w = wires[i]!;
    const sourceId = w.from.source === "external" ? "__external__" : w.from.stage;
    if (w.from.source === "external") hasExternalSource = true;
    const label =
      w.from.source === "external"
        ? w.from.port
        : `${w.from.port} → ${w.to.port}`;
    edges.push({
      id: `e${i}`,
      source: sourceId,
      target: w.to.stage,
      label,
      data: { guard: w.guard },
      animated: false,
    });
  }

  if (hasExternalSource) {
    // Insert the synthetic `__external__` node at the front so dagre
    // ranks it leftmost. It represents the seed inputs the runner
    // writes before any real stage executes (mirrors the EXTERNAL_STAGE
    // sentinel in the task page).
    nodes.unshift({
      id: "__external__",
      type: "stageNode",
      position: { x: 0, y: 0 },
      data: {
        label: "external inputs",
        stageType: "external",
        fanout: false,
        subAgentCount: 0,
        mcpCount: 0,
      },
    });
  }

  return layoutDagre(nodes, edges);
}

function layoutDagre(
  nodes: Node<StageNodeData>[],
  edges: Edge[],
): { nodes: Node<StageNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  // LR (left-to-right) matches the mental model of "inputs flow into
  // outputs". nodesep / ranksep values are tuned for the typical
  // 3-10 stage pipelines kernel-next produces; larger pipelines may
  // want to fitView rather than read absolute positions.
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 80 });

  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  return {
    nodes: nodes.map((n) => {
      const pos = g.node(n.id);
      // dagre returns the *center* of each node; reactflow expects the
      // top-left corner, so shift by half the node dimensions.
      return {
        ...n,
        position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      };
    }),
    edges,
  };
}
