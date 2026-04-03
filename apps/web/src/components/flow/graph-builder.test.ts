import { describe, it, expect } from "vitest";
import { buildPipelineGraph } from "./graph-builder";
import type { PipelineStageEntry } from "@/lib/pipeline-types";

function makeStage(
  name: string,
  type: "agent" | "script" | "human_confirm" | "condition" | "pipeline" | "foreach" = "agent",
  runtime?: Record<string, unknown>,
): PipelineStageEntry {
  return { name, type, runtime: runtime as any };
}

function makeParallelGroup(
  name: string,
  stages: Array<{ name: string; type?: "agent" | "script" }>,
): PipelineStageEntry {
  return {
    parallel: {
      name,
      stages: stages.map((s) => ({ name: s.name, type: s.type ?? "agent" })),
    },
  };
}

describe("buildPipelineGraph", () => {
  it("linear 3 agent stages → 5 nodes, 4 edges", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("analyze"),
      makeStage("implement"),
      makeStage("review"),
    ];
    const { nodes, edges } = buildPipelineGraph({ entries });

    expect(nodes).toHaveLength(5); // start + 3 + completed
    expect(edges).toHaveLength(4); // start→a, a→b, b→c, c→completed
  });

  it("condition with 3-way branch → 3 outgoing edges from condition", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("check", "condition", {
        engine: "condition",
        branches: [
          { when: "score > 80", to: "pass" },
          { when: "score > 50", to: "review" },
          { default: true, to: "fail" },
        ],
      }),
      makeStage("pass"),
      makeStage("review"),
      makeStage("fail"),
    ];
    const { nodes, edges } = buildPipelineGraph({ entries });

    // condition node should have 3 branch edges
    const conditionEdges = edges.filter((e) => e.source === "stage:check");
    expect(conditionEdges).toHaveLength(3);
    expect(conditionEdges[0].data?.label).toBe("score > 80");
    expect(conditionEdges[1].data?.label).toBe("score > 50");
    expect(conditionEdges[2].data?.label).toBe("default");
  });

  it("parallel group → group node + child nodes with parentId", () => {
    const entries: PipelineStageEntry[] = [
      makeParallelGroup("parallel_work", [
        { name: "sub_a" },
        { name: "sub_b" },
      ]),
    ];
    const { nodes } = buildPipelineGraph({ entries });

    const groupNode = nodes.find((n) => n.id === "group:parallel_work");
    expect(groupNode).toBeDefined();
    expect(groupNode!.type).toBe("parallelGroup");

    const childA = nodes.find((n) => n.id === "stage:sub_a");
    const childB = nodes.find((n) => n.id === "stage:sub_b");
    expect(childA?.parentId).toBe("group:parallel_work");
    expect(childB?.parentId).toBe("group:parallel_work");
  });

  it("foreach node has items and pipelineName in data", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("iterate", "foreach", {
        engine: "foreach",
        items: "store.files",
        pipeline_name: "code-review",
      }),
    ];
    const { nodes } = buildPipelineGraph({ entries });

    const foreachNode = nodes.find((n) => n.id === "stage:iterate");
    expect(foreachNode?.data.items).toBe("store.files");
    expect(foreachNode?.data.pipelineName).toBe("code-review");
  });

  it("human_confirm with reject_to generates red reject edge", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("analyze"),
      makeStage("approval", "human_confirm", {
        engine: "human_gate",
        on_reject_to: "analyze",
      }),
    ];
    const { edges } = buildPipelineGraph({ entries });

    const rejectEdge = edges.find((e) => e.id.includes("reject"));
    expect(rejectEdge).toBeDefined();
    expect(rejectEdge!.data?.isReject).toBe(true);
    expect(rejectEdge!.target).toBe("stage:analyze");
  });

  it("retry back_to generates retry edge", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("step-a"),
      makeStage("step-b", "agent", {
        engine: "llm",
        retry: { max_retries: 3, back_to: "step-a" },
      }),
    ];
    const { edges } = buildPipelineGraph({ entries });

    const retryEdge = edges.find((e) => e.id.includes("retry"));
    expect(retryEdge).toBeDefined();
    expect(retryEdge!.data?.isRetry).toBe(true);
    expect(retryEdge!.target).toBe("stage:step-a");
  });

  it("runtime status assignment: done/current/pending", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("a"),
      makeStage("b"),
      makeStage("c"),
    ];
    const { nodes } = buildPipelineGraph({
      entries,
      mode: "runtime",
      currentStatus: "b",
    });

    const nodeA = nodes.find((n) => n.id === "stage:a");
    const nodeB = nodes.find((n) => n.id === "stage:b");
    const nodeC = nodes.find((n) => n.id === "stage:c");
    expect(nodeA?.data.status).toBe("done");
    expect(nodeB?.data.status).toBe("current");
    expect(nodeC?.data.status).toBe("pending");
  });

  it("empty entries → only start + completed", () => {
    const { nodes, edges } = buildPipelineGraph({ entries: [] });

    expect(nodes).toHaveLength(2);
    expect(nodes[0].id).toBe("__start__");
    expect(nodes[1].id).toBe("__completed__");
    expect(edges).toHaveLength(1); // start → completed
  });

  it("condition branch to=completed → edge points to __completed__", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("check", "condition", {
        engine: "condition",
        branches: [
          { when: "done", to: "completed" },
          { default: true, to: "next" },
        ],
      }),
      makeStage("next"),
    ];
    const { edges } = buildPipelineGraph({ entries });

    const completedEdge = edges.find(
      (e) => e.source === "stage:check" && e.target === "__completed__",
    );
    expect(completedEdge).toBeDefined();
  });

  it("agent node includes writes and reads in data", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("step", "agent", {
        engine: "llm",
        writes: ["output_a", "output_b"],
        reads: { source: "prev.data" },
      }),
    ];
    const { nodes } = buildPipelineGraph({ entries });
    const node = nodes.find((n) => n.id === "stage:step");
    expect(node?.data.writes).toEqual(["output_a", "output_b"]);
    expect(node?.data.reads).toEqual(["prev.data"]);
  });

  it("human_confirm node includes rejectTo and maxFeedbackLoops", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("analyze"),
      makeStage("gate", "human_confirm", {
        engine: "human_gate",
        on_reject_to: "analyze",
        max_feedback_loops: 5,
      }),
    ];
    const { nodes } = buildPipelineGraph({ entries });
    const gate = nodes.find((n) => n.id === "stage:gate");
    expect(gate?.data.rejectTo).toBe("analyze");
    expect(gate?.data.maxFeedbackLoops).toBe(5);
  });

  it("foreach node includes concurrency, errorMode, collectTo", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("batch", "foreach", {
        engine: "foreach",
        items: "store.list",
        pipeline_name: "sub-pipe",
        max_concurrency: 5,
        on_item_error: "continue",
        collect_to: "results",
      }),
    ];
    const { nodes } = buildPipelineGraph({ entries });
    const node = nodes.find((n) => n.id === "stage:batch");
    expect(node?.data.concurrency).toBe(5);
    expect(node?.data.errorMode).toBe("continue");
    expect(node?.data.collectTo).toBe("results");
  });

  it("branch edges have colored markers", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("check", "condition", {
        engine: "condition",
        branches: [
          { when: "x > 1", to: "a" },
          { default: true, to: "b" },
        ],
      }),
      makeStage("a"),
      makeStage("b"),
    ];
    const { edges } = buildPipelineGraph({ entries });
    const branchEdge = edges.find((e) => e.source === "stage:check");
    expect(branchEdge?.markerEnd).toBeDefined();
    expect((branchEdge?.markerEnd as any)?.color).toBe("#ca8a04");
  });

  it("reject edge has red marker", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("prev"),
      makeStage("gate", "human_confirm", {
        engine: "human_gate",
        on_reject_to: "prev",
      }),
    ];
    const { edges } = buildPipelineGraph({ entries });
    const rejectEdge = edges.find((e) => e.id.includes("reject"));
    expect((rejectEdge?.markerEnd as any)?.color).toBe("#ef4444");
  });

  it("retry edge has orange marker", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("a"),
      makeStage("b", "agent", {
        engine: "llm",
        retry: { back_to: "a" },
      }),
    ];
    const { edges } = buildPipelineGraph({ entries });
    const retryEdge = edges.find((e) => e.id.includes("retry"));
    expect((retryEdge?.markerEnd as any)?.color).toBe("#f97316");
  });

  it("stage with no writes/reads has undefined for those fields", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("bare", "agent", { engine: "llm" }),
    ];
    const { nodes } = buildPipelineGraph({ entries });
    const node = nodes.find((n) => n.id === "stage:bare");
    expect(node?.data.writes).toBeUndefined();
    expect(node?.data.reads).toBeUndefined();
  });

  it("complex mixed pipeline: condition + parallel + foreach", () => {
    const entries: PipelineStageEntry[] = [
      makeStage("analyze", "agent"),
      makeStage("route", "condition", {
        engine: "condition",
        branches: [
          { when: "needs_review", to: "review-group" },
          { default: true, to: "auto-process" },
        ],
      }),
      makeParallelGroup("review-group", [
        { name: "code-review" },
        { name: "security-scan" },
      ]),
      makeStage("auto-process", "foreach", {
        engine: "foreach",
        items: "store.items",
        pipeline_name: "process-item",
      }),
      makeStage("finalize"),
    ];
    const { nodes, edges } = buildPipelineGraph({ entries });

    // 2 terminal + 1 condition + 1 group + 2 group children + 1 foreach + 1 analyze + 1 finalize = 9
    expect(nodes.length).toBe(9);
    // Verify condition creates branch edges not linear
    const routeEdges = edges.filter((e) => e.source === "stage:route");
    expect(routeEdges.length).toBe(2);
    // Verify all edges have valid targets
    const nodeIds = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      expect(nodeIds.has(e.target) || nodeIds.has(e.target)).toBe(true);
    }
  });
});
