import dagre from "dagre";
import type { Node, Edge } from "@xyflow/react";

interface LayoutOptions {
  compact?: boolean;
}

// Node dimensions must match the actual rendered sizes of custom nodes
const DIMS = {
  node: { w: 200, h: 70 },
  nodeCompact: { w: 120, h: 40 },
  terminal: { w: 100, h: 36 },
  terminalCompact: { w: 80, h: 28 },
  condition: { w: 280, h: 90 },
  conditionCompact: { w: 64, h: 64 },
};

function getNodeDims(node: Node, compact: boolean) {
  if (node.type === "terminal") return compact ? DIMS.terminalCompact : DIMS.terminal;
  if (node.type === "condition" && !compact) {
    // Dynamic height based on branch count
    const branches = (node.data as Record<string, unknown>).branches as unknown[] | undefined;
    const branchCount = branches?.length ?? 0;
    const h = 50 + branchCount * 16;
    return { w: DIMS.condition.w, h: Math.max(h, DIMS.condition.h) };
  }
  if (node.type === "condition") return DIMS.conditionCompact;
  if (!compact) {
    // Dynamic height for nodes with context lines
    const data = node.data as Record<string, unknown>;
    let lines = 1; // title row
    if (data.engine) lines++;
    if ((data.writes as string[] | undefined)?.length) lines++;
    if ((data.reads as string[] | undefined)?.length) lines++;
    if (data.pipelineName) lines++;
    if (data.stageType === "foreach" && data.concurrency) lines++;
    if (data.rejectTo || data.stageType === "human_confirm") lines++;
    if (data.maxFeedbackLoops != null) lines++;
    const h = Math.max(lines * 14 + 16, DIMS.node.h);
    return { w: DIMS.node.w, h };
  }
  return DIMS.nodeCompact;
}

export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  options: LayoutOptions = {},
): { nodes: Node[]; edges: Edge[] } {
  const { compact = false } = options;
  const nodeDims = compact ? DIMS.nodeCompact : DIMS.node;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    nodesep: compact ? 40 : 80,
    ranksep: compact ? 40 : 80,
    marginx: 20,
    marginy: 20,
  });

  // Separate parent (group) nodes and child nodes
  const parentNodes = nodes.filter((n) => n.type === "parallelGroup");
  const childNodesByParent = new Map<string, Node[]>();
  const standaloneNodes: Node[] = [];

  for (const n of nodes) {
    if (n.type === "parallelGroup") continue;
    if (n.parentId) {
      const list = childNodesByParent.get(n.parentId) ?? [];
      list.push(n);
      childNodesByParent.set(n.parentId, list);
    } else {
      standaloneNodes.push(n);
    }
  }

  // Compute group dimensions based on children
  const groupDimensions = new Map<string, { width: number; height: number }>();
  const padding = compact ? 16 : 28;
  const gap = compact ? 12 : 20;
  const headerH = compact ? 18 : 28;

  for (const pn of parentNodes) {
    const children = childNodesByParent.get(pn.id) ?? [];
    const childCount = Math.max(children.length, 1);
    const w = childCount * nodeDims.w + (childCount - 1) * gap + padding * 2;
    const h = nodeDims.h + headerH + padding * 2;
    groupDimensions.set(pn.id, { width: w, height: h });
  }

  // Add standalone nodes + parent nodes to dagre
  for (const n of standaloneNodes) {
    const dims = getNodeDims(n, compact);
    g.setNode(n.id, { width: dims.w, height: dims.h });
  }
  for (const pn of parentNodes) {
    const dim = groupDimensions.get(pn.id)!;
    g.setNode(pn.id, { width: dim.width, height: dim.height });
  }

  // Add edges (only between top-level nodes, dedup for dagre)
  const topLevelIds = new Set([
    ...standaloneNodes.map((n) => n.id),
    ...parentNodes.map((n) => n.id),
  ]);
  const edgeSet = new Set<string>();

  for (const e of edges) {
    const effectiveSource = getTopLevelId(e.source, nodes, topLevelIds);
    const effectiveTarget = getTopLevelId(e.target, nodes, topLevelIds);
    if (effectiveSource && effectiveTarget) {
      const key = `${effectiveSource}|${effectiveTarget}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        g.setEdge(effectiveSource, effectiveTarget);
      }
    }
  }

  dagre.layout(g);

  // Apply positions
  const positionedNodes = nodes.map((n) => {
    if (n.parentId) {
      // Position children within their parent group
      const children = childNodesByParent.get(n.parentId) ?? [];
      const childIdx = children.indexOf(n);
      const dim = groupDimensions.get(n.parentId)!;
      const totalChildrenW = children.length * nodeDims.w + (children.length - 1) * gap;
      const startX = (dim.width - totalChildrenW) / 2;
      return {
        ...n,
        position: {
          x: startX + childIdx * (nodeDims.w + gap),
          y: headerH + padding,
        },
      };
    }

    const dagreNode = g.node(n.id);
    if (!dagreNode) return n;

    let w: number, h: number;
    if (n.type === "parallelGroup") {
      const dim = groupDimensions.get(n.id)!;
      w = dim.width;
      h = dim.height;
    } else {
      const dims = getNodeDims(n, compact);
      w = dims.w;
      h = dims.h;
    }

    const positioned = {
      ...n,
      position: {
        x: dagreNode.x - w / 2,
        y: dagreNode.y - h / 2,
      },
    };

    // For group nodes, set explicit width/height so children render inside
    if (n.type === "parallelGroup") {
      positioned.style = { ...positioned.style, width: w, height: h };
    }

    return positioned;
  });

  return { nodes: positionedNodes, edges };
}

function getTopLevelId(
  nodeId: string,
  allNodes: Node[],
  topLevelIds: Set<string>,
): string | null {
  if (topLevelIds.has(nodeId)) return nodeId;
  const node = allNodes.find((n) => n.id === nodeId);
  if (node?.parentId && topLevelIds.has(node.parentId)) return node.parentId;
  return null;
}
