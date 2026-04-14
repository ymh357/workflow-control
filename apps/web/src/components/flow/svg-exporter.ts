import type { Node, Edge } from "@xyflow/react";
import type { StageNodeData, TerminalNodeData, ParallelGroupData } from "./types";

// Color mapping that mirrors the React node components
const TYPE_COLORS: Record<string, { border: string; fill: string; badge: string; badgeBg: string }> = {
  agent:        { border: "#3b82f6", fill: "#1a1f35", badge: "#60a5fa", badgeBg: "#1e3a5f" },
  script:       { border: "#71717a", fill: "#1c1c22", badge: "#a1a1aa", badgeBg: "#27272a" },
  pipeline:     { border: "#22c55e", fill: "#1a2e1a", badge: "#4ade80", badgeBg: "#14532d" },
  foreach:      { border: "#f97316", fill: "#2a1a0e", badge: "#fb923c", badgeBg: "#431407" },
  llm_decision: { border: "#ca8a04", fill: "#1f1a0a", badge: "#facc15", badgeBg: "#422006" },
};

const GATE_COLORS = { border: "#a855f7", fill: "#1e0a2e", badge: "#c084fc", badgeBg: "#3b0764" };
const CONDITION_COLORS = { border: "#ca8a04", fill: "#1f1a0a", badgeBg: "#422006" };
const TERMINAL_COLORS = { border: "#52525b", fill: "#18181b", text: "#a1a1aa" };
const PARALLEL_COLORS = { border: "#059669", fill: "rgba(6,78,59,0.1)" };

const TYPE_LABEL: Record<string, string> = {
  agent: "Agent", script: "Script", pipeline: "Pipeline", foreach: "Foreach", llm_decision: "Decision",
};

const EDGE_COLORS: Record<string, { stroke: string; dash?: string }> = {
  default: { stroke: "#52525b" },
  reject:  { stroke: "#ef4444", dash: "6 4" },
  retry:   { stroke: "#f97316", dash: "6 4" },
  branch:  { stroke: "#ca8a04" },
};

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderTerminalNode(node: Node, data: TerminalNodeData): string {
  const { x, y } = node.position;
  const w = (node.style?.width as number) || 100;
  const h = (node.style?.height as number) || 36;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;

  return `
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"
      fill="${TERMINAL_COLORS.fill}" stroke="${TERMINAL_COLORS.border}" stroke-width="2" />
    <text x="${cx}" y="${cy + 4}" text-anchor="middle" fill="${TERMINAL_COLORS.text}"
      font-size="11" font-weight="700" font-family="system-ui, sans-serif">${escapeXml(data.label)}</text>`;
}

function renderStageNode(node: Node, data: StageNodeData): string {
  const { x, y } = node.position;
  const w = 200;
  const colors = TYPE_COLORS[data.stageType] ?? TYPE_COLORS.script;

  const lines: Array<{ text: string; color: string }> = [];
  if (data.reads?.length) lines.push({ text: `reads: ${data.reads.join(", ")}`, color: "#06b6d4" });
  if (data.writes?.length) lines.push({ text: `writes: ${data.writes.join(", ")}`, color: "#10b981" });
  if (data.stageType === "foreach" && data.items) lines.push({ text: data.items, color: "#fb923c" });
  if (data.stageType === "pipeline" && data.pipelineName) lines.push({ text: `→ ${data.pipelineName}`, color: "#4ade80" });

  const h = Math.max(36 + lines.length * 14, 50);

  let svg = `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"
      fill="${colors.fill}" stroke="${colors.border}" stroke-width="2" />
    <line x1="${x + 4}" y1="${y}" x2="${x + 4}" y2="${y + h}" stroke="${colors.border}" stroke-width="4" />`;

  // Badge
  const badgeText = TYPE_LABEL[data.stageType] ?? "Script";
  const badgeW = badgeText.length * 6 + 8;
  svg += `
    <rect x="${x + 8}" y="${y + 6}" width="${badgeW}" height="14" rx="3" fill="${colors.badgeBg}" />
    <text x="${x + 8 + badgeW / 2}" y="${y + 16}" text-anchor="middle" fill="${colors.badge}"
      font-size="8" font-weight="700" font-family="system-ui, sans-serif">${escapeXml(badgeText)}</text>`;

  // Label
  const labelX = x + 8 + badgeW + 6;
  const maxLabelW = w - badgeW - 22;
  svg += `
    <text x="${labelX}" y="${y + 16}" fill="#f4f4f5"
      font-size="11" font-weight="600" font-family="system-ui, sans-serif">
      <tspan textLength="${Math.min(data.label.length * 6.5, maxLabelW)}" lengthAdjust="spacing">${escapeXml(data.label)}</tspan>
    </text>`;

  // Context lines
  lines.forEach((line, i) => {
    const ly = y + 30 + i * 13;
    const truncated = line.text.length > 35 ? line.text.slice(0, 35) + "..." : line.text;
    svg += `
    <text x="${x + 10}" y="${ly}" fill="${line.color}" opacity="0.7"
      font-size="8" font-family="system-ui, sans-serif">${escapeXml(truncated)}</text>`;
  });

  return svg;
}

function renderGateNode(node: Node, data: StageNodeData): string {
  const { x, y } = node.position;
  const w = 200;
  const lines: string[] = [];
  if (data.rejectTo) lines.push(`reject → ${data.rejectTo}`);
  else lines.push("reject → error");
  if (data.maxFeedbackLoops != null) lines.push(`max ${data.maxFeedbackLoops} loops`);
  const h = Math.max(36 + lines.length * 13, 50);

  let svg = `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"
      fill="${GATE_COLORS.fill}" stroke="${GATE_COLORS.border}" stroke-width="2" />
    <line x1="${x + 4}" y1="${y}" x2="${x + 4}" y2="${y + h}" stroke="${GATE_COLORS.border}" stroke-width="4" />`;

  const badgeW = 32;
  svg += `
    <rect x="${x + 8}" y="${y + 6}" width="${badgeW}" height="14" rx="3" fill="${GATE_COLORS.badgeBg}" />
    <text x="${x + 8 + badgeW / 2}" y="${y + 16}" text-anchor="middle" fill="${GATE_COLORS.badge}"
      font-size="8" font-weight="700" font-family="system-ui, sans-serif">Gate</text>
    <text x="${x + 8 + badgeW + 6}" y="${y + 16}" fill="#f4f4f5"
      font-size="11" font-weight="600" font-family="system-ui, sans-serif">${escapeXml(data.label)}</text>`;

  lines.forEach((line, i) => {
    const ly = y + 30 + i * 13;
    const color = line.startsWith("reject") ? "#f87171" : "#71717a";
    svg += `
    <text x="${x + 10}" y="${ly}" fill="${color}"
      font-size="8" font-family="system-ui, sans-serif">${escapeXml(line)}</text>`;
  });

  return svg;
}

function renderConditionNode(node: Node, data: StageNodeData): string {
  const { x, y } = node.position;
  const w = 280;
  const branches = data.branches ?? [];
  const h = Math.max(50 + branches.length * 16, 70);

  let svg = `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6"
      fill="${CONDITION_COLORS.fill}" stroke="${CONDITION_COLORS.border}" stroke-width="2" />
    <line x1="${x + 4}" y1="${y}" x2="${x + 4}" y2="${y + h}" stroke="${CONDITION_COLORS.border}" stroke-width="4" />`;

  const badgeW = 58;
  svg += `
    <rect x="${x + 8}" y="${y + 6}" width="${badgeW}" height="14" rx="3" fill="${CONDITION_COLORS.badgeBg}" />
    <text x="${x + 8 + badgeW / 2}" y="${y + 16}" text-anchor="middle" fill="#fbbf24"
      font-size="8" font-weight="700" font-family="system-ui, sans-serif">Condition</text>
    <text x="${x + 8 + badgeW + 6}" y="${y + 16}" fill="#f4f4f5"
      font-size="11" font-weight="600" font-family="system-ui, sans-serif">${escapeXml(data.label)}</text>`;

  branches.forEach((b, i) => {
    const ly = y + 34 + i * 15;
    const label = b.default ? "default" : (b.when ?? "?");
    const truncated = label.length > 30 ? label.slice(0, 30) + "..." : label;
    const target = b.to ?? "next";
    svg += `
    <text x="${x + 12}" y="${ly}" font-size="8" font-family="system-ui, sans-serif">
      <tspan fill="#ca8a04">→ </tspan><tspan fill="#ca8a04" opacity="0.6">${escapeXml(truncated)}</tspan>
      <tspan fill="#52525b"> → </tspan><tspan fill="#d4d4d8" font-weight="500">${escapeXml(target)}</tspan>
    </text>`;
  });

  return svg;
}

function renderParallelGroup(node: Node, _data: ParallelGroupData): string {
  const { x, y } = node.position;
  const w = (node.style?.width as number) || 400;
  const h = (node.style?.height as number) || 120;

  return `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8"
      fill="${PARALLEL_COLORS.fill}" stroke="${PARALLEL_COLORS.border}" stroke-width="2" stroke-dasharray="8 4" />
    <text x="${x + 8}" y="${y + 14}" fill="#059669" opacity="0.7"
      font-size="9" font-weight="700" font-family="system-ui, sans-serif"
      letter-spacing="0.1em" text-transform="uppercase">${escapeXml(_data.label)}</text>`;
}

function renderEdge(edge: Edge, nodeMap: Map<string, Node>): string {
  const source = nodeMap.get(edge.source);
  const target = nodeMap.get(edge.target);
  if (!source || !target) return "";

  const data = (edge.data ?? {}) as { label?: string; isReject?: boolean; isRetry?: boolean; isBranch?: boolean };

  let style = EDGE_COLORS.default;
  if (data.isReject) style = EDGE_COLORS.reject;
  else if (data.isRetry) style = EDGE_COLORS.retry;
  else if (data.isBranch) style = EDGE_COLORS.branch;

  // Compute source/target connection points
  const sw = getNodeWidth(source);
  const sh = getNodeHeight(source);
  const tw = getNodeWidth(target);

  let sx = source.position.x + sw / 2;
  let sy = source.position.y + sh;
  let tx = target.position.x + tw / 2;
  let ty = target.position.y;

  // Adjust for child nodes inside groups
  if (source.parentId) {
    const parent = nodeMap.get(source.parentId);
    if (parent) { sx += parent.position.x; sy += parent.position.y; }
  }
  if (target.parentId) {
    const parent = nodeMap.get(target.parentId);
    if (parent) { tx += parent.position.x; ty += parent.position.y; }
  }

  const isBackJump = ty < sy;
  let path: string;

  if (isBackJump) {
    // Bezier curve for back-jumps
    const dx = tx - sx;
    const dy = ty - sy;
    const cp1x = sx + dx * 0.1;
    const cp1y = sy + dy * 0.7;
    const cp2x = tx - dx * 0.1;
    const cp2y = ty - dy * 0.3;
    path = `M ${sx} ${sy} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${tx} ${ty}`;
  } else {
    // Smooth step path
    const midY = (sy + ty) / 2;
    if (Math.abs(sx - tx) < 2) {
      path = `M ${sx} ${sy} L ${tx} ${ty}`;
    } else {
      path = `M ${sx} ${sy} L ${sx} ${midY} Q ${sx} ${midY + 12} ${sx + (tx > sx ? 12 : -12)} ${midY + 12} L ${tx + (tx > sx ? -12 : 12)} ${midY + 12} Q ${tx} ${midY + 12} ${tx} ${midY + 24} L ${tx} ${ty}`;
    }
  }

  let svg = `
    <path d="${path}" fill="none" stroke="${style.stroke}" stroke-width="1.5"
      ${style.dash ? `stroke-dasharray="${style.dash}"` : ""}
      marker-end="url(#arrow-${data.isReject ? "reject" : data.isRetry ? "retry" : data.isBranch ? "branch" : "default"})" />`;

  // Edge label
  if (data.label) {
    const lx = sx + (tx - sx) * 0.3;
    const ly = sy + (ty - sy) * 0.3;
    const labelColor = data.isReject ? "#fca5a5" : data.isRetry ? "#fdba74" : data.isBranch ? "#fde68a" : "#d4d4d8";
    const bgColor = data.isReject ? "#450a0a" : data.isRetry ? "#431407" : data.isBranch ? "#422006" : "#27272a";
    const truncated = data.label.length > 28 ? data.label.slice(0, 28) + "..." : data.label;
    const lw = truncated.length * 5.5 + 12;
    svg += `
    <rect x="${lx - lw / 2}" y="${ly - 8}" width="${lw}" height="16" rx="4"
      fill="${bgColor}" stroke="${style.stroke}" stroke-width="0.5" opacity="0.9" />
    <text x="${lx}" y="${ly + 3}" text-anchor="middle" fill="${labelColor}"
      font-size="9" font-weight="500" font-family="system-ui, sans-serif">${escapeXml(truncated)}</text>`;
  }

  return svg;
}

function getNodeWidth(node: Node): number {
  if (node.style?.width) return node.style.width as number;
  if (node.type === "terminal") return 100;
  if (node.type === "condition") return 280;
  return 200;
}

function getNodeHeight(node: Node): number {
  if (node.style?.height) return node.style.height as number;
  if (node.type === "terminal") return 36;
  const data = node.data as Record<string, unknown>;
  if (node.type === "condition") {
    const branches = (data.branches as unknown[]) ?? [];
    return Math.max(50 + branches.length * 16, 70);
  }
  if (node.type === "gate") {
    let lines = 1;
    if (data.maxFeedbackLoops != null) lines++;
    return Math.max(36 + lines * 13, 50);
  }
  // stage
  let contextLines = 0;
  if ((data.reads as string[])?.length) contextLines++;
  if ((data.writes as string[])?.length) contextLines++;
  if (data.stageType === "foreach" && data.items) contextLines++;
  if (data.stageType === "pipeline" && data.pipelineName) contextLines++;
  return Math.max(36 + contextLines * 14, 50);
}

export function exportPipelineSvg(nodes: Node[], edges: Edge[]): string {
  const nodeMap = new Map<string, Node>();
  for (const n of nodes) nodeMap.set(n.id, n);

  // Compute bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.parentId) continue; // children are relative to parent
    const w = getNodeWidth(n);
    const h = getNodeHeight(n);
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }

  const pad = 40;
  const svgW = maxX - minX + pad * 2;
  const svgH = maxY - minY + pad * 2;

  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="${minX - pad} ${minY - pad} ${svgW} ${svgH}">`);

  // Defs: arrow markers
  parts.push(`<defs>
    <marker id="arrow-default" viewBox="0 0 14 14" refX="14" refY="7" markerWidth="14" markerHeight="14" orient="auto-start-reverse">
      <path d="M 0 0 L 14 7 L 0 14 z" fill="#52525b" />
    </marker>
    <marker id="arrow-reject" viewBox="0 0 14 14" refX="14" refY="7" markerWidth="14" markerHeight="14" orient="auto-start-reverse">
      <path d="M 0 0 L 14 7 L 0 14 z" fill="#ef4444" />
    </marker>
    <marker id="arrow-retry" viewBox="0 0 14 14" refX="14" refY="7" markerWidth="14" markerHeight="14" orient="auto-start-reverse">
      <path d="M 0 0 L 14 7 L 0 14 z" fill="#f97316" />
    </marker>
    <marker id="arrow-branch" viewBox="0 0 14 14" refX="14" refY="7" markerWidth="14" markerHeight="14" orient="auto-start-reverse">
      <path d="M 0 0 L 14 7 L 0 14 z" fill="#ca8a04" />
    </marker>
  </defs>`);

  // Background
  parts.push(`<rect x="${minX - pad}" y="${minY - pad}" width="${svgW}" height="${svgH}" fill="#09090b" />`);

  // Render edges first (behind nodes)
  for (const edge of edges) {
    parts.push(renderEdge(edge, nodeMap));
  }

  // Render nodes: groups first, then children, then standalone
  const groups = nodes.filter((n) => n.type === "parallelGroup");
  const children = nodes.filter((n) => n.parentId);
  const standalone = nodes.filter((n) => !n.parentId && n.type !== "parallelGroup");

  for (const node of groups) {
    parts.push(renderParallelGroup(node, node.data as ParallelGroupData));
  }

  for (const node of children) {
    const parent = nodeMap.get(node.parentId!);
    // Create offset node for rendering
    const offsetNode = {
      ...node,
      position: {
        x: node.position.x + (parent?.position.x ?? 0),
        y: node.position.y + (parent?.position.y ?? 0),
      },
    };
    parts.push(renderNodeByType(offsetNode));
  }

  for (const node of standalone) {
    parts.push(renderNodeByType(node));
  }

  parts.push("</svg>");
  return parts.join("\n");
}

function renderNodeByType(node: Node): string {
  switch (node.type) {
    case "terminal":
      return renderTerminalNode(node, node.data as TerminalNodeData);
    case "stage":
      return renderStageNode(node, node.data as StageNodeData);
    case "gate":
      return renderGateNode(node, node.data as StageNodeData);
    case "condition":
      return renderConditionNode(node, node.data as StageNodeData);
    default:
      return "";
  }
}
