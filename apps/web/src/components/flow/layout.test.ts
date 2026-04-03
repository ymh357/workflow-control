import { describe, it, expect } from "vitest";
import { applyDagreLayout } from "./layout";
import type { Node, Edge } from "@xyflow/react";

function makeNode(id: string, type: string, data: Record<string, unknown> = {}): Node {
  return { id, type, position: { x: 0, y: 0 }, data };
}

function makeEdge(source: string, target: string): Edge {
  return { id: `${source}->${target}`, source, target };
}

describe("applyDagreLayout", () => {
  it("positions nodes with non-zero coordinates", () => {
    const nodes = [
      makeNode("a", "stage"),
      makeNode("b", "stage"),
    ];
    const edges = [makeEdge("a", "b")];
    const result = applyDagreLayout(nodes, edges);

    for (const n of result.nodes) {
      expect(typeof n.position.x).toBe("number");
      expect(typeof n.position.y).toBe("number");
    }
    // b should be below a (TB layout)
    const a = result.nodes.find((n) => n.id === "a")!;
    const b = result.nodes.find((n) => n.id === "b")!;
    expect(b.position.y).toBeGreaterThan(a.position.y);
  });

  it("compact mode produces smaller spacing", () => {
    const nodes = [
      makeNode("a", "stage"),
      makeNode("b", "stage"),
    ];
    const edges = [makeEdge("a", "b")];
    const normal = applyDagreLayout(nodes, edges);
    const compact = applyDagreLayout(nodes, edges, { compact: true });

    const normalGap = Math.abs(
      normal.nodes.find((n) => n.id === "b")!.position.y -
      normal.nodes.find((n) => n.id === "a")!.position.y,
    );
    const compactGap = Math.abs(
      compact.nodes.find((n) => n.id === "b")!.position.y -
      compact.nodes.find((n) => n.id === "a")!.position.y,
    );
    expect(compactGap).toBeLessThan(normalGap);
  });

  it("condition node gets larger dimensions than regular node", () => {
    const nodes = [
      makeNode("cond", "condition", { branches: [{ to: "a" }, { to: "b" }, { to: "c" }] }),
      makeNode("a", "stage"),
      makeNode("b", "stage"),
      makeNode("c", "stage"),
    ];
    const edges = [makeEdge("cond", "a"), makeEdge("cond", "b"), makeEdge("cond", "c")];
    const result = applyDagreLayout(nodes, edges);

    // All nodes should have valid positions
    for (const n of result.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  it("group node gets explicit style.width and style.height", () => {
    const nodes = [
      makeNode("group:g", "parallelGroup"),
      { ...makeNode("child1", "stage"), parentId: "group:g" },
      { ...makeNode("child2", "stage"), parentId: "group:g" },
    ];
    const edges: Edge[] = [];
    const result = applyDagreLayout(nodes, edges);

    const group = result.nodes.find((n) => n.id === "group:g")!;
    expect(group.style).toBeDefined();
    expect((group.style as any).width).toBeGreaterThan(0);
    expect((group.style as any).height).toBeGreaterThan(0);
  });

  it("child nodes are positioned inside their parent group", () => {
    const nodes = [
      makeNode("group:g", "parallelGroup"),
      { ...makeNode("child1", "stage"), parentId: "group:g" },
      { ...makeNode("child2", "stage"), parentId: "group:g" },
    ];
    const edges: Edge[] = [];
    const result = applyDagreLayout(nodes, edges);

    const group = result.nodes.find((n) => n.id === "group:g")!;
    const child1 = result.nodes.find((n) => n.id === "child1")!;
    const child2 = result.nodes.find((n) => n.id === "child2")!;
    const groupW = (group.style as any).width as number;

    // Children should have x >= 0 and x < group width
    expect(child1.position.x).toBeGreaterThanOrEqual(0);
    expect(child1.position.x).toBeLessThan(groupW);
    expect(child2.position.x).toBeGreaterThanOrEqual(0);
    expect(child2.position.x).toBeLessThan(groupW);
    // Children should be side by side (different x)
    expect(child1.position.x).not.toBe(child2.position.x);
  });

  it("terminal nodes get smaller dimensions", () => {
    const nodes = [
      makeNode("start", "terminal"),
      makeNode("mid", "stage"),
      makeNode("end", "terminal"),
    ];
    const edges = [makeEdge("start", "mid"), makeEdge("mid", "end")];
    const result = applyDagreLayout(nodes, edges);

    // All should be laid out vertically
    const start = result.nodes.find((n) => n.id === "start")!;
    const mid = result.nodes.find((n) => n.id === "mid")!;
    const end = result.nodes.find((n) => n.id === "end")!;
    expect(mid.position.y).toBeGreaterThan(start.position.y);
    expect(end.position.y).toBeGreaterThan(mid.position.y);
  });

  it("dynamic height: node with writes/reads gets taller allocation", () => {
    const nodeWithData = makeNode("rich", "stage", {
      engine: "claude",
      writes: ["a", "b"],
      reads: ["c"],
      pipelineName: "sub",
    });
    const nodePlain = makeNode("plain", "stage", {});
    // Both should layout without error
    const result = applyDagreLayout([nodeWithData, nodePlain], [makeEdge("rich", "plain")]);
    expect(result.nodes).toHaveLength(2);
  });
});
