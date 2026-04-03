import type { Node, Edge } from "@xyflow/react";
import { MarkerType } from "@xyflow/react";
import type { PipelineStageEntry, PipelineStageSchema } from "@/lib/pipeline-types";
import { isPipelineParallelGroup } from "@/lib/pipeline-types";
import type { StageCostInfo, StageNodeData, TerminalNodeData, ParallelGroupData } from "./types";
import { applyDagreLayout } from "./layout";

const MARKER_DEFAULT = { type: MarkerType.ArrowClosed as const, width: 14, height: 14, color: "#52525b" };
const MARKER_BRANCH = { type: MarkerType.ArrowClosed as const, width: 14, height: 14, color: "#ca8a04" };
const MARKER_REJECT = { type: MarkerType.ArrowClosed as const, width: 14, height: 14, color: "#ef4444" };
const MARKER_RETRY = { type: MarkerType.ArrowClosed as const, width: 14, height: 14, color: "#f97316" };

export interface BuildGraphOptions {
  entries: PipelineStageEntry[];
  mode?: "edit" | "runtime";
  currentStatus?: string;
  stageCosts?: Record<string, StageCostInfo>;
  selectedStageName?: string;
  compact?: boolean;
}

function getNodeType(stageType: string): string {
  if (stageType === "condition") return "condition";
  if (stageType === "human_confirm") return "gate";
  return "stage";
}

function findCurrentEntryIdx(entries: PipelineStageEntry[], currentStatus: string): number {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (isPipelineParallelGroup(entry)) {
      if (entry.parallel.name === currentStatus) return i;
      if (entry.parallel.stages.some((s) => s.name === currentStatus)) return i;
    } else if ((entry as PipelineStageSchema).name === currentStatus) {
      return i;
    }
  }
  return -1;
}

function getEntryStatus(
  entryIdx: number,
  currentEntryIdx: number,
  isCompleted: boolean,
): "done" | "current" | "pending" {
  if (isCompleted) return "done";
  if (currentEntryIdx < 0) return "pending";
  if (entryIdx < currentEntryIdx) return "done";
  if (entryIdx > currentEntryIdx) return "pending";
  return "current";
}

function getStageName(entry: PipelineStageEntry): string {
  if (isPipelineParallelGroup(entry)) return entry.parallel.name;
  return (entry as PipelineStageSchema).name;
}

function resolveTarget(to: string | undefined, entries: PipelineStageEntry[]): string | null {
  if (!to) return null;
  if (to === "completed") return "__completed__";
  // Find matching stage
  for (const entry of entries) {
    if (isPipelineParallelGroup(entry)) {
      if (entry.parallel.name === to) return `group:${to}`;
      for (const child of entry.parallel.stages) {
        if (child.name === to) return `stage:${to}`;
      }
    } else if ((entry as PipelineStageSchema).name === to) {
      return `stage:${to}`;
    }
  }
  return null;
}

export function buildPipelineGraph(options: BuildGraphOptions): { nodes: Node[]; edges: Edge[] } {
  const {
    entries,
    mode = "edit",
    currentStatus,
    stageCosts,
    selectedStageName,
    compact = false,
  } = options;

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const isCompleted = currentStatus === "completed";
  const currentEntryIdx = currentStatus ? findCurrentEntryIdx(entries, currentStatus) : -1;

  // Start node
  const startStatus = entries.length > 0
    ? (isCompleted || currentEntryIdx >= 0 ? "done" : "pending")
    : "pending";
  nodes.push({
    id: "__start__",
    type: "terminal",
    position: { x: 0, y: 0 },
    data: { label: "Start", status: mode === "runtime" ? startStatus : undefined, compact } satisfies TerminalNodeData,
    draggable: !compact,
  });

  // Completed node
  const completedStatus = isCompleted ? "done" : "pending";
  nodes.push({
    id: "__completed__",
    type: "terminal",
    position: { x: 0, y: 0 },
    data: { label: "Completed", status: mode === "runtime" ? completedStatus : undefined, compact } satisfies TerminalNodeData,
    draggable: !compact,
  });

  // Track nodes for condition special routing
  const conditionNodes = new Set<string>();

  entries.forEach((entry, entryIdx) => {
    const status = mode === "runtime" ? getEntryStatus(entryIdx, currentEntryIdx, isCompleted) : undefined;

    if (isPipelineParallelGroup(entry)) {
      const group = entry.parallel;
      const groupId = `group:${group.name}`;

      nodes.push({
        id: groupId,
        type: "parallelGroup",
        position: { x: 0, y: 0 },
        data: { label: group.name, groupName: group.name, status, compact } satisfies ParallelGroupData,
        draggable: !compact,
      });

      group.stages.forEach((child) => {
        nodes.push({
          id: `stage:${child.name}`,
          type: getNodeType(child.type),
          position: { x: 0, y: 0 },
          parentId: groupId,
          extent: "parent" as const,
          data: {
            label: child.name,
            stageType: child.type,
            stageName: child.name,
            entryIndex: entryIdx,
            isSelected: mode === "edit" && selectedStageName === child.name,
            status,
            cost: stageCosts?.[child.name],
            engine: child.engine,
            compact,
          } satisfies StageNodeData,
          draggable: false,
        });
      });
    } else {
      const stage = entry as PipelineStageSchema;
      const nodeId = `stage:${stage.name}`;
      const runtime = (stage as any).runtime;

      const writes = runtime?.writes as string[] | undefined;
      const readsObj = runtime?.reads as Record<string, string> | undefined;
      const reads = readsObj ? Object.values(readsObj) : undefined;

      const nodeData: StageNodeData = {
        label: stage.name,
        stageType: stage.type,
        stageName: stage.name,
        entryIndex: entryIdx,
        isSelected: mode === "edit" && selectedStageName === stage.name,
        status,
        cost: stageCosts?.[stage.name],
        engine: stage.engine,
        compact,
        writes: writes?.length ? writes : undefined,
        reads: reads?.length ? reads : undefined,
      };

      if (stage.type === "condition" && runtime?.branches) {
        conditionNodes.add(nodeId);
        nodeData.branches = runtime.branches;
      }

      if (stage.type === "human_confirm") {
        if (runtime?.on_reject_to && runtime.on_reject_to !== "error") {
          nodeData.rejectTo = runtime.on_reject_to as string;
        }
        nodeData.maxFeedbackLoops = (stage as any).max_feedback_loops ?? runtime?.max_feedback_loops;
      }

      if (stage.type === "pipeline" && runtime?.pipeline_name) {
        nodeData.pipelineName = runtime.pipeline_name as string;
      }

      if (stage.type === "foreach") {
        nodeData.items = runtime?.items as string | undefined;
        nodeData.pipelineName = runtime?.pipeline_name as string | undefined;
        nodeData.concurrency = runtime?.max_concurrency as number | undefined;
        nodeData.errorMode = runtime?.on_item_error as string | undefined;
        nodeData.collectTo = runtime?.collect_to as string | undefined;
      }

      nodes.push({
        id: nodeId,
        type: getNodeType(stage.type),
        position: { x: 0, y: 0 },
        data: nodeData,
        draggable: !compact,
      });
    }
  });

  // Generate edges
  const entryIds = entries.map((entry): string => {
    if (isPipelineParallelGroup(entry)) return `group:${entry.parallel.name}`;
    return `stage:${(entry as PipelineStageSchema).name}`;
  });

  // Start → first entry
  if (entryIds.length > 0) {
    edges.push({
      id: "e:start->first",
      source: "__start__",
      target: entryIds[0],
      type: "branch",
    });
  } else {
    edges.push({
      id: "e:start->completed",
      source: "__start__",
      target: "__completed__",
      type: "branch",
    });
  }

  entries.forEach((entry, entryIdx) => {
    const currentId = entryIds[entryIdx];
    const nextId = entryIdx < entryIds.length - 1 ? entryIds[entryIdx + 1] : "__completed__";

    if (isPipelineParallelGroup(entry)) {
      // Group → next
      edges.push({
        id: `e:${currentId}->${nextId}`,
        source: currentId,
        target: nextId,
        type: "branch",
      });
      return;
    }

    const stage = entry as PipelineStageSchema;
    const runtime = (stage as any).runtime;

    // Condition: special routing
    if (conditionNodes.has(currentId) && runtime?.branches) {
      const branches = runtime.branches as Array<{ when?: string; default?: boolean; to?: string }>;
      branches.forEach((branch, bi) => {
        const targetId = resolveTarget(branch.to, entries) ?? nextId;
        const label = branch.default ? "default" : (branch.when ?? `branch ${bi}`);
        edges.push({
          id: `e:${currentId}->branch:${bi}`,
          source: currentId,
          target: targetId,
          type: "branch",
          markerEnd: MARKER_BRANCH,
          data: { label, isBranch: true },
        });
      });
      return;
    }

    // Default linear: current → next
    edges.push({
      id: `e:${currentId}->${nextId}`,
      source: currentId,
      target: nextId,
      type: "branch",
    });

    // human_confirm: reject edge
    if (stage.type === "human_confirm" && runtime?.on_reject_to && runtime.on_reject_to !== "error") {
      const rejectTarget = resolveTarget(runtime.on_reject_to, entries);
      if (rejectTarget) {
        edges.push({
          id: `e:${currentId}->reject`,
          source: currentId,
          target: rejectTarget,
          type: "branch",
          markerEnd: MARKER_REJECT,
          data: { label: "reject", isReject: true },
        });
      }
    }

    // human_confirm: approve_to edge (if non-default)
    if (stage.type === "human_confirm" && runtime?.on_approve_to) {
      const approveTarget = resolveTarget(runtime.on_approve_to, entries);
      if (approveTarget && approveTarget !== nextId) {
        edges.push({
          id: `e:${currentId}->approve`,
          source: currentId,
          target: approveTarget,
          type: "branch",
          data: { label: "approve" },
        });
      }
    }

    // Retry edge
    if (runtime?.retry?.back_to) {
      const retryTarget = resolveTarget(runtime.retry.back_to, entries);
      if (retryTarget) {
        edges.push({
          id: `e:${currentId}->retry`,
          source: currentId,
          target: retryTarget,
          type: "branch",
          markerEnd: MARKER_RETRY,
          data: { label: "retry", isRetry: true },
        });
      }
    }
  });

  // Apply layout
  const layoutResult = applyDagreLayout(nodes, edges, { compact });
  return layoutResult;
}
