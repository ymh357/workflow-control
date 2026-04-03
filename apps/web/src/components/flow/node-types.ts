import type { NodeTypes, EdgeTypes } from "@xyflow/react";
import TerminalNode from "./nodes/terminal-node";
import StageNode from "./nodes/stage-node";
import ConditionNode from "./nodes/condition-node";
import GateNode from "./nodes/gate-node";
import ParallelGroupNode from "./nodes/parallel-group-node";
import BranchEdge from "./edges/branch-edge";

export const nodeTypes: NodeTypes = {
  terminal: TerminalNode,
  stage: StageNode,
  condition: ConditionNode,
  gate: GateNode,
  parallelGroup: ParallelGroupNode,
};

export const edgeTypes: EdgeTypes = {
  branch: BranchEdge,
};
