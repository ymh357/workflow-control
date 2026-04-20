import { describe, it, expect } from "vitest";
import { unwrapParallelBlocks } from "./unwrap-parallel-blocks.js";

describe("unwrapParallelBlocks", () => {
  it("flattens a parallel block, records blockMap entry, and records blockMembers", () => {
    const legacy = {
      stages: [
        { name: "A", type: "agent" },
        { parallel: { name: "group", stages: [
          { name: "B1", type: "agent" },
          { name: "B2", type: "agent" },
        ] } },
        { name: "C", type: "agent" },
      ],
    };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flat.map((s: any) => s.name)).toEqual(["A", "B1", "B2", "C"]);
    expect(r.blockMap.get("group")).toBe("B1");
    expect(r.blockMembers.get("group")).toEqual(["B1", "B2"]);
  });

  it("preserves non-parallel stages unchanged", () => {
    const legacy = { stages: [{ name: "A", type: "agent", foo: 1 }] };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flat[0]).toEqual({ name: "A", type: "agent", foo: 1 });
    expect(r.blockMap.size).toBe(0);
    expect(r.blockMembers.size).toBe(0);
  });

  it("rejects nested parallel", () => {
    const legacy = {
      stages: [{
        parallel: {
          name: "outer",
          stages: [{ parallel: { name: "inner", stages: [{ name: "X" }] } }],
        },
      }],
    };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("NESTED_PARALLEL_UNSUPPORTED");
  });

  it("rejects empty parallel block", () => {
    const legacy = { stages: [{ parallel: { name: "g", stages: [] } }] };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("PARALLEL_EMPTY");
  });

  it("rejects name collision between inner and outer stages", () => {
    const legacy = {
      stages: [
        { name: "dup", type: "agent" },
        { parallel: { name: "g", stages: [{ name: "dup", type: "agent" }] } },
      ],
    };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("PARALLEL_NAME_COLLISION");
  });

  it("rejects name collision between two parallel blocks' inner stages", () => {
    const legacy = {
      stages: [
        { parallel: { name: "g1", stages: [{ name: "dup", type: "agent" }] } },
        { parallel: { name: "g2", stages: [{ name: "dup", type: "agent" }] } },
      ],
    };
    const r = unwrapParallelBlocks(legacy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]!.code).toBe("PARALLEL_NAME_COLLISION");
  });
});
