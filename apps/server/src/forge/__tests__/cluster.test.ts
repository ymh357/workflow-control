import { describe, it, expect } from "vitest";
import { cosine, assignToCluster, updateCentroidIncremental } from "../similarity/cluster.js";

describe("cosine", () => {
  it("identical vectors → 1.0", () => {
    const v = Float32Array.from([1, 0, 0]);
    expect(cosine(v, v)).toBeCloseTo(1.0, 5);
  });
  it("orthogonal → 0", () => {
    expect(cosine(Float32Array.from([1, 0, 0]), Float32Array.from([0, 1, 0]))).toBeCloseTo(0, 5);
  });
  it("opposite → -1", () => {
    expect(cosine(Float32Array.from([1, 0, 0]), Float32Array.from([-1, 0, 0]))).toBeCloseTo(-1, 5);
  });
  it("returns 0 when one side is zero vector", () => {
    expect(cosine(Float32Array.from([0, 0, 0]), Float32Array.from([1, 0, 0]))).toBe(0);
  });
  it("throws on dim mismatch", () => {
    expect(() => cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toThrow();
  });
});

describe("assignToCluster", () => {
  it("creates new cluster when no candidates exist", () => {
    const r = assignToCluster(Float32Array.from([1, 0, 0]), [], 0.85);
    expect(r.kind).toBe("new");
  });
  it("joins existing when cosine ≥ threshold", () => {
    const r = assignToCluster(
      Float32Array.from([0.99, 0.01, 0]),
      [{ clusterId: "c1", centroid: Float32Array.from([1, 0, 0]) }],
      0.85,
    );
    expect(r.kind).toBe("existing");
    if (r.kind === "existing") {
      expect(r.clusterId).toBe("c1");
      expect(r.cosine).toBeGreaterThan(0.85);
    }
  });
  it("creates new when cosine < threshold", () => {
    const r = assignToCluster(
      Float32Array.from([0, 0, 1]),
      [{ clusterId: "c1", centroid: Float32Array.from([1, 0, 0]) }],
      0.85,
    );
    expect(r.kind).toBe("new");
  });
  it("picks the closest cluster when multiple exist", () => {
    const v = Float32Array.from([1, 0.1, 0]);
    const r = assignToCluster(v, [
      { clusterId: "c1", centroid: Float32Array.from([0, 1, 0]) },
      { clusterId: "c2", centroid: Float32Array.from([1, 0, 0]) },
      { clusterId: "c3", centroid: Float32Array.from([0, 0, 1]) },
    ], 0.85);
    expect(r.kind).toBe("existing");
    if (r.kind === "existing") expect(r.clusterId).toBe("c2");
  });
  it("ignores clusters with mismatched dim", () => {
    const r = assignToCluster(
      Float32Array.from([1, 0, 0, 0]),
      [{ clusterId: "wrong", centroid: Float32Array.from([1, 0]) }],
      0.85,
    );
    expect(r.kind).toBe("new");
  });
});

describe("updateCentroidIncremental", () => {
  it("running mean is correct", () => {
    const c = updateCentroidIncremental(Float32Array.from([1, 0, 0]), 1, Float32Array.from([0, 1, 0]));
    expect(c[0]).toBeCloseTo(0.5);
    expect(c[1]).toBeCloseTo(0.5);
    expect(c[2]).toBeCloseTo(0);
  });

  it("does not mutate the old centroid", () => {
    const old = Float32Array.from([1, 0, 0]);
    const oldCopy = Float32Array.from(old);
    updateCentroidIncremental(old, 1, Float32Array.from([0, 1, 0]));
    expect(Array.from(old)).toEqual(Array.from(oldCopy));
  });

  it("accumulates correctly across many updates", () => {
    let centroid: Float32Array = new Float32Array([0, 0]);
    for (let i = 0; i < 10; i++) {
      centroid = updateCentroidIncremental(centroid, i, Float32Array.from([1, 0]));
    }
    // After 10 admissions of [1,0] starting from [0,0], the mean is [1,0]
    expect(centroid[0]).toBeCloseTo(1);
    expect(centroid[1]).toBeCloseTo(0);
  });

  it("throws on dim mismatch", () => {
    expect(() => updateCentroidIncremental(Float32Array.from([1, 0]), 1, Float32Array.from([1]))).toThrow();
  });
});
